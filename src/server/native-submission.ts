import { z } from 'zod';
import { sha256 as storedSha256 } from '../auth/crypto.ts';
import { Fault, ROOM, keySchema, postSchema, textSchema } from './contracts.ts';
import type { Workroom } from './domain.ts';
import type { Database, Statement } from './db.ts';
import { canonical, planMutation, run, sha256, type Predicate, type Row } from './mutations.ts';
import { taskSpecSchema, taskSubmitSchema } from './task-contracts.ts';
import { authorityPredicate, VERIFIER } from './run-supervisor.ts';

const id = z.string().min(1).max(128).refine(value => value.isWellFormed() && !value.includes('\0'));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nativePath = z.string().min(1).max(240).refine(value => value.split('/').every(part =>
  /^[A-Za-z0-9_@+.-]+$/.test(part) && part !== '.' && part !== '..'
  && !/^\.git(?:$|[^a-z])/i.test(part)
  && !/^(?:node_modules|\.env(?:\..*)?|\.ssh|\.npmrc|\.netrc)$/i.test(part)));
const command = z.union([
  z.tuple([z.literal('node'), z.literal('--check'), nativePath]),
  z.tuple([z.literal('git'), z.literal('diff'), z.literal('--check')]),
  z.tuple([z.literal('workroom'), z.literal('text-equals'), nativePath, z.string().max(32768)]),
  z.tuple([z.literal('workroom'), z.literal('json-equals'), nativePath, z.string().max(32768)]),
]);
const check = z.object({ id, cmd: command, expect: z.literal('exit0'), scope: z.enum(['touched', 'full']),
  exit: z.literal(0), signal: z.null(), stdout: z.string().max(16384), stderr: z.string().max(16384),
  log_sha256: digest, status: z.literal('PASS'), head_sha: gitSha, tree_sha: gitSha }).strict();
const tokens = z.object({ prompt: natural, completion: natural, total: natural }).strict()
  .refine(value => value.prompt + value.completion === value.total, 'Token census does not add up');

/** This validates an author's local evidence. It does not establish that the
 * checks ran, grant an independent verdict, or authorize a push or deployment. */
export const nativeReceiptSchema = z.object({
  contract: z.literal('workroom.native-receipt.v1'), status: z.literal('LOCAL_CHECKS_PASSED'),
  unit_id: id, run_id: id, principal_id: id, task_id: id, lease_epoch: natural.positive(), intent_revision: natural,
  spec_sha256: digest, task_spec_sha256: digest, base_sha: gitSha,
  branch: z.string().regex(/^native\/[a-f0-9]{24}$/), head_sha: gitSha, tree_sha: gitSha,
  model_artifact_id: id, checks: z.array(check).min(1).max(20), changed_files: z.array(nativePath).min(1).max(20),
  transcript_sha256: digest, transcript_ref: z.string().regex(/^[a-f0-9]{64}\/journal\.json$/),
  actual_micro_usd: natural, actual_tokens: tokens, budget_check: z.literal('estimate_admitted_and_actual_observed'),
  push: z.literal('NOT_RUN'), independent_verdict: z.literal('NOT_RUN'),
  execution_boundary: z.literal('trusted_data_checks_only'),
}).strict().superRefine((value, context) => {
  if (new Set(value.checks.map(item => item.id)).size !== value.checks.length
    || new Set(value.changed_files).size !== value.changed_files.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate native evidence member' });
  }
  if (value.checks.some(item => item.head_sha !== value.head_sha || item.tree_sha !== value.tree_sha)) {
    context.addIssue({ code: 'custom', message: 'Checks do not bind the submitted head and tree' });
  }
});
type NativeReceipt = z.infer<typeof nativeReceiptSchema>;

export const nativeSubmitSchema = z.object({
  schema_version: z.literal('1'), run_id: id, attempt_id: id, task_id: id,
  lease_epoch: natural.positive().max(2147483646), intent_revision: natural, cancel_generation: natural,
  expected_version: natural.positive().max(2147483646), idempotency_key: keySchema, receipt_json: textSchema,
}).strict();
export type NativeSubmitInput = z.infer<typeof nativeSubmitSchema>;

