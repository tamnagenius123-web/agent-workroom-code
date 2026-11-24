import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Workroom } from '../src/server/domain.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database, Statement } from '../src/server/db.ts';
import { DB_NOW, taskBundleSchema, type Bundle } from '../src/server/tasks.ts';
import { taskCreateSchema, taskClaimNextSchema, taskSchemas } from '../src/server/task-contracts.ts';

const ROOM = 'room_main', ALPHA = 'synthetic:ttl-alpha', BETA = 'synthetic:ttl-beta', GAMMA = 'synthetic:ttl-gamma';
let db: Database, mf: Miniflare, cleanup: () => void;
beforeEach(async () => {
  const template = await cloneD1(3); cleanup = template.cleanup;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: template.dir, cf: false });
  db = await mf.getD1Database('DB') as Database;
  await db.batch([
    db.prepare('INSERT INTO rooms(id) VALUES (?)').bind(ROOM),
    ...[ALPHA, BETA, GAMMA].map(p => db.prepare('INSERT INTO principals(id) VALUES (?)').bind(p)),
    ...[ALPHA, BETA, GAMMA].map(p => db.prepare('INSERT INTO memberships(principal_id,room_id,can_post) VALUES (?,?,1)').bind(p, ROOM)),
    ...[ALPHA, BETA, GAMMA].map(p => db.prepare("INSERT INTO principal_roles(principal_id,kind) VALUES (?,'agent')").bind(p)),
  ]);
});
afterEach(async () => { await mf?.dispose(); cleanup?.(); });

const service = (principal = ALPHA) => new Workroom(db, principal).tasks;
const key = () => crypto.randomUUID();
const read = (id: string) => service().get({ schema_version: '1', room: ROOM, task_id: id }).then(r => r.data);
async function create(extra: Record<string, unknown> = {}): Promise<Bundle> {
  const result = await service().create(taskCreateSchema.parse({ schema_version: '1', room: ROOM, idempotency_key: key(),
    goal: 'Complete an immutable unit', done_conditions: ['The check exits zero'], ...extra }));
  return taskBundleSchema.parse(result.data);
}
async function claim(task: Bundle, principal = ALPHA): Promise<Bundle> {
  const result = await service(principal).action('claim', taskSchemas.claim.parse({ schema_version: '1', room: ROOM, idempotency_key: key(),
    task_id: task.task.id, expected_version: task.task.version, lease_epoch: task.lease.lease_epoch }));
  return taskBundleSchema.parse(result.data);
}
async function next(principal = ALPHA, idempotencyKey = key()): Promise<Bundle> {
  await service(principal).claimNext(taskClaimNextSchema.parse({ schema_version: '1', room: ROOM, idempotency_key: idempotencyKey }));
  const row = await db.prepare('SELECT result_json FROM operations WHERE principal_id=? AND operation=\'task.claim_next\' AND key=?')
    .bind(principal, idempotencyKey).first<{ result_json: string }>();
  assert.ok(row);
  const value: unknown = JSON.parse(row.result_json);
  const receipt = taskBundleSchema.parse(value);
  assert.equal(receipt.lease.expires_at_ms - receipt.server_time_ms, receipt.task.unit?.lease_ms ?? 30_000);
  assert.ok(value && typeof value === 'object' && 'task' in value);
  const task = value.task;
  assert.ok(task && typeof task === 'object' && 'id' in task && typeof task.id === 'string');
  const current = await read(task.id);
  assert.deepEqual(Reflect.get(task, 'unit'), Reflect.get(current.task, 'unit'));
  return current;
}
const expire = (id: string) => db.prepare('UPDATE task_leases SET expires_at_ms=0 WHERE task_id=?').bind(id).all();
const ttl = (bundle: Bundle) => bundle.lease.expires_at_ms - bundle.server_time_ms;
const isConflict = (e: unknown) => e instanceof Fault && (e.code === 'LEASE_CONFLICT' || e.code === 'VERSION_CONFLICT');

