// Thin G1 supervisor. It does not replace the task engine. It reads the existing
// task, lease, and intent rows, then drives the existing budget ledger and the
// one OpenRouter client. Migration 0081 only stores the envelope and the trace.
// 0080 belongs to gate telegram_topics on the shared D1.
import { sha256 } from '../auth/crypto.ts';
import {
  chatOnce, estimateMicroUsd, getGenerationCost, loadRoster, reservationMicroUsd,
  type FetchLike, type SettleInput,
} from '../or-harness/client.ts';
import type { Database } from './db.ts';
import { openD1Ledger } from './dispatch-wire.ts';

export const VERIFIER = 'verifier:g1';
export const LIVE_MODEL = 'z-ai/glm-5.3-flash';
export const LIVE_MAX_TOKENS = 1024;
export const LIVE_MAX_PROMPT_CHARS = 120;
/** Hold for a 120-character prompt and 1024 completion tokens on the flash price. */
export const LIVE_MAX_HOLD_MICRO_USD = 782;
/** Chat timeout for a reasoning completion. The 1s mock timeout is too short for a live call. */
export const LIVE_CHAT_TIMEOUT_MS = 30_000;
/** Generation-cost lookup: six attempts, 2s starting delay, factor 2, cap 8s, 10s per attempt. */
export const LIVE_COST_RETRIES = 6;
export const LIVE_COST_DELAY_MS = 2_000;
export const LIVE_COST_BACKOFF = 2;
export const LIVE_COST_MAX_DELAY_MS = 8_000;
export const LIVE_COST_TIMEOUT_MS = 10_000;
/** Bounded wait between the first and last cost lookup, excluding request time. */
export const LIVE_COST_MAX_WAIT_MS = 2_000 + 4_000 + 8_000 + 8_000 + 8_000;

export type TraceStep = 'claim' | 'reserve' | 'model' | 'tool' | 'artifact' | 'settlement' | 'receipt';

export interface TraceEvent {
  step: TraceStep;
  task_id: string;
  run_id: string;
  attempt_id: string;
  lease_epoch: number;
  intent_revision: number;
  ok: boolean;
  detail: string;
}

export interface RunInput {
  project: string;
  task_id: string;
  run_id: string;
  attempt_id: string;
  principal: string;
  lease_epoch: number;
  intent_revision: number;
  cancel_generation: number;
  model: string;
  prompt: string;
  max_tokens: number;
  api_key: string;
  cap_micro_usd: number;
  fetch: FetchLike;
  after?: (step: TraceStep) => Promise<void> | void;
}

export interface RunReport {
  state: string;
  failure: string | null;
  disposition: 'PASS' | 'FAIL' | 'UNKNOWN' | 'CANCELED';
  generation_id: string | null;
  reservation_id: string | null;
  artifact_id: string | null;
  receipt_id: string;
  trace: TraceEvent[];
  fetches: number;
}

interface Bound {
  spec_digest: string;
  harness_digest: string;
  model_digest: string;
  policy_digest: string;
  context_digest: string;
}

function event(input: RunInput, step: TraceStep, ok: boolean, detail: string): TraceEvent {
  return {
    step, task_id: input.task_id, run_id: input.run_id, attempt_id: input.attempt_id,
    lease_epoch: input.lease_epoch, intent_revision: input.intent_revision, ok, detail,
  };
}

async function cancelGeneration(db: Database, taskId: string): Promise<number> {
  const row = await db.prepare('SELECT generation FROM execution_cancels WHERE task_id=?').bind(taskId).first<{ generation: number }>();
  return row?.generation ?? 0;
}

async function save(db: Database, input: RunInput, bound: Bound, state: string, failure: string | null, trace: TraceEvent[], ids: {
  generation_id: string | null; reservation_id: string | null; artifact_id: string | null; receipt_id: string | null;
}): Promise<void> {
  await db.prepare(`INSERT INTO execution_runs (
      run_id, attempt_id, project, task_id, principal_id, spec_digest, lease_epoch, intent_revision, cancel_generation,
      harness_digest, model_digest, policy_digest, context_digest, state, failure, generation_id, reservation_id,
      artifact_id, receipt_id, trace_json, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(run_id) DO UPDATE SET
      state=excluded.state, failure=excluded.failure, generation_id=excluded.generation_id,
      reservation_id=excluded.reservation_id, artifact_id=excluded.artifact_id, receipt_id=excluded.receipt_id,
      trace_json=excluded.trace_json`).bind(
    input.run_id, input.attempt_id, input.project, input.task_id, input.principal, bound.spec_digest,
    input.lease_epoch, input.intent_revision, input.cancel_generation, bound.harness_digest, bound.model_digest,
    bound.policy_digest, bound.context_digest, state, failure, ids.generation_id, ids.reservation_id,
    ids.artifact_id, ids.receipt_id, JSON.stringify(trace), Date.now(),
  ).all();
}

