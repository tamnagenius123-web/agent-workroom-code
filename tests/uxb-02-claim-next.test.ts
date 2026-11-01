import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { harness } from '../scripts/local-harness.ts';
import { DB_NOW } from '../src/server/tasks.ts';

// UXB-02 workroom_task_claim_next { room, idempotency_key }:
// claim the oldest open task in the room whose dependencies are all done and
// whose owner is the caller or null. Lease matches workroom_task_claim
// (in_progress, epoch + 1, holder, 30s server lease). The key replays like task create.

const TOOL = 'workroom_task_claim_next';
const ROOM = 'room_main';
const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const PRINCIPALS: Record<string, string> = { [ALPHA]: 'synthetic:alpha', [BETA]: 'synthetic:beta' };
const LEASE_MS = 30000;

interface TaskView {
  id: string;
  state: string;
  version: number;
  owner_id: string | null;
  dependencies: string[];
  created_at_ms: number;
  current_submission_id: string | null;
}
interface LeaseView { holder_id: string | null; lease_epoch: number; expires_at_ms: number }
interface Bundle {
  task: TaskView;
  lease: LeaseView;
  submission: unknown;
  server_time_ms: number;
  lease_active: boolean;
}
interface Body {
  ok: boolean;
  data?: Bundle | null;
  meta?: { replayed?: boolean };
  error?: { code?: string };
}

let app: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { app = await harness(); });
afterEach(async () => { await app.close(); });

const collection = '/rooms/room_main/tasks';

async function api(path: string, body?: object, key?: string, token = ALPHA) {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify({ schema_version: '1', ...body }) : undefined,
  });
  return { status: response.status, body: await response.json() as Body };
}

async function create(extra: object = {}, key: string = crypto.randomUUID()): Promise<Bundle> {
  const made = await api(collection, { goal: 'goal', done_conditions: ['verified'], ...extra }, key);
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.ok(made.body.data?.task, JSON.stringify(made.body));
  return made.body.data;
}

async function get(id: string, token = ALPHA): Promise<Bundle> {
  const loaded = await api(collection + '/' + id, undefined, undefined, token);
  assert.equal(loaded.status, 200, JSON.stringify(loaded.body));
  assert.ok(loaded.body.data?.task, JSON.stringify(loaded.body));
  return loaded.body.data;
}

const claimExisting = (task: Bundle, key: string, token = ALPHA) => api(
  collection + '/' + task.task.id + '/claim',
  { expected_version: task.task.version, lease_epoch: task.lease.lease_epoch },
  key,
  token,
);

async function serverNow(): Promise<number> {
  const row = await app.db.prepare(`SELECT ${DB_NOW} AS ms`).first<{ ms: number }>();
  assert.ok(row);
  assert.equal(typeof row.ms, 'number');
  return row.ms;
}