test('legacy task claims retain the 30-second server-clock lease', async () => {
  const created = await create(), held = await claim(created);
  assert.equal(ttl(held), 30_000);
  assert.equal('unit' in held.task, false);
});

test('expired in-progress work returns to claim_next with a new epoch; old operations cannot revive it', async () => {
  const created = await create(), firstKey = key();
  const first = await next(ALPHA, firstKey);
  await expire(created.task.id);
  const recovered = await next(BETA);
  assert.equal(recovered.task.id, created.task.id);
  assert.equal(recovered.lease.holder_id, BETA);
  assert.equal(recovered.lease.lease_epoch, first.lease.lease_epoch + 1);
  assert.equal(recovered.task.version, first.task.version + 1);
  await service(ALPHA).claimNext(taskClaimNextSchema.parse({ schema_version: '1', room: ROOM, idempotency_key: firstKey }));
  assert.deepEqual((await read(created.task.id)).lease, recovered.lease);
  await assert.rejects(service(ALPHA).action('renew', taskSchemas.renew.parse({ schema_version: '1', room: ROOM, idempotency_key: key(),
    task_id: created.task.id, expected_version: recovered.task.version, lease_epoch: first.lease.lease_epoch })), isConflict);
  const audit = await db.prepare("SELECT count(*) AS n FROM task_audit WHERE target_id=? AND operation='task.claim_next'").bind(created.task.id).first<{ n: number }>();
  assert.equal(audit?.n, 2);
});

