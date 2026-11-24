import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import type { Database } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import { taskSubmitSchema } from '../src/server/task-contracts.ts';
import { run } from '../src/server/mutations.ts';
import { LIVE_MODEL, getRunStatus, interruptRun, superviseRun, type RunInput } from '../src/server/run-supervisor.ts';

const ROOM = 'room_main', FIRST = 'synthetic:alpha', SECOND = 'synthetic:beta';
let db: Database, mf: Miniflare, cleanup: () => void;
before(async () => {
  const template = await cloneD1(84);
  cleanup = template.cleanup;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: template.dir, cf: false });
  db = await mf.getD1Database('DB') as Database;
  await db.batch([
    db.prepare('INSERT INTO rooms(id) VALUES (?)').bind(ROOM),
    ...[FIRST, SECOND, 'user:minsung'].map(principal => db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(principal)),
    ...[FIRST, SECOND].map(principal => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?,?,1)').bind(principal, ROOM)),
    ...[FIRST, SECOND].map(principal => db.prepare("INSERT INTO principal_roles(principal_id,kind) VALUES (?,'agent')").bind(principal)),
    db.prepare(`INSERT INTO owner_directives(id,room_id,actor_id,text,message_id,idempotency_key,request_hash,created_at)
      VALUES ('cross-host-directive','room_main','user:minsung','Review cross-host recovery',NULL,'cross-host-directive','fixture','2026-11-24T00:00:00.000Z')`),
    db.prepare(`INSERT INTO intent_versions(version,north_star,intent_md,parent_version,directive_id,author_principal,content_hash,created_at)
      VALUES (4,'Review','Review cross-host recovery',NULL,'cross-host-directive','user:minsung','fixture','2026-11-24T00:00:00.000Z')`),
  ]);
});
after(async () => { await mf?.dispose(); cleanup?.(); });

async function executed(taskId: string) {
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
      VALUES (?,?,?,NULL,?,'in_progress',2,NULL,NULL,?,?)`).bind(taskId, ROOM, FIRST,
      JSON.stringify({ goal: 'Return the artifact', owner: null, dependencies: [], input_versions: [], done_conditions: ['Artifact exists'] }), Date.now(), Date.now()),
    db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,?,3,?)').bind(taskId, FIRST, Date.now()+600_000),
  ]);
  let posts = 0;
  const request: RunInput = { project: 'native-authority', task_id: taskId, run_id: `run-${taskId}`, attempt_id: `attempt-${taskId}`,
    principal: FIRST, lease_epoch: 3, intent_revision: 4, cancel_generation: 0, model: LIVE_MODEL,
    prompt: 'Return the artifact', max_tokens: 64, api_key: 'fixture-key', cap_micro_usd: 3_000_000, cost_retries: 1, cost_delay_ms: 0,
    fetch: async (target, init) => {
      if (init?.method === 'POST') { posts++; return Response.json({ id: `gen-${taskId}`, model: LIVE_MODEL,
        choices: [{ message: { content: 'Artifact' } }], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } }); }
      const url = new URL(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url);
      return Response.json({ data: { id: url.searchParams.get('id'), total_cost: 0.000020, provider_name: 'fixture', model: LIVE_MODEL,
        tokens_prompt: 4, tokens_completion: 5 } });
    } };
  const result = await superviseRun(db, request);
  assert.equal(result.state, 'settled');
  return { request, result, posts: () => posts };
}

test('settled status separates current authority from historical outcome', { timeout: 60_000 }, async () => {
  const taskId = 'native-authority-task', { request, posts } = await executed(taskId);
  const initial = await getRunStatus(db, request.run_id);
  assert.equal(initial?.authority?.authorized, true);
  assert.equal(initial?.authority?.cancel_generation, 0);
  assert.equal(initial?.authority?.lease_epoch, 3);
  assert.equal(initial?.authority?.intent_revision, 4);
  assert.ok(initial!.authority.observed_at_ms > 0);
  await db.prepare("UPDATE principal_roles SET kind='user' WHERE principal_id=?").bind(FIRST).all();
  assert.equal((await getRunStatus(db, request.run_id))?.authority.authorized, false);
  await db.prepare("UPDATE principal_roles SET kind='agent' WHERE principal_id=?").bind(FIRST).all();
  await db.prepare('UPDATE task_leases SET expires_at_ms=0 WHERE task_id=?').bind(taskId).all();
  assert.equal((await getRunStatus(db, request.run_id))?.authority.authorized, false);
  await db.prepare('UPDATE task_leases SET expires_at_ms=? WHERE task_id=?').bind(Date.now()+600_000, taskId).all();
  assert.equal((await getRunStatus(db, request.run_id))?.authority.authorized, true);
  assert.equal((await interruptRun(db, { task_id: taskId, principal: FIRST, reason: 'before native steps' })).ok, true);
  const canceled = await getRunStatus(db, request.run_id);
  assert.equal(canceled?.state, 'settled', 'the historical execution outcome is preserved');
  assert.equal(canceled?.cancel_generation, 0, 'the stored execution envelope is immutable');
  assert.equal(canceled?.authority.cancel_generation, 1);
  assert.equal(canceled?.authority.authorized, false);
  assert.equal(posts(), 1);
});

test('execution-bound task submission rejects cancellation between planning and its write transaction', { timeout: 60_000 }, async () => {
  const { request, result } = await executed('text-submit-cancel');
  const service = new Workroom(db, FIRST);
  const base = taskSubmitSchema.parse({ schema_version: '1', room: ROOM, task_id: request.task_id,
    expected_version: 2, lease_epoch: 3, artifact_message_id: result.artifact_id, artifact_revision: 1,
    disposition: 'review', idempotency_key: 'text-submit-cancel-key' });
  const input = { ...base, execution: { run_id: request.run_id, attempt_id: request.attempt_id,
    intent_revision: request.intent_revision, cancel_generation: request.cancel_generation } };
  const plan = await service.tasks.planAction('submit', input);
  assert.equal((await interruptRun(db, { task_id: request.task_id, principal: FIRST, reason: 'after planned submission' })).ok, true);
  await assert.rejects(() => run(db, plan), /Execution authority changed/);
  assert.equal(await db.prepare('SELECT id FROM task_submissions WHERE task_id=?').bind(request.task_id).first(), null);
});

test('execution-bound task submission accepts the exact original settled artifact and replays the same request', { timeout: 60_000 }, async () => {
  const { request, result } = await executed('text-submit-live');
  const service = new Workroom(db, FIRST);
  const base = taskSubmitSchema.parse({ schema_version: '1', room: ROOM, task_id: request.task_id,
    expected_version: 2, lease_epoch: 3, artifact_message_id: result.artifact_id, artifact_revision: 1,
    disposition: 'review', idempotency_key: 'text-submit-live-key' });
  const input = { ...base, execution: { run_id: request.run_id, attempt_id: request.attempt_id,
    intent_revision: request.intent_revision, cancel_generation: request.cancel_generation } };
  assert.deepEqual(taskSubmitSchema.parse(input), input, 'HTTP/MCP schema retains the exact execution binding');
  await service.tasks.action('submit', input);
  await service.tasks.action('submit', input);
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM task_submissions WHERE task_id=?').bind(request.task_id).first<{n:number}>())?.n, 1);
  assert.equal((await service.tasks.get({ schema_version: '1', room: ROOM, task_id: request.task_id })).data.task.state, 'review');
});
