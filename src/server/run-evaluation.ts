// G5 evaluation admission over the existing task, run, artifact and receipt stores.
// This verifies binding/completeness and records an authenticated non-author's
// evidence. It does not execute arbitrary commands or prove a natural-language
// done condition. Execution self-checks in execution_receipts are not consumed
// here as independent evaluations. No provider call, task approval or promotion.
import { z } from 'zod';
import { sha256 as storedSha256 } from '../auth/crypto.ts';
import { Fault, keySchema } from './contracts.ts';
import type { Database, Value } from './db.ts';
import type { Workroom } from './domain.ts';

const VERSION = 'execution-evaluation-v1';
/** New evaluation wire digests use lowercase SHA-256 hex, explicitly distinct
 * from the existing supervisor's base64url spec/checkpoint digests. */
export async function hashEvaluationEvidence(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
const id = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const terminal = z.enum(['PASS', 'FAIL', 'NOT_RUN', 'UNKNOWN', 'ABORTED', 'SKIPPED']);
const caseSchema = z.object({
  case_id: id,
  status: terminal,
  evidence: z.string().max(8192),
  evidence_sha256: digest,
}).strict();
const shardSchema = z.object({
  condition_id: id,
  command: z.string().trim().min(1).max(512),
  exit_code: z.number().int().min(-255).max(255).nullable(),
  cases: z.array(caseSchema).max(100),
}).strict();
export const runEvaluationSchema = z.object({
  schema_version: z.literal('1'),
  manifest_id: id,
  manifest_digest: digest,
  shards: z.array(shardSchema).max(20),
}).strict();
export type RunEvaluationInput = z.infer<typeof runEvaluationSchema>;

interface Snapshot {
  run_id: string; attempt_id: string; project: string; task_id: string;
  principal_id: string; spec_digest: string; lease_epoch: number; intent_revision: number;
  cancel_generation: number; harness_digest: string; model_digest: string; policy_digest: string;
  context_digest: string; state: string; generation_id: string | null; reservation_id: string | null;
  artifact_id: string | null; spec_json: string; task_state: string; current_epoch: number | null;
  current_intent: number; current_cancel: number; stale_inputs: number;
  artifact_actor: string | null; artifact_text: string | null; artifact_version: number | null;
  model_text: string | null; tool_digest: string | null;
  reservation_state: string | null; reservation_generation: string | null; reserved_micro_usd: number | null;
  billing_attempt_id: string | null;
  actual_generation: string | null; actual_account: string | null; actual_micro_usd: number | null;
  actual_count: number; settlement_matches: number | null;
}

const SNAPSHOT_FROM = `FROM execution_runs r
  JOIN tasks t ON t.id=r.task_id AND t.room_id=?
  LEFT JOIN task_leases l ON l.task_id=t.id
  LEFT JOIN message_current m ON m.id=r.artifact_id AND m.room_id=t.room_id
  LEFT JOIN execution_checkpoints c ON c.run_id=r.run_id
  LEFT JOIN budget_reservations b ON b.reservation_id=r.reservation_id
  LEFT JOIN budget_actuals a ON a.reservation_id=b.reservation_id
  WHERE r.run_id=?`;
const CURRENT_INTENT = 'COALESCE((SELECT MAX(version) FROM intent_versions),0)';
const CURRENT_CANCEL = 'COALESCE((SELECT generation FROM execution_cancels WHERE task_id=r.task_id),0)';
const STALE_INPUTS = `EXISTS (SELECT 1 FROM json_each(t.spec_json,'$.input_versions') i
  LEFT JOIN message_current source ON source.id=json_extract(i.value,'$.message_id')
  WHERE source.id IS NULL OR source.room_id<>t.room_id OR source.version<>json_extract(i.value,'$.revision'))`;

async function snapshot(db: Database, room: string, runId: string): Promise<Snapshot> {
  const row = await db.prepare(`SELECT r.run_id,r.attempt_id,r.project,r.task_id,r.principal_id,r.spec_digest,
      r.lease_epoch,r.intent_revision,r.cancel_generation,r.harness_digest,r.model_digest,r.policy_digest,
      r.context_digest,r.state,r.generation_id,r.reservation_id,r.artifact_id,
      t.spec_json,t.state AS task_state,l.lease_epoch AS current_epoch,
      ${CURRENT_INTENT} AS current_intent,${CURRENT_CANCEL} AS current_cancel,${STALE_INPUTS} AS stale_inputs,
      m.actor_id AS artifact_actor,m.text AS artifact_text,m.version AS artifact_version,
      c.model_text,c.tool_digest,b.state AS reservation_state,b.generation_id AS reservation_generation,b.micro_usd AS reserved_micro_usd,
      b.attempt_id AS billing_attempt_id,
      a.generation_id AS actual_generation,a.provider_account AS actual_account,a.micro_usd AS actual_micro_usd,
      (SELECT COUNT(*) FROM budget_actuals counted WHERE counted.reservation_id=b.reservation_id) AS actual_count,
      (a.provider='openrouter' AND a.provider_account=b.provider_account AND a.model=b.model
        AND a.project=b.project
        AND b.principal_id=r.principal_id AND b.run_id=r.run_id
        AND b.project=r.project) AS settlement_matches
    ${SNAPSHOT_FROM}`).bind(room, runId).first<Snapshot>();
  if (!row) throw new Fault('NOT_FOUND', 'Execution run not found in this room.', 404);
  return row;
}

export interface EvaluationManifest {
  version: typeof VERSION;
  room: string; run_id: string; attempt_id: string; task_id: string; project: string;
  author_principal: string; reviewer_principal: string;
  spec_digest: string; lease_epoch: number; intent_revision: number; cancel_generation: number;
  harness_digest: string; model_digest: string; policy_digest: string; context_digest: string;
  generation_id: string | null; reservation_id: string | null; billing_attempt_id: string | null;
  artifact_id: string | null; artifact_version: number | null; artifact_digest: string | null;
  reserved_micro_usd: number | null; actual_micro_usd: number | null; actual_exceeds_reserved_hold: boolean;
  expected_shards: { condition_id: string; condition: string }[];
}

function canonical(value: unknown): string {
  function sort(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === 'object') return Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, item]) => [k, sort(item)]),
    );
    return v;
  }
  return JSON.stringify(sort(value));
}