const PREPARE = 'native.submit.prepare', ACCEPT = 'native.submit.accepted';
const acceptedSchema = z.object({
  artifact_id: id, submission_id: id, task_id: id, run_id: id, attempt_id: id, principal_id: id,
  lease_epoch: natural.positive(), intent_revision: natural, cancel_generation: natural, expected_version: natural.positive(),
  head_sha: gitSha, receipt_sha256: digest, accepted_for_review: z.literal(true),
  current_authority_granted: z.literal(false), check_kind: z.literal('local_builder_evidence'), task_approved: z.literal(false),
}).strict();
type Accepted = z.infer<typeof acceptedSchema>;
const operationSchema = z.object({ request_hash: digest, result_json: z.string() }).strict();
const preparedSchema = z.object({ native: z.object({ contract: z.literal('workroom.native-submit-prepared.v1'),
  run_id: id, task_id: id, receipt_sha256: digest, artifact_key: keySchema, submission_key: keySchema }).strict(),
  operation: z.object({ type: z.literal(PREPARE), idempotency_key: keySchema, id }).strict(),
}).strict();

function conflict(): Fault { return new Fault('IDEMPOTENCY_CONFLICT', 'Native submission key already has different content.', 409, 'not_applied'); }
function lost(): Fault { return new Fault('LEASE_CONFLICT', 'Native submission lost its current execution authority.', 409, 'not_applied'); }
function invalid(message: string): Fault { return new Fault('INVALID_INPUT', message, 400, 'not_applied'); }
function parseJSON(text: string): unknown {
  try { return JSON.parse(text); } catch { throw invalid('Native receipt is not valid JSON.'); }
}
async function operation(db: Database, principal: string, name: string, key: string): Promise<Row | null> {
  const row = await db.prepare('SELECT request_hash,result_json FROM operations WHERE principal_id=? AND operation=? AND key=?')
    .bind(principal, name, key).first<unknown>();
  return row === null ? null : operationSchema.parse(row);
}
function assertion(db: Database, condition: Predicate): Statement {
  // D1 batch is transactional: a failed assertion rolls back every following
  // message, notification, task, audit and acceptance-marker write in it.
  return db.prepare(`SELECT json(CASE WHEN (${condition.sql}) THEN '{}' ELSE 'native_authority_lost' END)`)
    .bind(...condition.args);
}
async function live(db: Database, condition: Predicate): Promise<boolean> {
  return !!await db.prepare(`SELECT 1 WHERE ${condition.sql}`).bind(...condition.args).first();
}

async function validateReceipt(input: NativeSubmitInput, principal: string): Promise<NativeReceipt> {
  const receipt = nativeReceiptSchema.parse(parseJSON(input.receipt_json));
  if (receipt.run_id !== input.run_id || receipt.task_id !== input.task_id || receipt.principal_id !== principal
    || receipt.lease_epoch !== input.lease_epoch || receipt.intent_revision !== input.intent_revision) {
    throw invalid('Native receipt identity does not match the authenticated execution.');
  }
  const runDigest = await sha256(input.run_id);
  if (receipt.branch !== `native/${runDigest.slice(0, 24)}` || receipt.transcript_ref !== `${runDigest}/journal.json`) {
    throw invalid('Native branch or transcript does not bind this run.');
  }
  for (const item of receipt.checks) {
    if (item.log_sha256 !== await sha256(JSON.stringify({ exit: item.exit, signal: item.signal, stdout: item.stdout, stderr: item.stderr }))) {
      throw invalid('Native check log digest does not match its bytes.');
    }
  }
  return receipt;
}

