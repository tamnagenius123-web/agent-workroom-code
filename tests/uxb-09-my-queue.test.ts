import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { harness } from '../scripts/local-harness.ts';
import { proposeItem } from '../src/server/memory-items.ts';

// UXB-09: workroom_my_queue is one read for the authenticated caller.
// tasks: owner_id is the caller, or the caller holds the lease.
// reviews: pending memory items the caller is listed to review and did not propose.
// handoffs: handoff_receipts in this room whose consumer_id is the caller.
// The tool is called through tools/call. A missing tool has no structured data, so the id lists fail.

const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const ALPHA_ID = 'synthetic:alpha';
const BETA_ID = 'synthetic:beta';
const ROOM = 'room_main';
const T0 = '2026-10-01T00:00:00.000Z';
const REVIEW_A = 'review-for-alpha';
const REVIEW_B = 'review-for-beta';
const HANDOFF_A = 'handoff-for-alpha';
const HANDOFF_B = 'handoff-for-beta';

type App = Awaited<ReturnType<typeof harness>>;
interface Rpc {
  result?: {
    isError?: boolean;
    structuredContent?: { ok?: boolean; data?: QueueData };
  };
}
interface QueueData {
  tasks?: { id: string }[];
  reviews?: { id: string }[];
  handoffs?: { id: string }[];
}
interface Queue {
  tasks: string[];
  reviews: string[];
  handoffs: string[];
}
interface TaskEnvelope {
  ok?: boolean;
  data?: {
    task: { id: string; owner_id: string | null; state: string; version: number };
    lease: { holder_id: string | null; lease_epoch: number };
  };
  error?: { code?: string };
}

let app: App;
let taskOwnedByA = '';
let taskHeldByA = '';
let taskOwnedByB = '';

function ids(rows: { id: string }[] | undefined): string[] {
  return (rows ?? []).map(row => row.id).sort();
}

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

async function myQueue(token: string): Promise<Queue> {
  const res = await rpc(token, 'tools/call', {
    name: 'workroom_my_queue',
    arguments: { schema_version: '1', room: ROOM },
  });
  const data = res.body.result?.structuredContent?.data;
  return { tasks: ids(data?.tasks), reviews: ids(data?.reviews), handoffs: ids(data?.handoffs) };
}

async function taskApi(path: string, body: object | undefined, key: string, token: string): Promise<{ status: number; body: TaskEnvelope }> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: body ? JSON.stringify({ schema_version: '1', ...body }) : undefined,
  });
  return { status: response.status, body: await response.json() as TaskEnvelope };
}

async function makeTask(owner: string | null, goal: string, key: string, token: string): Promise<string> {
  const created = await taskApi('/rooms/' + ROOM + '/tasks', {
    goal,
    done_conditions: ['recorded'],
    ...(owner === null ? {} : { owner }),
  }, key, token);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.data?.task.owner_id ?? null, owner);
  assert.equal(created.body.data?.task.state, 'open');
  assert.equal(created.body.data?.lease.holder_id ?? null, null);
  return created.body.data!.task.id;
}

async function claim(id: string, token: string, holder: string): Promise<void> {
  const claimed = await taskApi('/rooms/' + ROOM + '/tasks/' + id + '/claim', {
    expected_version: 1,
    lease_epoch: 0,
  }, 'claim-' + id, token);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.data?.task.state, 'in_progress');
  assert.equal(claimed.body.data?.lease.holder_id, holder);
}

before(async () => {
  app = await harness({ through: 9999 });
  await app.db.batch([
    app.db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-src-a','room_main','synthetic:beta','source for alpha review','text',?)").bind(T0),
    app.db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('msg-src-b','room_main','synthetic:alpha','source for beta review','text',?)").bind(T0),
    app.db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('synthetic:alpha', ?)").bind(T0),
    app.db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('synthetic:beta', ?)").bind(T0),
    // Recorded by the other agent, so principal_id is not the addressee. consumer_id is.
    app.db.prepare(`INSERT INTO handoff_receipts(id,room_id,principal_id,consumer_id,checkpoint_hash,wake_stage_id,injection_receipt_id,proven_live,attempt_json,result_json,idempotency_key,recorded_at)
      VALUES (?,?,?,?,?,?,?,0,'{}','{}',?,?)`).bind(HANDOFF_A, ROOM, BETA_ID, ALPHA_ID, 'a'.repeat(64), 'stage-alpha', 'inj-alpha', 'handoff-key-alpha', 1_700_000_000_000),
    app.db.prepare(`INSERT INTO handoff_receipts(id,room_id,principal_id,consumer_id,checkpoint_hash,wake_stage_id,injection_receipt_id,proven_live,attempt_json,result_json,idempotency_key,recorded_at)
      VALUES (?,?,?,?,?,?,?,0,'{}','{}',?,?)`).bind(HANDOFF_B, ROOM, ALPHA_ID, BETA_ID, 'b'.repeat(64), 'stage-beta', 'inj-beta', 'handoff-key-beta', 1_700_000_000_001),
  ]);
  const awaitingA = await proposeItem(app.db, BETA_ID, {
    id: REVIEW_A, room_id: ROOM, kind: 'fact', tier: 0, title: 'Awaiting alpha', body: 'Beta proposed this for alpha to review.',
    source_message_id: 'msg-src-a', valid_from: T0,
  });
  const awaitingB = await proposeItem(app.db, ALPHA_ID, {
    id: REVIEW_B, room_id: ROOM, kind: 'fact', tier: 0, title: 'Awaiting beta', body: 'Alpha proposed this for beta to review.',
    source_message_id: 'msg-src-b', valid_from: T0,
  });
  assert.equal(awaitingA.review_state, 'pending');
  assert.equal(awaitingA.proposed_by, BETA_ID);
  assert.equal(awaitingB.review_state, 'pending');
  assert.equal(awaitingB.proposed_by, ALPHA_ID);
  // Creator is the other agent, so the queue cannot key off creator_id.
  taskOwnedByA = await makeTask(ALPHA_ID, 'owned by alpha', 'task-owned-by-alpha', BETA);
  taskHeldByA = await makeTask(null, 'held by alpha', 'task-held-by-alpha', BETA);
  taskOwnedByB = await makeTask(BETA_ID, 'owned by beta', 'task-owned-by-beta', ALPHA);
  await claim(taskHeldByA, ALPHA, ALPHA_ID);
  await claim(taskOwnedByB, BETA, BETA_ID);
});

after(async () => { await app?.close(); });

test('my_queue for A returns the task A owns, the task A holds, the review awaiting A, and the handoff addressed to A', async () => {
  assert.deepEqual(await myQueue(ALPHA), {
    tasks: [taskOwnedByA, taskHeldByA].sort(),
    reviews: [REVIEW_A],
    handoffs: [HANDOFF_A],
  });
});

test('my_queue for A excludes B, and my_queue for B returns only B', async () => {
  const forA = await myQueue(ALPHA);
  for (const id of [taskOwnedByB, REVIEW_B, HANDOFF_B]) {
    assert.equal(forA.tasks.includes(id) || forA.reviews.includes(id) || forA.handoffs.includes(id), false, id);
  }
  assert.deepEqual(await myQueue(BETA), {
    tasks: [taskOwnedByB],
    reviews: [REVIEW_B],
    handoffs: [HANDOFF_B],
  });
});