async function describe(row: Snapshot, room: string, reviewer: string) {
  const reasons: string[] = [];
  if (reviewer === row.principal_id) reasons.push('reviewer_is_author');
  if (row.state !== 'settled') reasons.push('run_not_settled');
  if (!['in_progress', 'review', 'done'].includes(row.task_state)) reasons.push('task_not_reviewable');
  if (row.current_epoch !== row.lease_epoch) reasons.push('stale_lease_epoch');
  if (row.current_intent !== row.intent_revision) reasons.push('stale_intent');
  if (row.current_cancel !== row.cancel_generation) reasons.push('canceled');
  if (row.stale_inputs) reasons.push('stale_task_inputs');
  const specDigest = await storedSha256(row.spec_json);
  if (specDigest !== row.spec_digest) reasons.push('spec_digest_mismatch');
  let conditions: unknown;
  try { conditions = z.object({ done_conditions: z.unknown().optional() }).passthrough().parse(JSON.parse(row.spec_json)).done_conditions; }
  catch { reasons.push('invalid_task_spec'); }
  const validConditions = Array.isArray(conditions) && conditions.length > 0 && conditions.length <= 20
    && conditions.every((condition): condition is string => typeof condition === 'string' && condition.trim().length > 0);
  if (!validConditions) reasons.push('missing_done_conditions');
  const expected = validConditions ? await Promise.all((conditions as string[]).map(async (condition, index) => ({
    condition_id: `condition_${index}_${await hashEvaluationEvidence(condition)}`,
    condition,
  }))) : [];
  const artifactDigest = row.artifact_text === null ? null : await hashEvaluationEvidence(row.artifact_text);
  const storedArtifactDigest = row.artifact_text === null ? null : await storedSha256(row.artifact_text);
  if (!row.artifact_id || row.artifact_text === null || row.artifact_version === null) reasons.push('artifact_missing');
  if (row.artifact_actor !== row.principal_id) reasons.push('artifact_author_mismatch');
  if (row.artifact_text === null || row.model_text !== row.artifact_text || row.tool_digest !== storedArtifactDigest) {
    reasons.push('artifact_output_mismatch');
  }
  if (!row.generation_id || row.reservation_state !== 'settled'
    || row.reservation_generation !== row.generation_id || row.actual_generation !== row.generation_id
    || row.actual_count !== 1 || row.settlement_matches !== 1
    || !Number.isSafeInteger(row.reserved_micro_usd) || (row.reserved_micro_usd ?? -1) < 0
    || !Number.isSafeInteger(row.actual_micro_usd) || (row.actual_micro_usd ?? -1) < 0) reasons.push('settlement_unbound');
  const manifest: EvaluationManifest = {
    version: VERSION, room, run_id: row.run_id, attempt_id: row.attempt_id, task_id: row.task_id, project: row.project,
    author_principal: row.principal_id, reviewer_principal: reviewer,
    spec_digest: specDigest, lease_epoch: row.lease_epoch, intent_revision: row.intent_revision,
    cancel_generation: row.cancel_generation, harness_digest: row.harness_digest, model_digest: row.model_digest,
    policy_digest: row.policy_digest, context_digest: row.context_digest,
    generation_id: row.generation_id, reservation_id: row.reservation_id, billing_attempt_id: row.billing_attempt_id,
    artifact_id: row.artifact_id, artifact_version: row.artifact_version, artifact_digest: artifactDigest,
    reserved_micro_usd: row.reserved_micro_usd, actual_micro_usd: row.actual_micro_usd,
    actual_exceeds_reserved_hold: row.actual_micro_usd !== null && row.reserved_micro_usd !== null
      && row.actual_micro_usd > row.reserved_micro_usd,
    expected_shards: expected,
  };
  return { manifest, manifest_digest: await hashEvaluationEvidence(canonical(manifest)), reasons };
}