async function boundAuthority(db: Database, principal: string, input: NativeSubmitInput, receipt: NativeReceipt): Promise<Predicate> {
  const row = await db.prepare('SELECT spec_json,owner_id FROM tasks WHERE id=? AND room_id=?')
    .bind(input.task_id, ROOM).first<unknown>();
  if (row === null) throw new Fault('NOT_FOUND', 'Task not found.', 404);
  const task = z.object({ spec_json: z.string(), owner_id: id.nullable() }).strict().parse(row);
  const spec = taskSpecSchema.parse(parseJSON(task.spec_json));
  if (spec.unit?.kind !== 'builder') throw invalid('Native submission requires an explicit immutable builder task unit.');
  const taskDigest = await sha256(JSON.stringify({ id: input.task_id, goal: spec.goal, owner_id: task.owner_id,
    dependencies: spec.dependencies, input_versions: spec.input_versions, done_conditions: spec.done_conditions,
    ...('unit' in spec ? { unit: spec.unit } : {}) }));
  if (receipt.task_spec_sha256 !== taskDigest) throw invalid('Native task specification digest differs.');
  const auth = authorityPredicate({ task_id: input.task_id, principal, lease_epoch: input.lease_epoch,
    intent_revision: input.intent_revision, cancel_generation: input.cancel_generation });
  return {
    sql: `(${auth.sql}) AND EXISTS (SELECT 1 FROM tasks t WHERE t.id=? AND t.version=? AND t.spec_json=?)
      AND EXISTS (SELECT 1 FROM execution_runs r
        JOIN execution_receipts c ON c.receipt_id=r.receipt_id AND c.run_id=r.run_id
        JOIN messages original ON original.id=r.artifact_id AND original.actor_id=r.principal_id AND original.room_id='room_main'
        JOIN budget_reservations b ON b.reservation_id=r.reservation_id AND b.run_id=r.run_id
          AND b.principal_id=r.principal_id AND b.project=r.project AND b.generation_id=r.generation_id AND b.state='settled'
        JOIN budget_actuals a ON a.reservation_id=b.reservation_id AND a.project=b.project AND a.generation_id=b.generation_id
          AND a.provider='openrouter' AND a.provider_account=b.provider_account AND a.model=b.model
        WHERE r.run_id=? AND r.attempt_id=? AND r.task_id=? AND r.principal_id=? AND r.state='settled'
          AND r.lease_epoch=? AND r.intent_revision=? AND r.cancel_generation=? AND r.spec_digest=?
          AND r.artifact_id=? AND c.verifier=? AND c.disposition='PASS' AND c.attempt_id=r.attempt_id
          AND c.author_principal=r.principal_id AND c.task_id=r.task_id AND c.lease_epoch=r.lease_epoch
          AND c.intent_revision=r.intent_revision AND c.generation_id IS r.generation_id AND c.artifact_id IS r.artifact_id
          AND NOT EXISTS (SELECT 1 FROM message_revisions rev WHERE rev.message_id=original.id)
          AND CASE WHEN json_valid(original.text) THEN json_extract(original.text,'$.contract')='workroom.native-actions.v1'
            AND json_extract(original.text,'$.spec_sha256')=? ELSE 0 END
          AND a.micro_usd=? AND json_type(a.tokens_json,'$.prompt')='integer' AND json_extract(a.tokens_json,'$.prompt')=?
          AND json_type(a.tokens_json,'$.completion')='integer' AND json_extract(a.tokens_json,'$.completion')=?
          AND json_type(a.tokens_json,'$.total')='integer' AND json_extract(a.tokens_json,'$.total')=?
          AND (SELECT count(*) FROM budget_actuals actual WHERE actual.reservation_id=b.reservation_id)=1)`,
    args: [...auth.args, input.task_id, input.expected_version, task.spec_json, input.run_id, input.attempt_id,
      input.task_id, principal, input.lease_epoch, input.intent_revision, input.cancel_generation,
      await storedSha256(task.spec_json), receipt.model_artifact_id, VERIFIER, receipt.spec_sha256, receipt.actual_micro_usd,
      receipt.actual_tokens.prompt, receipt.actual_tokens.completion, receipt.actual_tokens.total],
  };
}

/** Read the server-only acceptance marker and immutable history. Generic
 * message.post/task.submit operations alone cannot manufacture this replay. */
