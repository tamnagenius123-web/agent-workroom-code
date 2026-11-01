import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start, fullEnv, tokens, mcp, outboxFixture } from './support/g5-harness.ts';
// Split from g5.test.ts (part 8/8); each test boots its own Miniflare + unique D1, so parts run in parallel.

test('outbox claim fencing: an in-flight success after webhook removal leaves the removal-failed state', async () => {
  const { deliver, Webhooks } = await import('../src/server/notify.ts');
  const f = await outboxFixture();
  try {
    const a = deliver(f.db as never, ['d1']); const resolveA = await f.nextCall();
    await new Webhooks(f.db as never, 'agent:muse').remove();
    const removed = (await f.row())!;
    assert.equal(removed.status, 'failed'); assert.equal(removed.last_error, 'webhook removed'); assert.ok(removed.terminal_at);
    resolveA(new Response('ok', { status: 200 })); await a;
    const after = (await f.row())!;
    assert.equal(after.status, 'failed'); assert.equal(after.terminal_at, removed.terminal_at, 'not re-queued, terminal stamp kept');
  } finally { f.restore(); }
});
// Codex 17ea0f72: atomic rollback is shown through the real post endpoint with a forced outbox-insert failure.
test('transactional outbox via MCP post: a forced outbox insert failure rolls back the message, mentions and operation', async () => {
  const db = await start(fullEnv(), true);
  const muse = await tokens('client:muse');
  await db.prepare("INSERT INTO webhooks(principal_id,url,secret,all_messages,created_at,updated_at) VALUES ('agent:dots','https://hooks.example.com/d','x',1,0,0)").run();
  await db.prepare("CREATE TRIGGER outbox_boom BEFORE INSERT ON webhook_outbox BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END").run();
  const r = await mcp(muse.access_token, 'tools/call', { name: 'workroom_message_post', arguments: { schema_version: '1', room: 'room_main', text: 'rollback probe @dots', format: 'text', idempotency_key: 'rollback-probe-01' } });
  assert.notEqual((r.body.result?.structuredContent as { ok?: boolean } | undefined)?.ok, true, 'post does not report success');
  for (const t of ['messages', 'message_mentions', 'webhook_outbox']) assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${t}`).first<{ n: number }>())!.n, 0, t + ' rolled back');
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM operations WHERE key='rollback-probe-01'").first<{ n: number }>())!.n, 0, 'operation rolled back');
});