// Compare the exact bytes used to construct the manifest at the write's
// linearization point. The pre-read authorizes inspection; this predicate
// rejects cancellation, revision, lease, membership or artifact drift before
// persistence. There is no second task/approval authority here.
function unchanged(row: Snapshot, room: string, reviewer: string): { sql: string; args: Value[] } {
  return {
    sql: `EXISTS (SELECT 1 ${SNAPSHOT_FROM}
      AND r.attempt_id=? AND r.project=? AND r.principal_id=? AND r.spec_digest=?
      AND r.lease_epoch=? AND r.intent_revision=? AND r.cancel_generation=?
      AND r.harness_digest=? AND r.model_digest=? AND r.policy_digest=? AND r.context_digest=?
      AND r.state=? AND r.generation_id IS ? AND r.reservation_id IS ? AND r.artifact_id IS ?
      AND t.spec_json=? AND t.state=? AND l.lease_epoch IS ?
      AND ${CURRENT_INTENT}=? AND ${CURRENT_CANCEL}=? AND ${STALE_INPUTS}=?
      AND m.actor_id IS ? AND m.text IS ? AND m.version IS ? AND c.model_text IS ? AND c.tool_digest IS ?
      AND b.state IS ? AND b.generation_id IS ? AND b.micro_usd IS ? AND b.attempt_id IS ? AND a.generation_id IS ?
      AND a.provider_account IS ? AND a.micro_usd IS ?
      AND (SELECT COUNT(*) FROM budget_actuals counted WHERE counted.reservation_id=b.reservation_id)=?
      AND (a.provider='openrouter' AND a.provider_account=b.provider_account AND a.model=b.model
        AND a.project=b.project
        AND b.principal_id=r.principal_id AND b.run_id=r.run_id
        AND b.project=r.project) IS ?)
      AND EXISTS (SELECT 1 FROM memberships mb JOIN principals p ON p.id=mb.principal_id
        JOIN principal_roles pr ON pr.principal_id=p.id
        WHERE mb.room_id=? AND p.id=? AND mb.active=1 AND mb.can_post=1 AND p.active=1
          AND pr.kind IN ('agent','user'))`,
    args: [room, row.run_id, row.attempt_id, row.project, row.principal_id, row.spec_digest,
      row.lease_epoch, row.intent_revision, row.cancel_generation, row.harness_digest, row.model_digest,
      row.policy_digest, row.context_digest, row.state, row.generation_id, row.reservation_id, row.artifact_id,
      row.spec_json, row.task_state, row.current_epoch, row.current_intent, row.current_cancel, row.stale_inputs,
      row.artifact_actor, row.artifact_text, row.artifact_version, row.model_text, row.tool_digest,
      row.reservation_state, row.reservation_generation, row.reserved_micro_usd, row.billing_attempt_id, row.actual_generation, row.actual_account, row.actual_micro_usd,
      row.actual_count, row.settlement_matches,
      room, reviewer],
  };
}

