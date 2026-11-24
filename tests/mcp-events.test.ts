import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { harness } from '../scripts/local-harness.ts';
import { Fault, ROOM } from '../src/server/contracts.ts';
import { DOTS, DIRECT_MENTION, type IsolatedEventsBindings } from '../src/server/mcp-events.ts';
import { isolatedMcpEvents } from '../src/server/mcp-events-isolated.ts';

const callback = 'https://receiver.example.test/isolated';
const fixtureKey = (value: number) => Buffer.alloc(24, value);
const secret = (value: number) => 'whsec_' + fixtureKey(value).toString('base64');
const subscription = (value = 9) => ({
  name: DIRECT_MENTION, arguments: { room: ROOM },
  delivery: { mode: 'webhook', url: callback, secret: secret(value) }, cursor: null,
});
type Delivery = Parameters<IsolatedEventsBindings['send']>[0];

async function fixture() {
  const dbApp = await harness({ through: 9999 });
  const { db } = dbApp;
  const schema = await readFile('tests/fixtures/mcp-events/schema.sql', 'utf8');
  await db.batch(schema.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO principals(id) VALUES (?)').bind(DOTS),
    db.prepare('INSERT OR IGNORE INTO memberships(principal_id,room_id,can_post) VALUES (?,?,0)').bind(DOTS, ROOM),
    db.prepare('INSERT OR IGNORE INTO agent_aliases(alias,principal_id) VALUES (?,?)').bind('dots', DOTS),
  ]);

  const k = randomBytes(32);
  const env = { DB: db };
  const deliveries: Delivery[] = [];
  let now = Date.now();
  let revoked = false;
  let verifyMatches = true;
  let responseStatus = 204;
  let pauseVerification: (() => Promise<void>) | undefined;
  const bindings: IsolatedEventsBindings = {
    now: () => now,
    connection: async (request, principal) => principal === DOTS ? request.headers.get('x-fixture-grant') : null,
    active: async (grant, principal, room) => !revoked && ['fixture-grant-a','fixture-grant-b'].includes(grant) && principal === DOTS && room === ROOM,
    async seal(id, value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', k, nonce).setAAD(Buffer.from(id));
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64');
    },
    async open(id, value) {
      const data = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', k, data.subarray(0, 12))
        .setAAD(Buffer.from(id)).setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    },
    async send(post) {
      assert.equal(post.url, callback);
      deliveries.push(post);
      if (!post.verify) return { status: responseStatus };
      await pauseVerification?.();
      const { challenge } = JSON.parse(post.body) as { challenge: string };
      return { status: 200, challenge: verifyMatches ? challenge : 'wrong-challenge' };
    },
  };
  const newWorker = () => isolatedMcpEvents(async request => {
    const credential = request.headers.get('Authorization');
    if (credential === 'fixture-dots') return { principal: DOTS, write: true };
    if (credential === 'fixture-dots-read') return { principal: DOTS, write: false };
    if (credential === 'fixture-sender') return { principal: 'synthetic:alpha', write: true };
    throw new Fault('UNAUTHORIZED', 'Synthetic authentication required.', 401);
  }, () => bindings, { legacy: () => true });
  let worker = newWorker();
  let pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); } };
  async function drain() {
    const work = pending;
    pending = [];
    await Promise.all(work);
  }
  async function rpc(method: string, params: object = {}, credential = 'fixture-dots', grant = 'fixture-grant-a', modern = true) {
    const version = '2026-07-28';
    const headers = {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: credential, 'x-fixture-grant': grant,
      ...(modern ? { 'MCP-Protocol-Version': version, 'Mcp-Method': method } : {}),
    };
    const response = await worker.fetch(new Request('https://workroom.example.test/mcp', {
      method: 'POST', headers, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method,
        params: modern ? { ...params, _meta: {
          'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {},
          ...((params as { _meta?: object })._meta ?? {}),
        } } : params,
      }),
    }), env, ctx);
    const raw = await response.text();
    const dataLine = raw.split('\n').find(line => line.startsWith('data: '));
    return { status: response.status, body: JSON.parse(dataLine ? dataLine.slice(6) : raw) as {
      result?: { capabilities?: Record<string, unknown>; events?: { name: string }[]; id?: string; cursor?: unknown; refreshBefore?: string };
      error?: { code: number; data?: { reason: string } };
    } };
  }
  async function post(key: string, text: string) {
    const response = await worker.fetch(new Request('https://workroom.example.test/api/v1/rooms/room_main/messages', {
      method: 'POST',
      headers: { Authorization: 'fixture-sender', 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ schema_version: '1', text }),
    }), env, ctx);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { message: { id: string } } };
    await drain();
    return body.data.message.id;
  }
  return {
    ...dbApp, rpc, post, deliveries,
    sweep: async (ms: number) => { now += ms; worker.scheduled(undefined, env, ctx); await drain(); },
    restart: () => { worker = newWorker(); },
    revoke: () => { revoked = true; },
    verifyMatches: (value: boolean) => { verifyMatches = value; },
    responseStatus: (value: number) => { responseStatus = value; },
    pauseVerification: (value: () => Promise<void>) => { pauseVerification = value; },
  };
}

