import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { lookupOwnerDecisions, ownerDecisionRoute } from '../src/server/owner-decisions.ts';
import type { Database } from '../src/server/db.ts';

async function database() {
  const mf = new Miniflare({ modules: true, script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: 'od-' + crypto.randomUUID() }, cf: false } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready; return { db: await mf.getD1Database('DB') as Database, close: () => mf.dispose() };
}
const DDL = `CREATE TABLE owner_directives (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, actor_id TEXT NOT NULL, text TEXT NOT NULL, message_id TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (actor_id, idempotency_key))`;
const LEDGER = [
  { id: 'od_t907u_owner', ts_kst: '2026-10-28 00:28', source: 't907u', verbatim: '2번은 2로 간다. 1번은 기본값대로', normalized: 'TG-MIRROR owner check = from.id only', topics: ['tg-mirror', 'owner-check'], supersedes: [], direct: true },
  { id: 'od_t912u_identity', ts_kst: '2026-10-28 02:05', source: 't912u', verbatim: '3번은 내가 프레임워크 단위로 단속하라고', normalized: 'No per-agent GitHub identities; framework-level identity', topics: ['identity', 'github'], supersedes: [], direct: true },
  { id: 'od_old', ts_kst: '2026-10-27 20:00', source: 't800u', verbatim: '옛 결정', normalized: 'TG-MIRROR owner check = three checks', topics: ['tg-mirror', 'owner-check'], supersedes: [], direct: true },
  { id: 'od_new', ts_kst: '2026-10-28 00:29', source: 't907u', verbatim: '2번은 2로', normalized: 'owner-check from.id (supersedes three checks)', topics: ['tg-mirror', 'owner-check'], supersedes: ['od_old'], direct: true },
];
function seedSql(): string {
  const dir = mkdtempSync(join(tmpdir(), 'od-')); const f = join(dir, 'l.jsonl');
  writeFileSync(f, LEDGER.map(r => JSON.stringify(r)).join('\n') + '\n');
  return execFileSync(process.execPath, ['scripts/owner-decisions-seed.mjs', f, '--room', 'main'], { encoding: 'utf8' });
}
async function seeded() {
  const h = await database(); await h.db.prepare(DDL).all();
  const sql = seedSql(); for (const s of sql.split(/;\s*\n/).filter(x => x.trim())) await h.db.prepare(s).all();
  return { ...h, sql };
}

test('seed is deterministic, idempotent and owned by user:minsung', async () => {
  assert.equal(seedSql(), seedSql());
  const { db, close, sql } = await seeded();
  try {
    for (const s of sql.split(/;\s*\n/).filter(x => x.trim())) await db.prepare(s).all(); // re-apply: no dup
    const rows = (await db.prepare('SELECT actor_id, idempotency_key FROM owner_directives ORDER BY id').all<{ actor_id: string; idempotency_key: string }>()).results;
    assert.equal(rows.length, 4);
    assert.ok(rows.every(r => r.actor_id === 'user:minsung' && r.idempotency_key.startsWith('od:')));
  } finally { await close(); }
});

test('lookup returns verbatim + source, all terms must match, superseded ranks last', async () => {
  const { db, close } = await seeded();
  try {
    const hits = await lookupOwnerDecisions(db, 'owner-check');
    assert.deepEqual(hits.map(h => h.id), ['od_new', 'od_t907u_owner', 'od_old']);
    assert.equal(hits[2]!.active, false);
    assert.equal(hits[1]!.source, 't907u');
    assert.equal(hits[1]!.verbatim, '2번은 2로 간다. 1번은 기본값대로');
    assert.deepEqual((await lookupOwnerDecisions(db, 'identity github')).map(h => h.id), ['od_t912u_identity']);
    assert.deepEqual(await lookupOwnerDecisions(db, 'identity tg-mirror'), []);
    await assert.rejects(lookupOwnerDecisions(db, ''), /query/i);
  } finally { await close(); }
});

test('route: GET /v1/owner-decisions/lookup only; 503 when 0045 missing', async () => {
  const { db, close } = await seeded();
  try {
    const svc = { database: db, authorize: async () => undefined };
    const hit = await ownerDecisionRoute(svc, new Request('https://x/v1/owner-decisions/lookup?q=tg-mirror'), new URL('https://x/v1/owner-decisions/lookup?q=tg-mirror'));
    assert.equal(hit!.meta.matched, 3);
    assert.equal(await ownerDecisionRoute(svc, new Request('https://x/v1/other'), new URL('https://x/v1/other')), null);
    await assert.rejects(ownerDecisionRoute(svc, new Request('https://x/v1/owner-decisions/lookup?q=a', { method: 'POST' }), new URL('https://x/v1/owner-decisions/lookup?q=a')), /405|Method/);
  } finally { await close(); }
  const empty = await database();
  try {
    await assert.rejects(ownerDecisionRoute({ database: empty.db, authorize: async () => undefined }, new Request('https://x/v1/owner-decisions/lookup?q=a'), new URL('https://x/v1/owner-decisions/lookup?q=a')), (e: { status?: number }) => e.status === 503);
  } finally { await empty.close(); }
});