async function receipt(db: Database, input: RunInput, disposition: RunReport['disposition'], detail: string, ids: {
  generation_id: string | null; artifact_id: string | null;
}): Promise<string> {
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO execution_receipts (
      receipt_id, run_id, attempt_id, verifier, author_principal, task_id, lease_epoch, intent_revision,
      generation_id, artifact_id, disposition, detail, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    receiptId, input.run_id, input.attempt_id, VERIFIER, input.principal, input.task_id, input.lease_epoch,
    input.intent_revision, ids.generation_id, ids.artifact_id, disposition, detail, Date.now(),
  ).all();
  return receiptId;
}

async function releaseOpen(db: Database, reservationId: string, reason: string): Promise<void> {
  await db.prepare(`UPDATE budget_reservations SET state='closed_no_charge', pending_reason=?
    WHERE reservation_id=? AND state='open'`).bind(reason, reservationId).all();
}

async function replayed(db: Database, input: RunInput): Promise<RunReport | null> {
  const row = await db.prepare(`SELECT run_id, attempt_id, state, failure, generation_id, reservation_id, artifact_id, receipt_id, trace_json
    FROM execution_runs WHERE run_id=?`).bind(input.run_id).first<{
    run_id: string; attempt_id: string; state: string; failure: string | null;
    generation_id: string | null; reservation_id: string | null; artifact_id: string | null;
    receipt_id: string | null; trace_json: string;
  }>();
  if (!row) return null;
  const terminal = row.generation_id !== null || row.state === 'settled' || row.state === 'unknown'
    || row.state === 'canceled' || row.state === 'rejected';
  if (!terminal) return null;
  if (row.attempt_id !== input.attempt_id) {
    return {
      state: 'rejected', failure: 'run_id_conflict', disposition: 'FAIL',
      generation_id: row.generation_id, reservation_id: row.reservation_id, artifact_id: row.artifact_id,
      receipt_id: row.receipt_id ?? '', trace: [], fetches: 0,
    };
  }
  let disposition: RunReport['disposition'] = 'FAIL';
  if (row.receipt_id) {
    const stored = await db.prepare('SELECT disposition FROM execution_receipts WHERE receipt_id=?')
      .bind(row.receipt_id).first<{ disposition: RunReport['disposition'] }>();
    if (stored?.disposition) disposition = stored.disposition;
  } else if (row.state === 'settled') disposition = 'PASS';
  else if (row.state === 'unknown') disposition = 'UNKNOWN';
  else if (row.state === 'canceled') disposition = 'CANCELED';
  let trace: TraceEvent[] = [];
  try { trace = JSON.parse(row.trace_json) as TraceEvent[]; } catch { /* keep empty */ }
  return {
    state: row.state, failure: row.failure, disposition,
    generation_id: row.generation_id, reservation_id: row.reservation_id, artifact_id: row.artifact_id,
    receipt_id: row.receipt_id ?? '', trace, fetches: 0,
  };
}

