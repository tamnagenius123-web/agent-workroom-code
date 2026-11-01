import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { harness } from '../scripts/local-harness.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import { taskSchemas } from '../src/server/task-contracts.ts';
import { Tasks } from '../src/server/tasks.ts';

type Bundle = Awaited<ReturnType<Tasks['get']>>['data'];
interface Listed { id: string; state: string; dep_ids: string[] }
interface Body { ok: boolean; data: Bundle & { tasks?: Listed[] }; error?: { code: string } }

let app: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { app = await harness(); });
afterEach(async () => { await app.close(); });

const collection = '/rooms/room_main/tasks';
const ALPHA = 'local-alpha-fixture';

async function api(path: string, body?: object, key?: string, token = ALPHA) {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify({ schema_version: '1', ...body }) : undefined,
  });
  return { status: response.status, body: await response.json() as Body };
}

async function create(extra: object = {}) {
  const made = await api(collection, { goal: 'goal', done_conditions: ['verified'], ...extra }, crypto.randomUUID());
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body.data;
}

const act = (id: string, name: string, body: object, key = crypto.randomUUID()) => api(collection + '/' + id + '/' + name, body, key);

function serviceTasks(): Tasks {
  return new Workroom(app.db as unknown as Database, 'synthetic:alpha').tasks;
}

async function domainFault(run: () => Promise<unknown>): Promise<Fault> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Fault, error instanceof Error ? error.message : String(error));
    return error;
  }
  assert.fail('expected a domain fault');
}

test('UXB-05 state=blocked lists a task with two unmet deps and omits an unblocked task', async () => {
  const depA = await create();
  const depB = await create();
  const blocked = await create({ dependencies: [depA.task.id, depB.task.id] });
  const free = await create();
  assert.equal(free.task.state, 'open');
  assert.notEqual(depA.task.state, 'done');
  assert.notEqual(depB.task.state, 'done');
  // Claim refuses unmet deps, so this row is marked blocked directly. Both dependencies stay open.
  try {
    await app.db.prepare("UPDATE tasks SET state='blocked', version=version+1, updated_at_ms=updated_at_ms+1 WHERE id=? AND state='open'").bind(blocked.task.id).run();
  } catch (error) {
    assert.fail(error instanceof Error ? error.message : String(error));
  }
  const stored = await api(collection + '/' + blocked.task.id);
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  assert.equal(stored.body.data.task.state, 'blocked');
  assert.deepEqual(stored.body.data.task.dependencies, [depA.task.id, depB.task.id]);

  const listed = await api(collection + '?state=blocked');
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const rows = listed.body.data?.tasks;
  assert.ok(Array.isArray(rows), JSON.stringify(listed.body));
  assert.equal(rows.length, 1);
  const hit = rows.find(row => row.id === blocked.task.id);
  assert.ok(hit, JSON.stringify(rows));
  assert.equal(hit.state, 'blocked');
  assert.deepEqual(hit.dep_ids, [depA.task.id, depB.task.id]);
  assert.equal(rows.some(row => row.id === free.task.id), false);
});

test('UXB-05 DEPENDENCY_CONFLICT details.dep_ids equals the unmet dependency ids', async () => {
  const depA = await create();
  const depB = await create();
  const child = await create({ dependencies: [depA.task.id, depB.task.id] });
  const fault = await domainFault(() => serviceTasks().action('claim', taskSchemas.claim.parse({
    schema_version: '1', room: 'room_main', task_id: child.task.id,
    expected_version: child.task.version, lease_epoch: child.lease.lease_epoch,
    idempotency_key: crypto.randomUUID(),
  })));
  assert.equal(fault.code, 'DEPENDENCY_CONFLICT');
  assert.equal(fault.status, 409);
  assert.deepEqual(fault.details.dep_ids, [depA.task.id, depB.task.id]);
});

test('UXB-05 VERSION_CONFLICT details.current_version is the stored task version', async () => {
  const open = await create();
  const claimed = await act(open.task.id, 'claim', { expected_version: open.task.version, lease_epoch: open.lease.lease_epoch });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const fault = await domainFault(() => serviceTasks().action('renew', taskSchemas.renew.parse({
    schema_version: '1', room: 'room_main', task_id: open.task.id,
    expected_version: claimed.body.data.task.version - 1,
    lease_epoch: claimed.body.data.lease.lease_epoch,
    idempotency_key: crypto.randomUUID(),
  })));
  assert.equal(fault.code, 'VERSION_CONFLICT');
  assert.equal(fault.status, 409);
  assert.equal(fault.details.current_version, claimed.body.data.task.version);
});

test('UXB-05 LEASE_CONFLICT details.lease_epoch is the current lease epoch', async () => {
  const open = await create();
  const claimed = await act(open.task.id, 'claim', { expected_version: open.task.version, lease_epoch: open.lease.lease_epoch });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const fault = await domainFault(() => serviceTasks().action('renew', taskSchemas.renew.parse({
    schema_version: '1', room: 'room_main', task_id: open.task.id,
    expected_version: claimed.body.data.task.version,
    lease_epoch: claimed.body.data.lease.lease_epoch + 1,
    idempotency_key: crypto.randomUUID(),
  })));
  assert.equal(fault.code, 'LEASE_CONFLICT');
  assert.equal(fault.status, 409);
  assert.equal(fault.details.lease_epoch, claimed.body.data.lease.lease_epoch);
});
