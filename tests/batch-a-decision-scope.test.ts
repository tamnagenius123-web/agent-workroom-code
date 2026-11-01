import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { Database } from '../src/server/db.ts';

// BATCH-A HOLD: UNIQUE (recorded_by, idempotency_key) is global. Replay is
// already room-scoped, so a row in another room must not reject a legitimate
// room_main insert. The decisions table is created empty, so apply cannot
// fail on existing rows.

function applySql(db: Database, sql: string) {
  const statements = sql.trim().split(/;\s*\n/).filter(statement => statement.trim()).map(statement => db.prepare(statement));
  return db.batch(statements);
}

const COLUMNS = [
  'id', 'directive_id', 'intent_version', 'statement', 'criteria_json', 'alternatives_json',
  'best_choice', 'scored_choice', 'weight', 'weight_rank', 'provenance', 'approval', 'owner_text',
  'recorded_by', 'room_id', 'idempotency_key', 'request_hash', 'created_at',
];

function row(id: string, room: string): (string | number | null)[] {
  return [
    id, 'd1', 1, 'cite the id',
    '[{"id":"c","label":"C","weight":1}]',
    '[{"id":"a","label":"A","scores":{"c":1},"weighted_score":1}]',
    'a', 'a', 'inferred', 1, 'directive:d1', 0, null,
    'agent:dots', room, 'same-key', 'hash-1', '2026-10-27T00:00:00.000Z',
  ];
}

test('decision idempotency is per room and the migration applies onto zero rows', async () => {
  const name = readdirSync('migrations').find(entry => /^\d{4}_decisions\.sql$/.test(entry));
  assert.ok(name, 'decisions migration is missing');
  const sql = readFileSync('migrations/' + name, 'utf8');
  assert.doesNotMatch(sql, /\bINSERT\b/i);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'batch-a-scope-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB') as Database;
    await applySql(db, 'CREATE TABLE owner_directives (id TEXT PRIMARY KEY);\nCREATE TABLE intent_versions (version INTEGER PRIMARY KEY);\n');
    await applySql(db, sql);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM decisions').first<{ n: number }>())?.n, 0);
    await db.prepare("INSERT INTO owner_directives(id) VALUES ('d1')").all();
    await db.prepare('INSERT INTO intent_versions(version) VALUES (1)').all();
    const insert = `INSERT INTO decisions(${COLUMNS.join(',')}) VALUES (${COLUMNS.map(() => '?').join(',')})`;
    await db.prepare(insert).bind(...row('dec_00000000-0000-4000-8000-0000000000a1', 'room_main')).all();
    await db.prepare(insert).bind(...row('dec_00000000-0000-4000-8000-0000000000a2', 'room_other')).all();
    await assert.rejects(
      () => db.prepare(insert).bind(...row('dec_00000000-0000-4000-8000-0000000000a3', 'room_main')).all(),
      /UNIQUE|constraint/i,
    );
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM decisions').first<{ n: number }>())?.n, 2);
    assert.match(sql, /UNIQUE \(recorded_by, room_id, idempotency_key\)/);
  } finally {
    await mf.dispose();
  }
});