interface Stored {
  id: string; room_id: string; principal_id: string; disposition: string; observation_json: string; result_json: string; recorded_at: number;
}
interface StoredManifest {
  kind: 'execution_evaluation_manifest';
  manifest: EvaluationManifest; manifest_digest: string;
  disposition: 'HOLD'; reasons: string[];
}
interface EvaluationResult {
  kind: 'execution_evaluation'; version: typeof VERSION;
  manifest_id: string; manifest_digest: string; manifest: EvaluationManifest;
  proof_mode: 'authenticated_reviewer_evidence';
  disposition: 'PASS' | 'HOLD'; reasons: string[]; recorded_failure: boolean;
  case_count: number; shards: RunEvaluationInput['shards'];
  task_approved: false; live_proof: false;
}

const safeInt = z.number().int().nonnegative().refine(Number.isSafeInteger);
const storedDigest = z.string().min(1).max(128);
const manifestSchema: z.ZodType<EvaluationManifest> = z.object({
  version: z.literal(VERSION), room: id, run_id: id, attempt_id: id, task_id: id, project: id,
  author_principal: id, reviewer_principal: id, spec_digest: storedDigest,
  lease_epoch: safeInt, intent_revision: safeInt, cancel_generation: safeInt,
  harness_digest: storedDigest, model_digest: storedDigest, policy_digest: storedDigest, context_digest: storedDigest,
  generation_id: id.nullable(), reservation_id: id.nullable(), billing_attempt_id: id.nullable(),
  artifact_id: id.nullable(), artifact_version: safeInt.nullable(), artifact_digest: digest.nullable(),
  reserved_micro_usd: safeInt.nullable(), actual_micro_usd: safeInt.nullable(), actual_exceeds_reserved_hold: z.boolean(),
  expected_shards: z.array(z.object({ condition_id: id, condition: z.string().min(1) }).strict()).max(20),
}).strict();
const storedManifestSchema: z.ZodType<StoredManifest> = z.object({
  kind: z.literal('execution_evaluation_manifest'), manifest: manifestSchema, manifest_digest: digest,
  disposition: z.literal('HOLD'), reasons: z.array(z.string()),
}).strict();
const evaluationResultSchema: z.ZodType<EvaluationResult> = z.object({
  kind: z.literal('execution_evaluation'), version: z.literal(VERSION), manifest_id: id,
  manifest_digest: digest, manifest: manifestSchema, proof_mode: z.literal('authenticated_reviewer_evidence'),
  disposition: z.enum(['PASS', 'HOLD']), reasons: z.array(z.string()), recorded_failure: z.boolean(),
  case_count: safeInt, shards: z.array(shardSchema).max(20), task_approved: z.literal(false), live_proof: z.literal(false),
}).strict().refine(result => result.case_count === result.shards.reduce((n, shard) => n + shard.cases.length, 0), 'Stored census differs from cases')
  .refine(result => result.recorded_failure === result.shards.some(shard => (shard.exit_code !== null && shard.exit_code !== 0)
    || shard.cases.some(item => item.status === 'FAIL' || item.status === 'ABORTED')), 'Stored failure flag differs from evidence')
  .refine(result => result.disposition !== 'PASS' || (result.reasons.length === 0 && result.case_count > 0
    && result.manifest.expected_shards.length > 0 && !result.recorded_failure
    && result.shards.every(shard => shard.exit_code === 0 && shard.cases.length > 0 && shard.cases.every(item => item.status === 'PASS'))),
  'Stored PASS is incomplete');

async function readStored<T extends StoredManifest | EvaluationResult>(row: Stored, schema: z.ZodType<T>): Promise<T> {
  const corrupt = () => new Fault('CORRUPT_EVIDENCE', 'Stored evaluation evidence failed validation; no acceptance is available.', 500);
  let result: T;
  try { result = schema.parse(JSON.parse(row.result_json)); } catch { throw corrupt(); }
  if (result.manifest.room !== row.room_id || result.manifest.reviewer_principal !== row.principal_id
    || result.manifest.author_principal === result.manifest.reviewer_principal || result.disposition !== row.disposition
    || result.manifest_digest !== await hashEvaluationEvidence(canonical(result.manifest))) throw corrupt();
  if (result.kind === 'execution_evaluation' && result.disposition === 'PASS') {
    const expected = new Set(result.manifest.expected_shards.map(shard => shard.condition_id));
    const seen = new Set(result.shards.map(shard => shard.condition_id));
    const cases = result.shards.flatMap(shard => shard.cases);
    if (expected.size !== result.manifest.expected_shards.length || seen.size !== result.shards.length
      || seen.size !== expected.size || [...expected].some(key => !seen.has(key))
      || new Set(cases.map(item => item.case_id)).size !== cases.length) throw corrupt();
    for (const item of cases) if (!item.evidence.trim() || item.evidence.includes('\0')
      || await hashEvaluationEvidence(item.evidence) !== item.evidence_sha256) throw corrupt();
  }
  return result;
}

