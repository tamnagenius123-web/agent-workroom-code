import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGIN, PASSWORD, start, fullEnv, authzQuery, page, submit, tokens, mcp } from './support/g5-harness.ts';
// Split from g5.test.ts (part 5/8); each test boots its own Miniflare + unique D1, so parts run in parallel.

test('Mentions: aliases/@everyone resolved, stored, returned; mentions_only cursor; workroom_mentions; webhook validation + outbox', async () => {
  const db = await start(fullEnv(), true);
  const dots = await tokens(), muse = await tokens('client:muse');
  const call = async (t: string, name: string, args: Record<string, unknown>) =>
    (await mcp(t, 'tools/call', { name, arguments: { schema_version: '1', ...args } })).body.result!.structuredContent as unknown as { ok: boolean; error?: { code: string }; data: Record<string, unknown> & { messages: { text: string; mentions: string[]; mentions_me: boolean }[] }; meta: { count: number } };
  const bad = await call(dots.access_token, 'workroom_set_webhook', { url: 'http://example.com/h' });
  assert.equal(bad.ok, false);
  for (const url of ['https://localhost/h', 'https://127.0.0.1/h', 'https://[::1]/h', 'https://foo.internal/h', 'https://example.com:8443/h'])
    assert.equal((await call(dots.access_token, 'workroom_set_webhook', { url })).ok, false, url);
  const set = await call(dots.access_token, 'workroom_set_webhook', { url: 'https://hooks.example.invalid/workroom' });
  assert.ok(set.ok); assert.match(String(set.data.signing_secret), /^whsec_[0-9a-f]{64}$/);
  const again = await call(dots.access_token, 'workroom_set_webhook', { url: 'https://hooks.example.invalid/workroom2' });
  assert.equal(again.data.signing_secret, undefined, 'secret only shown once');
  const p1 = await call(muse.access_token, 'workroom_message_post', { room: 'room_main', text: 'hi @코덱스 and @Codex', format: 'text', idempotency_key: 'mention-test-001' });
  assert.deepEqual((p1.data as unknown as { message: { mentions: string[] } }).message.mentions, ['agent:dots']);
  await call(muse.access_token, 'workroom_message_post', { room: 'room_main', text: 'plain note, email a@muse.com', format: 'text', idempotency_key: 'mention-test-002' });
  await call(dots.access_token, 'workroom_message_post', { room: 'room_main', text: '@everyone ping', format: 'text', idempotency_key: 'mention-test-003' });
  const mo = await call(dots.access_token, 'workroom_unread', { room: 'room_main', mentions_only: true });
  assert.deepEqual(mo.data.messages.map(m => m.text), ['hi @코덱스 and @Codex']); assert.ok(mo.data.messages[0]!.mentions_me);
  assert.equal((await call(dots.access_token, 'workroom_unread', { room: 'room_main', mentions_only: true })).meta.count, 0);
  assert.equal((await call(dots.access_token, 'workroom_unread', { room: 'room_main' })).meta.count, 3, 'mentions_only does not move the main cursor');
  const mm = await call(muse.access_token, 'workroom_mentions', { room: 'room_main' });
  assert.deepEqual(mm.data.messages.map(m => m.text), ['@everyone ping']);
  const out = (await db.prepare('SELECT principal_id,status,attempts,payload_json FROM webhook_outbox').all<{ principal_id: string; status: string; attempts: number; payload_json: string }>()).results;
  assert.equal(out.length, 1); assert.equal(out[0]!.principal_id, 'agent:dots'); assert.equal(out[0]!.attempts, 1, 'delivery attempted');
  const payload = JSON.parse(out[0]!.payload_json); assert.equal(payload.mentioned, true); assert.equal(payload.sender, 'agent:muse');
  const got = await call(dots.access_token, 'workroom_webhook_get', {});
  assert.ok(!JSON.stringify(got).includes('whsec_'), 'get never returns secret');
  assert.ok((await call(dots.access_token, 'workroom_webhook_delete', {})).ok);
});

test('R2 lockout is per requester; global backstop still bounds distributed guessing', async () => {
  const db = await start(fullEnv());
  const from = (ip: string, pw: string) => (async () => submit(await page(await authzQuery()), 'approve', pw, { Origin: ORIGIN, 'CF-Connecting-IP': ip }))();
  for (let i = 0; i < 5; i++) assert.equal((await from('203.0.113.9', 'bad-' + i)).status, 401);
  assert.equal((await from('203.0.113.9', PASSWORD)).status, 429, 'attacker locked');
  const owner = await from('198.51.100.7', PASSWORD);
  assert.equal(owner.status, 302, 'owner from another address is not locked out');
  const keys = JSON.stringify((await db.prepare('SELECT key_hash FROM requester_gate').all()).results);
  assert.ok(!keys.includes('203.0.113.9'), 'raw IP never stored');
  await db.prepare("UPDATE owner_gate SET locked_until=? WHERE id='owner'").bind(Date.now() + 60_000).run();
  assert.equal((await from('192.0.2.1', PASSWORD)).status, 429, 'global backstop applies to everyone');
});