function assertSignature(post: Delivery, value: number) {
  const id = post.headers.get('webhook-id');
  const ts = post.headers.get('webhook-timestamp');
  const mac = createHmac('sha256', fixtureKey(value)).update(`${id}.${ts}.${post.body}`).digest('base64');
  assert.ok(post.headers.get('webhook-signature')?.split(' ').includes('v1,' + mac));
}

test('authenticated MCP discovery and signed direct mention survive restart and retry', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const legacy = await f.rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  }, undefined, undefined, false);
  assert.deepEqual(legacy.body.result?.capabilities?.events, {});
  const discovery = await f.rpc('server/discover');
  assert.deepEqual(discovery.body.result?.capabilities?.events, {});
  assert.equal((await f.rpc('events/list')).body.result?.events?.[0]?.name, DIRECT_MENTION);
  assert.equal((await f.rpc('events/list', {}, 'fixture-sender')).body.error?.code, -32601);
  assert.equal((await f.rpc('events/subscribe', subscription(), 'fixture-dots-read')).body.error?.code, -32001);
  const otherRoom = await f.rpc('events/subscribe', { ...subscription(), arguments: { room: 'other-room' } });
  assert.equal(otherRoom.body.error?.code, -32602);
  const extra = await f.rpc('events/subscribe', { ...subscription(), [callback]: secret(9) });
  assert.equal(extra.body.error?.code, -32602);
  assert.ok(!JSON.stringify(extra.body).includes(callback));
  assert.ok(!JSON.stringify(extra.body).includes(secret(9)));

  f.verifyMatches(false);
  const bad = await f.rpc('events/subscribe', subscription());
  assert.equal(bad.body.error?.code, -32015);
  assert.equal(bad.body.error?.data?.reason, 'challenge_failed');
  await f.post('fixture-mcp-events-001', 'private marker @dots without a verified callback');
  assert.equal(f.deliveries.filter(p => !p.verify).length, 0);
  f.verifyMatches(true);
  const subscribed = await f.rpc('events/subscribe', subscription());
  const subId = subscribed.body.result?.id;
  assert.match(subId ?? '', /^sub_[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(subscribed.body).includes(callback));
  assert.ok(!JSON.stringify(subscribed.body).includes(secret(9)));
  assertSignature(f.deliveries.at(-1)!, 9);
  assert.equal((await f.rpc('events/subscribe', { ...subscription(), _meta: { progressToken: 'fixture-progress' } })).body.result?.id, subId);
  assert.equal(f.deliveries.filter(p => p.verify).length, 2);

  f.restart();
  await f.post('fixture-mcp-events-002', 'broadcast only @everyone');
  await f.post('fixture-mcp-events-003', 'no target and no direct mention');
  f.responseStatus(503);
  const messageId = await f.post('fixture-mcp-events-004', 'sensitive marker @everyone @dots');
  assert.equal(await f.post('fixture-mcp-events-004', 'sensitive marker @everyone @dots'), messageId);
  const first = f.deliveries.find(p => !p.verify)!;
  assertSignature(first, 9);
  const wire = JSON.parse(first.body);
  assert.deepEqual(Object.keys(wire).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp']);
  assert.equal(wire.eventId, first.headers.get('webhook-id'));
  assert.equal(first.headers.get('X-MCP-Subscription-Id'), subId);
  assert.deepEqual(wire.data, { room: ROOM, message_id: messageId });
  assert.equal(wire.cursor, null);
  assert.equal(f.deliveries.filter(p => !p.verify).length, 1);

  const rotated = await f.rpc('events/subscribe', subscription(10));
  assert.equal(rotated.body.result?.id, subId);
  f.responseStatus(204);
  await Promise.all([f.sweep(15_000), f.sweep(0)]);
  const resent = f.deliveries.filter(p => !p.verify);
  assert.equal(resent.length, 2);
  assert.equal(resent[0]!.body, resent[1]!.body);
  assert.notEqual(resent[0]!.headers.get('webhook-timestamp'), resent[1]!.headers.get('webhook-timestamp'));
  assertSignature(resent[1]!, 9);
  assertSignature(resent[1]!, 10);
  assert.equal((await f.db.prepare('SELECT status FROM mcp_event_outbox').first<{ status: string }>())?.status, 'accepted');

  const unsub = { name: DIRECT_MENTION, arguments: { room: ROOM }, delivery: { mode: 'webhook', url: callback } };
  await f.rpc('events/unsubscribe', unsub, undefined, 'fixture-grant-b');
  f.responseStatus(410);
  await f.post('fixture-mcp-events-005', '@dots expired receiver');
  f.responseStatus(413);
  await f.post('fixture-mcp-events-large', '@dots receiver reports too large');
  await f.sweep(60_000);
  assert.equal(f.deliveries.filter(p => !p.verify).length, 4);
  await f.rpc('events/unsubscribe', unsub);
  await f.rpc('events/unsubscribe', unsub);
  await f.post('fixture-mcp-events-006', '@dots after unsubscribe');
  assert.equal(f.deliveries.filter(p => !p.verify).length, 4);
});

