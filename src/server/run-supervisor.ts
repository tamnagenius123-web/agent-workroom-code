// G1/G2 supervisor. It does not replace the task engine. It reads the existing
// task, lease, and intent rows, then drives the existing budget ledger and the
// one OpenRouter client. 0080 belongs to gate telegram_topics on the shared D1;
// 0081 stores execution_runs/receipts/cancels; 0082 stores execution_checkpoints/interrupts.
import { sha256 } from '../auth/crypto.ts';
import { z } from 'zod';
import {
  sendReservedChat, estimateMicroUsd, getGenerationCost, loadRoster, reservationMicroUsd, OpenRouterError,
  type ChatUsage, type FetchLike, type SettleInput,
} from '../or-harness/client.ts';
import type { Database } from './db.ts';
import { openD1Ledger } from './dispatch-wire.ts';
import { Fault } from './contracts.ts';
import { DB_NOW, Tasks } from './tasks.ts';
import {
  admitExecution, admitTool, ExecutionFenceLost, executionLive, fencedDatabase, releaseExecution,
  EXECUTION_LEASE_MS,
  executionNow,
  type ExecutionFence, type ExecutionLimits,
} from './execution-fence.ts';
import { getUnitLease, leaseLive, type UnitLease } from './unit-leases.ts';

export const VERIFIER = 'verifier:g1';
export const LIVE_MODEL = 'z-ai/glm-5.3-flash';
export const LIVE_MAX_TOKENS = 1024;
export const LIVE_MAX_PROMPT_CHARS = 120;
/** General execution envelope. The historical G1 live probe bound stays 120. */
export const EXECUTION_MAX_PROMPT_CHARS = 8000;
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
export type CheckpointStep = 'claimed' | 'reserved' | 'modeled' | 'tool' | 'artifact' | 'settled' | 'canceled' | 'unknown' | 'rejected';

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
  resume?: boolean;
  cost_retries?: number;
  cost_delay_ms?: number;
  after?: (step: TraceStep) => Promise<void> | void;
  /** Server policy; never accepted from the request body. */
  limits?: Partial<ExecutionLimits>;
}

interface ActiveRunInput extends RunInput { execution: ExecutionFence; raw_database: Database }

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

export interface InterruptInput {
  task_id: string;
  run_id?: string | null;
  principal: string;
  reason: string;
}

export interface InterruptReport {
  ok: boolean;
  failure: string | null;
  interrupt_id: string | null;
  task_id: string;
  run_id: string | null;
  cancel_generation: number;
  reason: string;
}

export interface HeartbeatInput {
  task_id: string;
  run_id: string;
  attempt_id: string;
  principal: string;
  lease_epoch: number;
  intent_revision: number;
  cancel_generation: number;
  execution_generation?: number;
}

export interface HeartbeatReport {
  alive: boolean;
  failure: string | null;
  task_id: string;
  run_id: string;
  attempt_id: string;
  cancel_generation: number;
  lease_epoch: number | null;
  intent_revision: number;
}

export interface RunStatusView {
  run_id: string;
  attempt_id: string;
  project: string;
  task_id: string;
  principal_id: string;
  lease_epoch: number;
  intent_revision: number;
  cancel_generation: number;
  state: string;
  failure: string | null;
  disposition: RunReport['disposition'];
  generation_id: string | null;
  reservation_id: string | null;
  artifact_id: string | null;
  receipt_id: string | null;
  checkpoint_step: string | null;
  resumed_count: number;
  last_heartbeat_at: number | null;
  reservation_state: string | null;
  actual_micro_usd: number | null;
  tokens: unknown;
  execution_generation: number | null;
  check_kind: 'execution_self_check';
}

interface Bound {
  spec_digest: string;
  harness_digest: string;
  model_digest: string;
  policy_digest: string;
  context_digest: string;
}

interface ExistingRunRow {
  run_id: string;
  attempt_id: string;
  project: string;
  task_id: string;
  principal_id: string;
  spec_digest: string;
  lease_epoch: number;
  intent_revision: number;
  cancel_generation: number;
  harness_digest: string;
  model_digest: string;
  policy_digest: string;
  context_digest: string;
  state: string;
  failure: string | null;
  generation_id: string | null;
  reservation_id: string | null;
  artifact_id: string | null;
  receipt_id: string | null;
  trace_json: string;
}

interface CheckpointRow {
  run_id: string;
  task_id: string;
  attempt_id: string;
  lease_epoch: number;
  intent_revision: number;
  cancel_generation: number;
  checkpoint_step: CheckpointStep;
  model_text: string | null;
  tool_digest: string | null;
  usage_json: string | null;
  resumed_count: number;
  last_heartbeat_at: number | null;
  updated_at: number;
}

interface ReservationRow {
  reservation_id: string;
  attempt_id: string;
  state: string;
  micro_usd: number;
  generation_id: string | null;
  principal_id: string;
  project: string;
  run_id: string;
}

interface TaskLeaseRow {
  spec_json: string;
  state: string;
  holder_id: string | null;
  lease_epoch: number;
  expires_at_ms: number;
  server_time_ms: number;
  authority_active: number;
  dependencies_ready: number;
  inputs_current: number;
  version: number;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` ${error.cause.message}` : '';
  return `${error.message}${cause}`;
}

function missingTable(error: unknown): boolean {
  return /no such table/i.test(errorText(error));
}

function event(input: RunInput, step: TraceStep, ok: boolean, detail: string): TraceEvent {
  return {
    step, task_id: input.task_id, run_id: input.run_id, attempt_id: input.attempt_id,
    lease_epoch: input.lease_epoch, intent_revision: input.intent_revision, ok, detail,
  };
}