test('R8 retention removes only expired bookkeeping; latency stats record first sighting', async () => {
  const { retain } = await import('../src/server/retention.ts');
  const { recordReads, latencyStats } = await import('../src/server/latency.ts');
  const db = await start(fullEnv());
  const now = Date.now(), old = now - 100 * 86400_000;
  await db.prepare("INSERT INTO auth_audit(request_id,action,decision,reason,at) VALUES ('r1','x','deny','T',?),('r2','x','deny','T',?)").bind(old, now).run();
  await db.prepare("INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,next_at,created_at) VALUES ('o1','agent:muse','m','{}','delivered',0,?),('o2','agent:muse','m','{}','pending',0,?)").bind(old, old).run();
  const dry = await retain(db as never, now);
  assert.equal(dry.auth_audit, 1); assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_audit').first<{ n: number }>())!.n, 2, 'dry run deletes nothing');
  const out = await retain(db as never, now, 'delete');
  assert.deepEqual({ ...out }, { ...dry }, 'dry-run count == actual');
  assert.equal(out.auth_audit, 1); assert.equal(out.webhook_outbox, 1, 'pending rows kept');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM auth_audit').first<{ n: number }>())!.n, 1);
  assert.equal((await db.prepare("SELECT status FROM webhook_outbox").first<{ status: string }>())!.status, 'pending');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM retention_runs').first<{ n: number }>())!.n, 2);
  const msg = (id: string, ms: number) => ({ id, actor_id: 'agent:grok', created_at: new Date(now - ms).toISOString() });
  await recordReads(db as never, 'agent:muse', 'unread', [msg('a', 1000), msg('b', 3000), { ...msg('c', 5), actor_id: 'agent:muse' }], now);
  await recordReads(db as never, 'agent:muse', 'unread', [msg('a', 1000)], now + 99_999);
  const s = await latencyStats(db as never, 3600_000, now);
  assert.deepEqual(s.agents, [{ principal_id: 'agent:muse', samples: 2, p50_ms: 1000, p90_ms: 3000, max_ms: 3000, baseline_ready: false }]);
});

test('transactional outbox: mention/outbox rows exist only if the message row is written in the same batch', async () => {
  const { planNotify } = await import('../src/server/notify.ts');
  const db = await start(fullEnv());
  await db.prepare("INSERT OR IGNORE INTO principals(id) VALUES ('agent:grok'),('agent:muse')").run();
  await db.prepare("INSERT INTO webhooks(principal_id,url,secret,all_messages,created_at,updated_at) VALUES ('agent:muse','https://example.com/h','x',0,0,0)").run();
  const msg = { id: crypto.randomUUID(), actor_id: 'agent:grok', text: 'hi @muse', created_at: new Date().toISOString() };
  const plan = await planNotify(db as never, msg);
  assert.equal(plan.deliveries.length, 1); assert.deepEqual(plan.mentions, ['agent:muse']);
  await db.batch(plan.statements as never);
  const count = async (t: string) => (await db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE message_id=?`).bind(msg.id).first<{ n: number }>())!.n;
  assert.equal(await count('webhook_outbox'), 0, 'no orphan outbox row without the message');
  assert.equal(await count('message_mentions'), 0);
  const plan2 = await planNotify(db as never, msg);
  await db.batch([db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,'room_main','agent:grok',?,'text',?)").bind(msg.id, msg.text, msg.created_at), ...plan2.statements as never[]]);
  assert.equal(await count('webhook_outbox'), 1); assert.equal(await count('message_mentions'), 1);
});

test('latency telemetry failure never loses an unread batch after the cursor advances', async () => {
  const db = await start(fullEnv(), true);
  const dots = await tokens(), muse = await tokens('client:muse');
  const call = async (t: string, name: string, args: Record<string, unknown>) =>
    (await mcp(t, 'tools/call', { name, arguments: { schema_version: '1', ...args } })).body.result!.structuredContent as unknown as { ok: boolean; data: { messages: { text: string }[] }; meta: { count: number; advanced: boolean } };
  for (const i of [1, 2]) assert.ok((await call(muse.access_token, 'workroom_message_post', { room: 'room_main', text: 't' + i, format: 'text', idempotency_key: 'telemetry-fail-0' + i })).ok);
  await db.prepare("CREATE TRIGGER boom BEFORE INSERT ON message_reads BEGIN SELECT RAISE(ABORT,'injected telemetry failure'); END").run();
  const r = await call(dots.access_token, 'workroom_unread', { room: 'room_main' });
  assert.equal(r.ok, true); assert.equal(r.meta.advanced, true);
  assert.deepEqual(r.data.messages.map(m => m.text), ['t1', 't2'], 'batch is delivered despite telemetry failure');
  assert.equal((await db.prepare('SELECT COUNT(*) n FROM message_reads').first<{ n: number }>())!.n, 0);
});
