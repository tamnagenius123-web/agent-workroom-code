// Billing readback is allowed after execution authority expires. It can settle
// an already-issued generation, but it never reserves or sends a chat request.
import { getGenerationCost, type FetchLike } from '../or-harness/client.ts';
import { Fault } from './contracts.ts';
import type { Database } from './db.ts';
import { admitExecution, ExecutionFenceLost, fencedDatabase, releaseExecution } from './execution-fence.ts';
import { getRunStatus, settleAgain, type RunStatusView } from './run-supervisor.ts';

interface BillingRun {
  run_id: string; task_id: string; project: string; principal_id: string;
  state: string; reservation_id: string | null; generation_id: string | null; receipt_id: string | null;
}
interface HeldGeneration {
  reservation_id: string; generation_id: string | null; state: string;
  model: string; requested_model: string | null;
}

export interface ReconcileCostInput {
  run_id: string;
  principal: string;
  api_key: string;
  cap_micro_usd: number;
  fetch: FetchLike;
}

export async function reconcileRunCost(db: Database, input: ReconcileCostInput) {
  const run = await db.prepare(`SELECT run_id,task_id,project,principal_id,state,reservation_id,generation_id,receipt_id
    FROM execution_runs WHERE run_id=?`).bind(input.run_id).first<BillingRun>();
  if (!run) throw new Fault('NOT_FOUND', 'Execution run not found.', 404);
  if (run.principal_id !== input.principal) throw new Fault('FORBIDDEN', 'Only the run author may reconcile its billing.', 403);
  const reservation = run.reservation_id ? await db.prepare(`SELECT b.reservation_id,b.generation_id,b.state,b.model,
      json_extract(b.pricing_snapshot_json,'$.model') AS requested_model
    FROM budget_reservations b WHERE b.reservation_id=? AND b.principal_id=? AND b.run_id=? AND b.project=?`)
    .bind(run.reservation_id, input.principal, run.run_id, run.project).first<HeldGeneration>() : null;
  if (run.reservation_id && !reservation) throw new Fault('CONFLICT', 'Run reservation ownership does not match.', 409);
  if (run.generation_id && reservation?.generation_id && run.generation_id !== reservation.generation_id) {
    throw new Fault('CONFLICT', 'Run generation does not match the held reservation.', 409);
  }
  const generation = run.generation_id ?? reservation?.generation_id ?? null;
  const result = (status: RunStatusView | null, fetches: number, failure: string | null = status?.failure ?? null) => ({
    run_id: run.run_id, state: status?.state ?? run.state, failure,
    disposition: status?.disposition ?? 'UNKNOWN', generation_id: generation,
    reservation_id: reservation?.reservation_id ?? null, receipt_id: status?.receipt_id ?? run.receipt_id,
    actual_micro_usd: status?.actual_micro_usd ?? null, reservation_state: status?.reservation_state ?? null,
    fetches, chat_posts: 0, check_kind: 'cost_readback_only', task_approved: false,
  });
  if (!reservation || !generation) return result(await getRunStatus(db, run.run_id), 0, 'generation_unknown');
  // A completed reconciliation is an idempotent read, including a stale result
  // that remains UNKNOWN or canceled. A crash between settlement and receipt
  // append is retried below against the original generation only.
  if (reservation.state === 'settled' && (['settled', 'canceled', 'rejected'].includes(run.state)
    || (run.state === 'unknown' && run.receipt_id?.startsWith('rcpt_late_')))) {
    return result(await getRunStatus(db, run.run_id), 0);
  }
  const admission = await admitExecution(db, { run_id: run.run_id, task_id: run.task_id,
    principal: input.principal, model: 'cost-readback' });
  if (!admission.admitted) return result(await getRunStatus(db, run.run_id), 0, `${admission.reason}:${admission.plane}`);
  let fetches = 0;
  const guarded = fencedDatabase(db, admission.fence);
  try {
    const cost = await getGenerationCost(generation, {
      fetchImpl: (target, init) => { fetches++; return input.fetch(target, init); },
      apiKey: input.api_key, retries: 2, delayMs: 250, timeoutMs: 10_000,
    });
    if (!cost) return result(await getRunStatus(guarded, run.run_id), fetches, 'cost_unknown');
    const model = cost.model ?? (reservation.model || reservation.requested_model);
    if (!model) return result(await getRunStatus(guarded, run.run_id), fetches, 'cost_model_unknown');
    await settleAgain(guarded, input.principal, input.cap_micro_usd, reservation.reservation_id, {
      generation_id: generation, micro_usd: cost.micro_usd, cost_field: cost.cost_field,
      provider_account: cost.provider_name, model, tokens: cost.tokens,
    });
    return result(await getRunStatus(guarded, run.run_id), fetches);
  } catch (error) {
    if (error instanceof ExecutionFenceLost) return { ...result(null, fetches, 'execution_fence_lost'), disposition: 'UNKNOWN' };
    throw error;
  } finally { await releaseExecution(db, admission.fence); }
}