async function prior(db: Database, principal: string, key: string): Promise<Stored | null> {
  return db.prepare('SELECT id,room_id,principal_id,disposition,observation_json,result_json,recorded_at FROM verifier_receipts WHERE principal_id=? AND idempotency_key=?')
    .bind(principal, key).first<Stored>();
}
function conflict(): never {
  throw new Fault('IDEMPOTENCY_CONFLICT', 'Evaluation key already has different content.', 409);
}
async function presented<T extends StoredManifest | EvaluationResult>(row: Stored, replayed: boolean, schema: z.ZodType<T>) {
  return { data: { id: row.id, recorded_at: row.recorded_at, result: await readStored(row, schema) }, meta: { replayed } };
}
async function persist(
  service: Workroom, room: string, key: string, requestJson: string,
  result: StoredManifest | EvaluationResult, observed: Snapshot,
): Promise<Stored> {
  const guard = unchanged(observed, room, service.principal);
  if (result.kind === 'execution_evaluation' && result.disposition === 'PASS') {
    guard.sql += ` AND NOT EXISTS (SELECT 1 FROM verifier_receipts
      WHERE room_id=? AND json_extract(result_json,'$.kind')='execution_evaluation'
        AND json_extract(result_json,'$.manifest.run_id')=? AND json_extract(result_json,'$.recorded_failure')=1)`;
    guard.args.push(room, result.manifest.run_id);
  }
  const receiptId = `eval_${crypto.randomUUID()}`;
  // 0029 is the existing durable verifier receipt store. Its principal/key
  // uniqueness resolves competing retries; a different payload cannot replay.
  await service.database.prepare(`INSERT INTO verifier_receipts
      (id,room_id,principal_id,disposition,observation_json,result_json,idempotency_key,recorded_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql}
    ON CONFLICT(principal_id,idempotency_key) DO NOTHING`)
    .bind(receiptId, room, service.principal, result.disposition, requestJson, JSON.stringify(result), key, Date.now(), ...guard.args).all();
  const stored = await prior(service.database, service.principal, key);
  if (!stored) throw new Fault('VERSION_CONFLICT', 'Execution or authority changed before evaluation was stored.', 409);
  if (stored.room_id !== room || stored.observation_json !== requestJson) conflict();
  return stored;
}

/** Freeze host-derived expectations before accepting any reviewer results. */
export async function freezeRunEvaluation(service: Workroom, room: string, runId: string, key: string) {
  await authorizeReviewer(service, room);
  keySchema.parse(key);
  const requestJson = canonical({ kind: 'execution_evaluation_manifest', room, run_id: runId });
  const stored = await prior(service.database, service.principal, key);
  if (stored) {
    if (stored.room_id !== room || stored.observation_json !== requestJson) conflict();
    return presented(stored, true, storedManifestSchema);
  }
  const observed = await snapshot(service.database, room, runId);
  if (observed.principal_id === service.principal) throw new Fault('FORBIDDEN', 'The run author cannot independently evaluate that run.', 403);
  const view = await describe(observed, room, service.principal);
  const result: StoredManifest = {
    kind: 'execution_evaluation_manifest', manifest: view.manifest, manifest_digest: view.manifest_digest,
    disposition: 'HOLD', reasons: view.reasons.length ? view.reasons : ['evaluation_not_submitted'],
  };
  return presented(await persist(service, room, key, requestJson, result, observed), false, storedManifestSchema);
}