export async function superviseRun(db: Database, input: RunInput): Promise<RunReport> {
  const prior = await replayed(db, input);
  if (prior) return prior;
  let fetches = 0;
  const fetchImpl: FetchLike = async (target, init) => {
    fetches += 1;
    return input.fetch(target, init);
  };
  const roster = loadRoster();
  const bound: Bound = {
    spec_digest: '',
    harness_digest: await sha256('g1-supervisor-v1'),
    model_digest: await sha256(`${input.model}|${input.max_tokens}`),
    policy_digest: await sha256('workroom.write+can_post'),
    context_digest: await sha256(input.prompt),
  };
  const trace: TraceEvent[] = [];
  const ids = { generation_id: null as string | null, reservation_id: null as string | null, artifact_id: null as string | null, receipt_id: null as string | null };
  const task = await db.prepare(`SELECT t.spec_json, t.state, l.holder_id, l.lease_epoch, l.expires_at_ms
    FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE t.id=?`).bind(input.task_id).first<{
    spec_json: string; state: string; holder_id: string | null; lease_epoch: number; expires_at_ms: number;
  }>();
  const head = await db.prepare('SELECT MAX(version) AS version FROM intent_versions').first<{ version: number | null }>();
  const intent = head?.version ?? 0;
  if (!task) {
    bound.spec_digest = await sha256('missing-task');
    trace.push(event(input, 'claim', false, 'task_missing'));
    const receiptId = await receipt(db, input, 'FAIL', 'task_missing', ids);
    await save(db, input, bound, 'rejected', 'task_missing', trace, { ...ids, receipt_id: receiptId });
    return { state: 'rejected', failure: 'task_missing', disposition: 'FAIL', ...ids, receipt_id: receiptId, trace, fetches };
  }
  bound.spec_digest = await sha256(task.spec_json);
  const epochOk = task.state === 'in_progress' && task.holder_id === input.principal
    && task.lease_epoch === input.lease_epoch && task.expires_at_ms > Date.now();
  trace.push(event(input, 'claim', epochOk, epochOk ? 'held' : 'stale_epoch'));
  await save(db, input, bound, epochOk ? 'claimed' : 'rejected', epochOk ? null : 'stale_epoch', trace, ids);
  if (!epochOk || intent !== input.intent_revision) {
    const failure = epochOk ? 'stale_intent' : 'stale_epoch';
    const receiptId = await receipt(db, input, 'FAIL', failure, ids);
    await save(db, input, bound, 'rejected', failure, trace, { ...ids, receipt_id: receiptId });
    return { state: 'rejected', failure, disposition: 'FAIL', ...ids, receipt_id: receiptId, trace, fetches };
  }
  await input.after?.('claim');
  const ledger = openD1Ledger(db, input.principal, input.cap_micro_usd);
  const estimate = estimateMicroUsd(input.model, input.prompt.length, input.max_tokens, roster);
  const hold = reservationMicroUsd(estimate);
  const row = roster.models.find(item => item.id === input.model);
  const reserved = await ledger.reserve({
    project: input.project, run_id: input.run_id, attempt_id: input.attempt_id, model: input.model,
    est_micro_usd: hold,
    pricing_snapshot: {
      model: input.model, snapshot_utc: roster.snapshot_utc, source: roster.source,
      price_usd_per_token: row?.price_usd_per_token ?? { prompt: '0', completion: '0' },
      prompt_chars: input.prompt.length, prompt_tokens_est: Math.ceil(input.prompt.length / 3) + 16,
      max_tokens: input.max_tokens, estimate_micro_usd: estimate, reserved_micro_usd: hold,
    },
  });
  if (!reserved.ok) {
    trace.push(event(input, 'reserve', false, 'cap_overflow'));
    const receiptId = await receipt(db, input, 'FAIL', `cap_overflow remaining=${reserved.remaining}`, ids);
    await save(db, input, bound, 'rejected', 'cap_overflow', trace, { ...ids, receipt_id: receiptId });
    return { state: 'rejected', failure: 'cap_overflow', disposition: 'FAIL', ...ids, receipt_id: receiptId, trace, fetches };
  }
  ids.reservation_id = reserved.reservation_id;
  trace.push(event(input, 'reserve', true, `hold=${hold}`));
  await save(db, input, bound, 'reserved', null, trace, ids);
  await input.after?.('reserve');
  if (await cancelGeneration(db, input.task_id) !== input.cancel_generation) {
    await releaseOpen(db, reserved.reservation_id, 'canceled_before_send');
    trace.push(event(input, 'model', false, 'cancel_mid_run'));
    const receiptId = await receipt(db, input, 'CANCELED', 'cancel_before_send', ids);
    await save(db, input, bound, 'canceled', 'cancel_mid_run', trace, { ...ids, receipt_id: receiptId });
    return { state: 'canceled', failure: 'cancel_mid_run', disposition: 'CANCELED', ...ids, receipt_id: receiptId, trace, fetches };
  }
  let text = '';
  try {
    const chat = await chatOnce({
      model: input.model, prompt: input.prompt, maxTokens: input.max_tokens, timeoutMs: LIVE_CHAT_TIMEOUT_MS,
      fetchImpl, apiKey: input.api_key,
    });
    ids.generation_id = chat.generation_id;
    text = chat.text;
    trace.push(event(input, 'model', true, chat.generation_id));
  } catch {
    await ledger.markPending(reserved.reservation_id, 'lost_response');
    trace.push(event(input, 'model', false, 'lost_response'));
    const receiptId = await receipt(db, input, 'UNKNOWN', 'lost_response', ids);
    await save(db, input, bound, 'unknown', 'lost_response', trace, { ...ids, receipt_id: receiptId });
    return { state: 'unknown', failure: 'lost_response', disposition: 'UNKNOWN', ...ids, receipt_id: receiptId, trace, fetches };
  }
  await save(db, input, bound, 'modeled', null, trace, ids);
  await input.after?.('model');
  const canceled = await cancelGeneration(db, input.task_id) !== input.cancel_generation;
  const cost = await getGenerationCost(ids.generation_id ?? '', {
    fetchImpl, apiKey: input.api_key,
      retries: LIVE_COST_RETRIES, delayMs: LIVE_COST_DELAY_MS, timeoutMs: LIVE_COST_TIMEOUT_MS,
      backoffFactor: LIVE_COST_BACKOFF, maxDelayMs: LIVE_COST_MAX_DELAY_MS,
  });
  const actual: SettleInput | null = cost ? {
    generation_id: ids.generation_id ?? '', micro_usd: cost.micro_usd, cost_field: cost.cost_field,
    provider_account: cost.provider_name, model: cost.model ?? input.model, tokens: cost.tokens,
  } : null;
  if (canceled) {
    if (actual) await ledger.settle(reserved.reservation_id, actual);
    else await ledger.markPending(reserved.reservation_id, 'cancel_cost_unknown', { generation_id: ids.generation_id ?? undefined, model: input.model });
    trace.push(event(input, 'tool', false, 'not_reached'));
    trace.push(event(input, 'artifact', false, 'not_reached'));
    trace.push(event(input, 'settlement', actual !== null, actual ? 'settled_after_cancel' : 'cost_unknown'));
    const receiptId = await receipt(db, input, 'CANCELED', 'cancel_mid_run', ids);
    trace.push(event(input, 'receipt', true, 'CANCELED'));
    await save(db, input, bound, 'canceled', 'cancel_mid_run', trace, { ...ids, receipt_id: receiptId });
    return { state: 'canceled', failure: 'cancel_mid_run', disposition: 'CANCELED', ...ids, receipt_id: receiptId, trace, fetches };
  }
  const tool = await sha256(text);
  trace.push(event(input, 'tool', true, tool));
  const artifactId = `art_${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO messages(id, room_id, actor_id, text, format, created_at) VALUES (?,?,?,?,?,?)`).bind(
    artifactId, 'room_main', input.principal, tool, 'text', new Date().toISOString(),
  ).all();
  ids.artifact_id = artifactId;
  trace.push(event(input, 'artifact', true, artifactId));
  if (!actual) {
    await ledger.markPending(reserved.reservation_id, 'cost_unknown', { generation_id: ids.generation_id ?? undefined, model: input.model });
    trace.push(event(input, 'settlement', false, 'cost_unknown'));
    const receiptId = await receipt(db, input, 'UNKNOWN', 'cost_unknown', ids);
    trace.push(event(input, 'receipt', true, 'UNKNOWN'));
    await save(db, input, bound, 'unknown', 'cost_unknown', trace, { ...ids, receipt_id: receiptId });
    return { state: 'unknown', failure: 'cost_unknown', disposition: 'UNKNOWN', ...ids, receipt_id: receiptId, trace, fetches };
  }
  await ledger.settle(reserved.reservation_id, actual);
  trace.push(event(input, 'settlement', true, `micro=${actual.micro_usd}`));
  const receiptId = await receipt(db, input, 'PASS', 'ids_match', ids);
  trace.push(event(input, 'receipt', true, VERIFIER));
  await save(db, input, bound, 'settled', null, trace, { ...ids, receipt_id: receiptId });
  return { state: 'settled', failure: null, disposition: 'PASS', ...ids, receipt_id: receiptId, trace, fetches };
}

export async function settleAgain(db: Database, principal: string, cap: number, reservationId: string, actual: SettleInput): Promise<void> {
  await openD1Ledger(db, principal, cap).settle(reservationId, actual);
}