async function historical(db: Database, principal: string, input: NativeSubmitInput, requestHash: string): Promise<Accepted | null> {
  const row = await operation(db, principal, ACCEPT, input.idempotency_key);
  if (!row) return null;
  if (row.request_hash !== requestHash) throw conflict();
  const accepted = acceptedSchema.parse(parseJSON(row.result_json));
  if (accepted.principal_id !== principal || accepted.run_id !== input.run_id || accepted.attempt_id !== input.attempt_id
    || accepted.task_id !== input.task_id || accepted.lease_epoch !== input.lease_epoch
    || accepted.intent_revision !== input.intent_revision || accepted.cancel_generation !== input.cancel_generation
    || accepted.expected_version !== input.expected_version || accepted.receipt_sha256 !== await sha256(input.receipt_json)) {
    throw new Fault('CONFLICT', 'Stored native acceptance binding differs.', 409);
  }
  const verified = await db.prepare(`SELECT 1 FROM task_submissions s JOIN messages m ON m.id=s.artifact_message_id
    JOIN operations prepared ON prepared.principal_id=s.actor_id AND prepared.operation=? AND prepared.key=? AND prepared.request_hash=?
    WHERE s.id=? AND s.task_id=? AND s.actor_id=? AND s.lease_epoch=? AND s.disposition='review'
      AND s.artifact_message_id=? AND s.artifact_revision=1 AND m.room_id=? AND m.actor_id=? AND m.text=? AND m.format='text'`)
    .bind(PREPARE, input.idempotency_key, requestHash, accepted.submission_id, input.task_id, principal,
      input.lease_epoch, accepted.artifact_id, ROOM, principal, input.receipt_json).first();
  if (!verified) throw new Fault('CONFLICT', 'Stored native acceptance history is missing or differs.', 409);
  return accepted;
}

