import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { harness } from '../scripts/local-harness.ts';
import type { Database } from '../src/server/db.ts';
import { Fault } from '../src/server/contracts.ts';
import { Workroom } from '../src/server/domain.ts';
import {
  STALE_OUTBOX_MS,
  Webhooks,
  checkWebhookUrl,
  deliver,
  wakeAuthFrom,
  wakeAuthHeader,
} from '../src/server/notify.ts';

async function withHarness(
  outboundService?: (request: Request) => Response | Promise<Response>,
) {
  return harness({ through: 11, outboundService });
}

async function callMcp(
  mf: Awaited<ReturnType<typeof harness>>['mf'],
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await mf.dispatchFetch('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'MCP-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: { schema_version: '1', ...args },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  return {
    status: response.status,
    body: (await response.json()) as {
      result?: { structuredContent?: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } };
    },
  };
}

test('checkWebhookUrl rejects insecure, private, IP-literal, and self-worker hosts', () => {
  assert.equal(checkWebhookUrl('https://hooks.example.test/workroom'), 'https://hooks.example.test/workroom');
  assert.equal(checkWebhookUrl('https://hooks.example.test:443/path?a=1'), 'https://hooks.example.test/path?a=1');
  assert.equal(checkWebhookUrl('https://agent-workroom-dots-wake.example.workers.dev/wake'), 'https://agent-workroom-dots-wake.example.workers.dev/wake');
  for (const bad of [
    'not-a-url',
    'http://hooks.example.test/hook',
    'https://user:pass@hooks.example.test/hook',
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://localhost/hook',
    'https://sub.localhost/hook',
    'https://relay.local/hook',
    'https://service.internal/hook',
    'https://metadata.google.internal/hook',
    'https://agent-workroom-main.example.workers.dev/hook',
    'https://agent-workroom-gate.example.workers.dev/wake',
    'https://hooks.example.test:8443/hook',
    'https://singlelabel/hook',
  ]) {
    assert.throws(() => checkWebhookUrl(bad), (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT', bad);
  }
});

test('wakeAuthFrom and wakeAuthHeader enforce exact URL pin and per-invocation isolation', async () => {
  const url = 'https://wake.example.test/hook/abc';
  assert.deepEqual(wakeAuthHeader(wakeAuthFrom({}), 'agent:grok', url), {});
  assert.deepEqual(wakeAuthHeader(wakeAuthFrom({ GROK_WAKE_KEY: 'k1' }), 'agent:grok', url), {});
  const dotsUrl = 'https://agent-workroom-dots-wake.example.workers.dev/wake';
  const auth = wakeAuthFrom({ GROK_WAKE_KEY: 'k1', GROK_WAKE_URL: url, DOTS_WAKE_KEY: 'd1', DOTS_WAKE_URL: dotsUrl });
  assert.deepEqual(wakeAuthHeader(auth, 'agent:grok', url), { Authorization: 'Bearer k1' });
  assert.deepEqual(wakeAuthHeader(auth, 'agent:grok', url + '?x=1'), {});
  assert.deepEqual(wakeAuthHeader(auth, 'agent:muse', url), {});
  assert.deepEqual(wakeAuthHeader(auth, 'constructor', url), {});
  assert.deepEqual(wakeAuthHeader(auth, 'agent:dots', dotsUrl), { Authorization: 'Bearer d1' });
  assert.deepEqual(wakeAuthHeader(auth, 'agent:dots', url), {});
  assert.deepEqual(wakeAuthHeader(auth, 'agent:grok', dotsUrl), {});
  assert.ok(Object.isFrozen(auth) && Object.isFrozen(auth['agent:grok']));

  const fakeDb = (id: string): Database => {
    const stmt = (sql: string) => ({
      bind: () => stmt(sql),
      all: async () => {
        if (sql.includes('claim_token FROM webhook_outbox LIMIT 0')) throw new Error('no such column: claim_token');
        return {
          results: sql.startsWith('SELECT o.id')
            ? [{ id, principal_id: 'agent:grok', payload_json: '{"n":1}', attempts: 0, url, secret: 's' }]
            : [],
        };
      },
      first: async () => null,
    });
    return { prepare: stmt, batch: async () => [] } as unknown as Database;
  };

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: Record<string, string | undefined> = {};
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const deliveryId = headers['X-Workroom-Delivery']!;
    if (deliveryId === 'A') await gate;
    seen[deliveryId] = headers.Authorization;
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  const inflight = deliver(fakeDb('A'), ['A'], wakeAuthFrom({ GROK_WAKE_KEY: 'kA', GROK_WAKE_URL: url }), fetchImpl);
  await deliver(fakeDb('B'), ['B'], wakeAuthFrom({}), fetchImpl);
  await deliver(fakeDb('C'), ['C'], wakeAuthFrom({ GROK_WAKE_KEY: 'kC', GROK_WAKE_URL: url }), fetchImpl);
  release();
  await inflight;
  assert.deepEqual(seen, { A: 'Bearer kA', B: undefined, C: 'Bearer kC' });
});

test('MCP webhook tools register, inspect, test with HMAC signature, deliver on mention, and remove cleanly', async () => {
  const deliveries: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const app = await withHarness(async request => {
    const body = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    deliveries.push({ url: request.url, headers, body });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  });

  try {
    const missing = await callMcp(app.mf, 'local-beta-fixture', 'workroom_webhook_test', {});
    assert.equal(missing.body.result?.structuredContent?.ok, false);
    assert.equal(missing.body.result?.structuredContent?.error?.code, 'NOT_FOUND');

    const set1 = await callMcp(app.mf, 'local-beta-fixture', 'workroom_set_webhook', {
      url: 'https://hooks.example.test/beta',
      all_messages: false,
      rotate_secret: false,
    });
    const set1Data = set1.body.result?.structuredContent?.data as {
      signing_secret?: string;
      signing_secret_returned?: boolean;
    };
    assert.equal(set1.body.result?.structuredContent?.ok, true);
    assert.equal(set1Data.signing_secret_returned, true);
    assert.match(set1Data.signing_secret ?? '', /^whsec_[0-9a-f]{64}$/);
    const firstSecret = set1Data.signing_secret!;

    const set2 = await callMcp(app.mf, 'local-beta-fixture', 'workroom_set_webhook', {
      url: 'https://hooks.example.test/beta-v2',
      all_messages: false,
      rotate_secret: false,
    });
    const set2Data = set2.body.result?.structuredContent?.data as {
      signing_secret?: string;
      signing_secret_returned?: boolean;
    };
    assert.equal(set2Data.signing_secret_returned, false);
    assert.equal(set2Data.signing_secret, undefined);

    const ping = await callMcp(app.mf, 'local-beta-fixture', 'workroom_webhook_test', {});
    assert.equal(ping.body.result?.structuredContent?.ok, true);
    const pingData = ping.body.result?.structuredContent?.data as { status?: string; attempts?: number; last_status?: number };
    assert.equal(pingData.status, 'delivered');
    assert.equal(pingData.attempts, 1);
    assert.equal(pingData.last_status, 200);
    assert.equal(deliveries.length, 1);
    const pingDelivery = deliveries[0]!;
    assert.equal(pingDelivery.url, 'https://hooks.example.test/beta-v2');
    assert.equal(pingDelivery.headers['user-agent'], 'agent-workroom-webhook/1');
    const expectedSig = 'sha256=' + createHmac('sha256', firstSecret)
      .update(`${pingDelivery.headers['x-workroom-timestamp']}.${pingDelivery.body}`)
      .digest('hex');
    assert.equal(pingDelivery.headers['x-workroom-signature'], expectedSig);

    const getRes = await callMcp(app.mf, 'local-beta-fixture', 'workroom_webhook_get', {});
    assert.equal(getRes.body.result?.structuredContent?.ok, true);
    const getData = getRes.body.result?.structuredContent?.data as {
      webhook?: { url: string; all_messages: boolean };
      recent_deliveries?: Array<{ status: string }>;
    };
    assert.equal(getData.webhook?.url, 'https://hooks.example.test/beta-v2');
    assert.equal(getData.webhook?.all_messages, false);
    assert.equal(JSON.stringify(getData).includes(firstSecret), false);
    assert.equal(getData.recent_deliveries?.[0]?.status, 'delivered');

    await app.db.prepare("INSERT OR IGNORE INTO agent_aliases(alias, principal_id) VALUES ('beta', 'synthetic:beta')").run();
    const postRes = await callMcp(app.mf, 'local-alpha-fixture', 'workroom_message_post', {
      room: 'room_main',
      text: 'ping @beta for webhook test',
      format: 'text',
      idempotency_key: 'webhook-mention-0001',
    });
    assert.equal(postRes.body.result?.structuredContent?.ok, true);
    for (let i = 0; i < 100 && deliveries.length < 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(deliveries.length, 2);
    const mentionPayload = JSON.parse(deliveries[1]!.body) as { type: string; sender: string; recipient: string; mentioned: boolean };
    assert.equal(mentionPayload.type, 'workroom.message');
    assert.equal(mentionPayload.sender, 'synthetic:alpha');
    assert.equal(mentionPayload.recipient, 'synthetic:beta');
    assert.equal(mentionPayload.mentioned, true);

    const delRes = await callMcp(app.mf, 'local-beta-fixture', 'workroom_webhook_delete', {});
    assert.equal(delRes.body.result?.structuredContent?.ok, true);
    const afterDel = await callMcp(app.mf, 'local-beta-fixture', 'workroom_webhook_get', {});
    assert.equal((afterDel.body.result?.structuredContent?.data as { webhook: unknown }).webhook, null);
  } finally {
    await app.close();
  }
});

test('deliver sweep expires stale outbox rows without bursting and retries recent failures up to MAX_ATTEMPTS', async () => {
  const app = await withHarness();
  try {
    const db = app.db as unknown as Database;
    const hooks = new Webhooks(db, 'synthetic:beta');
    await hooks.set({ url: 'https://hooks.example.test/sweep', all_messages: false, rotate_secret: false });

    const now = Date.now();
    const staleAt = now - STALE_OUTBOX_MS - 10_000;
    await app.db.batch([
      app.db.prepare(`INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,attempts,next_at,created_at) VALUES ('stale-1','synthetic:beta','m-stale',?,'pending',0,?,?)`)
        .bind(JSON.stringify({ type: 'workroom.message', delivery_id: 'stale-1' }), staleAt, staleAt),
      app.db.prepare(`INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,attempts,next_at,created_at) VALUES ('fresh-1','synthetic:beta','m-fresh',?,'pending',5,?,?)`)
        .bind(JSON.stringify({ type: 'workroom.message', delivery_id: 'fresh-1' }), now - 1000, now - 1000),
    ]);

    const seenIds: string[] = [];
    const sent = await deliver(db, undefined, undefined, (async (_url: string, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      seenIds.push(h['X-Workroom-Delivery']!);
      return new Response('err', { status: 502 });
    }) as typeof fetch);

    assert.equal(sent, 1);
    assert.deepEqual(seenIds, ['fresh-1']);

    const staleRow = await app.db.prepare('SELECT status,attempts,last_error,terminal_at FROM webhook_outbox WHERE id=?').bind('stale-1').first<{
      status: string; attempts: number; last_error: string; terminal_at: number | null;
    }>();
    assert.equal(staleRow?.status, 'failed');
    assert.equal(staleRow?.attempts, 0);
    assert.equal(staleRow?.last_error, 'expired stale');
    assert.ok(staleRow?.terminal_at);

    const freshRow = await app.db.prepare('SELECT status,attempts,last_status,last_error,terminal_at FROM webhook_outbox WHERE id=?').bind('fresh-1').first<{
      status: string; attempts: number; last_status: number; last_error: string; terminal_at: number | null;
    }>();
    assert.equal(freshRow?.status, 'failed');
    assert.equal(freshRow?.attempts, 6);
    assert.equal(freshRow?.last_status, 502);
    assert.equal(freshRow?.last_error, 'HTTP 502');
    assert.ok(freshRow?.terminal_at);

    // remove() also works cleanly on a Workroom instance and fails pending rows
    const wr = new Workroom(db, 'synthetic:beta');
    await wr.webhooks.set({ url: 'https://hooks.example.test/r', all_messages: false, rotate_secret: true });
    await app.db.prepare(`INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,attempts,next_at,created_at) VALUES ('pend-rm','synthetic:beta','m-rm','{}','pending',0,?,?)`)
      .bind(now, now).run();
    await wr.webhooks.remove();
    const rmRow = await app.db.prepare('SELECT status,last_error,terminal_at FROM webhook_outbox WHERE id=?').bind('pend-rm').first<{
      status: string; last_error: string; terminal_at: number | null;
    }>();
    assert.equal(rmRow?.status, 'failed');
    assert.equal(rmRow?.last_error, 'webhook removed');
    assert.ok(rmRow?.terminal_at);
  } finally {
    await app.close();
  }
});

test('deliver supports claim-fenced outbox schema and refuses stale completion after removal', async () => {
  const app = await withHarness();
  try {
    await app.db.batch([
      app.db.prepare('ALTER TABLE webhook_outbox ADD COLUMN claim_token TEXT'),
      app.db.prepare('ALTER TABLE webhook_outbox ADD COLUMN claimed_until INTEGER'),
    ]);
    const db = app.db as unknown as Database;
    const hooks = new Webhooks(db, 'synthetic:beta');
    await hooks.set({ url: 'https://hooks.example.test/fenced', all_messages: false, rotate_secret: false });

    const now = Date.now();
    await app.db.prepare(`INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,attempts,next_at,created_at) VALUES ('fenced-1','synthetic:beta','m-fenced','{}','pending',0,?,?)`)
      .bind(now, now).run();

    let releaseFetch!: () => void;
    const gate = new Promise<void>(resolve => { releaseFetch = resolve; });
    let inflight!: Promise<number>;
    const started = new Promise<void>(resolve => {
      inflight = deliver(db, ['fenced-1'], undefined, (async () => {
        resolve();
        await gate;
        return new Response('ok', { status: 200 });
      }) as typeof fetch);
    });

    await started;
    await hooks.remove();
    releaseFetch();
    const attempted = await inflight;
    assert.equal(attempted, 1);
    const after = await app.db.prepare('SELECT status,last_error,claim_token,claimed_until FROM webhook_outbox WHERE id=?').bind('fenced-1').first<{
      status: string; last_error: string; claim_token: string | null; claimed_until: number | null;
    }>();
    assert.equal(after?.status, 'failed');
    assert.equal(after?.last_error, 'webhook removed');
    const finalRow = await app.db.prepare('SELECT status,last_error FROM webhook_outbox WHERE id=?').bind('fenced-1').first<{
      status: string; last_error: string;
    }>();
    assert.equal(finalRow?.status, 'failed');
    assert.equal(finalRow?.last_error, 'webhook removed');
  } finally {
    await app.close();
  }
});
