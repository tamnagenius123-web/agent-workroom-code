import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORIGIN, PASSWORD, start, fullEnv, authzQuery, page, submit } from './support/g5-harness.ts';
// Split from g5.test.ts (part 6/8); each test boots its own Miniflare + unique D1, so parts run in parallel.

test('R2 admission is atomic under concurrency; the real global threshold locks everyone', async () => {
  const { GLOBAL_LOCK_FAILURES, LOCK_FAILURES } = await import('../src/auth/g5.ts');
  const db = await start(fullEnv());
  const from = (ip: string, pw: string) => (async () => submit(await page(await authzQuery()), 'approve', pw, { Origin: ORIGIN, 'CF-Connecting-IP': ip }))();
  // Barrier: build every consent page first, then fire all password submissions at once.
  const pages = await Promise.all(Array.from({ length: 12 }, async () => page(await authzQuery())));
  const burst = await Promise.all(pages.map((p, i) => submit(p, 'approve', 'bad-c' + i, { Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.50' })));
  const verified = burst.filter(r => r.status === 401).length;
  assert.ok(verified <= LOCK_FAILURES, `at most ${LOCK_FAILURES} concurrent attempts reach verification, got ${verified}`);
  assert.equal(burst.filter(r => r.status === 429).length, 12 - verified);
  assert.equal((await from('203.0.113.50', PASSWORD)).status, 429, 'burst requester is locked');
  await db.prepare('DELETE FROM owner_gate').run();
  // Distributed guessing: GLOBAL_LOCK_FAILURES wrong attempts from distinct requesters trip the backstop.
  for (let i = 0; i < GLOBAL_LOCK_FAILURES; i++) assert.equal((await from('10.9.' + Math.floor(i / 250) + '.' + (i % 250), 'bad-g' + i)).status, 401);
  assert.equal((await from('198.51.100.77', PASSWORD)).status, 429, 'global backstop locks a fresh requester, incl. the owner (documented residual risk)');
});

test('outbox retention ages terminal rows from completion (terminal_at), not creation', async () => {
  const { retain } = await import('../src/server/retention.ts');
  const db = await start(fullEnv());
  const now = Date.now(), day = 86400_000;
  await db.prepare("INSERT INTO webhook_outbox(id,principal_id,message_id,payload_json,status,next_at,created_at,terminal_at) VALUES ('late','agent:muse','m','{}','failed',0,?,?),('done','agent:muse','m','{}','delivered',0,?,?),('legacy','agent:muse','m','{}','failed',0,?,NULL)")
    .bind(now - 15 * day, now - 1000, now - 30 * day, now - 20 * day, now - 30 * day).run();
  const out = await retain(db as never, now);
  assert.equal(out.webhook_outbox, 2, '15-day-old item that failed today is NOT eligible; old terminal + legacy rows are');
  await retain(db as never, now, 'delete');
  assert.deepEqual((await db.prepare('SELECT id FROM webhook_outbox').all<{ id: string }>()).results.map((r: { id: string }) => r.id), ['late']);
});

test('OCG-W W1: memory search indexes messages and latest revisions; FTS operators are neutralised', async () => {
  const { searchMessages, ftsQuery } = await import('../src/server/memory.ts');
  const db = await start(fullEnv());
  await db.prepare("INSERT OR IGNORE INTO principals(id) VALUES ('agent:grok')").run();
  const t = new Date().toISOString();
  await db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m1','room_main','agent:grok','supersede needs verifier approval','text',?),('m2','room_main','agent:grok','unrelated lunch note','text',?)").bind(t, t).run();
  assert.deepEqual((await searchMessages(db as never, 'room_main', 'verifier', 10)).map(h => h.message_id), ['m1']);
  await db.prepare("INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES ('r1','m1',2,'agent:grok','renamed to reviewer gate','text',?)").bind(t).run();
  assert.equal((await searchMessages(db as never, 'room_main', 'verifier', 10)).length, 0, 'old revision text no longer matches');
  const hit = (await searchMessages(db as never, 'room_main', 'reviewer GATE', 10))[0]!;
  assert.equal(hit.message_id, 'm1'); assert.match(hit.snippet, /\[reviewer\]/);
  assert.equal((await searchMessages(db as never, 'other_room', 'reviewer', 10)).length, 0, 'room scoped');
  assert.equal(ftsQuery('a OR b* NEAR(x) col:y'), '"a" "OR" "b" "NEAR" "x" "col" "y"');
  assert.throws(() => ftsQuery('*** ()'), /no searchable terms/);
  assert.equal((await searchMessages(db as never, 'room_main', 'lunch', 10, '2000-01-01T00:00:00Z')).length, 0, 'before filter');
});

test('OCG-W wiring: propose via Workroom is pending, proposer cannot self-approve, listed reviewer approves, view shows it', async () => {
  const { Workroom } = await import('../src/server/domain.ts');
  const { itemContentDigest } = await import('../src/server/memory-review.ts');
  const db = await start(fullEnv());
  const muse = new Workroom(db as never, 'agent:muse'), dots = new Workroom(db as never, 'agent:dots');
  const t = new Date(Date.now() - 1000).toISOString();
  await db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('src1','room_main','agent:muse','we decided X','text',?)").bind(t).run();
  const { data: { item } } = await muse.memoryPropose({ room: 'room_main', kind: 'decision', tier: 2, title: 'Decision X', body: 'We do X.', source_message_id: 'src1', valid_from: t });
  assert.equal(item.review_state, 'pending');
  assert.equal((await muse.memoryView({ room: 'room_main', include_pending: false })).data.items.length, 0);
  assert.equal((await muse.memoryView({ room: 'room_main', include_pending: true })).data.items.length, 1);
  const digest = await itemContentDigest(item);
  await db.prepare("INSERT INTO memory_reviewers(principal_id,added_at) VALUES ('agent:muse',?),('agent:dots',?)").bind(t, t).run();
  await assert.rejects(muse.memoryReview({ room: 'room_main', target: 'item', id: item.id, verdict: 'approve', reason: 'self', content_digest: digest }));
  await assert.rejects(muse.memoryPropose({ room: 'room_main', kind: 'fact', tier: 1, title: 'k', body: 'token=' + 'a1'.repeat(25), source_message_id: 'src1', valid_from: t }), /secret/);
  const ok = await dots.memoryReview({ room: 'room_main', target: 'item', id: item.id, verdict: 'approve', reason: 'matches room decision', content_digest: digest });
  assert.equal((ok.data as unknown as { item: { review_state: string } }).item.review_state, 'approved');
  assert.deepEqual((await dots.memoryView({ room: 'room_main', include_pending: false })).data.items.map(i => i.id), [item.id]);
});

// Codex re-review c98873cb (P1) boundary reproductions at 20fb7fd.
test('R2 P1: a requester-locked client cannot exhaust the global verification budget', async () => {
  const { GLOBAL_LOCK_FAILURES, LOCK_FAILURES } = await import('../src/auth/g5.ts');
  const db = await start(fullEnv());
  const from = (ip: string, pw: string) => (async () => submit(await page(await authzQuery()), 'approve', pw, { Origin: ORIGIN, 'CF-Connecting-IP': ip }))();
  for (let i = 0; i < GLOBAL_LOCK_FAILURES + 5; i++) await from('203.0.113.66', 'bad-seq-' + i);
  const g = await db.prepare("SELECT failures, locked_until FROM owner_gate WHERE id='owner'").first<{ failures: number; locked_until: number }>();
  assert.ok(g!.failures <= LOCK_FAILURES, `only admitted attempts charge global, got ${g!.failures}`);
  assert.equal(g!.locked_until, 0, 'global backstop not tripped by one locked requester');
  assert.equal((await from('198.51.100.8', PASSWORD)).status, 302, 'owner elsewhere still gets in');
});
