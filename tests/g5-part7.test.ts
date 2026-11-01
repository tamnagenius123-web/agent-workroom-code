import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGIN, PASSWORD, start, fullEnv, authzQuery, page, submit, outboxFixture } from './support/g5-harness.ts';
import { migrate } from '../scripts/local-harness.ts';
// Split from g5.test.ts (part 7/8); each test boots its own Miniflare + unique D1, so parts run in parallel.

test('R2 P1: a correct password admitted as the global limit-th attempt does not leave the global lock set', async () => {
  const { GLOBAL_LOCK_FAILURES } = await import('../src/auth/g5.ts');
  const db = await start(fullEnv());
  await db.prepare("INSERT INTO owner_gate(id,failures,window_start,locked_until) VALUES ('owner',?,?,0)").bind(GLOBAL_LOCK_FAILURES - 1, Date.now()).run();
  const from = (ip: string, pw: string) => (async () => submit(await page(await authzQuery()), 'approve', pw, { Origin: ORIGIN, 'CF-Connecting-IP': ip }))();
  assert.equal((await from('198.51.100.9', PASSWORD)).status, 302, 'limit-th admission with the right password succeeds');
  const g = await db.prepare("SELECT failures, locked_until FROM owner_gate WHERE id='owner'").first<{ failures: number; locked_until: number }>();
  assert.equal(g!.locked_until, 0, 'success refund clears the lock its own reservation set');
  assert.equal(g!.failures, GLOBAL_LOCK_FAILURES - 1);
  assert.equal((await from('198.51.100.10', PASSWORD)).status, 302, 'next owner attempt is not locked out');
});

// Codex 17ea0f72 (P2): refund is bound to its own reservation and window.
test('R2 P2: a delayed success refunds only its own slot, never later charges or another window', async () => {
  const { admit, refund, LOCK_WINDOW } = await import('../src/auth/g5.ts');
  const db = await start(fullEnv());
  const now = Date.now(), req = () => db.prepare("SELECT failures, locked_until, window_start FROM requester_gate WHERE key_hash='k'").first<{ failures: number; locked_until: number; window_start: number }>();
  const a = await admit(db as never, 'k', now);
  assert.ok(a);
  for (let i = 1; i <= 3; i++) assert.ok(await admit(db as never, 'k', now + i));
  await refund(db as never, a!);
  assert.equal((await req())!.failures, 3, 'later failures survive a delayed success');
  const b = await admit(db as never, 'k', now + 10);
  await db.prepare("UPDATE requester_gate SET window_start=? WHERE key_hash='k'").bind(now - LOCK_WINDOW - 1).run();
  const c = await admit(db as never, 'k', now + 20);
  assert.ok(c); assert.equal((await req())!.failures, 1, 'window rolled over');
  await refund(db as never, b!);
  assert.equal((await req())!.failures, 1, 'stale-window refund is a no-op');
  const og = await db.prepare("SELECT failures FROM owner_gate WHERE id='owner'").first<{ failures: number }>();
  assert.equal(og!.failures, 4, 'global: 6 admitted, a and b refunded in their (unchanged) global window');
});

// Codex 17ea0f72 (P2): populated 0010 -> 0011 -> 0017 migration keeps unknown legacy terminal times conservative.
test('outbox migration 10->17 on a populated DB: legacy failed/removed rows are not made retention-eligible', async () => {
  const { retain } = await import('../src/server/retention.ts');
  const db = await start(fullEnv(), false, 10);
  const day = 86400_000, now = Date.now();
  await db.prepare("INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,attempts,next_at,created_at,delivered_at,last_error) VALUES ('fail-old','agent:muse','m','{}','failed',6,?,?,NULL,'HTTP 500'),('removed-old','agent:muse','m','{}','failed',0,?,?,NULL,'webhook removed'),('ok-old','agent:muse','m','{}','delivered',1,?,?,?,NULL),('pend','agent:muse','m','{}','pending',0,?,?,NULL,NULL)")
    .bind(now - 40 * day, now - 41 * day, now - 30 * day, now - 30 * day, now - 30 * day, now - 30 * day, now - 29 * day, now - 20 * day, now - 20 * day).run();
  await migrate(db, 17);
  const rows = Object.fromEntries((await db.prepare('SELECT id, terminal_at FROM webhook_outbox').all<{ id: string; terminal_at: number | null }>()).results.map((r: { id: string; terminal_at: number | null }) => [r.id, r.terminal_at]));
  assert.ok(rows['fail-old']! >= now && rows['removed-old']! >= now, 'unknown legacy failure/removal time treated as migration time');
  assert.equal(rows['ok-old'], now - 29 * day, 'delivered rows keep delivered_at');
  assert.equal(rows['pend'], null);
  const out = await retain(db as never, now + 1000);
  assert.equal(out.webhook_outbox, 1, 'only the old delivered row is eligible');
});

test('outbox claim fencing: concurrent deliveries of one row make one attempt', async () => {
  const { deliver } = await import('../src/server/notify.ts');
  const f = await outboxFixture();
  try {
    const a = deliver(f.db as never, ['d1']), b = deliver(f.db as never, ['d1']);
    (await f.nextCall())(new Response('ok', { status: 200 }));
    assert.deepEqual((await Promise.all([a, b])).sort(), [0, 1]);
    assert.equal(f.calls(), 1, 'second worker lost the claim and did not fetch');
    assert.deepEqual({ ...(await f.row())!, terminal_at: null }, { status: 'delivered', attempts: 1, terminal_at: null, last_error: null, claim_token: null });
  } finally { f.restore(); }
});
test('outbox claim fencing: a stale failure after lease expiry never overwrites delivered state or its terminal stamp', async () => {
  const { deliver } = await import('../src/server/notify.ts');
  const f = await outboxFixture();
  try {
    const a = deliver(f.db as never, ['d1']); const resolveA = await f.nextCall();
    await f.db.prepare("UPDATE webhook_outbox SET claimed_until=0 WHERE id='d1'").run();
    const b = deliver(f.db as never, ['d1']); (await f.nextCall())(new Response('ok', { status: 200 })); await b;
    const delivered = (await f.row())!;
    assert.equal(delivered.status, 'delivered');
    resolveA(new Response('err', { status: 500 })); await a;
    assert.deepEqual(await f.row(), delivered, 'stale attempt A is fenced out');
  } finally { f.restore(); }
});