/** Next create is strictly newer than `previous` on the server clock. */
async function createNewer(previous: number | null, extra: object = {}, key?: string): Promise<Bundle> {
  if (previous !== null) {
    const deadline = Date.now() + 2500;
    for (;;) {
      const now = await serverNow();
      if (now > previous) break;
      assert.ok(Date.now() < deadline, `server clock stayed at ${now}`);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  const made = await create(extra, key);
  const stored = await get(made.task.id);
  const createdAt = Number(stored.task.created_at_ms);
  assert.ok(Number.isFinite(createdAt) && createdAt > 0, String(stored.task.created_at_ms));
  if (previous !== null) assert.ok(createdAt > previous, `${createdAt} is not after ${previous}`);
  stored.task.created_at_ms = createdAt;
  return stored;
}

function envelope(result: unknown): Body {
  assert.ok(result && typeof result === 'object', `${TOOL} returned no result`);
  const record = result as { structuredContent?: unknown; content?: { type?: string; text?: string }[] };
  const structured = record.structuredContent;
  if (structured && typeof structured === 'object') return structured as Body;
  const text = record.content?.find(part => part.type === 'text')?.text;
  if (typeof text !== 'string') assert.fail(`${TOOL} result had no JSON body: ${JSON.stringify(result)}`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { assert.fail(`${TOOL} result was not JSON`); }
  assert.ok(parsed && typeof parsed === 'object', text);
  return parsed as Body;
}

/** Dispatch workroom_task_claim_next. A missing tool rejects the MCP call; that becomes an assertion failure. */
async function claimNext(token: string, key: string): Promise<Body> {
  const client = new Client({ name: 'uxb-02', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', app.url), {
    requestInit: { headers: { Authorization: 'Bearer ' + token } },
  }));
  try {
    let result: unknown;
    try {
      result = await client.callTool({
        name: TOOL,
        arguments: { schema_version: '1', room: ROOM, idempotency_key: key },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.fail(`${TOOL} dispatch failed: ${message}`);
    }
    return envelope(result);
  } finally {
    await client.close();
  }
}

function assertClearEmpty(body: Body) {
  const notFound = body.ok === false && body.error?.code === 'NOT_FOUND';
  const empty = body.ok === true && (body.data == null || body.data.task == null);
  assert.ok(notFound || empty, `expected NOT_FOUND or an empty task, got ${JSON.stringify(body)}`);
}

function assertClaim(body: Body, token: string, source: Bundle) {
  assert.equal(body.ok, true, JSON.stringify(body));
  const data = body.data;
  assert.ok(data?.task, JSON.stringify(body));
  assert.equal(data.task.id, source.task.id);
  assert.equal(data.task.state, 'in_progress');
  assert.equal(data.task.version, source.task.version + 1);
  assert.equal(data.task.owner_id, source.task.owner_id);
  assert.equal(data.task.current_submission_id, null);
  assert.equal('lease_epoch' in data.task, false);
  assert.equal(data.lease.holder_id, PRINCIPALS[token]);
  assert.equal(data.lease.lease_epoch, source.lease.lease_epoch + 1);
  assert.equal(data.lease_active, true);
  assert.equal(data.submission, null);
  assert.equal(data.lease.expires_at_ms - data.server_time_ms, LEASE_MS);
}

async function assertStillOpen(source: Bundle) {
  const stored = await get(source.task.id);
  assert.equal(stored.task.state, 'open');
  assert.equal(stored.task.version, source.task.version);
  assert.equal(stored.task.owner_id, source.task.owner_id);
  assert.equal(stored.lease.holder_id, null);
  assert.equal(stored.lease.lease_epoch, source.lease.lease_epoch);
  return stored;
}

test('UXB-02 two agents racing claim_next take two distinct eligible tasks', async () => {
  const first = await create({}, 'uxb02-race-create-01');
  const second = await create({}, 'uxb02-race-create-02');
  const [alpha, beta] = await Promise.all([
    claimNext(ALPHA, 'uxb02-race-alpha-01'),
    claimNext(BETA, 'uxb02-race-beta-001'),
  ]);
  assert.equal(alpha.ok, true, JSON.stringify(alpha));
  assert.equal(beta.ok, true, JSON.stringify(beta));
  assert.ok(alpha.data?.task && beta.data?.task, JSON.stringify({ alpha, beta }));
  assert.deepEqual([alpha.data.task.id, beta.data.task.id].sort(), [first.task.id, second.task.id].sort());
  const byCaller = new Map([[PRINCIPALS[ALPHA], alpha], [PRINCIPALS[BETA], beta]]);
  for (const [principal, body] of byCaller) {
    assert.equal(body.data!.lease.holder_id, principal);
    assert.equal(body.data!.task.state, 'in_progress');
    assert.equal(body.data!.task.version, 2);
    assert.equal(body.data!.lease.lease_epoch, 1);
    assert.equal(body.data!.lease_active, true);
    assert.equal(body.data!.submission, null);
    assert.equal(body.data!.lease.expires_at_ms - body.data!.server_time_ms, LEASE_MS);
    const stored = await get(body.data!.task.id);
    assert.equal(stored.task.state, 'in_progress');
    assert.equal(stored.lease.holder_id, principal);
    assert.equal(stored.lease.lease_epoch, 1);
    assert.equal(stored.task.version, 2);
  }
  const none = await claimNext(ALPHA, 'uxb02-race-none-0001');
  assertClearEmpty(none);
});

test('UXB-02 replaying the same claim_next key returns the same task', async () => {
  const older = await create({}, 'uxb02-replay-create-1');
  const newer = await create({}, 'uxb02-replay-create-2');
  const key = 'uxb02-replay-key-0001';
  const first = await claimNext(ALPHA, key);
  const won = first.ok && first.data?.task.id === newer.task.id ? newer : older;
  assertClaim(first, ALPHA, won);
  assert.equal(first.meta?.replayed, false, JSON.stringify(first));
  const again = await claimNext(ALPHA, key);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.meta?.replayed, true, JSON.stringify(again));
  assert.equal(again.data?.task.id, won.task.id);
  assert.equal(again.data?.lease.holder_id, PRINCIPALS[ALPHA]);
  assert.equal(again.data?.lease.lease_epoch, won.lease.lease_epoch + 1);
  assert.equal(again.data?.task.version, won.task.version + 1);
  const stored = await get(won.task.id);
  assert.equal(stored.task.version, won.task.version + 1);
  assert.equal(stored.lease.lease_epoch, won.lease.lease_epoch + 1);
  assert.equal(stored.lease.holder_id, PRINCIPALS[ALPHA]);
  await assertStillOpen(won.task.id === older.task.id ? newer : older);
});

test('UXB-02 an open task whose dependency is not done stays unclaimed', async () => {
  const dep = await create({}, 'uxb02-dep-parent-001');
  const child = await create({ dependencies: [dep.task.id] }, 'uxb02-dep-child-0001');
  assert.equal(child.task.state, 'open');
  assert.deepEqual(child.task.dependencies, [dep.task.id]);
  assert.notEqual(dep.task.state, 'done');
  const held = await claimExisting(dep, 'uxb02-dep-hold-00001');
  assert.equal(held.status, 200, JSON.stringify(held.body));
  assert.equal(held.body.data?.task.state, 'in_progress');
  const none = await claimNext(ALPHA, 'uxb02-dep-skip-00001');
  assertClearEmpty(none);
  await assertStillOpen(child);
  const parent = await get(dep.task.id);
  assert.equal(parent.task.state, 'in_progress');
  assert.notEqual(parent.task.state, 'done');
  assert.equal(parent.lease.holder_id, PRINCIPALS[ALPHA]);
  assert.equal(parent.lease.lease_epoch, dep.lease.lease_epoch + 1);
});

test('UXB-02 a task owned by another principal stays unclaimed', async () => {
  const theirs = await createNewer(null, { owner: 'synthetic:beta' }, 'uxb02-own-beta-0001');
  const open = await createNewer(theirs.task.created_at_ms, {}, 'uxb02-own-free-0001');
  assert.equal(theirs.task.owner_id, 'synthetic:beta');
  assert.equal(open.task.owner_id, null);
  assert.ok(theirs.task.created_at_ms < open.task.created_at_ms);
  const claimed = await claimNext(ALPHA, 'uxb02-own-alpha-0001');
  assertClaim(claimed, ALPHA, open);
  await assertStillOpen(theirs);
  const none = await claimNext(ALPHA, 'uxb02-own-none-00001');
  assertClearEmpty(none);
  await assertStillOpen(theirs);
  const byOwner = await claimNext(BETA, 'uxb02-own-beta-claim1');
  assertClaim(byOwner, BETA, theirs);
  const stored = await get(theirs.task.id, BETA);
  assert.equal(stored.lease.holder_id, PRINCIPALS[BETA]);
  assert.equal(stored.task.state, 'in_progress');
  assert.equal(stored.task.owner_id, 'synthetic:beta');
});

test('UXB-02 claim_next claims the oldest open eligible task first', async () => {
  const oldest = await createNewer(null, {}, 'uxb02-age-create-001');
  const middle = await createNewer(oldest.task.created_at_ms, {}, 'uxb02-age-create-002');
  const newest = await createNewer(middle.task.created_at_ms, {}, 'uxb02-age-create-003');
  assert.ok(oldest.task.created_at_ms < middle.task.created_at_ms);
  assert.ok(middle.task.created_at_ms < newest.task.created_at_ms);
  const first = await claimNext(ALPHA, 'uxb02-age-claim-0001');
  assertClaim(first, ALPHA, oldest);
  await assertStillOpen(middle);
  await assertStillOpen(newest);
  const second = await claimNext(ALPHA, 'uxb02-age-claim-0002');
  assertClaim(second, ALPHA, middle);
  await assertStillOpen(newest);
  const third = await claimNext(ALPHA, 'uxb02-age-claim-0003');
  assertClaim(third, ALPHA, newest);
  const none = await claimNext(ALPHA, 'uxb02-age-none-00001');
  assertClearEmpty(none);
});

test('UXB-02 claim_next with no eligible task returns NOT_FOUND or an empty result', async () => {
  const none = await claimNext(ALPHA, 'uxb02-empty-room-001');
  assertClearEmpty(none);
  const count = await app.db.prepare('SELECT count(*) AS n FROM tasks').first<{ n: number }>();
  assert.equal(count?.n, 0);
  const only = await create({}, 'uxb02-empty-create-01');
  const held = await claimExisting(only, 'uxb02-empty-hold-001');
  assert.equal(held.status, 200, JSON.stringify(held.body));
  const busy = await claimNext(ALPHA, 'uxb02-empty-busy-001');
  assertClearEmpty(busy);
  const stored = await get(only.task.id);
  assert.equal(stored.task.state, 'in_progress');
  assert.equal(stored.task.version, only.task.version + 1);
  assert.equal(stored.lease.holder_id, PRINCIPALS[ALPHA]);
  assert.equal(stored.lease.lease_epoch, only.lease.lease_epoch + 1);
});