test('two reclaimers of one expired task produce one current holder and one epoch increment', async () => {
  const first = await claim(await create()); await expire(first.task.id);
  const results = await Promise.allSettled([next(BETA), next(GAMMA)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = results.find(r => r.status === 'rejected');
  assert.ok(rejected && rejected.status === 'rejected');
  assert.ok(rejected.reason instanceof Fault && rejected.reason.code === 'NOT_FOUND');
  const current = await read(first.task.id);
  assert.equal(current.lease.lease_epoch, first.lease.lease_epoch + 1);
  assert.equal(current.task.version, first.task.version + 1);
  assert.ok([BETA, GAMMA].includes(current.lease.holder_id ?? ''));
});

test('same-principal stale epoch cannot renew or submit after expiry and reclaim', async () => {
  const first = await claim(await create()); await expire(first.task.id);
  const second = await next(ALPHA);
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind('ttl-artifact', ROOM, ALPHA, 'old result', 'text', new Date().toISOString()).all();
  const base = { schema_version: '1', room: ROOM, idempotency_key: key(), task_id: first.task.id,
    expected_version: second.task.version, lease_epoch: first.lease.lease_epoch };
  await assert.rejects(service().action('renew', taskSchemas.renew.parse(base)), isConflict);
  await assert.rejects(service().action('submit', taskSchemas.submit.parse({ ...base, idempotency_key: key(),
    artifact_message_id: 'ttl-artifact', artifact_revision: 1 })), isConflict);
  assert.equal((await read(first.task.id)).task.current_submission_id, null);
});

test('builder unit default is 40 minutes for direct claim, claim_next, and renewal with an immutable spec', async () => {
  const created = await create({ unit: { kind: 'builder' } });
  const raw = await db.prepare('SELECT spec_json FROM tasks WHERE id=?').bind(created.task.id).first<{ spec_json: string }>();
  assert.ok(raw); const digest = createHash('sha256').update(raw.spec_json).digest('hex');
  assert.deepEqual(Reflect.get(created.task, 'unit'), { kind: 'builder', lease_ms: 2_400_000 });
  const first = await claim(created); assert.equal(ttl(first), 2_400_000);
  const renewed = await service().action('renew', taskSchemas.renew.parse({ schema_version: '1', room: ROOM, idempotency_key: key(),
    task_id: created.task.id, expected_version: first.task.version, lease_epoch: first.lease.lease_epoch }));
  assert.equal(ttl(taskBundleSchema.parse(renewed.data)), 2_400_000);
  await expire(created.task.id);
  const recovered = await next(BETA);
  assert.ok(ttl(recovered) > 2_399_000 && ttl(recovered) <= 2_400_000);
  assert.deepEqual(Reflect.get(recovered.task, 'unit'), { kind: 'builder', lease_ms: 2_400_000 });
  const after = await db.prepare('SELECT spec_json FROM tasks WHERE id=?').bind(created.task.id).first<{ spec_json: string }>();
  assert.ok(after); assert.equal(createHash('sha256').update(after.spec_json).digest('hex'), digest);
  await assert.rejects(db.prepare("UPDATE tasks SET spec_json=json_set(spec_json,'$.unit.lease_ms',30000),version=version+1 WHERE id=?").bind(created.task.id).all(), /immutable task spec/);
});

test('explicit immutable unit lease_ms is used on pull, renewal, and idempotent replay', async () => {
  const created = await create({ unit: { kind: 'builder', lease_ms: 90_000 } }), claimKey = key();
  const pulled = await next(ALPHA, claimKey);
  assert.ok(ttl(pulled) > 89_000 && ttl(pulled) <= 90_000);
  const renewed = await service().action('renew', taskSchemas.renew.parse({ schema_version: '1', room: ROOM, idempotency_key: key(),
    task_id: created.task.id, expected_version: pulled.task.version, lease_epoch: pulled.lease.lease_epoch }));
  const renewedBundle = taskBundleSchema.parse(renewed.data);
  assert.equal(ttl(renewedBundle), 90_000);
  await service().claimNext(taskClaimNextSchema.parse({ schema_version: '1', room: ROOM, idempotency_key: claimKey }));
  assert.equal((await read(created.task.id)).task.version, renewedBundle.task.version);
  assert.deepEqual(Reflect.get((await read(created.task.id)).task, 'unit'), { kind: 'builder', lease_ms: 90_000 });
});

test('unit lease bounds reject malformed durations and cannot be overridden by a renew request', async () => {
  for (const lease_ms of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001, '2400000']) {
    assert.equal(taskCreateSchema.safeParse({ schema_version: '1', room: ROOM, idempotency_key: key(), goal: 'g',
      done_conditions: ['checked'], unit: { kind: 'builder', lease_ms } }).success, false);
  }
  assert.equal(taskCreateSchema.safeParse({ schema_version: '1', room: ROOM, idempotency_key: key(), goal: 'g',
    done_conditions: ['checked'], unit: { kind: 'builder', lease_ms: 86_400_000 } }).success, true);
  const held = await claim(await create({ unit: { kind: 'builder' } }));
  assert.equal(taskSchemas.renew.safeParse({ schema_version: '1', room: ROOM, idempotency_key: key(),
    task_id: held.task.id, expected_version: held.task.version, lease_epoch: held.lease.lease_epoch, unit: { kind: 'builder', lease_ms: 1 } }).success, false);
});

test('expired tasks keep owner and dependency restrictions, and live work stays excluded', async () => {
  const mine = await create({ owner: ALPHA }), held = await claim(mine); await expire(held.task.id);
  await assert.rejects(next(BETA), (e: unknown) => e instanceof Fault && e.code === 'NOT_FOUND');
  const recovered = await next(ALPHA); assert.equal(recovered.task.id, mine.task.id);
  await assert.rejects(next(ALPHA), (e: unknown) => e instanceof Fault && e.code === 'NOT_FOUND');
  const parent = await create(), child = await create({ dependencies: [parent.task.id] });
  await db.batch([
    db.prepare("UPDATE tasks SET state='in_progress',version=version+1 WHERE id=?").bind(child.task.id),
    db.prepare('UPDATE task_leases SET holder_id=?,lease_epoch=1,expires_at_ms=0 WHERE task_id=?').bind(ALPHA, child.task.id),
  ]);
  const picked = await next(BETA); assert.equal(picked.task.id, parent.task.id);
  await assert.rejects(next(GAMMA), (e: unknown) => e instanceof Fault && e.code === 'NOT_FOUND');
  assert.equal((await read(child.task.id)).lease.lease_epoch, 1);
});

test('invalid stored unit metadata fails closed on read and cannot receive a pull lease', async () => {
  const id = crypto.randomUUID(), spec = JSON.stringify({ goal: 'Corrupt fixture', owner: null, dependencies: [], input_versions: [],
    done_conditions: ['checked'], unit: { kind: 'builder', lease_ms: -30 } });
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
      VALUES (?,?,?,NULL,?,'open',1,NULL,NULL,${DB_NOW},${DB_NOW})`).bind(id, ROOM, ALPHA, spec),
    db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,NULL,0,0)').bind(id),
  ]);
  await assert.rejects(read(id));
  await assert.rejects(next());
  const row = await db.prepare('SELECT state,version FROM tasks WHERE id=?').bind(id).first<{ state: string; version: number }>();
  assert.deepEqual(row, { state: 'open', version: 1 });
});

test('a legitimate re-claim after queue read fences a delayed pull without changing its successor', async () => {
  const first = await claim(await create()); await expire(first.task.id);
  let raced = false;
  const delayedDb: Database = {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.includes('SELECT t.id AS id,t.spec_json AS spec_json')) return statement;
      function wrap(bound: Statement): Statement {
        return {
          bind(...args) { return wrap(bound.bind(...args)); },
          async first<T>() {
            const row = await bound.first<T>();
            if (!raced && row) { raced = true; await claim(await read(first.task.id), ALPHA); }
            return row;
          },
          all<T>() { return bound.all<T>(); },
        };
      }
      return wrap(statement);
    },
    batch: statements => db.batch(statements),
  };
  const claimKey = key();
  await assert.rejects(new Workroom(delayedDb, BETA).tasks.claimNext(taskClaimNextSchema.parse({ schema_version: '1', room: ROOM,
    idempotency_key: claimKey })), (e: unknown) => e instanceof Fault && e.code === 'NOT_FOUND');
  assert.equal(raced, true);
  const current = await read(first.task.id);
  assert.equal(current.lease.holder_id, ALPHA);
  assert.equal(current.lease.lease_epoch, first.lease.lease_epoch + 1);
  assert.equal(current.task.version, first.task.version + 1);
  const rejected = await db.prepare('SELECT count(*) AS n FROM operations WHERE principal_id=? AND operation=\'task.claim_next\' AND key=?')
    .bind(BETA, claimKey).first<{ n: number }>();
  assert.equal(rejected?.n, 0);
});

test('stored spec corruption is rejected before any pull mutation commits', async () => {
  const id = crypto.randomUUID(), spec = JSON.stringify({ goal: 42, owner: null, dependencies: [], input_versions: [], done_conditions: ['checked'] });
  await db.batch([
    db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms)
      VALUES (?,?,?,NULL,?,'open',1,NULL,NULL,${DB_NOW},${DB_NOW})`).bind(id, ROOM, ALPHA, spec),
    db.prepare('INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES (?,NULL,0,0)').bind(id),
  ]);
  await assert.rejects(next());
  const row = await db.prepare('SELECT state,version FROM tasks WHERE id=?').bind(id).first<{ state: string; version: number }>();
  assert.deepEqual(row, { state: 'open', version: 1 });
  const lease = await db.prepare('SELECT holder_id,lease_epoch,expires_at_ms FROM task_leases WHERE task_id=?').bind(id).first();
  assert.deepEqual(lease, { holder_id: null, lease_epoch: 0, expires_at_ms: 0 });
});