function parseTrace(raw: string): TraceEvent[] {
  try {
    return z.array(z.object({
      step: z.enum(['claim', 'reserve', 'model', 'tool', 'artifact', 'settlement', 'receipt']),
      task_id: z.string(), run_id: z.string(), attempt_id: z.string(),
      lease_epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      intent_revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      ok: z.boolean(), detail: z.string(),
    })).parse(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function cancelGeneration(db: Database, taskId: string): Promise<number> {
  const row = await db.prepare('SELECT generation FROM execution_cancels WHERE task_id=?').bind(taskId).first<{ generation: number }>();
  return row?.generation ?? 0;
}

async function readTaskAndIntent(db: Database, taskId: string): Promise<{ task: TaskLeaseRow | null; intent: number }> {
  const task = await db.prepare(`SELECT t.spec_json, t.state, t.version, l.holder_id, l.lease_epoch, l.expires_at_ms,
      ${DB_NOW} AS server_time_ms,
      EXISTS (SELECT 1 FROM principals p JOIN memberships m ON m.principal_id=p.id
        JOIN principal_roles pr ON pr.principal_id=p.id AND pr.kind='agent'
        WHERE p.id=l.holder_id AND p.active=1 AND m.room_id=t.room_id AND m.active=1 AND m.can_post=1) AS authority_active,
      NOT EXISTS (SELECT 1 FROM json_each(json_extract(t.spec_json,'$.dependencies')) d
        LEFT JOIN tasks dep ON dep.id=d.value AND dep.room_id=t.room_id WHERE dep.id IS NULL OR dep.state<>'done') AS dependencies_ready,
      NOT EXISTS (SELECT 1 FROM json_each(json_extract(t.spec_json,'$.input_versions')) v
        WHERE COALESCE((SELECT max(h.version) FROM message_history h
          WHERE h.message_id=json_extract(v.value,'$.message_id') AND h.room_id=t.room_id),-1)<>json_extract(v.value,'$.revision')) AS inputs_current
    FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE t.id=? AND t.room_id='room_main'`).bind(taskId).first<TaskLeaseRow>();
  const head = await db.prepare('SELECT MAX(version) AS version FROM intent_versions').first<{ version: number | null }>();
  return { task: task ?? null, intent: head?.version ?? 0 };
}

/** Authority is rechecked inside the same D1 transaction as effects or finalization. */
function authorityPredicate(input: Pick<RunInput, 'task_id' | 'principal' | 'lease_epoch' | 'intent_revision' | 'cancel_generation'>): { sql: string; args: (string | number)[] } {
  return {
    sql: `EXISTS (SELECT 1 FROM tasks t JOIN task_leases l ON l.task_id=t.id
      JOIN principals p ON p.id=l.holder_id JOIN memberships m ON m.principal_id=p.id AND m.room_id=t.room_id
      JOIN principal_roles pr ON pr.principal_id=p.id AND pr.kind='agent'
      WHERE t.id=? AND t.room_id='room_main' AND t.state='in_progress'
        AND p.id=? AND p.active=1 AND m.active=1 AND m.can_post=1
        AND l.lease_epoch=? AND l.expires_at_ms>${DB_NOW}
        AND COALESCE((SELECT max(version) FROM intent_versions),0)=?
        AND COALESCE((SELECT generation FROM execution_cancels WHERE task_id=t.id),0)=?
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(t.spec_json,'$.dependencies')) d
          LEFT JOIN tasks dep ON dep.id=d.value AND dep.room_id=t.room_id WHERE dep.id IS NULL OR dep.state<>'done')
        AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(t.spec_json,'$.input_versions')) v
          WHERE COALESCE((SELECT max(h.version) FROM message_history h
            WHERE h.message_id=json_extract(v.value,'$.message_id') AND h.room_id=t.room_id),-1)<>json_extract(v.value,'$.revision')))`,
    args: [input.task_id, input.principal, input.lease_epoch, input.intent_revision, input.cancel_generation],
  };
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
      attempt_id=excluded.attempt_id, lease_epoch=excluded.lease_epoch,
      state=excluded.state, failure=excluded.failure, generation_id=excluded.generation_id,
      reservation_id=excluded.reservation_id, artifact_id=excluded.artifact_id, receipt_id=excluded.receipt_id,
      trace_json=excluded.trace_json`).bind(
    input.run_id, input.attempt_id, input.project, input.task_id, input.principal, bound.spec_digest,
    input.lease_epoch, input.intent_revision, input.cancel_generation, bound.harness_digest, bound.model_digest,
    bound.policy_digest, bound.context_digest, state, failure, ids.generation_id, ids.reservation_id,
    ids.artifact_id, ids.receipt_id, JSON.stringify(trace), Date.now(),
  ).all();
}

async function loadCheckpoint(db: Database, runId: string): Promise<{ present: boolean; row: CheckpointRow | null }> {
  try {
    const row = await db.prepare(`SELECT run_id, task_id, attempt_id, lease_epoch, intent_revision, cancel_generation,
        checkpoint_step, model_text, tool_digest, usage_json, resumed_count, last_heartbeat_at, updated_at
      FROM execution_checkpoints WHERE run_id=?`).bind(runId).first<CheckpointRow>();
    return { present: true, row: row ?? null };
  } catch (error) {
    if (missingTable(error)) return { present: false, row: null };
    throw error;
  }
}

async function saveCheckpoint(db: Database, input: RunInput, step: CheckpointStep, extra: {
  model_text?: string | null;
  tool_digest?: string | null;
  usage?: ChatUsage | null;
  resumed_delta?: number;
} = {}): Promise<void> {
  const now = Date.now();
  const usageJson = extra.usage ? JSON.stringify(extra.usage) : null;
  const resumedDelta = extra.resumed_delta ?? 0;
  try {
    await db.prepare(`INSERT INTO execution_checkpoints (
        run_id, task_id, attempt_id, lease_epoch, intent_revision, cancel_generation,
        checkpoint_step, model_text, tool_digest, usage_json, resumed_count, last_heartbeat_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET
        attempt_id=excluded.attempt_id,
        lease_epoch=excluded.lease_epoch,
        checkpoint_step=excluded.checkpoint_step,
        model_text=COALESCE(excluded.model_text, execution_checkpoints.model_text),
        tool_digest=COALESCE(excluded.tool_digest, execution_checkpoints.tool_digest),
        usage_json=COALESCE(excluded.usage_json, execution_checkpoints.usage_json),
        resumed_count=execution_checkpoints.resumed_count + ?,
        last_heartbeat_at=excluded.last_heartbeat_at,
        updated_at=excluded.updated_at`).bind(
      input.run_id, input.task_id, input.attempt_id, input.lease_epoch, input.intent_revision, input.cancel_generation,
      step, extra.model_text ?? null, extra.tool_digest ?? null, usageJson, resumedDelta, now, now,
      resumedDelta,
    ).all();
  } catch (error) {
    if (!missingTable(error)) throw error;
  }
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

async function releaseOpen(db: Database, input: RunInput, reservationId: string, reason: string): Promise<void> {
  await db.prepare(`UPDATE budget_reservations SET state='closed_no_charge', pending_reason=?
    WHERE reservation_id=? AND principal_id=? AND project=? AND run_id=? AND state='open' AND generation_id IS NULL`)
    .bind(reason, reservationId, input.principal, input.project, input.run_id).all();
}

async function storedDisposition(db: Database, row: Pick<ExistingRunRow, 'run_id' | 'state' | 'receipt_id'>): Promise<RunReport['disposition']> {
  if (row.receipt_id) {
    const stored = await db.prepare(`SELECT c.disposition FROM execution_receipts c
      JOIN execution_runs r ON r.run_id=c.run_id AND r.receipt_id=c.receipt_id
      WHERE r.run_id=? AND c.receipt_id=? AND c.verifier=? AND c.attempt_id=r.attempt_id
        AND c.author_principal=r.principal_id AND c.task_id=r.task_id
        AND c.lease_epoch=r.lease_epoch AND c.intent_revision=r.intent_revision
        AND c.generation_id IS r.generation_id AND c.artifact_id IS r.artifact_id`)
      .bind(row.run_id, row.receipt_id, VERIFIER).first<{ disposition: string }>();
    if (stored?.disposition === 'PASS') return row.state === 'settled' ? 'PASS' : 'UNKNOWN';
    if (stored?.disposition === 'FAIL' || stored?.disposition === 'UNKNOWN' || stored?.disposition === 'CANCELED') return stored.disposition;
  }
  if (row.state === 'canceled') return 'CANCELED';
  if (row.state === 'rejected') return 'FAIL';
  // A state label cannot substitute for missing or foreign receipt evidence.
  return 'UNKNOWN';
}

function reportFromRow(row: ExistingRunRow, disposition: RunReport['disposition']): RunReport {
  return {
    state: row.state,
    failure: row.failure,
    disposition,
    generation_id: row.generation_id,
    reservation_id: row.reservation_id,
    artifact_id: row.artifact_id,
    receipt_id: row.receipt_id ?? '',
    trace: parseTrace(row.trace_json),
    fetches: 0,
  };
}

function rejectedFromExisting(row: ExistingRunRow, failure: string): RunReport {
  return {
    state: 'rejected',
    failure,
    disposition: 'FAIL',
    generation_id: row.generation_id,
    reservation_id: row.reservation_id,
    artifact_id: row.artifact_id,
    receipt_id: row.receipt_id ?? '',
    trace: parseTrace(row.trace_json),
    fetches: 0,
  };
}

async function verifyEnvelopeMatch(row: ExistingRunRow, input: RunInput, bound: Bound, task: TaskLeaseRow | null): Promise<string | null> {
  if (row.principal_id !== input.principal) return 'principal_mismatch';
  if (row.task_id !== input.task_id) return 'task_mismatch';
  if (row.project !== input.project) return 'project_mismatch';
  if (!task) return 'task_missing';
  if (row.spec_digest !== bound.spec_digest) return 'spec_mismatch';
  if (row.harness_digest !== bound.harness_digest) return 'harness_mismatch';
  if (row.model_digest !== bound.model_digest) return 'model_mismatch';
  if (row.policy_digest !== bound.policy_digest) return 'policy_mismatch';
  if (row.context_digest !== bound.context_digest) return 'context_mismatch';
  return null;
}

async function runReservationByRunId(db: Database, input: RunInput): Promise<ReservationRow | null> {
  const row = await db.prepare(`SELECT reservation_id, attempt_id, state, micro_usd, generation_id,principal_id,project,run_id
    FROM budget_reservations WHERE run_id=? AND principal_id=? AND project=? ORDER BY created_at ASC LIMIT 1`)
    .bind(input.run_id, input.principal, input.project).first<ReservationRow>();
  return row ?? null;
}

async function reservationById(db: Database, reservationId: string): Promise<ReservationRow | null> {
  const row = await db.prepare(`SELECT reservation_id, attempt_id, state, micro_usd, generation_id,principal_id,project,run_id
    FROM budget_reservations WHERE reservation_id=?`).bind(reservationId).first<ReservationRow>();
  return row ?? null;
}

async function midRunAuthFailure(db: Database, input: Pick<RunInput, 'task_id' | 'principal' | 'lease_epoch' | 'intent_revision' | 'cancel_generation'>): Promise<string | null> {
  if (await cancelGeneration(db, input.task_id) !== input.cancel_generation) return 'cancel_mid_run';
  const { task, intent } = await readTaskAndIntent(db, input.task_id);
  if (!task || task.state === 'canceled') return 'cancel_mid_run';
  if (task.state !== 'in_progress' || task.holder_id !== input.principal || task.lease_epoch !== input.lease_epoch || task.expires_at_ms <= task.server_time_ms) {
    return 'stale_epoch_mid_run';
  }
  if (intent !== input.intent_revision) return 'stale_intent_mid_run';
  if (!task.authority_active) return 'authority_revoked_mid_run';
  if (!task.dependencies_ready) return 'dependency_not_ready';
  if (!task.inputs_current) return 'stale_input_mid_run';
  return null;
}

export async function superviseRun(db: Database, input: RunInput): Promise<RunReport> {
  if (!input.api_key || input.api_key.trim() !== input.api_key || /[\r\n\0]/.test(input.api_key)) {
    throw new Fault('DISPATCH_NOT_CONFIGURED', 'OpenRouter dispatch is not configured.', 503);
  }
  for (const value of [input.run_id, input.attempt_id, input.task_id, input.principal]) {
    if (!value || value.length > 128 || !value.isWellFormed() || value.includes('\0')) throw new Fault('INVALID_INPUT', 'Invalid execution identity.');
  }
  let admission;
  try { admission = await admitExecution(db, input); }
  catch (error) {
    if (/no such (table|column)|has no column/i.test(errorText(error))) {
      throw new Fault('NOT_AVAILABLE', 'Execution leases require migrations through 0084.', 503, 'not_applied');
    }
    throw error;
  }
  if (!admission.admitted) {
    return { state: 'busy', failure: `${admission.reason}:${admission.plane}`, disposition: 'UNKNOWN',
      generation_id: null, reservation_id: null, artifact_id: null, receipt_id: '', trace: [], fetches: 0 };
  }
  const fence = admission.fence;
  let transmitted = 0;
  const fetch: FetchLike = async (target, init) => { transmitted++; return input.fetch(target, init); };
  try {
    return await superviseOwnedRun(fencedDatabase(db, fence), { ...input, fetch, execution: fence, raw_database: db });
  } catch (error) {
    if (error instanceof ExecutionFenceLost) {
      return { state: 'unknown', failure: 'execution_fence_lost', disposition: 'UNKNOWN',
        generation_id: null, reservation_id: null, artifact_id: null, receipt_id: '', trace: [], fetches: transmitted };
    }
    throw error;
  } finally { await releaseExecution(db, fence); }
}

async function superviseOwnedRun(db: Database, input: ActiveRunInput): Promise<RunReport> {
  const existing = await db.prepare(`SELECT run_id, attempt_id, project, task_id, principal_id, spec_digest, lease_epoch,
      intent_revision, cancel_generation, harness_digest, model_digest, policy_digest, context_digest,
      state, failure, generation_id, reservation_id, artifact_id, receipt_id, trace_json
    FROM execution_runs WHERE run_id=?`).bind(input.run_id).first<ExistingRunRow>();

  const bound: Bound = {
    spec_digest: '',
    harness_digest: await sha256('g1-supervisor-v2-fenced'),
    model_digest: await sha256(`${input.model}|${input.max_tokens}`),
    policy_digest: await sha256('workroom.write+can_post'),
    context_digest: await sha256(input.prompt),
  };

  const { task, intent } = await readTaskAndIntent(db, input.task_id);
  bound.spec_digest = await sha256(task ? task.spec_json : 'missing-task');
  if (existing) {
    const mismatch = await verifyEnvelopeMatch(existing, input, bound, task);
    if (mismatch) return rejectedFromExisting(existing, mismatch);
  }

  if (existing && !input.resume) {
    const terminal = existing.generation_id !== null || existing.state === 'settled' || existing.state === 'unknown'
      || existing.state === 'canceled' || existing.state === 'rejected';
    if (!terminal) return rejectedFromExisting(existing, 'run_id_conflict');
    if (existing.attempt_id !== input.attempt_id) return rejectedFromExisting(existing, 'run_id_conflict');
    return reportFromRow(existing, await storedDisposition(db, existing));
  }

  if (!existing && input.resume) {
    return {
      state: 'rejected', failure: 'run_not_found', disposition: 'FAIL',
      generation_id: null, reservation_id: null, artifact_id: null, receipt_id: '', trace: [], fetches: 0,
    };
  }

  const attemptCollision = await db.prepare('SELECT run_id FROM execution_runs WHERE attempt_id=? AND run_id<>?')
    .bind(input.attempt_id, input.run_id).first<{ run_id: string }>();
  if (attemptCollision) {
    return {
      state: 'rejected', failure: 'attempt_id_conflict', disposition: 'FAIL',
      generation_id: existing?.generation_id ?? null, reservation_id: existing?.reservation_id ?? null,
      artifact_id: existing?.artifact_id ?? null, receipt_id: existing?.receipt_id ?? '',
      trace: existing ? parseTrace(existing.trace_json) : [], fetches: 0,
    };
  }

  let fetches = 0;
  const fetchImpl: FetchLike = async (target, init) => {
    fetches += 1;
    return input.fetch(target, init);
  };

  let trace: TraceEvent[] = [];
  let ids = {
    generation_id: null as string | null,
    reservation_id: null as string | null,
    artifact_id: null as string | null,
    receipt_id: null as string | null,
  };
  let checkpointText: string | null = null;
  let checkpointToolDigest: string | null = null;
  let resumeStep: 'start' | 'from_claim' | 'from_reserve' | 'from_model' | 'from_artifact' | 'reconcile_cost' = 'start';
  let existingReservation: ReservationRow | null = null;

  if (existing && input.resume) {
    if (existing.state === 'sending') {
      const sentReservation = existing.reservation_id ? await reservationById(db, existing.reservation_id) : null;
      const unknownIds = { generation_id: existing.generation_id ?? sentReservation?.generation_id ?? null, reservation_id: existing.reservation_id,
        artifact_id: existing.artifact_id, receipt_id: existing.receipt_id };
      if (existing.reservation_id && sentReservation?.state !== 'settled') await openD1Ledger(db, input.principal, input.cap_micro_usd)
        .markPending(existing.reservation_id, 'provider_start_unknown', { generation_id: unknownIds.generation_id ?? undefined });
      const recoveredTrace = parseTrace(existing.trace_json);
      recoveredTrace.push(event(input, 'model', false, 'provider_start_unknown'));
      const receiptId = await receipt(db, input, 'UNKNOWN', 'provider_start_unknown', unknownIds);
      await save(db, input, bound, 'unknown', 'provider_start_unknown', recoveredTrace, { ...unknownIds, receipt_id: receiptId });
      await saveCheckpoint(db, input, 'unknown', { resumed_delta: 1 });
      return { state: 'unknown', failure: 'provider_start_unknown', disposition: 'UNKNOWN', ...unknownIds,
        receipt_id: receiptId, trace: recoveredTrace, fetches: 0 };
    }
    if (existing.state === 'rejected') {
      return reportFromRow(existing, await storedDisposition(db, existing));
    }
    if (existing.state === 'canceled') {
      return reportFromRow(existing, await storedDisposition(db, existing));
    }
    if (existing.state === 'settled') {
      const envMismatch = await verifyEnvelopeMatch(existing, input, bound, task);
      if (envMismatch) return rejectedFromExisting(existing, envMismatch);
      if (input.lease_epoch < existing.lease_epoch) return rejectedFromExisting(existing, 'stale_epoch');
      return reportFromRow(existing, await storedDisposition(db, existing));
    }
    if (existing.state === 'unknown' && existing.generation_id === null) {
      return reportFromRow(existing, await storedDisposition(db, existing));
    }
    if (existing.state === 'unknown' && existing.artifact_id === null) {
      return reportFromRow(existing, await storedDisposition(db, existing));
    }

    const envMismatch = await verifyEnvelopeMatch(existing, input, bound, task);
    if (envMismatch) return rejectedFromExisting(existing, envMismatch);
    if (input.lease_epoch < existing.lease_epoch) return rejectedFromExisting(existing, 'stale_epoch');

    const currentCancel = await cancelGeneration(db, input.task_id);
    const canceledInDb = task?.state === 'canceled' || currentCancel !== existing.cancel_generation;
    const isCostUnknownReconcile = existing.state === 'unknown' && existing.generation_id !== null && existing.artifact_id !== null;

    if (canceledInDb && !isCostUnknownReconcile) {
      const canFinalizeCancel = task !== null && (
        task.state === 'canceled' ||
        (task.state === 'in_progress' && task.holder_id === input.principal && task.lease_epoch === input.lease_epoch && task.expires_at_ms > task.server_time_ms)
      );
      if (!canFinalizeCancel) return rejectedFromExisting(existing, 'stale_epoch');
      trace = parseTrace(existing.trace_json);
      ids = {
        generation_id: existing.generation_id,
        reservation_id: existing.reservation_id,
        artifact_id: existing.artifact_id,
        receipt_id: existing.receipt_id,
      };
      const ledger = openD1Ledger(db, input.principal, input.cap_micro_usd);
      const resRow = ids.reservation_id ? await reservationById(db, ids.reservation_id) : await runReservationByRunId(db, input);
      if (resRow) ids.reservation_id = resRow.reservation_id;
      if (ids.generation_id && ids.reservation_id) {
        let actual: SettleInput | null = null;
        if (resRow?.state !== 'settled') {
          const cost = await getGenerationCost(ids.generation_id, {
            fetchImpl, apiKey: input.api_key,
            retries: input.cost_retries ?? LIVE_COST_RETRIES, delayMs: input.cost_delay_ms ?? LIVE_COST_DELAY_MS, timeoutMs: LIVE_COST_TIMEOUT_MS,
            backoffFactor: LIVE_COST_BACKOFF, maxDelayMs: LIVE_COST_MAX_DELAY_MS,
          });
          actual = cost ? {
            generation_id: ids.generation_id, micro_usd: cost.micro_usd, cost_field: cost.cost_field,
            provider_account: cost.provider_name, model: cost.model ?? input.model, tokens: cost.tokens,
          } : null;
          if (actual) await ledger.settle(ids.reservation_id, actual);
          else await ledger.markPending(ids.reservation_id, 'cancel_cost_unknown', { generation_id: ids.generation_id });
        }
        trace.push(event(input, 'artifact', false, 'not_reached'));
        trace.push(event(input, 'settlement', actual !== null || resRow?.state === 'settled', actual ? 'settled_after_cancel' : resRow?.state === 'settled' ? 'settled' : 'cost_unknown'));
      } else {
        if (ids.reservation_id) await releaseOpen(db, input, ids.reservation_id, 'canceled_on_resume');
        trace.push(event(input, 'model', false, 'cancel_mid_run'));
      }
      const receiptId = await receipt(db, input, 'CANCELED', 'cancel_mid_run', ids);
      trace.push(event(input, 'receipt', true, 'CANCELED'));
      await save(db, input, bound, 'canceled', 'cancel_mid_run', trace, { ...ids, receipt_id: receiptId });
      await saveCheckpoint(db, input, 'canceled', { resumed_delta: 1 });
      return { state: 'canceled', failure: 'cancel_mid_run', disposition: 'CANCELED', ...ids, receipt_id: receiptId, trace, fetches };
    }

    const epochOk = task !== null && task.state === 'in_progress' && task.holder_id === input.principal
      && task.lease_epoch === input.lease_epoch && task.expires_at_ms > task.server_time_ms;
    if (!epochOk) return rejectedFromExisting(existing, 'stale_epoch');
    if (intent !== input.intent_revision || existing.intent_revision !== input.intent_revision) {
      return rejectedFromExisting(existing, 'stale_intent');
    }
    if (currentCancel !== input.cancel_generation || existing.cancel_generation !== input.cancel_generation) {
      return rejectedFromExisting(existing, 'stale_cancel_generation');
    }

    trace = parseTrace(existing.trace_json);
    ids = {
      generation_id: existing.generation_id,
      reservation_id: existing.reservation_id,
      artifact_id: existing.artifact_id,
      receipt_id: existing.receipt_id,
    };
    const cp = await loadCheckpoint(db, input.run_id);
    existingReservation = ids.reservation_id ? await reservationById(db, ids.reservation_id) : await runReservationByRunId(db, input);

    if (isCostUnknownReconcile) {
      const msg = await db.prepare('SELECT id FROM messages WHERE id=?').bind(ids.artifact_id).first<{ id: string }>();
      if (!msg || !ids.reservation_id || !existingReservation) {
        return { state: 'unknown', failure: 'ambiguous_checkpoint', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches: 0 };
      }
      resumeStep = 'reconcile_cost';
    } else if (existing.state === 'claimed') {
      if (existingReservation) {
        if (existingReservation.state !== 'open' || existingReservation.generation_id !== null) {
          return { state: 'unknown', failure: 'ambiguous_checkpoint', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches: 0 };
        }
        ids.reservation_id = existingReservation.reservation_id;
        resumeStep = 'from_reserve';
      } else {
        resumeStep = 'from_claim';
      }
    } else if (existing.state === 'reserved') {
      if (!ids.reservation_id || !existingReservation || existingReservation.reservation_id !== ids.reservation_id
        || existingReservation.state !== 'open' || existingReservation.generation_id !== null) {
        return { state: 'unknown', failure: 'ambiguous_checkpoint', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches: 0 };
      }
      resumeStep = 'from_reserve';
    } else if (existing.state === 'modeled' || existing.state === 'tool' || existing.state === 'artifact') {
      if (!ids.generation_id || !ids.reservation_id || !existingReservation) {
        return { state: 'unknown', failure: 'ambiguous_checkpoint', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches: 0 };
      }
      if (ids.artifact_id !== null) {
        const msg = await db.prepare('SELECT id FROM messages WHERE id=?').bind(ids.artifact_id).first<{ id: string }>();
        if (!msg) return { state: 'unknown', failure: 'ambiguous_checkpoint', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches: 0 };
        resumeStep = 'from_artifact';
      } else {
        if (!cp.present || !cp.row || cp.row.model_text === null) {
          return { state: 'unknown', failure: 'ambiguous_checkpoint', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches: 0 };
        }
        checkpointText = cp.row.model_text;
        checkpointToolDigest = cp.row.tool_digest;
        resumeStep = 'from_model';
      }
    } else {
      return { state: 'unknown', failure: 'ambiguous_checkpoint', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches: 0 };
    }

    trace.push(event(input, 'claim', true, `resumed_from=${existing.state}`));
    // A deliberate resume may advance the execution attempt and task epoch.
    // Bind the durable run before publishing a new checkpoint or receipt; the
    // billing reservation keeps its original attempt identity independently.
    await save(db, input, bound, existing.state, existing.failure, trace, ids);
  }

  if (resumeStep === 'start') {
    if (!task) {
      trace.push(event(input, 'claim', false, 'task_missing'));
      const receiptId = await receipt(db, input, 'FAIL', 'task_missing', ids);
      await save(db, input, bound, 'rejected', 'task_missing', trace, { ...ids, receipt_id: receiptId });
      await saveCheckpoint(db, input, 'rejected');
      return { state: 'rejected', failure: 'task_missing', disposition: 'FAIL', ...ids, receipt_id: receiptId, trace, fetches };
    }
    const epochOk = task.state === 'in_progress' && task.holder_id === input.principal
      && task.lease_epoch === input.lease_epoch && task.expires_at_ms > task.server_time_ms;
    trace.push(event(input, 'claim', epochOk, epochOk ? 'held' : 'stale_epoch'));
    await save(db, input, bound, epochOk ? 'claimed' : 'rejected', epochOk ? null : 'stale_epoch', trace, ids);
    await saveCheckpoint(db, input, epochOk ? 'claimed' : 'rejected');
    if (!epochOk || intent !== input.intent_revision || !task.authority_active || !task.dependencies_ready || !task.inputs_current) {
      const failure = !epochOk ? 'stale_epoch' : intent !== input.intent_revision ? 'stale_intent'
        : !task.authority_active ? 'authority_revoked' : !task.dependencies_ready ? 'dependency_not_ready' : 'stale_input';
      const receiptId = await receipt(db, input, 'FAIL', failure, ids);
      await save(db, input, bound, 'rejected', failure, trace, { ...ids, receipt_id: receiptId });
      await saveCheckpoint(db, input, 'rejected');
      return { state: 'rejected', failure, disposition: 'FAIL', ...ids, receipt_id: receiptId, trace, fetches };
    }
    await input.after?.('claim');
  }

  const ledger = openD1Ledger(db, input.principal, input.cap_micro_usd);

  if (resumeStep === 'start' || resumeStep === 'from_claim') {
    const priorRes = await runReservationByRunId(db, input);
    if (priorRes) {
      if (priorRes.state !== 'open' || priorRes.generation_id !== null) {
        return { state: 'unknown', failure: 'ambiguous_checkpoint', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches };
      }
      ids.reservation_id = priorRes.reservation_id;
      trace.push(event(input, 'reserve', true, `reused=${priorRes.reservation_id}`));
      await save(db, input, bound, 'reserved', null, trace, ids);
      await saveCheckpoint(db, input, 'reserved', { resumed_delta: input.resume ? 1 : 0 });
    } else {
      const roster = loadRoster();
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
        await saveCheckpoint(db, input, 'rejected');
        return { state: 'rejected', failure: 'cap_overflow', disposition: 'FAIL', ...ids, receipt_id: receiptId, trace, fetches };
      }
      ids.reservation_id = reserved.reservation_id;
      trace.push(event(input, 'reserve', true, `hold=${hold}`));
      await save(db, input, bound, 'reserved', null, trace, ids);
      await saveCheckpoint(db, input, 'reserved', { resumed_delta: input.resume ? 1 : 0 });
    }
    await input.after?.('reserve');
  } else if (resumeStep === 'from_reserve') {
    trace.push(event(input, 'reserve', true, `reused=${ids.reservation_id}`));
    await save(db, input, bound, 'reserved', null, trace, ids);
    await saveCheckpoint(db, input, 'reserved', { resumed_delta: 1 });
  }

  let text = checkpointText ?? '';

  if (resumeStep === 'start' || resumeStep === 'from_claim' || resumeStep === 'from_reserve') {
    const preSendFailure = await midRunAuthFailure(db, input);
    if (preSendFailure !== null) {
      if (ids.reservation_id) await releaseOpen(db, input, ids.reservation_id, 'canceled_before_send');
      const canceled = preSendFailure === 'cancel_mid_run';
      const disposition = canceled ? 'CANCELED' : 'FAIL';
      const state = canceled ? 'canceled' : 'rejected';
      trace.push(event(input, 'model', false, preSendFailure));
      const receiptId = await receipt(db, input, disposition, 'rejected_before_send', ids);
      await save(db, input, bound, state, preSendFailure, trace, { ...ids, receipt_id: receiptId });
      await saveCheckpoint(db, input, state);
      return { state, failure: preSendFailure, disposition, ...ids, receipt_id: receiptId, trace, fetches };
    }
    const authorization = authorityPredicate(input);
    const start = await db.batch<{ run_id: string }>([
      db.prepare(`UPDATE execution_runs SET state='sending', failure='provider_start_unknown'
        WHERE run_id=? AND attempt_id=? AND state='reserved' AND ${authorization.sql}
          AND EXISTS (SELECT 1 FROM budget_reservations WHERE reservation_id=? AND principal_id=? AND project=? AND run_id=? AND state='open' AND generation_id IS NULL)
        RETURNING run_id`).bind(input.run_id, input.attempt_id, ...authorization.args, ids.reservation_id, input.principal, input.project, input.run_id),
      db.prepare(`UPDATE budget_reservations SET state='unknown', pending_reason='provider_start_unknown'
        WHERE reservation_id=? AND principal_id=? AND project=? AND run_id=? AND state='open'
          AND EXISTS (SELECT 1 FROM execution_runs WHERE run_id=? AND state='sending' AND reservation_id=?)`)
        .bind(ids.reservation_id, input.principal, input.project, input.run_id, input.run_id, ids.reservation_id),
    ]);
    if (!start[0]?.results.length) {
      return { state: 'unknown', failure: 'provider_start_fenced', disposition: 'UNKNOWN', ...ids,
        receipt_id: ids.receipt_id ?? '', trace, fetches };
    }
    const heldReservation = await reservationById(db, ids.reservation_id ?? '');
    if (!heldReservation) throw new Error('provider reservation missing');
    try {
      const chat = await sendReservedChat({
        ledger, reservation: { reservation_id: heldReservation.reservation_id, project: input.project,
          run_id: input.run_id, attempt_id: heldReservation.attempt_id, model: input.model },
        model: input.model, prompt: input.prompt, maxTokens: input.max_tokens, timeoutMs: LIVE_CHAT_TIMEOUT_MS,
        fetchImpl, apiKey: input.api_key,
      });
      ids.generation_id = chat.generation_id;
      text = chat.text;
      // Persist known provider identity before advancing. UNKNOWN never means a
      // confirmed free call and its hold remains counted until actual readback.
      await ledger.markPending(heldReservation.reservation_id, 'generation_received', { generation_id: chat.generation_id });
      trace.push(event(input, 'model', true, chat.generation_id));
      await save(db, input, bound, 'modeled', null, trace, ids);
      await saveCheckpoint(db, input, 'modeled', { model_text: text, usage: chat.usage });
    } catch (error) {
      if (error instanceof ExecutionFenceLost || !await executionLive(input.raw_database, input.execution)) throw error;
      if (error instanceof OpenRouterError && error.generation_id) ids.generation_id = error.generation_id;
      if (ids.reservation_id) await ledger.markPending(ids.reservation_id, 'lost_response', { generation_id: ids.generation_id ?? undefined });
      trace.push(event(input, 'model', false, 'lost_response'));
      const receiptId = await receipt(db, input, 'UNKNOWN', 'lost_response', ids);
      await save(db, input, bound, 'unknown', 'lost_response', trace, { ...ids, receipt_id: receiptId });
      await saveCheckpoint(db, input, 'unknown');
      return { state: 'unknown', failure: 'lost_response', disposition: 'UNKNOWN', ...ids, receipt_id: receiptId, trace, fetches };
    }
    await input.after?.('model');
  }

  const reservationId = ids.reservation_id ?? '';
  let alreadySettled = existingReservation?.state === 'settled';
  if (!alreadySettled && resumeStep !== 'start' && resumeStep !== 'from_claim' && resumeStep !== 'from_reserve') {
    const refreshed = await reservationById(db, reservationId);
    alreadySettled = refreshed?.state === 'settled';
  }

  let actual: SettleInput | null = null;
  const authFailureAfterModel = resumeStep === 'reconcile_cost' ? null : await midRunAuthFailure(db, input);

  if (!alreadySettled) {
    const cost = await getGenerationCost(ids.generation_id ?? '', {
      fetchImpl, apiKey: input.api_key,
      retries: input.cost_retries ?? LIVE_COST_RETRIES, delayMs: input.cost_delay_ms ?? LIVE_COST_DELAY_MS, timeoutMs: LIVE_COST_TIMEOUT_MS,
      backoffFactor: LIVE_COST_BACKOFF, maxDelayMs: LIVE_COST_MAX_DELAY_MS,
    });
    actual = cost ? {
      generation_id: ids.generation_id ?? '', micro_usd: cost.micro_usd, cost_field: cost.cost_field,
      provider_account: cost.provider_name, model: cost.model ?? input.model, tokens: cost.tokens,
    } : null;
  }

  if (authFailureAfterModel === 'cancel_mid_run') {
    if (!alreadySettled) {
      if (actual) await ledger.settle(reservationId, actual);
      else await ledger.markPending(reservationId, 'cancel_cost_unknown', { generation_id: ids.generation_id ?? undefined });
    }
    trace.push(event(input, 'tool', false, 'not_reached'));
    trace.push(event(input, 'artifact', false, 'not_reached'));
    trace.push(event(input, 'settlement', actual !== null || alreadySettled, actual ? 'settled_after_cancel' : alreadySettled ? 'settled' : 'cost_unknown'));
    const receiptId = await receipt(db, input, 'CANCELED', 'cancel_mid_run', ids);
    trace.push(event(input, 'receipt', true, 'CANCELED'));
    await save(db, input, bound, 'canceled', 'cancel_mid_run', trace, { ...ids, receipt_id: receiptId });
    await saveCheckpoint(db, input, 'canceled', { resumed_delta: resumeStep === 'from_model' || resumeStep === 'from_artifact' ? 1 : 0 });
    return { state: 'canceled', failure: 'cancel_mid_run', disposition: 'CANCELED', ...ids, receipt_id: receiptId, trace, fetches };
  }

  if (authFailureAfterModel !== null) {
    if (!alreadySettled) {
      if (actual) await ledger.settle(reservationId, actual);
      else await ledger.markPending(reservationId, authFailureAfterModel, { generation_id: ids.generation_id ?? undefined });
    }
    trace.push(event(input, 'artifact', false, authFailureAfterModel));
    trace.push(event(input, 'settlement', actual !== null || alreadySettled, actual ? `micro=${actual.micro_usd}` : alreadySettled ? 'settled' : 'cost_unknown'));
    const receiptId = await receipt(db, input, 'FAIL', authFailureAfterModel, ids);
    trace.push(event(input, 'receipt', true, 'FAIL'));
    await save(db, input, bound, 'rejected', authFailureAfterModel, trace, { ...ids, receipt_id: receiptId });
    await saveCheckpoint(db, input, 'rejected', { resumed_delta: resumeStep === 'from_model' || resumeStep === 'from_artifact' ? 1 : 0 });
    return { state: 'rejected', failure: authFailureAfterModel, disposition: 'FAIL', ...ids, receipt_id: receiptId, trace, fetches };
  }

  if (resumeStep === 'start' || resumeStep === 'from_claim' || resumeStep === 'from_reserve' || resumeStep === 'from_model') {
    if (!await admitTool(input.raw_database, input.execution)) {
      return { state: 'modeled', failure: 'tool_capacity', disposition: 'UNKNOWN', ...ids,
        receipt_id: ids.receipt_id ?? '', trace, fetches };
    }
    const tool = await sha256(text);
    if (checkpointToolDigest !== null && checkpointToolDigest !== tool) {
      return { state: 'rejected', failure: 'checkpoint_mismatch', disposition: 'FAIL', ...ids, receipt_id: ids.receipt_id ?? '', trace, fetches };
    }
    trace.push(event(input, 'tool', true, tool));
    await save(db, input, bound, 'tool', null, trace, ids);
    await saveCheckpoint(db, input, 'tool', { tool_digest: tool, resumed_delta: resumeStep === 'from_model' ? 1 : 0 });
    await input.after?.('tool');

    const preArtifactFailure = await midRunAuthFailure(db, input);
    if (preArtifactFailure !== null) {
      if (!alreadySettled) {
        if (actual) await ledger.settle(reservationId, actual);
        else await ledger.markPending(reservationId, preArtifactFailure, { generation_id: ids.generation_id ?? undefined });
      }
      const isCancel = preArtifactFailure === 'cancel_mid_run';
      const disp: RunReport['disposition'] = isCancel ? 'CANCELED' : 'FAIL';
      const nextState = isCancel ? 'canceled' : 'rejected';
      trace.push(event(input, 'artifact', false, preArtifactFailure));
      trace.push(event(input, 'settlement', actual !== null || alreadySettled, actual ? `micro=${actual.micro_usd}` : alreadySettled ? 'settled' : 'cost_unknown'));
      const receiptId = await receipt(db, input, disp, preArtifactFailure, ids);
      trace.push(event(input, 'receipt', true, disp));
      await save(db, input, bound, nextState, preArtifactFailure, trace, { ...ids, receipt_id: receiptId });
      await saveCheckpoint(db, input, isCancel ? 'canceled' : 'rejected');
      return { state: nextState, failure: preArtifactFailure, disposition: disp, ...ids, receipt_id: receiptId, trace, fetches };
    }

    const artifactId = `art_${await sha256(`execution-artifact-v1:${input.run_id}`)}`;
    const authorization = authorityPredicate(input);
    const artifact = await db.batch<{ id: string; text: string }>([
      db.prepare(`INSERT INTO messages(id, room_id, actor_id, text, format, created_at)
        SELECT ?, 'room_main', ?, ?, 'text', ? WHERE ${authorization.sql}
        ON CONFLICT(id) DO NOTHING`).bind(artifactId, input.principal, text, new Date().toISOString(), ...authorization.args),
      db.prepare(`UPDATE execution_runs SET artifact_id=?, state='artifact'
        WHERE run_id=? AND ${authorization.sql}
          AND EXISTS (SELECT 1 FROM messages WHERE id=? AND actor_id=? AND text=?)`)
        .bind(artifactId, input.run_id, ...authorization.args, artifactId, input.principal, text),
      db.prepare(`SELECT m.id,m.text FROM messages m JOIN execution_runs r ON r.artifact_id=m.id
        WHERE r.run_id=? AND m.id=? AND m.actor_id=? AND m.text=?`).bind(input.run_id, artifactId, input.principal, text),
    ]);
    if (!artifact[2]?.results.length) {
      if (!alreadySettled && actual) await ledger.settle(reservationId, actual);
      return { state: 'rejected', failure: 'artifact_authority_changed', disposition: 'FAIL', ...ids,
        receipt_id: ids.receipt_id ?? '', trace, fetches };
    }
    ids.artifact_id = artifactId;
    trace.push(event(input, 'artifact', true, artifactId));
    await save(db, input, bound, 'artifact', null, trace, ids);
    await saveCheckpoint(db, input, 'artifact');
    await input.after?.('artifact');
  } else if (resumeStep === 'from_artifact') {
    trace.push(event(input, 'artifact', true, `reused=${ids.artifact_id}`));
    await saveCheckpoint(db, input, 'artifact', { resumed_delta: 1 });
  } else if (resumeStep === 'reconcile_cost') {
    await saveCheckpoint(db, input, 'artifact', { resumed_delta: 1 });
  }

  if (!alreadySettled && !actual) {
    await ledger.markPending(reservationId, 'cost_unknown', { generation_id: ids.generation_id ?? undefined });
    trace.push(event(input, 'settlement', false, 'cost_unknown'));
    if (resumeStep === 'reconcile_cost' && ids.receipt_id) {
      await save(db, input, bound, 'unknown', 'cost_unknown', trace, ids);
      await saveCheckpoint(db, input, 'unknown');
      return { state: 'unknown', failure: 'cost_unknown', disposition: 'UNKNOWN', ...ids, receipt_id: ids.receipt_id, trace, fetches };
    }
    const receiptId = await receipt(db, input, 'UNKNOWN', 'cost_unknown', ids);
    trace.push(event(input, 'receipt', true, 'UNKNOWN'));
    await save(db, input, bound, 'unknown', 'cost_unknown', trace, { ...ids, receipt_id: receiptId });
    await saveCheckpoint(db, input, 'unknown');
    return { state: 'unknown', failure: 'cost_unknown', disposition: 'UNKNOWN', ...ids, receipt_id: receiptId, trace, fetches };
  }

  if (resumeStep === 'reconcile_cost' && actual) {
    const settlement = await settleAgain(db, input.principal, input.cap_micro_usd, reservationId, actual);
    const updated = await db.prepare('SELECT receipt_id, trace_json, state, failure FROM execution_runs WHERE run_id=?')
      .bind(input.run_id).first<{ receipt_id: string | null; trace_json: string; state: string; failure: string | null }>();
    const finalReceiptId = updated?.receipt_id ?? ids.receipt_id ?? '';
    return {
      state: updated?.state ?? settlement.state ?? 'unknown',
      failure: updated?.failure ?? null,
      disposition: settlement.disposition ?? 'UNKNOWN',
      ...ids,
      receipt_id: finalReceiptId,
      trace: updated ? parseTrace(updated.trace_json) : trace,
      fetches,
    };
  }

  if (!alreadySettled && actual) {
    await ledger.settle(reservationId, actual);
    trace.push(event(input, 'settlement', true, `micro=${actual.micro_usd}`));
  } else {
    trace.push(event(input, 'settlement', true, 'already_settled'));
  }
  const receiptId = `rcpt_${crypto.randomUUID()}`;
  trace.push(event(input, 'receipt', true, VERIFIER));
  const authorization = authorityPredicate(input);
  const finished = await db.batch<{ receipt_id: string }>([
    db.prepare(`INSERT INTO execution_receipts(receipt_id,run_id,attempt_id,verifier,author_principal,
        task_id,lease_epoch,intent_revision,generation_id,artifact_id,disposition,detail,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,'PASS','execution_check:ids_match',? WHERE ${authorization.sql}
        AND EXISTS (SELECT 1 FROM execution_runs WHERE run_id=? AND artifact_id=?)
        AND EXISTS (SELECT 1 FROM budget_reservations WHERE reservation_id=? AND state='settled')
      RETURNING receipt_id`).bind(receiptId, input.run_id, input.attempt_id, VERIFIER, input.principal,
      input.task_id, input.lease_epoch, input.intent_revision, ids.generation_id, ids.artifact_id, Date.now(),
      ...authorization.args, input.run_id, ids.artifact_id, ids.reservation_id),
    db.prepare(`UPDATE execution_runs SET state='settled',failure=NULL,receipt_id=?,trace_json=?
      WHERE run_id=? AND EXISTS (SELECT 1 FROM execution_receipts WHERE receipt_id=?)`)
      .bind(receiptId, JSON.stringify(trace), input.run_id, receiptId),
  ]);
  if (!finished[0]?.results.length) {
    const failure = await midRunAuthFailure(db, input) ?? 'completion_authority_changed';
    const disposition = failure === 'cancel_mid_run' ? 'CANCELED' : 'FAIL';
    const state = disposition === 'CANCELED' ? 'canceled' : 'rejected';
    trace.pop();
    const rejectedReceipt = await receipt(db, input, disposition, failure, ids);
    await save(db, input, bound, state, failure, trace, { ...ids, receipt_id: rejectedReceipt });
    await saveCheckpoint(db, input, state);
    return { state, failure, disposition, ...ids, receipt_id: rejectedReceipt, trace, fetches };
  }
  await saveCheckpoint(db, input, 'settled');
  return { state: 'settled', failure: null, disposition: 'PASS', ...ids, receipt_id: receiptId, trace, fetches };
}

export async function resumeRun(db: Database, input: Omit<RunInput, 'resume'>): Promise<RunReport> {
  return superviseRun(db, { ...input, resume: true });
}

export async function interruptRun(db: Database, input: InterruptInput): Promise<InterruptReport> {
  const task = await db.prepare(`SELECT id FROM tasks WHERE id=? AND room_id='room_main'`)
    .bind(input.task_id).first<{ id: string }>();
  if (!task) {
    return {
      ok: false, failure: 'task_missing', interrupt_id: null,
      task_id: input.task_id, run_id: input.run_id ?? null, cancel_generation: 0, reason: input.reason,
    };
  }
  const authority = `EXISTS (SELECT 1 FROM tasks t JOIN principals p ON p.id=?
    JOIN memberships m ON m.principal_id=p.id AND m.room_id=t.room_id
    WHERE t.id=? AND t.room_id='room_main' AND p.active=1 AND m.active=1 AND m.can_post=1
      AND (t.creator_id=p.id OR EXISTS (SELECT 1 FROM principal_roles r WHERE r.principal_id=p.id AND r.kind='user')))`;
  const authorityArgs = [input.principal, input.task_id];
  if (!await db.prepare(`SELECT 1 WHERE ${authority}`).bind(...authorityArgs).first()) {
    return { ok: false, failure: 'forbidden', interrupt_id: null, task_id: input.task_id,
      run_id: input.run_id ?? null, cancel_generation: await cancelGeneration(db, input.task_id), reason: input.reason };
  }
  if (input.run_id) {
    const run = await db.prepare('SELECT run_id, task_id FROM execution_runs WHERE run_id=?')
      .bind(input.run_id).first<{ run_id: string; task_id: string }>();
    if (!run) {
      return {
        ok: false, failure: 'run_not_found', interrupt_id: null,
        task_id: input.task_id, run_id: input.run_id, cancel_generation: 0, reason: input.reason,
      };
    }
    if (run.task_id !== input.task_id) {
      return {
        ok: false, failure: 'task_mismatch', interrupt_id: null,
        task_id: input.task_id, run_id: input.run_id, cancel_generation: 0, reason: input.reason,
      };
    }
  }
  const interruptId = `int_${crypto.randomUUID()}`;
  const batch = await db.batch<{ generation: number }>([
    db.prepare(`INSERT INTO execution_cancels(task_id, generation) SELECT ?,1 WHERE ${authority}
      ON CONFLICT(task_id) DO UPDATE SET generation = execution_cancels.generation + 1
      WHERE execution_cancels.generation<9007199254740991 AND ${authority}
      RETURNING generation`).bind(input.task_id, ...authorityArgs, ...authorityArgs),
    db.prepare(`INSERT INTO execution_interrupts (
        interrupt_id, task_id, run_id, actor_principal, cancel_generation, reason, created_at
      ) SELECT ?,?,?,?,generation,?,? FROM execution_cancels WHERE task_id=? AND changes()>0`).bind(
      interruptId, input.task_id, input.run_id ?? null, input.principal, input.reason, Date.now(), input.task_id),
  ]);
  const nextGen = batch[0]?.results[0]?.generation;
  if (nextGen === undefined) return { ok: false, failure: 'forbidden', interrupt_id: null,
    task_id: input.task_id, run_id: input.run_id ?? null, cancel_generation: await cancelGeneration(db, input.task_id), reason: input.reason };
  return {
    ok: true, failure: null, interrupt_id: interruptId,
    task_id: input.task_id, run_id: input.run_id ?? null, cancel_generation: nextGen, reason: input.reason,
  };
}

export async function heartbeatRun(db: Database, input: HeartbeatInput): Promise<HeartbeatReport> {
  const row = await db.prepare(`SELECT run_id, attempt_id, task_id, principal_id, lease_epoch, intent_revision, cancel_generation, state
    FROM execution_runs WHERE run_id=?`).bind(input.run_id).first<{
    run_id: string; attempt_id: string; task_id: string; principal_id: string;
    lease_epoch: number; intent_revision: number; cancel_generation: number; state: string;
  }>();
  const { task, intent } = await readTaskAndIntent(db, input.task_id);
  const currentCancel = await cancelGeneration(db, input.task_id);
  const fail = (failure: string): HeartbeatReport => ({
    alive: false, failure, task_id: input.task_id, run_id: input.run_id, attempt_id: input.attempt_id,
    cancel_generation: currentCancel, lease_epoch: task?.lease_epoch ?? null, intent_revision: intent,
  });
  if (!row) return fail('run_not_found');
  if (row.task_id !== input.task_id) return fail('task_mismatch');
  if (row.principal_id !== input.principal) return fail('principal_mismatch');
  if (row.attempt_id !== input.attempt_id) return fail('attempt_mismatch');
  if (['settled', 'canceled', 'rejected', 'unknown'].includes(row.state)) return fail(`terminal_${row.state}`);
  if (currentCancel !== input.cancel_generation || currentCancel !== row.cancel_generation) return fail('cancel_bumped');
  if (!task || task.state !== 'in_progress' || task.holder_id !== input.principal
    || task.lease_epoch !== input.lease_epoch || input.lease_epoch !== row.lease_epoch || task.expires_at_ms <= task.server_time_ms) {
    return fail('stale_epoch');
  }
  if (intent !== input.intent_revision || intent !== row.intent_revision) return fail('stale_intent');
  if (!task.authority_active) return fail('authority_revoked');
  if (!task.dependencies_ready) return fail('dependency_not_ready');
  if (!task.inputs_current) return fail('stale_input');
  const runUnit = `execution/run/${encodeURIComponent(input.run_id)}`;
  const activeLease = await getUnitLease(db, runUnit);
  const active = leaseLive(activeLease, await executionNow(db));
  let heartbeatDb = db;
  let resources: UnitLease[] = [];
  if (active && activeLease) {
    if (input.execution_generation !== activeLease.generation) return fail('execution_generation_mismatch');
    resources = (await db.prepare("SELECT unit_id,holder,lease_until,heartbeat_at,state,generation FROM unit_leases WHERE holder=? AND state='held'")
      .bind(activeLease.holder).all<UnitLease>()).results;
    heartbeatDb = fencedDatabase(db, { holder: activeLease.holder, leases: resources,
      limits: { logical_agents: 1, processes: 1, model_calls: 1, tools: 1 } });
  } else if (input.execution_generation !== undefined) return fail('execution_not_active');
  // Use the existing task engine for renewal so its version, authorization,
  // operation replay and task audit remain the sole task authority.
  const tasks = new Tasks(heartbeatDb, input.principal, async (room = 'room_main', write = false) => {
    const allowed = await heartbeatDb.prepare(`SELECT 1 FROM principals p JOIN memberships m ON m.principal_id=p.id
      WHERE p.id=? AND p.active=1 AND m.room_id=? AND m.active=1 AND (?=0 OR m.can_post=1)`)
      .bind(input.principal, room, write ? 1 : 0).first();
    if (!allowed) throw new Fault('FORBIDDEN', 'Room access denied.', 403);
  });
  try {
    await tasks.action('renew', { schema_version: '1', room: 'room_main', task_id: input.task_id,
      expected_version: task.version, lease_epoch: input.lease_epoch, idempotency_key: `heartbeat-${crypto.randomUUID()}` });
  } catch (error) {
    if (error instanceof Fault || error instanceof ExecutionFenceLost) return fail('lease_renewal_conflict');
    throw error;
  }
  const auth = authorityPredicate(input);
  await heartbeatDb.batch([
    ...resources.map(resource => heartbeatDb.prepare(`UPDATE unit_leases SET heartbeat_at=${DB_NOW},lease_until=${DB_NOW}+?
      WHERE unit_id=? AND holder=? AND generation=? AND state='held' AND lease_until>${DB_NOW} AND ${auth.sql}`)
      .bind(EXECUTION_LEASE_MS, resource.unit_id, resource.holder, resource.generation, ...auth.args)),
    heartbeatDb.prepare(`UPDATE execution_checkpoints SET last_heartbeat_at=${DB_NOW},updated_at=${DB_NOW}
      WHERE run_id=? AND attempt_id=? AND ${auth.sql}`).bind(input.run_id, input.attempt_id, ...auth.args),
  ]);
  const drift = await midRunAuthFailure(db, input);
  if (drift) return fail(drift);
  return {
    alive: true, failure: null, task_id: input.task_id, run_id: input.run_id, attempt_id: input.attempt_id,
    cancel_generation: currentCancel, lease_epoch: input.lease_epoch, intent_revision: intent,
  };
}

export async function getRunStatus(db: Database, runId: string): Promise<RunStatusView | null> {
  const row = await db.prepare(`SELECT run_id, attempt_id, project, task_id, principal_id, lease_epoch, intent_revision,
      cancel_generation, state, failure, generation_id, reservation_id, artifact_id, receipt_id, trace_json
    FROM execution_runs WHERE run_id=?`).bind(runId).first<ExistingRunRow>();
  if (!row) return null;
  const disposition = await storedDisposition(db, row);
  const cp = await loadCheckpoint(db, runId);
  const res = row.reservation_id ? await reservationById(db, row.reservation_id) : null;
  const actual = row.reservation_id
    ? await db.prepare('SELECT micro_usd, tokens_json FROM budget_actuals WHERE reservation_id=?')
        .bind(row.reservation_id).first<{ micro_usd: number; tokens_json: string }>()
    : null;
  let tokens: unknown = null;
  if (actual?.tokens_json) {
    try { tokens = JSON.parse(actual.tokens_json); } catch { tokens = null; }
  }
  const currentLease = await getUnitLease(db, `execution/run/${encodeURIComponent(runId)}`);
  const active = leaseLive(currentLease, await executionNow(db));
  return {
    run_id: row.run_id,
    attempt_id: row.attempt_id,
    project: row.project,
    task_id: row.task_id,
    principal_id: row.principal_id,
    lease_epoch: row.lease_epoch,
    intent_revision: row.intent_revision,
    cancel_generation: row.cancel_generation,
    state: row.state,
    failure: row.failure,
    disposition,
    generation_id: row.generation_id,
    reservation_id: row.reservation_id,
    artifact_id: row.artifact_id,
    receipt_id: row.receipt_id,
    checkpoint_step: cp.row?.checkpoint_step ?? null,
    resumed_count: cp.row?.resumed_count ?? 0,
    last_heartbeat_at: cp.row?.last_heartbeat_at ?? null,
    reservation_state: res?.state ?? null,
    actual_micro_usd: actual?.micro_usd ?? null,
    tokens,
    execution_generation: active ? currentLease!.generation : null,
    check_kind: 'execution_self_check',
  };
}

export async function settleAgain(
  db: Database,
  principal: string,
  cap: number,
  reservationId: string,
  actual: SettleInput,
): Promise<{ updated_run: boolean; state: string | null; disposition: RunReport['disposition'] | null }> {
  await openD1Ledger(db, principal, cap).settle(reservationId, actual);
  const run = await db.prepare(`SELECT run_id, attempt_id, task_id, principal_id, lease_epoch, intent_revision,
      cancel_generation, state, failure, generation_id, artifact_id, receipt_id, trace_json
    FROM execution_runs WHERE reservation_id=? AND principal_id=?`).bind(reservationId, principal).first<{
    run_id: string; attempt_id: string; task_id: string; principal_id: string; lease_epoch: number; intent_revision: number;
    cancel_generation: number; state: string; failure: string | null; generation_id: string | null;
    artifact_id: string | null; receipt_id: string | null; trace_json: string;
  }>();
  if (!run) return { updated_run: false, state: null, disposition: null };
  if (run.state !== 'unknown' && run.state !== 'sending') {
    return { updated_run: false, state: run.state, disposition: await storedDisposition(db, run) };
  }
  const receiptId = `rcpt_late_${await sha256(JSON.stringify([run.run_id, actual.generation_id, actual.provider_account]))}`;
  if (run.receipt_id === receiptId) return { updated_run: false, state: run.state, disposition: await storedDisposition(db, run) };
  const auth = authorityPredicate({ task_id: run.task_id, principal, lease_epoch: run.lease_epoch,
    intent_revision: run.intent_revision, cancel_generation: run.cancel_generation });
  const artifact = `EXISTS (SELECT 1 FROM messages m JOIN execution_checkpoints cp ON cp.run_id=r.run_id
    JOIN message_current mc ON mc.id=m.id
    WHERE m.id=r.artifact_id AND m.actor_id=r.principal_id AND m.text=cp.model_text AND mc.version=1)`;
  const canceled = `EXISTS (SELECT 1 FROM tasks WHERE id=r.task_id AND state='canceled')
    OR COALESCE((SELECT generation FROM execution_cancels WHERE task_id=r.task_id),0)<>r.cancel_generation`;
  const trace = parseTrace(run.trace_json);
  trace.push({ step: 'settlement', task_id: run.task_id, run_id: run.run_id, attempt_id: run.attempt_id,
    lease_epoch: run.lease_epoch, intent_revision: run.intent_revision, ok: true,
    detail: `late_cost_micro=${actual.micro_usd};previous_receipt=${run.receipt_id ?? ''}` });
  // Old UNKNOWN/FAIL receipts are immutable evidence. A reconciliation appends a
  // receipt and advances the current pointer in the same transaction. Cost may
  // settle after cancellation, but it cannot revive canceled or stale execution.
  await db.batch([
    db.prepare(`INSERT INTO execution_receipts(receipt_id,run_id,attempt_id,verifier,author_principal,
        task_id,lease_epoch,intent_revision,generation_id,artifact_id,disposition,detail,created_at)
      SELECT ?,r.run_id,r.attempt_id,?,r.principal_id,r.task_id,r.lease_epoch,r.intent_revision,?,r.artifact_id,
        CASE WHEN ${canceled} THEN 'CANCELED' WHEN r.state='unknown' AND ${auth.sql} AND ${artifact} THEN 'PASS' ELSE 'UNKNOWN' END,
        CASE WHEN r.artifact_id IS NULL THEN 'reconciled_no_artifact' ELSE 'execution_check:late_cost_settled' END,${DB_NOW}
      FROM execution_runs r WHERE r.run_id=? AND r.state IN ('unknown','sending')
      ON CONFLICT(receipt_id) DO NOTHING`).bind(receiptId, VERIFIER, actual.generation_id, ...auth.args, run.run_id),
    db.prepare(`UPDATE execution_runs SET
        state=CASE (SELECT disposition FROM execution_receipts WHERE receipt_id=?) WHEN 'PASS' THEN 'settled' WHEN 'CANCELED' THEN 'canceled' ELSE 'unknown' END,
        failure=CASE (SELECT disposition FROM execution_receipts WHERE receipt_id=?) WHEN 'PASS' THEN NULL WHEN 'CANCELED' THEN 'cancel_mid_run' ELSE CASE WHEN artifact_id IS NULL THEN 'reconciled_no_artifact' ELSE 'stale_result_after_settlement' END END,
        generation_id=COALESCE(generation_id,?),receipt_id=?,trace_json=?
      WHERE run_id=? AND state IN ('unknown','sending') AND EXISTS (SELECT 1 FROM execution_receipts WHERE receipt_id=?)`)
      .bind(receiptId, receiptId, actual.generation_id, receiptId, JSON.stringify(trace), run.run_id, receiptId),
    db.prepare(`UPDATE execution_checkpoints SET checkpoint_step=(SELECT state FROM execution_runs WHERE run_id=?),updated_at=${DB_NOW}
      WHERE run_id=? AND EXISTS (SELECT 1 FROM execution_runs WHERE run_id=? AND receipt_id=?)`)
      .bind(run.run_id, run.run_id, run.run_id, receiptId),
  ]);
  const final = await db.prepare('SELECT run_id,state,receipt_id FROM execution_runs WHERE run_id=?').bind(run.run_id)
    .first<{ run_id: string; state: string; receipt_id: string | null }>();
  return { updated_run: final?.receipt_id === receiptId, state: final?.state ?? null,
    disposition: final ? await storedDisposition(db, final) : null };
}
