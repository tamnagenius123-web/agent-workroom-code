import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { lookupOwnerDecisions } from '../src/server/owner-decisions.ts';
import type { Database } from '../src/server/db.ts';

test('real migrations (incl. 0045) + committed seed -> lookup 보안 returns t916u', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: 'odm-' + crypto.randomUUID() }, cf: false } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  try {
    const raw = await mf.getD1Database('DB');
    await migrate(raw, 9999);
    const db = raw as unknown as Database;
    await db.prepare("INSERT INTO rooms(id) VALUES ('room_main')").all(); // as local-harness; prod already has room_main
    const seed = readFileSync('seeds/owner-decisions.sql', 'utf8');
    for (const s of seed.split(/;\n/).filter(x => x.trim())) await db.prepare(s).all();
    for (const s of seed.split(/;\n/).filter(x => x.trim())) await db.prepare(s).all(); // idempotent
    const hits = await lookupOwnerDecisions(db, '보안');
    assert.ok(hits.some(h => h.source === 't916u' && h.active), 'expected active t916u record');
    const n = await db.prepare("SELECT count(*) AS n FROM owner_directives WHERE idempotency_key LIKE 'od:%'").first<{ n: number }>();
    assert.equal(n!.n, seed.split(/;\n/).filter(x => x.trim()).length);
  } finally { await mf.dispose(); }
});
