import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { Database } from '../src/server/db.ts';
import { lookupOwnerDecisions, groupBySource } from '../src/server/owner-decisions.ts';
import { ownerMemory, shouldRecall, recallTerms, PINNED_LIMIT } from '../src/server/memory-hook.ts';

// MEM-HOOK (owner t924u/t926u): recall is enforced at handoff/question/decision points.
// Paper Scout: (a) router skips trivial turns, (b) pinned core of active owner decisions first, (c) query from draft action.
const DDL = `CREATE TABLE owner_directives (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, actor_id TEXT NOT NULL, text TEXT NOT NULL, message_id TEXT, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (actor_id, idempotency_key))`;
type R = { id: string; ts_kst: string; source: string; verbatim: string; normalized: string; topics?: string[]; supersedes?: string[] };
const ROWS: R[] = [
  { id: 'od_a', ts_kst: '2026-10-28 02:05', source: 't912u', verbatim: '프레임워크 단위로 단속', normalized: 'No per-agent GitHub identities; framework-level identity enforcement', topics: ['identity', 'github'] },
  { id: 'od_b', ts_kst: '2026-10-28 02:10', source: 't916u', verbatim: '보안 관련된 건 뒤로 싹다 미뤄', normalized: 'Security and gate work deferred; functional verification only', topics: ['security', 'verification'] },
  { id: 'od_b2', ts_kst: '2026-10-28 02:10', source: 't916u', verbatim: '보안 관련된 건 뒤로 싹다 미뤄', normalized: 'dup backfill', topics: ['security'] },
  { id: 'od_b3', ts_kst: '2026-10-28 02:11', source: 't917u', verbatim: '로드맵 새로 짜라 (t916u 참고)', normalized: 'roadmap without security, see t916u', topics: ['roadmap'] },
  { id: 'od_c', ts_kst: '2026-10-27 ??:??', source: 't869s3155', verbatim: '기존 TS 호스트 컴포넌트도 Rust로 다시 짜', normalized: 'Rewrite TS host in Rust', topics: ['rust'] },
  { id: 'od_old', ts_kst: '2026-10-27 20:00', source: 't800u', verbatim: '옛 결정', normalized: 'OpenRouter spend forbidden', topics: ['openrouter', 'spend'] },
  { id: 'od_new', ts_kst: '2026-10-28 02:20', source: 't918u', verbatim: '20달러 선에서 허가할게', normalized: 'OpenRouter spend approved up to USD 20, sticky provider', topics: ['openrouter', 'spend'], supersedes: ['od_old'] },
];
async function seeded(rows: R[] = ROWS) {
  const mf = new Miniflare({ modules: true, script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: 'mh-' + crypto.randomUUID() }, cf: false } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready; const db = await mf.getD1Database('DB') as Database;
  await db.prepare(DDL).all();
  for (const r of rows) await db.prepare("INSERT INTO owner_directives VALUES (?, 'room_main', 'user:minsung', ?, NULL, ?, 'h', ?)")
    .bind(r.id, JSON.stringify({ ...r, topics: r.topics ?? [], supersedes: r.supersedes ?? [], direct: true }), 'od:' + r.id, '2026-10-28T00:00:00+09:00').all();
  return { db, close: () => mf.dispose() };
}

test('router: trivial turns skip recall, real work recalls', () => {
  for (const t of ['ok', '네', 'thanks!', '👍', '  ']) assert.equal(shouldRecall(t).recall, false, t);
  assert.equal(shouldRecall('Implement OpenRouter sticky provider routing for Dots').recall, true);
  assert.equal(shouldRecall('보안 게이트 작업 다시 넣을까요?').recall, true);
});

test('recall query is built from draft action text (stopwords dropped, capped)', () => {
  const terms = recallTerms('Please implement the OpenRouter spend cap for the harness');
  assert.ok(terms.includes('openrouter') && terms.includes('spend'));
  assert.ok(!terms.includes('the') && !terms.includes('please'));
  assert.ok(recallTerms('a b '.repeat(50) + 'x'.repeat(5)).length <= 12);
});

test('ownerMemory: pinned core of active decisions first, stable order, superseded excluded; recall ranks by overlap', async () => {
  const { db, close } = await seeded();
  try {
    const m = await ownerMemory(db, { kind: 'handoff', text: 'Wire OpenRouter spend metering into the harness' });
    assert.ok(m);
    assert.ok(m.pinned.length > 0 && m.pinned.length <= PINNED_LIMIT);
    assert.ok(!m.pinned.some(p => p.id === 'od_old'), 'superseded never pinned');
    const again = await ownerMemory(db, { kind: 'question', text: 'something different about rust hosts' });
    assert.deepEqual(again!.pinned, m.pinned, 'pinned prefix independent of query (cache-stable)');
    assert.equal(m.recalled[0]?.id, 'od_new');
    assert.ok(!m.recalled.some(r => r.id === 'od_old'));
    const skip = await ownerMemory(db, { kind: 'question', text: 'ok' });
    assert.equal(skip!.recalled.length, 0); assert.equal(skip!.recall_skipped, 'trivial');
    assert.ok(skip!.pinned.length > 0, 'pinned still injected on trivial turns');
  } finally { await close(); }
});

