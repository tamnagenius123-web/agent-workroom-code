import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { Database } from '../src/server/db.ts';
import { proposeFold, reviewFold } from '../src/server/fold.ts';

// Codex HOLD d1def20: the test D1 applied 0024 before 0021/0022. Replay that order and check the audit rows survive.
async function apply(db: Database, name: string): Promise<void> {
  const statements = (await readFile('migrations/' + name, 'utf8')).trim().split(/;\s*\n/).filter(s => s.trim()).map(s => db.prepare(s));
  await db.batch(statements);
}

test('0024 applied before 0021/0022, then 0025: reviewer audit rows are preserved and folds work', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'migration-order-' + webcrypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB') as Database;
    const all = (await readdir('migrations')).filter(n => /^\d{4}.*\.sql$/.test(n)).sort();
    for (const name of all.filter(n => Number(n.slice(0, 4)) <= 20)) await apply(db, name);
    await db.batch([
      db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
      db.prepare("INSERT INTO principals(id) VALUES ('agent:muse')"),
      db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:muse', '2026-10-23T01:00:00.000Z')"),
    ]);
    await apply(db, all.find(n => n.startsWith('0024'))!);
    await db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')").all();
    await db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots', '2026-10-23T02:00:00.000Z')").all();
    const audit = await db.prepare('SELECT seq, principal_id, action, logged_at FROM memory_reviewer_log ORDER BY seq').all<{ seq: number; principal_id: string; action: string; logged_at: string }>();
    assert.deepEqual(audit.results.map(row => [row.principal_id, row.action]), [['agent:muse', 'present_at_migration'], ['agent:dots', 'added']]);
    for (const prefix of ['0021', '0022', '0025']) await apply(db, all.find(n => n.startsWith(prefix))!);
    const after = await db.prepare('SELECT seq, principal_id, action, logged_at FROM memory_reviewer_log ORDER BY seq').all();
    assert.deepEqual(after.results, audit.results);
    await assert.rejects(() => db.prepare('DELETE FROM memory_reviewer_log').all(), /immutable/);
    await db.prepare("INSERT INTO rooms(id) VALUES ('room_main')").all();
    await db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m1','room_main','agent:grok','body','text','2026-10-01T00:00:00.001Z')").all();
    for (let i = 2; i <= 21; i += 1) await db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,'room_main','agent:grok','pad','text',?)").bind(`p${i}`, new Date(Date.UTC(2026, 9, 1, 0, 0, 0, i)).toISOString()).all();
    const proposed = await proposeFold(db, 'agent:grok', { id: 'fold-1', room_id: 'room_main', summary: 'S.', valid_from: '2026-10-02T00:00:00.000Z', message_ids: ['m1'] });
    const approved = await reviewFold(db, 'agent:dots', 'room_main', 'fold-1', 'approve', 'Recorded.', proposed.content_digest);
    assert.equal(approved.review_state, 'approved');
  } finally { await mf.dispose(); }
});