export async function submitRunEvaluation(service: Workroom, room: string, runId: string, key: string, raw: unknown) {
  await authorizeReviewer(service, room);
  keySchema.parse(key);
  const input = runEvaluationSchema.parse(raw);
  const requestJson = canonical({ kind: 'execution_evaluation', room, run_id: runId, ...input });
  const stored = await prior(service.database, service.principal, key);
  if (stored) {
    if (stored.room_id !== room || stored.observation_json !== requestJson) conflict();
    return presentEvaluation(service, room, runId, stored, true);
  }
  const frozen = await service.database.prepare('SELECT id,room_id,principal_id,disposition,observation_json,result_json,recorded_at FROM verifier_receipts WHERE id=? AND room_id=? AND principal_id=?')
    .bind(input.manifest_id, room, service.principal).first<Stored>();
  if (!frozen) throw new Fault('NOT_FOUND', 'Frozen evaluation manifest not found for this reviewer.', 404);
  const record = await readStored(frozen, storedManifestSchema);
  if (record.kind !== 'execution_evaluation_manifest' || record.manifest.run_id !== runId
    || record.manifest_digest !== input.manifest_digest
    || await hashEvaluationEvidence(canonical(record.manifest)) !== input.manifest_digest) {
    throw new Fault('INVALID_INPUT', 'Evaluation manifest binding does not match.');
  }
  const observed = await snapshot(service.database, room, runId);
  if (observed.principal_id === service.principal) throw new Fault('FORBIDDEN', 'The run author cannot independently evaluate that run.', 403);
  const current = await describe(observed, room, service.principal);
  const reasons = [...current.reasons];
  if (current.manifest_digest !== record.manifest_digest) reasons.push('manifest_stale');
  const expected = new Set(record.manifest.expected_shards.map(shard => shard.condition_id));
  const seen = new Set<string>(), cases = new Set<string>();
  let caseCount = 0, recordedFailure = false;
  if (!expected.size) reasons.push('empty_expected_shards');
  for (const shard of input.shards) {
    if (!expected.has(shard.condition_id)) reasons.push('unexpected_shard');
    if (seen.has(shard.condition_id)) reasons.push('duplicate_shard');
    seen.add(shard.condition_id);
    if (shard.exit_code !== 0) reasons.push('shard_not_passed');
    if (shard.exit_code !== null && shard.exit_code !== 0) recordedFailure = true;
    if (!shard.cases.length) reasons.push('zero_test_shard');
    for (const item of shard.cases) {
      caseCount += 1;
      if (cases.has(item.case_id)) reasons.push('duplicate_case');
      cases.add(item.case_id);
      if (item.status !== 'PASS') reasons.push(`case_${item.status.toLowerCase()}`);
      if (item.status === 'FAIL' || item.status === 'ABORTED') recordedFailure = true;
      if (!item.evidence.trim() || item.evidence.includes('\0') || await hashEvaluationEvidence(item.evidence) !== item.evidence_sha256) {
        reasons.push('evidence_invalid');
      }
    }
  }
  if ([...expected].some(condition => !seen.has(condition))) reasons.push('missing_shard');
  const failure = await service.database.prepare(`SELECT 1 FROM verifier_receipts
    WHERE room_id=? AND json_extract(result_json,'$.kind')='execution_evaluation'
      AND json_extract(result_json,'$.manifest.run_id')=? AND json_extract(result_json,'$.recorded_failure')=1 LIMIT 1`)
    .bind(room, runId).first();
  if (failure) reasons.push('prior_failed_evidence');
  const result: EvaluationResult = {
    kind: 'execution_evaluation', version: VERSION, manifest_id: input.manifest_id,
    manifest_digest: input.manifest_digest, manifest: record.manifest,
    proof_mode: 'authenticated_reviewer_evidence', disposition: reasons.length ? 'HOLD' : 'PASS',
    reasons: [...new Set(reasons)], recorded_failure: recordedFailure,
    case_count: caseCount, shards: input.shards, task_approved: false, live_proof: false,
  };
  return presentEvaluation(service, room, runId, await persist(service, room, key, requestJson, result, observed), false);
}

async function authorizeReviewer(service: Workroom, room: string): Promise<void> {
  await service.authorize(room, true);
  const role = await service.database.prepare("SELECT 1 FROM principal_roles WHERE principal_id=? AND kind IN ('agent','user')")
    .bind(service.principal).first();
  if (!role) throw new Fault('FORBIDDEN', 'Evaluation requires an authenticated agent or user reviewer role.', 403);
}

