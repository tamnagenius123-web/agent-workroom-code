/* eslint-disable @typescript-eslint/no-explicit-any -- untyped Miniflare D1/JSON test plumbing; CI-GATE lint baseline */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

async function apply(db: any, name: string): Promise<void> {
  const sql = (await readFile('migrations/' + name, 'utf8')).replace(/^--.*$/gm, '').trim();
  await db.batch(sql.split(/;\s*\n/).filter(s => s.trim()).map(s => db.prepare(s)));
}

test('0053 adds claude aliases additively and is idempotent', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null) } }', compatibilityDate: '2026-07-28', d1Databases: { DB: 'alias-' + webcrypto.randomUUID() }, cf: false } as any);
  try {
    const db: any = await mf.getD1Database('DB');
    await db.prepare('CREATE TABLE agent_aliases (alias TEXT PRIMARY KEY, principal_id TEXT NOT NULL)').run();
    await db.prepare("INSERT INTO agent_aliases VALUES ('muse','agent:muse')").run();
    await apply(db, '0053_claude_alias.sql');
    await apply(db, '0053_claude_alias.sql');
    const rows = (await db.prepare('SELECT alias, principal_id FROM agent_aliases ORDER BY alias').all()).results.map((r: any) => [r.alias, r.principal_id]);
    assert.deepEqual(rows, [['claude','agent:claude'],['muse','agent:muse'],['클로드','agent:claude']]);
  } finally { await mf.dispose(); }
});
