import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { harness } from '../scripts/local-harness.ts';

// UXB-09 rev2. workroom_my_queue is still one tools/call read for the caller.
// A held task is actionable only while the single-task read reports lease_active.
// Done and canceled tasks are finished, so ownership does not keep them in the list.
// A handoff receipt addressed to the caller stays listed only while it is unacknowledged.
// result_json.acknowledged true is that acknowledgement. '{}' (the UXB-09 fixture shape) is not.

const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const HUMAN = 'local-human-fixture';
const ALPHA_ID = 'synthetic:alpha';
const BETA_ID = 'synthetic:beta';
const ROOM = 'room_main';
const HANDOFF_UNACK = 'handoff-rev2-unack';
const HANDOFF_ACK = 'handoff-rev2-ack';

type App = Awaited<ReturnType<typeof harness>>;
interface Rpc {
  result?: {
    isError?: boolean;
    structuredContent?: { ok?: boolean; data?: QueueData & TaskRead };
  };
}
interface TaskItem { id: string; state?: string; lease_active?: boolean }
interface QueueData {
  tasks?: TaskItem[];
  reviews?: { id: string }[];
  handoffs?: { id: string }[];
}
interface TaskRead {
  task: { id: string; owner_id: string | null; state: string; version: number };
  lease: { holder_id: string | null; lease_epoch: number; expires_at_ms: number };
  submission: { id: string; artifact_message_id: string; artifact_revision: number } | null;
  lease_active: boolean;
}
interface Envelope { ok?: boolean; data?: TaskRead & { message?: { id: string } } }

let app: App;
let taskOpenOwned = '';
let taskHeldActive = '';
let taskHeldExpired = '';
let taskDone = '';
let taskCanceled = '';

async function rpc(token: string, method: string, params: Record<string, unknown>): Promise<{ status: number; body: Rpc }> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'MCP-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await response.text();
  const raw = text.includes('\ndata:') ? (text.split('\n').find(line => line.startsWith('data:'))?.slice(5) ?? '') : text;
  let body: Rpc = {};
  try { body = JSON.parse(raw) as Rpc; } catch { body = {}; }
  return { status: response.status, body };
}

async function rest(path: string, body: object | undefined, key: string, token: string): Promise<{ status: number; body: Envelope }> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify({ schema_version: '1', ...body }) : undefined,
  });
  return { status: response.status, body: await response.json() as Envelope };
}

async function myQueue(token: string): Promise<Required<QueueData>> {
  const res = await rpc(token, 'tools/call', {
    name: 'workroom_my_queue',
    arguments: { schema_version: '1', room: ROOM },
  });
  assert.equal(res.body.result?.isError, false, JSON.stringify(res.body));
  const data = res.body.result?.structuredContent?.data;
  return { tasks: data?.tasks ?? [], reviews: data?.reviews ?? [], handoffs: data?.handoffs ?? [] };
}

async function taskGet(token: string, id: string): Promise<TaskRead> {
  const res = await rpc(token, 'tools/call', {
    name: 'workroom_task_get',
    arguments: { schema_version: '1', room: ROOM, task_id: id },
  });
  assert.equal(res.body.result?.isError, false, JSON.stringify(res.body));
  const data = res.body.result?.structuredContent?.data;
  assert.ok(data?.task, JSON.stringify(res.body));
  return data;
}

async function makeTask(owner: string | null, goal: string, key: string, token: string): Promise<TaskRead> {
  const created = await rest('/rooms/' + ROOM + '/tasks', {
    goal,
    done_conditions: ['recorded'],
    ...(owner === null ? {} : { owner }),
  }, key, token);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data?.task.owner_id ?? null, owner);
  assert.equal(created.body.data?.task.state, 'open');
  return created.body.data!;
}

async function claim(task: TaskRead, token: string, holder: string, key: string): Promise<TaskRead> {
  const claimed = await rest('/rooms/' + ROOM + '/tasks/' + task.task.id + '/claim', {
    expected_version: task.task.version,
    lease_epoch: task.lease.lease_epoch,
  }, key, token);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.data?.task.state, 'in_progress');
  assert.equal(claimed.body.data?.lease.holder_id, holder);
  return claimed.body.data!;
}