async function presentEvaluation(service: Workroom, room: string, runId: string, receipt: Stored, replayed: boolean) {
  const stored = await presented(receipt, replayed, evaluationResultSchema);
  const current = await getRunEvaluation(service, room, runId);
  return {
    data: { ...stored.data, current_disposition: current.data.disposition, current_reasons: current.data.reasons },
    meta: { ...stored.meta, result_is_historical_receipt: true },
  };
}

/** Historical PASS is never returned as current PASS after authority/source drift. */
export async function getRunEvaluation(service: Workroom, room: string, runId: string) {
  await service.authorize(room);
  const observed = await snapshot(service.database, room, runId);
  const rows = await service.database.prepare(`SELECT id,room_id,principal_id,disposition,observation_json,result_json,recorded_at
    FROM verifier_receipts WHERE room_id=? AND json_extract(result_json,'$.kind')='execution_evaluation'
      AND json_extract(result_json,'$.manifest.run_id')=? ORDER BY rowid DESC LIMIT 50`).bind(room, runId).all<Stored>();
  const latest = rows.results[0];
  if (!latest) return { data: { run_id: runId, disposition: 'HOLD' as const, reasons: ['not_evaluated'], receipts: [] }, meta: {} };
  const history = await Promise.all(rows.results.map(async row => ({ id: row.id, reviewer: row.principal_id, recorded_at: row.recorded_at,
    result: await readStored(row, evaluationResultSchema) })));
  const result = history[0]!.result;
  const current = await describe(observed, room, latest.principal_id);
  const reasons = [...current.reasons];
  if (current.manifest_digest !== result.manifest_digest) reasons.push('manifest_stale');
  const failure = await service.database.prepare(`SELECT 1 FROM verifier_receipts
    WHERE room_id=? AND json_extract(result_json,'$.kind')='execution_evaluation'
      AND json_extract(result_json,'$.manifest.run_id')=? AND json_extract(result_json,'$.recorded_failure')=1 LIMIT 1`)
    .bind(room, runId).first();
  if (failure) reasons.push('failed_evidence_retained');
  // A final atomic read anchors the view after its constituent reads. It also
  // checks the original reviewer's current membership, so revoked authority
  // and receipts arriving during readback cannot produce a current PASS.
  const stable = unchanged(observed, room, latest.principal_id);
  stable.sql += ` AND NOT EXISTS (SELECT 1 FROM verifier_receipts
    WHERE room_id=? AND json_extract(result_json,'$.kind')='execution_evaluation'
      AND json_extract(result_json,'$.manifest.run_id')=?
      AND rowid>(SELECT rowid FROM verifier_receipts WHERE id=?))`;
  stable.args.push(room, runId, latest.id);
  if (!await service.database.prepare(`SELECT 1 AS evaluation_snapshot_current WHERE ${stable.sql}`)
    .bind(...stable.args).first()) reasons.push('evaluation_snapshot_changed');
  return {
    data: {
      run_id: runId, disposition: reasons.length ? 'HOLD' as const : result.disposition,
      reasons: [...new Set([...result.reasons, ...reasons])], proof_mode: result.proof_mode,
      latest_receipt_id: latest.id, current: reasons.length === 0,
      receipts: history,
    },
    meta: { historical_receipts_preserved: true, history_limit: 50 },
  };
}

export async function runEvaluationRoute(service: Workroom, request: Request, url: URL, readJSON: () => Promise<unknown>) {
  const match = /^\/api\/v1\/rooms\/([^/]+)\/execution-runs\/([^/]+)\/evaluation(?:\/(manifest))?$/.exec(url.pathname);
  if (!match) return null;
  if (url.search) throw new Fault('INVALID_INPUT', 'No evaluation query parameters.');
  let room: string, runId: string;
  try { room = decodeURIComponent(match[1]!); runId = decodeURIComponent(match[2]!); }
  catch { throw new Fault('INVALID_INPUT', 'Invalid evaluation path.'); }
  id.parse(room); id.parse(runId);
  if (!match[3] && request.method === 'GET') return getRunEvaluation(service, room, runId);
  if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  const key = keySchema.parse(request.headers.get('idempotency-key'));
  const body = await readJSON();
  if (match[3]) {
    z.object({ schema_version: z.literal('1') }).strict().parse(body);
    return freezeRunEvaluation(service, room, runId, key);
  }
  return submitRunEvaluation(service, room, runId, key, body);
}