export async function submitNative(service: Workroom, raw: NativeSubmitInput) {
  const input = nativeSubmitSchema.parse(raw), db = service.database, principal = service.principal;
  await service.authorize(ROOM);
  const requestHash = await sha256(JSON.stringify(canonical(input)));
  const result = async (accepted: Accepted, replayed: boolean) => {
    const current = await db.prepare('SELECT state,current_submission_id FROM tasks WHERE id=? AND room_id=?')
      .bind(input.task_id, ROOM).first<{ state: string; current_submission_id: string | null }>();
    return { data: { ...accepted, historical_replay: replayed, current_task_state: current?.state ?? null,
      current_submission_matches: current?.current_submission_id === accepted.submission_id },
    meta: { idempotency_key: input.idempotency_key, replayed } };
  };
  const previous = await historical(db, principal, input, requestHash);
  if (previous) return result(previous, true);
  const prepared = await operation(db, principal, PREPARE, input.idempotency_key);
  if (prepared && prepared.request_hash !== requestHash) throw conflict();
  if (prepared) preparedSchema.parse(parseJSON(prepared.result_json));
  const receipt = await validateReceipt(input, principal), receiptDigest = await sha256(input.receipt_json);
  const suffix = await sha256(JSON.stringify([principal, input.idempotency_key, input.run_id]));
  const artifactKey = `native-post-${suffix}`, submissionKey = `native-task-${suffix}`;
  const condition = await boundAuthority(db, principal, input, receipt);
  try {
    if (!prepared) {
      await run(db, await planMutation(db, principal, (room, write) => service.authorize(room, write),
        PREPARE, input.idempotency_key, input,
        { native: { contract: 'workroom.native-submit-prepared.v1', run_id: input.run_id, task_id: input.task_id,
          receipt_sha256: receiptDigest, artifact_key: artifactKey, submission_key: submissionKey } },
        input.task_id, input.expected_version, condition, () => [], true, async () => { throw lost(); }, { audit: 'task_audit' }));
    }
    const frozen = await operation(db, principal, PREPARE, input.idempotency_key);
    if (!frozen || frozen.request_hash !== requestHash) throw conflict();
    const bound = preparedSchema.parse(parseJSON(frozen.result_json)).native;
    if (bound.run_id !== input.run_id || bound.task_id !== input.task_id || bound.receipt_sha256 !== receiptDigest
      || bound.artifact_key !== artifactKey || bound.submission_key !== submissionKey) throw conflict();

    const postPlan = await service.planPost(postSchema.parse({ schema_version: '1', room: ROOM,
      idempotency_key: artifactKey, text: input.receipt_json, format: 'text' }));
    const posted = await db.batch<Row>([assertion(db, condition), ...postPlan.statements]);
    const artifact = await postPlan.finish(posted.at(-1)?.results[0]);
    const message = z.object({ id, actor_id: id, room_id: z.literal(ROOM), text: z.string(), format: z.literal('text') })
      .passthrough().parse(artifact.data.message);
    if (message.actor_id !== principal || message.text !== input.receipt_json) throw conflict();

    const taskInput = taskSubmitSchema.parse({ schema_version: '1', room: ROOM, task_id: input.task_id,
      idempotency_key: submissionKey, expected_version: input.expected_version, lease_epoch: input.lease_epoch,
      artifact_message_id: message.id, artifact_revision: 1, disposition: 'review' });
    const taskHash = await sha256(JSON.stringify(canonical(taskInput)));
    const taskPlan = await service.tasks.planAction('submit', taskInput);
    const acceptedBase: Accepted = { artifact_id: message.id, submission_id: 'pending', task_id: input.task_id,
      run_id: input.run_id, attempt_id: input.attempt_id, principal_id: principal, lease_epoch: input.lease_epoch,
      intent_revision: input.intent_revision, cancel_generation: input.cancel_generation, expected_version: input.expected_version,
      head_sha: receipt.head_sha, receipt_sha256: receiptDigest, accepted_for_review: true,
      current_authority_granted: false, check_kind: 'local_builder_evidence', task_approved: false };
    const now = new Date().toISOString();
    const acceptedCondition: Predicate = { sql: 'EXISTS (SELECT 1 FROM operations WHERE principal_id=? AND operation=? AND key=? AND request_hash=?)',
      args: [principal, ACCEPT, input.idempotency_key, requestHash] };
    const statements = [assertion(db, condition), ...taskPlan.statements, assertion(db, taskPlan.applied),
      db.prepare(`INSERT INTO operations(principal_id,operation,key,room_id,request_hash,result_json,created_at)
        SELECT ?,?,?,?,?,json_set(json(?),'$.submission_id',s.id),? FROM operations o
        JOIN task_submissions s ON s.id=json_extract(o.result_json,'$.submitted.id')
        JOIN tasks t ON t.id=s.task_id AND t.current_submission_id=s.id AND t.state='review' AND t.version=?
        WHERE o.principal_id=? AND o.operation='task.submit' AND o.key=? AND o.request_hash=?
          AND s.actor_id=? AND s.task_id=? AND s.lease_epoch=? AND s.artifact_message_id=? AND s.artifact_revision=1 AND s.disposition='review'
        ON CONFLICT(principal_id,operation,key) DO NOTHING`)
        .bind(principal, ACCEPT, input.idempotency_key, ROOM, requestHash, JSON.stringify(acceptedBase), now,
          input.expected_version + 1, principal, submissionKey, taskHash, principal, input.task_id, input.lease_epoch, message.id),
      assertion(db, acceptedCondition),
    ];
    const submitted = await db.batch<Row>(statements);
    await taskPlan.finish(submitted[taskPlan.statements.length]?.results[0]);
    const accepted = await historical(db, principal, input, requestHash);
    if (!accepted) throw new Fault('TEMPORARY_FAILURE', 'Native acceptance outcome is unknown; retry the exact payload.', 503, 'unknown', true);
    return result(accepted, false);
  } catch (error) {
    // A concurrent identical request or a lost response can have committed.
    // An exact accepted history is returned without renewing the old authority.
    const accepted = await historical(db, principal, input, requestHash);
    if (accepted) return result(accepted, true);
    if (!await live(db, condition)) throw lost();
    throw error;
  }
}