test('ownerMemory returns null when 0045 is absent (brief unchanged)', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: 'mh0-' + crypto.randomUUID() }, cf: false } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  try { assert.equal(await ownerMemory(await mf.getD1Database('DB') as Database, { kind: 'handoff', text: 'x y z task' }), null); } finally { await mf.dispose(); }
});

test('lookup: exact source query returns that source only, groups by source', async () => {
  const { db, close } = await seeded();
  try {
    const hits = await lookupOwnerDecisions(db, 't916u');
    assert.deepEqual(hits.map(h => h.source), ['t916u', 't916u'], 'distinct decisions from one source both kept');
    const g = groupBySource(await lookupOwnerDecisions(db, 'security'));
    assert.equal(g.filter(x => x.source === 't916u').length, 1);
  } finally { await close(); }
});

test('lookup: unknown time ??:?? is normalized to a date with ts_approx', async () => {
  const { db, close } = await seeded();
  try {
    const [h] = await lookupOwnerDecisions(db, 't869s3155');
    assert.equal(h!.ts_kst, '2026-10-27'); assert.equal(h!.ts_approx, true);
  } finally { await close(); }
});

// Claude FAIL on 582f2e8 (e6507d6e): dedupe dropped distinct decisions; non-ISO timestamps sorted wrong.
test('dedupe: one source with two distinct decisions keeps both; only true duplicates collapse', async () => {
  const rows: R[] = [
    { id: 'od_s1', ts_kst: '2026-10-28 02:10', source: 't999u', verbatim: '같은 원문', normalized: 'decision one', topics: ['x'] },
    { id: 'od_s2', ts_kst: '2026-10-28 02:10', source: 't999u', verbatim: '같은 원문', normalized: 'decision two', topics: ['x'] },
    { id: 'od_s3', ts_kst: '2026-10-28 02:10', source: 't999u', verbatim: '같은 원문', normalized: 'decision two', topics: ['x'] },
  ];
  const { db, close } = await seeded(rows);
  try {
    const hits = await lookupOwnerDecisions(db, 't999u');
    assert.deepEqual(hits.map(h => h.normalized).sort(), ['decision one', 'decision two']);
  } finally { await close(); }
});

test('timestamps: all formats normalize to KST "YYYY-MM-DD HH:MM" and sort chronologically', async () => {
  const rows: R[] = [
    { id: 'od_t1', ts_kst: 'Tuesday, Oct 27, 2026, 4:26 PM (UTC+9)', source: 'tz1', verbatim: 'v1', normalized: 'n1', topics: ['tzsort'] },
    { id: 'od_t2', ts_kst: '2026-10-27T23:05+09:00', source: 'tz2', verbatim: 'v2', normalized: 'n2', topics: ['tzsort'] },
    { id: 'od_t3', ts_kst: '2026-10-28 01:00', source: 'tz3', verbatim: 'v3', normalized: 'n3', topics: ['tzsort'] },
    { id: 'od_t4', ts_kst: 'Tuesday, Oct 27, 2026, 9:01 AM (UTC+9)', source: 'tz4', verbatim: 'v4', normalized: 'n4', topics: ['tzsort'] },
    { id: 'od_t5', ts_kst: 'Tuesday, Oct 27, 2026, 12:30 PM (UTC+9)', source: 'tz5', verbatim: 'v5', normalized: 'n5', topics: ['tzsort'] },
  ];
  const { db, close } = await seeded(rows);
  try {
    const hits = await lookupOwnerDecisions(db, 'tzsort');
    assert.deepEqual(hits.map(h => h.ts_kst), ['2026-10-28 01:00', '2026-10-27 23:05', '2026-10-27 16:26', '2026-10-27 12:30', '2026-10-27 09:01']);
  } finally { await close(); }
});

test('real seed: active count >= 57; security and t916u return both t916u rows', async () => {
  const { readFileSync } = await import('node:fs');
  const mf = new Miniflare({ modules: true, script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28', d1Databases: { DB: 'mhs-' + crypto.randomUUID() }, cf: false } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready; const db = await mf.getD1Database('DB') as Database;
  try {
    await db.prepare(DDL).all();
    for (const line of readFileSync(new URL('../seeds/owner-decisions.sql', import.meta.url), 'utf8').split('\n')) if (line.startsWith('INSERT')) await db.prepare(line).all();
    const m = await ownerMemory(db, { kind: 'handoff', text: 'x' });
    const { activeOwnerDecisions } = await import('../src/server/owner-decisions.ts');
    const active = await activeOwnerDecisions(db);
    assert.ok(active && active.length >= 57, `active=${active?.length}`);
    assert.ok(m);
    for (const q of ['security', 't916u']) {
      const ids = (await lookupOwnerDecisions(db, q)).map(h => h.id);
      assert.ok(ids.includes('od_t916u_functional') && ids.includes('od_t916u_security_defer'), `${q}: ${ids}`);
    }
  } finally { await mf.dispose(); }
});
