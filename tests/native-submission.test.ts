import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { harness } from '../scripts/local-harness.ts';
import type { Database, Statement, Value } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import { Fault, postSchema } from '../src/server/contracts.ts';
import { taskCancelSchema, taskClaimSchema, taskSubmitSchema } from '../src/server/task-contracts.ts';
import { sha256 } from '../src/server/mutations.ts';
import { LIVE_MODEL, superviseRun, interruptRun, getRunStatus, type RunInput } from '../src/server/run-supervisor.ts';
import { submitNative, type NativeSubmitInput } from '../src/server/native-submission.ts';

const ROOM = 'room_main', AUTHOR = 'synthetic:alpha', OTHER = 'synthetic:beta';
let db: Database, app: Awaited<ReturnType<typeof harness>>, serial = 0, unexpectedOutbound = 0;
before(async () => {
  app = await harness({ through: 84, seed: false, outboundService: () => {
    unexpectedOutbound++;
    return new Response('External calls are forbidden in this fixture.', { status: 502 });
  } });
  db = app.db;
  await db.batch([
    db.prepare('INSERT INTO rooms(id) VALUES (?)').bind(ROOM),
    ...[AUTHOR, OTHER, 'user:minsung'].map(p => db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(p)),
    ...[AUTHOR, OTHER].map(p => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?,?,1)').bind(p, ROOM)),
    ...[AUTHOR, OTHER].map(p => db.prepare("INSERT INTO principal_roles(principal_id,kind) VALUES (?,'agent')").bind(p)),
    db.prepare(`INSERT INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
      VALUES ('native-directive','room_main','user:minsung','Review local native evidence',NULL,'native-directive','fixture','2026-11-24T00:00:00.000Z')`),
    db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
      VALUES (4,'Review','Review local native evidence',NULL,'native-directive','user:minsung','fixture','2026-11-24T00:00:00.000Z')`),
  ]);
});
after(async () => { await app?.close(); });

async function fixture() {
  const n = ++serial, task = `native-task-${n}`, run = `native-run-${n}`, attempt = `native-attempt-${n}`;
  const spec = { goal: 'Write the approved local artifact', owner: null, dependencies: [], input_versions: [],
    done_conditions: ['The exact approved data check passes'], unit: { kind: 'builder', lease_ms: 2_400_000 } };
  const specHash = await sha256(`approved unit ${n}`);
  const modelText = JSON.stringify({ contract: 'workroom.native-actions.v1', spec_sha256: specHash,
    actions: [{ tool: 'write_file', path: 'result.txt', before_sha256: null, content: 'approved' }] });
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
      VALUES (?,?,?,NULL,?,'in_progress',2,NULL,NULL,?,?)`).bind(task, ROOM, AUTHOR, JSON.stringify(spec), Date.now(), Date.now()),
    db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,3,?)').bind(task, AUTHOR, Date.now() + 1_200_000),
  ]);
  const calls = { posts: 0 };
  const provider: RunInput['fetch'] = async (target, init) => {
    if (init?.method === 'POST') {
      calls.posts++;
      return Response.json({ id: `native-generation-${n}`, model: LIVE_MODEL,
        choices: [{ message: { content: modelText } }], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } });
    }
    const url = new URL(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url);
    return Response.json({ data: { id: url.searchParams.get('id'), total_cost: 0.000020,
      provider_name: 'fixture', model: LIVE_MODEL, tokens_prompt: 4, tokens_completion: 5 } });
  };
  const report = await superviseRun(db, { project: 'native-review', task_id: task, run_id: run, attempt_id: attempt,
    principal: AUTHOR, lease_epoch: 3, intent_revision: 4, cancel_generation: 0, model: LIVE_MODEL,
    prompt: 'Return the approved native JSON actions.', max_tokens: 128, api_key: 'fixture-key',
    cap_micro_usd: 3_000_000, fetch: provider, cost_retries: 1, cost_delay_ms: 0 });
  assert.equal(report.disposition, 'PASS', report.failure ?? '');
  assert.equal(calls.posts, 1);
  const runDigest = await sha256(run), output = { exit: 0, signal: null, stdout: 'data check passed\n', stderr: '' };
  const receipt = { contract: 'workroom.native-receipt.v1', status: 'LOCAL_CHECKS_PASSED',
    unit_id: `native-unit-${n}`, run_id: run, principal_id: AUTHOR, task_id: task, lease_epoch: 3, intent_revision: 4,
    spec_sha256: specHash, task_spec_sha256: await sha256(JSON.stringify({ id: task, goal: spec.goal, owner_id: null,
      dependencies: [], input_versions: [], done_conditions: spec.done_conditions, unit: spec.unit })),
    base_sha: '1'.repeat(40), branch: `native/${runDigest.slice(0, 24)}`, head_sha: '2'.repeat(40), tree_sha: '3'.repeat(40),
    model_artifact_id: report.artifact_id,
    checks: [{ ...output, id: 'exact-data', cmd: ['workroom', 'text-equals', 'result.txt', 'approved'], expect: 'exit0', scope: 'touched',
      log_sha256: await sha256(JSON.stringify(output)), status: 'PASS', head_sha: '2'.repeat(40), tree_sha: '3'.repeat(40) }],
    changed_files: ['result.txt'], transcript_sha256: '4'.repeat(64), transcript_ref: `${runDigest}/journal.json`,
    actual_micro_usd: 20, actual_tokens: { prompt: 4, completion: 5, total: 9 },
    budget_check: 'estimate_admitted_and_actual_observed', push: 'NOT_RUN', independent_verdict: 'NOT_RUN', execution_boundary: 'trusted_data_checks_only' };
  const input: NativeSubmitInput = { schema_version: '1', run_id: run, attempt_id: attempt, task_id: task,
    lease_epoch: 3, intent_revision: 4, cancel_generation: 0, expected_version: 2,
    idempotency_key: `native-request-${n}`, receipt_json: JSON.stringify(receipt) };
  return { n, task, run, attempt, input, receipt, report, calls };
}

