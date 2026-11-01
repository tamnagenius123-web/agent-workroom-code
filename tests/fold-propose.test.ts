import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { sha256Hex } from '../src/server/canonical.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { foldCanonical, foldContentDigest, proposeFold, type FoldProposal } from '../src/server/fold.ts';
import { retain } from '../src/server/retention.ts';

const ROOM = 'room_main';
const OTHER = 'room_other';
const FROM = '2026-10-02T00:00:00.000Z';

function iso(ms: number): string {
  return new Date(Date.UTC(2026, 9, 1, 0, 0, 0, ms)).toISOString();
}

async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(25);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  try {
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, 25);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots', '2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
  } catch (err) { await mf.dispose(); d1.cleanup(); throw err; }
}

async function say(db: Database, id: string, text: string, createdAt: string, room = ROOM): Promise<void> {
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, room, 'agent:grok', text, 'text', createdAt).all();
}

async function count(db: Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function fault(pattern: RegExp): (err: unknown) => boolean {
  return err => err instanceof Fault && err.code === 'INVALID_INPUT' && pattern.test(err.message);
}

async function roomMessages(db: Database, n: number, textFor: (i: number) => string): Promise<void> {
  for (let i = 1; i <= n; i += 1) await say(db, `m${i}`, textFor(i), iso(i));
}

test('0021 splits into one statement per trigger and none of those statements contain a newline', () => {
  const text = readFileSync(fileURLToPath(new URL('../migrations/0021_ocgw_fold.sql', import.meta.url)), 'utf8');
  assert.equal(text.endsWith(';\n'), true);
  const parts = text.trim().split(/;\s*\n/).map(part => part.trim()).filter(part => part.length > 0);
  const triggers = parts.filter(part => part.includes('CREATE TRIGGER'));
  assert.equal(triggers.length, text.match(/CREATE TRIGGER/g)?.length ?? 0);
  assert.ok(triggers.length >= 15);
  for (const trigger of triggers) {
    assert.equal(trigger.includes('\n'), false);
    assert.equal(trigger.replace(/;$/, '').endsWith('END'), true);
  }
});

test('a closed span pins version and hash, a gap or foreign id or a short room writes nothing', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 5, i => `body ${i}`);
    await say(db, 'm-foreign', 'other room', iso(1), OTHER);
    assert.equal(await count(db, 'memory_folds'), 0);
    await assert.rejects(
      () => proposeFold(db, 'agent:grok', { room_id: ROOM, summary: 'too new', valid_from: FROM, message_ids: ['m1', 'm2', 'm3', 'm4', 'm5'] }),
      fault(/newest 20/),
    );
    await assert.rejects(
      () => proposeFold(db, 'agent:grok', { room_id: ROOM, summary: 'sk-ant-secret', valid_from: FROM, message_ids: ['m1'] }),
      fault(/^Title or body looks like a secret$/),
    );
    await assert.rejects(
      () => proposeFold(db, 'agent:grok', { room_id: ROOM, summary: 'foreign', valid_from: FROM, message_ids: ['m-foreign'] }),
      fault(/Unknown message in this room: m-foreign/),
    );
    assert.equal(await count(db, 'memory_folds'), 0);
    assert.equal(await count(db, 'fold_sources'), 0);

    for (let i = 6; i <= 25; i += 1) await say(db, `m${i}`, `tail ${i}`, iso(i));
    const messagesBefore = await count(db, 'messages');
    const revisionsBefore = await count(db, 'message_revisions');
    await assert.rejects(
      () => proposeFold(db, 'agent:grok', { room_id: ROOM, summary: 'gap', valid_from: FROM, message_ids: ['m1', 'm2', 'm4', 'm5'] }),
      fault(/Missing: m3/),
    );
    await assert.rejects(
      () => proposeFold(db, 'agent:grok', { room_id: ROOM, summary: 'tail', valid_from: FROM, message_ids: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'] }),
      fault(/m6/),
    );
    assert.equal(await count(db, 'memory_folds'), 0);
    assert.equal(await count(db, 'fold_sources'), 0);
    assert.equal(await count(db, 'messages'), messagesBefore);
    assert.equal(await count(db, 'message_revisions'), revisionsBefore);

    const proposed = await proposeFold(db, 'agent:grok', {
      id: 'fold-old5', room_id: ROOM, summary: 'Oldest five.', valid_from: FROM,
      message_ids: ['m5', 'm4', 'm3', 'm2', 'm1'],
    });
    assert.deepEqual(proposed.sources.map(source => source.message_id), ['m1', 'm2', 'm3', 'm4', 'm5']);
    assert.equal(proposed.fold.review_state, 'pending');
    assert.equal(proposed.fold.valid_until, null);
    assert.equal(proposed.fold.summary, 'Oldest five.');
    assert.equal(proposed.fold.first_message_id, 'm1');
    assert.equal(proposed.fold.last_message_id, 'm5');
    assert.equal(proposed.content_digest, proposed.fold.content_digest);
    for (const source of proposed.sources) {
      assert.equal(source.source_version, 1);
      assert.equal(source.source_hash, await sha256Hex(`body ${source.message_id.slice(1)}`));
      assert.equal(source.provenance_state, 'resolvable');
    }
    const digest = await foldContentDigest({
      id: proposed.fold.id, room_id: proposed.fold.room_id, summary: proposed.fold.summary,
      first_message_id: proposed.fold.first_message_id, last_message_id: proposed.fold.last_message_id,
      span_from: proposed.fold.span_from, span_to: proposed.fold.span_to, valid_from: proposed.fold.valid_from,
      sources: proposed.sources.map(source => ({
        message_id: source.message_id, source_version: source.source_version, source_hash: source.source_hash, source_seq: source.source_seq,
      })),
      children: [],
    });
    assert.equal(proposed.content_digest, digest);
    assert.equal(foldCanonical({
      id: proposed.fold.id, room_id: ROOM, summary: proposed.fold.summary,
      first_message_id: 'm1', last_message_id: 'm5', span_from: proposed.fold.span_from, span_to: proposed.fold.span_to, valid_from: FROM,
      sources: proposed.sources, children: [],
    }).includes('workroom.memory_fold.v1'), true);
    assert.equal(await count(db, 'messages'), messagesBefore);
    assert.equal(await count(db, 'message_revisions'), revisionsBefore);
    assert.equal(await count(db, 'memory_folds'), 1);
    assert.equal(await count(db, 'fold_sources'), 5);

    await assert.rejects(() => db.prepare('UPDATE memory_folds SET summary=? WHERE id=?').bind('changed', 'fold-old5').all());
    await assert.rejects(() => db.prepare('DELETE FROM fold_sources WHERE fold_id=?').bind('fold-old5').all());
    const summary = await db.prepare('SELECT summary FROM memory_folds WHERE id=?').bind('fold-old5').first<{ summary: string }>();
    assert.equal(summary?.summary, 'Oldest five.');
    assert.equal(await count(db, 'fold_sources'), 5);
    await retain(db, Date.now(), 'delete');
    assert.equal(await count(db, 'messages'), messagesBefore);
    assert.equal(await count(db, 'message_revisions'), revisionsBefore);
    assert.equal(await count(db, 'memory_folds'), 1);
    assert.equal(await count(db, 'fold_sources'), 5);
  } finally { await close(); }
});

