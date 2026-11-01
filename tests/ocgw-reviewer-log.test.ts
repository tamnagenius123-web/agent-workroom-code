import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';

type Database = Awaited<ReturnType<Miniflare['getD1Database']>>;

async function start(through: number): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(through);
  const mf = new Miniflare({ modules: true, script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir, cf: false } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB');
  await migrate(db, through);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

const rows = async (db: Database) => (await db.prepare('SELECT principal_id, action FROM memory_reviewer_log ORDER BY seq').all<{ principal_id: string; action: string }>()).results;

test('0024 seeds nobody, backfills existing reviewers, logs add/remove append-only', async () => {
  const { db, close } = await start(20);
  try {
    await db.batch(['agent:dots', 'agent:muse'].map(p => db.prepare('INSERT INTO principals(id) VALUES (?)').bind(p)));
    await db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots','2026-10-22T00:00:00.000Z')").run();
    await migrate(db, 24);
    assert.deepEqual(await rows(db), [{ principal_id: 'agent:dots', action: 'present_at_migration' }]);
    await db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:muse','2026-10-23T03:00:00.000Z')").run();
    await db.prepare("DELETE FROM memory_reviewers WHERE principal_id='agent:dots'").run();
    assert.deepEqual(await rows(db), [
      { principal_id: 'agent:dots', action: 'present_at_migration' },
      { principal_id: 'agent:muse', action: 'added' },
      { principal_id: 'agent:dots', action: 'removed' },
    ]);
    await assert.rejects(db.prepare("UPDATE memory_reviewer_log SET action='added'").run(), /immutable/);
    await assert.rejects(db.prepare('DELETE FROM memory_reviewer_log').run(), /immutable/);
    const n = await db.prepare('SELECT count(*) AS n FROM memory_reviewers').first<{ n: number }>();
    assert.equal(n?.n, 1);
  } finally { await close(); }
});

test('0024 on a fresh database seeds no reviewer', async () => {
  const { db, close } = await start(24);
  try {
    assert.equal((await db.prepare('SELECT count(*) AS n FROM memory_reviewers').first<{ n: number }>())?.n, 0);
    assert.deepEqual(await rows(db), []);
  } finally { await close(); }
});