/** Inject a competing real D1 action immediately before a selected transaction.
 * All production SQL and real task/message engines still execute unchanged. */
function beforeEffect(pattern: RegExp, effect: () => Promise<void>): Database {
  let fired = false;
  class Tracked implements Statement {
    constructor(readonly sql: string, readonly raw: Statement) {}
    bind(...values: Value[]): Statement { return new Tracked(this.sql, this.raw.bind(...values)); }
    first<T>() { return this.raw.first<T>(); }
    all<T>() { return this.raw.all<T>(); }
  }
  return {
    prepare(sql) { return new Tracked(sql, db.prepare(sql)); },
    async batch<T>(statements: Statement[]) {
      const tracked = statements.map(statement => { assert.ok(statement instanceof Tracked); return statement; });
      if (!fired && tracked.some(statement => pattern.test(statement.sql))) { fired = true; await effect(); }
      return db.batch<T>(tracked.map(statement => statement.raw));
    },
  };
}
const interrupted = async (f: Awaited<ReturnType<typeof fixture>>) => {
  assert.equal((await interruptRun(db, { task_id: f.task, run_id: f.run, principal: AUTHOR, reason: 'independent race fixture' })).ok, true);
};
const lost = (error: unknown) => error instanceof Fault && error.code === 'LEASE_CONFLICT';
async function counts(f: Awaited<ReturnType<typeof fixture>>) {
  const artifact = await db.prepare('SELECT count(*) AS n FROM messages WHERE text=?').bind(f.input.receipt_json).first<{ n: number }>();
  const submission = await db.prepare('SELECT count(*) AS n FROM task_submissions WHERE task_id=?').bind(f.task).first<{ n: number }>();
  const marker = await db.prepare("SELECT count(*) AS n FROM operations WHERE operation='native.submit.accepted' AND key=?")
    .bind(f.input.idempotency_key).first<{ n: number }>();
  return { artifacts: artifact?.n, submissions: submission?.n, accepted: marker?.n };
}