test('unsubscribe fences in-flight verification and revoking the grant suppresses retry', async t => {
  const f = await fixture();
  t.after(() => f.close());
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.pauseVerification(async () => { reached.resolve(); await release.promise; });
  const request = f.rpc('events/subscribe', subscription());
  await reached.promise;
  const unsub = { name: DIRECT_MENTION, arguments: { room: ROOM }, delivery: { mode: 'webhook', url: callback } };
  try { await f.rpc('events/unsubscribe', unsub); }
  finally { release.resolve(); }
  assert.equal((await request).body.error?.code, -32015);

  assert.ok((await f.rpc('events/subscribe', subscription())).body.result?.id);
  f.responseStatus(503);
  await f.post('fixture-mcp-events-007', '@dots isolated retry');
  assert.equal(f.deliveries.filter(p => !p.verify).length, 1);
  f.revoke();
  await f.sweep(15_000);
  assert.equal(f.deliveries.filter(p => !p.verify).length, 1);
  const stopped = await f.db.prepare('SELECT status,last_status FROM mcp_event_outbox').first<{ status: string; last_status: number | null }>();
  assert.deepEqual(stopped, { status: 'terminal', last_status: null });

  // Simulate persistence after the final claim but before its outcome was recorded.
  await f.db.prepare("UPDATE mcp_event_outbox SET status='pending',attempts=6,lease_until=1,claim='closed-fixture'").run();
  await f.sweep(0);
  const recovered = await f.db.prepare('SELECT status,claim FROM mcp_event_outbox').first<{ status: string; claim: string | null }>();
  assert.deepEqual(recovered, { status: 'terminal', claim: null });
  assert.equal(f.deliveries.filter(p => !p.verify).length, 1);
});