before(async () => {
  app = await harness({ through: 9999 });
  await app.db.batch([
    app.db.prepare(`INSERT INTO handoff_receipts(id,room_id,principal_id,consumer_id,checkpoint_hash,wake_stage_id,injection_receipt_id,proven_live,attempt_json,result_json,idempotency_key,recorded_at)
      VALUES (?,?,?,?,?,?,?,0,'{}',?,?,?)`).bind(HANDOFF_UNACK, ROOM, BETA_ID, ALPHA_ID, 'c'.repeat(64), 'stage-rev2-unack', 'inj-rev2-unack', '{}', 'handoff-rev2-unack', 1_700_000_100_000),
    app.db.prepare(`INSERT INTO handoff_receipts(id,room_id,principal_id,consumer_id,checkpoint_hash,wake_stage_id,injection_receipt_id,proven_live,attempt_json,result_json,idempotency_key,recorded_at)
      VALUES (?,?,?,?,?,?,?,0,'{}',?,?,?)`).bind(HANDOFF_ACK, ROOM, BETA_ID, ALPHA_ID, 'd'.repeat(64), 'stage-rev2-ack', 'inj-rev2-ack', JSON.stringify({ acknowledged: true }), 'handoff-rev2-ack', 1_700_000_100_001),
  ]);

  const openOwned = await makeTask(ALPHA_ID, 'open owned by alpha', 'task-rev2-open-owned', BETA);
  const heldActive = await claim(await makeTask(null, 'held by alpha', 'task-rev2-held-active', BETA), ALPHA, ALPHA_ID, 'claim-rev2-held-active');
  const heldExpired = await claim(await makeTask(null, 'expired hold by alpha', 'task-rev2-held-expired', BETA), ALPHA, ALPHA_ID, 'claim-rev2-held-expired');
  await app.db.prepare('UPDATE task_leases SET expires_at_ms=0 WHERE task_id=?').bind(heldExpired.task.id).run();

  const doneClaimed = await claim(await makeTask(ALPHA_ID, 'done owned by alpha', 'task-rev2-done', ALPHA), ALPHA, ALPHA_ID, 'claim-rev2-done');
  const posted = await rest('/rooms/' + ROOM + '/messages', { text: 'done artifact', format: 'text' }, 'msg-rev2-done-art', ALPHA);
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const submitted = await rest('/rooms/' + ROOM + '/tasks/' + doneClaimed.task.id + '/submit', {
    expected_version: doneClaimed.task.version,
    lease_epoch: doneClaimed.lease.lease_epoch,
    artifact_message_id: posted.body.data!.message!.id,
    artifact_revision: 1,
    disposition: 'review',
  }, 'submit-rev2-done', ALPHA);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.data?.task.state, 'review');
  const approved = await rest('/rooms/' + ROOM + '/tasks/' + doneClaimed.task.id + '/approve', {
    expected_version: submitted.body.data!.task.version,
    submission_id: submitted.body.data!.submission!.id,
    artifact_message_id: submitted.body.data!.submission!.artifact_message_id,
    artifact_revision: submitted.body.data!.submission!.artifact_revision,
  }, 'approve-rev2-done', HUMAN);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data?.task.state, 'done');
  assert.equal(approved.body.data?.task.owner_id, ALPHA_ID);

  // Creator beta cancels at the create version. Owner alpha is not the cancel actor. The task is never claimed, so holder stays null.
  const cancelOwned = await makeTask(ALPHA_ID, 'canceled owned by alpha', 'task-rev2-canceled', BETA);
  const canceled = await rest('/rooms/' + ROOM + '/tasks/' + cancelOwned.task.id + '/cancel', {
    expected_version: cancelOwned.task.version,
    reason: 'stop this work',
  }, 'cancel-rev2-owned', BETA);
  assert.equal(canceled.status, 200, JSON.stringify(canceled.body));
  assert.equal(canceled.body.data?.task.state, 'canceled');
  assert.equal(canceled.body.data?.task.owner_id, ALPHA_ID);
  assert.equal(canceled.body.data?.lease.holder_id ?? null, null);

  taskOpenOwned = openOwned.task.id;
  taskHeldActive = heldActive.task.id;
  taskHeldExpired = heldExpired.task.id;
  taskDone = doneClaimed.task.id;
  taskCanceled = cancelOwned.task.id;
});

after(async () => { await app?.close(); });

test('a task I hold whose lease has expired is not an actionable held item in my_queue', async () => {
  const read = await taskGet(ALPHA, taskHeldExpired);
  assert.equal(read.task.state, 'in_progress');
  assert.equal(read.lease.holder_id, ALPHA_ID);
  assert.equal(read.lease_active, false);
  const queue = await myQueue(ALPHA);
  assert.equal(queue.tasks.some(item => item.id === taskHeldActive), true, JSON.stringify(queue.tasks));
  assert.equal(queue.tasks.some(item => item.id === taskHeldExpired), false, JSON.stringify(queue.tasks));
});

test('done and canceled tasks I own do not appear in my_queue', async () => {
  const queue = await myQueue(ALPHA);
  assert.equal(queue.tasks.some(item => item.id === taskOpenOwned), true, JSON.stringify(queue.tasks));
  assert.deepEqual(queue.tasks.map(item => item.id).filter(id => id === taskDone || id === taskCanceled).sort(), []);
});

test('an acknowledged handoff to me is omitted and an unacknowledged handoff is listed', async () => {
  const queue = await myQueue(ALPHA);
  assert.deepEqual(queue.handoffs.map(item => item.id).sort(), [HANDOFF_UNACK]);
});

test('each my_queue task item carries state and lease_active from the single-task read', async () => {
  const queue = await myQueue(ALPHA);
  assert.ok(queue.tasks.length > 0, JSON.stringify(queue));
  for (const item of queue.tasks) {
    const read = await taskGet(ALPHA, item.id);
    assert.equal(item.state, read.task.state, item.id);
    assert.equal(typeof item.lease_active, 'boolean', item.id);
    assert.equal(item.lease_active, read.lease_active, item.id);
  }
});