test('interrupt between last authority read and evidence write rejects the same transaction', async () => {
  const f = await fixture();
  const guarded = beforeEffect(/INSERT INTO messages\(/, () => interrupted(f));
  let rejected: unknown;
  try { await submitNative(new Workroom(guarded, AUTHOR), f.input); } catch (error) { rejected = error; }
  const evidence = await counts(f);
  console.log(JSON.stringify({ case: 'native-publish-race', rejected: lost(rejected), ...evidence }));
  assert.ok(lost(rejected), String(rejected));
  assert.deepEqual(evidence, { artifacts: 0, submissions: 0, accepted: 0 });
  assert.equal(f.calls.posts, 1);
});

test('interrupt after valid evidence publication prevents task submission and preserves history', async () => {
  const f = await fixture();
  await assert.rejects(submitNative(new Workroom(beforeEffect(/INSERT INTO task_submissions\(/, () => interrupted(f)), AUTHOR), f.input), lost);
  assert.deepEqual(await counts(f), { artifacts: 1, submissions: 0, accepted: 0 });
  assert.deepEqual(await db.prepare('SELECT state,current_submission_id FROM tasks WHERE id=?').bind(f.task).first(),
    { state: 'in_progress', current_submission_id: null });
});

test('a new same-task epoch fences native publication after a genuine cross-principal reclaim', async () => {
  const f = await fixture();
  const database = beforeEffect(/INSERT INTO messages\(/, async () => {
    await db.prepare('UPDATE task_leases SET expires_at_ms=0 WHERE task_id=?').bind(f.task).all();
    await new Workroom(db, OTHER).tasks.action('claim', taskClaimSchema.parse({ schema_version: '1', room: ROOM,
      task_id: f.task, expected_version: 2, lease_epoch: 3, idempotency_key: `reclaim-native-${f.n}` }));
  });
  await assert.rejects(submitNative(new Workroom(database, AUTHOR), f.input), lost);
  assert.deepEqual(await counts(f), { artifacts: 0, submissions: 0, accepted: 0 });
  assert.equal((await new Workroom(db, OTHER).tasks.get({ schema_version: '1', room: ROOM, task_id: f.task })).data.lease.lease_epoch, 4);
});

test('accepted native submission replays exact immutable history after cancellation without renewing authority', async () => {
  const f = await fixture(), service = new Workroom(db, AUTHOR);
  const accepted = await submitNative(service, f.input);
  assert.equal(accepted.data.accepted_for_review, true);
  assert.equal(accepted.data.historical_replay, false);
  assert.equal(accepted.data.current_authority_granted, false);
  assert.equal(accepted.data.task_approved, false);
  assert.equal(accepted.data.check_kind, 'local_builder_evidence');
  await interrupted(f);
  const before = await db.prepare('SELECT version,state FROM tasks WHERE id=?').bind(f.task).first();
  const replay = await submitNative(service, f.input);
  assert.equal(replay.meta.replayed, true); assert.equal(replay.data.historical_replay, true);
  assert.equal(replay.data.submission_id, accepted.data.submission_id);
  assert.equal(replay.data.current_task_state, 'review');
  assert.equal(replay.data.current_submission_matches, true);
  assert.deepEqual(await db.prepare('SELECT version,state FROM tasks WHERE id=?').bind(f.task).first(), before);
  assert.deepEqual(await counts(f), { artifacts: 1, submissions: 1, accepted: 1 });
  await service.tasks.action('cancel', taskCancelSchema.parse({ schema_version: '1', room: ROOM, task_id: f.task,
    expected_version: 3, idempotency_key: `cancel-native-${f.n}`, reason: 'Submission superseded after response loss' }));
  const superseded = await submitNative(service, f.input);
  assert.equal(superseded.data.historical_replay, true);
  assert.equal(superseded.data.current_task_state, 'canceled');
  assert.equal(superseded.data.current_submission_matches, false, 'historical acceptance is not a current review result');
});

test('concurrent exact native requests create one evidence message and one submitted review', async () => {
  const f = await fixture();
  const answers = await Promise.all([submitNative(new Workroom(db, AUTHOR), f.input), submitNative(new Workroom(db, AUTHOR), f.input)]);
  assert.equal(answers[0].data.submission_id, answers[1].data.submission_id);
  assert.equal(answers[0].data.artifact_id, answers[1].data.artifact_id);
  assert.deepEqual(await counts(f), { artifacts: 1, submissions: 1, accepted: 1 });
});

test('conflicting native payload and foreign execution receipt cannot manufacture acceptance', async () => {
  const first = await fixture(), second = await fixture();
  await submitNative(new Workroom(db, AUTHOR), first.input);
  await assert.rejects(submitNative(new Workroom(db, AUTHOR), { ...first.input, receipt_json: first.input.receipt_json + ' ' }),
    (error: unknown) => error instanceof Fault && error.code === 'IDEMPOTENCY_CONFLICT');
  await db.prepare('UPDATE execution_runs SET receipt_id=? WHERE run_id=?').bind(first.report.receipt_id, second.run).all();
  await assert.rejects(submitNative(new Workroom(db, AUTHOR), second.input), lost);
  assert.deepEqual(await counts(second), { artifacts: 0, submissions: 0, accepted: 0 });
});

test('generic operation keys cannot spoof the server-only native acceptance after interruption', async () => {
  const f = await fixture();
  await assert.rejects(submitNative(new Workroom(beforeEffect(/INSERT INTO task_submissions\(/, () => interrupted(f)), AUTHOR), f.input), lost);
  const suffix = await sha256(JSON.stringify([AUTHOR, f.input.idempotency_key, f.run]));
  const service = new Workroom(db, AUTHOR);
  const artifact = await service.post(postSchema.parse({ schema_version: '1', room: ROOM,
    idempotency_key: `native-post-${suffix}`, text: f.input.receipt_json, format: 'text' }));
  await service.tasks.action('submit', taskSubmitSchema.parse({ schema_version: '1', room: ROOM, task_id: f.task,
    idempotency_key: `native-task-${suffix}`, expected_version: 2, lease_epoch: 3,
    artifact_message_id: artifact.data.message.id, artifact_revision: 1, disposition: 'review' }));
  assert.equal((await getRunStatus(db, f.run))?.authority.authorized, false);
  await assert.rejects(submitNative(service, f.input), lost);
  assert.deepEqual(await counts(f), { artifacts: 1, submissions: 1, accepted: 0 });
});

test('native-submit HTTP binds strict payloads to the authenticated actor and fences canceled executions', async () => {
  const send = (body: unknown, token: string | null = 'local-alpha-fixture', method = 'POST') =>
    app.mf.dispatchFetch(`http://127.0.0.1/api/v1/rooms/${ROOM}/execution-runs/native-submit`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });
  const errorCode = z.object({ ok: z.literal(false), error: z.object({ code: z.string() }).passthrough() }).passthrough();
  const acceptedSchema = z.object({ ok: z.literal(true), data: z.object({
    artifact_id: z.string(), submission_id: z.string(), principal_id: z.literal(AUTHOR),
    run_id: z.string(), task_id: z.string(), accepted_for_review: z.literal(true), task_approved: z.literal(false),
    current_authority_granted: z.literal(false), historical_replay: z.boolean(),
    current_task_state: z.literal('review'), current_submission_matches: z.literal(true),
  }).passthrough(), meta: z.object({ idempotency_key: z.string(), replayed: z.boolean() }).passthrough() }).passthrough();

  // No OPENROUTER_API_KEY is configured in this Worker. Native publication uses
  // the already-settled run, and the request body legitimately owns its retry key.
  const f = await fixture();
  const acceptedResponse = await send(f.input);
  assert.equal(acceptedResponse.status, 200, await acceptedResponse.clone().text());
  const accepted = acceptedSchema.parse(await acceptedResponse.json());
  assert.equal(accepted.data.run_id, f.run); assert.equal(accepted.data.task_id, f.task);
  assert.equal(accepted.data.historical_replay, false);
  assert.equal(accepted.meta.idempotency_key, f.input.idempotency_key);
  assert.equal(accepted.meta.replayed, false);
  assert.equal((await db.prepare('SELECT actor_id FROM messages WHERE id=?').bind(accepted.data.artifact_id)
    .first<{ actor_id: string }>())?.actor_id, AUTHOR);
  const replayResponse = await send(f.input);
  assert.equal(replayResponse.status, 200);
  const replay = acceptedSchema.parse(await replayResponse.json());
  assert.equal(replay.data.submission_id, accepted.data.submission_id);
  assert.equal(replay.data.historical_replay, true); assert.equal(replay.meta.replayed, true);

  const injected = await send({ ...f.input, principal_id: OTHER });
  assert.equal(injected.status, 400);
  assert.equal(errorCode.parse(await injected.json()).error.code, 'INVALID_INPUT');
  const foreign = await send(f.input, 'local-beta-fixture');
  assert.equal(foreign.status, 400);
  assert.equal(errorCode.parse(await foreign.json()).error.code, 'INVALID_INPUT');
  const missingAuth = await send(f.input, null);
  assert.equal(missingAuth.status, 401);
  assert.equal(errorCode.parse(await missingAuth.json()).error.code, 'UNAUTHENTICATED');
  assert.equal((await send(f.input, 'local-alpha-fixture', 'GET')).status, 405);
  assert.deepEqual(await counts(f), { artifacts: 1, submissions: 1, accepted: 1 });

  const canceled = await fixture();
  await interrupted(canceled);
  const denied = await send(canceled.input);
  assert.equal(denied.status, 409);
  assert.equal(errorCode.parse(await denied.json()).error.code, 'LEASE_CONFLICT');
  assert.deepEqual(await counts(canceled), { artifacts: 0, submissions: 0, accepted: 0 });
  assert.equal(unexpectedOutbound, 0);
  assert.equal(f.calls.posts + canceled.calls.posts, 2, 'Only the two explicitly injected fixture calls ran.');
});