test('a revision is pinned at max version and the original history row remains', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25, i => `body ${i}`);
    await db.prepare('INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES (?,?,2,?,?,?,?)')
      .bind('rev-m1', 'm1', 'agent:grok', 'revised body', 'text', iso(30)).all();
    const revisionsBefore = await count(db, 'message_revisions');
    const proposed: FoldProposal = await proposeFold(db, 'agent:grok', {
      id: 'fold-rev', room_id: ROOM, summary: 'Pinned revision.', valid_from: FROM, message_ids: ['m1'],
    });
    const pinned = proposed.sources[0];
    assert.ok(pinned);
    assert.equal(pinned.source_version, 2);
    assert.equal(pinned.source_hash, await sha256Hex('revised body'));
    assert.notEqual(pinned.source_hash, await sha256Hex('body 1'));
    const history = await db.prepare('SELECT version, text FROM message_history WHERE message_id=? ORDER BY version').bind('m1').all<{ version: number; text: string }>();
    assert.deepEqual(history.results.map(row => ({ version: Number(row.version), text: row.text })), [
      { version: 1, text: 'body 1' },
      { version: 2, text: 'revised body' },
    ]);
    assert.equal(await count(db, 'messages'), 25);
    assert.equal(await count(db, 'message_revisions'), revisionsBefore);
  } finally { await close(); }
});

function racing(db: Database, before: () => Promise<unknown>): Database {
  let fired = false;
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key === 'batch') {
        return async (statements: Parameters<Database['batch']>[0]) => {
          if (!fired) { fired = true; await before(); }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('HOLD P1: a source revised between read and write stores no fold, no sources and no edges', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25, i => `body ${i}`);
    const counts = async () => [await count(db, 'memory_folds'), await count(db, 'fold_sources'), await count(db, 'fold_edges'), await count(db, 'fold_write_guard')];
    const before = await counts();
    const raced = racing(db, () => db.prepare('INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) VALUES (?,?,2,?,?,?,?)')
      .bind('rev-race', 'm2', 'agent:grok', 'edited mid-proposal', 'text', iso(40)).all());
    await assert.rejects(() => proposeFold(raced, 'agent:grok', {
      id: 'fold-race', room_id: ROOM, summary: 'Raced.', valid_from: FROM, message_ids: ['m1', 'm2', 'm3'],
    }), fault(/source or child changed/));
    assert.deepEqual(await counts(), before);
  } finally { await close(); }
});
