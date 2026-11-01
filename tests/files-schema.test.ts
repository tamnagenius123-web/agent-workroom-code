import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import type { Database } from '../src/server/db.ts';
import { retain } from '../src/server/retention.ts';

const SHA = 'a'.repeat(64);

async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(23);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, 23);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    db.prepare("INSERT INTO principals(id) VALUES ('synthetic:alpha')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

async function count(db: Database, table: 'messages' | 'shared_files' | 'message_file_refs'): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function rejectsWith(run: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await run();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    assert.match(text, pattern);
    return;
  }
  assert.fail('expected rejection ' + pattern);
}

test('0023 splits into one newline-free statement per trigger', async () => {
  const sql = await readFile('migrations/0023_shared_files.sql', 'utf8');
  assert.equal(sql.endsWith(';\n'), true);
  const parts = sql.trim().split(/;\s*\n/).map(part => part.trim()).filter(Boolean);
  const triggers = parts.filter(part => part.startsWith('CREATE TRIGGER'));
  assert.deepEqual(triggers.map(part => /CREATE TRIGGER (\w+)/.exec(part)?.[1]), [
    'shared_files_no_delete',
    'shared_files_tombstone_only',
    'message_file_refs_no_update',
    'message_file_refs_no_delete',
    'message_file_refs_same_room',
  ]);
  for (const trigger of triggers) assert.equal(trigger.includes('\n'), false);
  const raw = sql.trim().split(/;\s*\n/).filter(part => /CREATE TRIGGER/.test(part));
  for (const trigger of raw) assert.equal(trigger.includes('\n'), false);
});

test('file rows only tombstone once, refs are immutable, and retain leaves them', async () => {
  const { db, close } = await start();
  try {
    const created = 1_700_000_000_000;
    const expires = created + 3_600_000;
    await db.prepare(
      `INSERT INTO shared_files(
        id, room_id, storage, name, mime, size_bytes, sha256, sha256_verified, uploader_id,
        created_at_ms, expires_at_ms, r2_key)
       VALUES ('file-1','room_main','r2','note.txt','text/plain',4,?,1,'synthetic:alpha',?,?,'rooms/room_main/files/file-1')`,
    ).bind(SHA, created, expires).all();
    await rejectsWith(
      () => db.prepare("UPDATE shared_files SET sha256=? WHERE id='file-1'").bind('b'.repeat(64)).all(),
      /shared file rows change only by tombstone/,
    );
    const sha = await db.prepare("SELECT sha256 FROM shared_files WHERE id='file-1'").first<{ sha256: string }>();
    assert.equal(sha?.sha256, SHA);
    await rejectsWith(() => db.prepare("DELETE FROM shared_files WHERE id='file-1'").all(), /shared file rows are kept/);
    assert.equal(await count(db, 'shared_files'), 1);

    await db.prepare("UPDATE shared_files SET deleted_at_ms=?, tombstone_reason='expired' WHERE id='file-1'").bind(expires).all();
    const once = await db.prepare('SELECT deleted_at_ms, tombstone_reason FROM shared_files WHERE id=?').bind('file-1')
      .first<{ deleted_at_ms: number; tombstone_reason: string }>();
    assert.equal(once?.deleted_at_ms, expires);
    assert.equal(once?.tombstone_reason, 'expired');
    await rejectsWith(
      () => db.prepare("UPDATE shared_files SET deleted_at_ms=?, tombstone_reason='expired' WHERE id='file-1'").bind(expires + 1).all(),
      /shared file rows change only by tombstone/,
    );
    const twice = await db.prepare('SELECT deleted_at_ms FROM shared_files WHERE id=?').bind('file-1').first<{ deleted_at_ms: number }>();
    assert.equal(twice?.deleted_at_ms, expires);

    await db.prepare("INSERT INTO shared_files(id,room_id,storage,name,mime,size_bytes,sha256,sha256_verified,uploader_id,created_at_ms,drive_file_id,web_link) VALUES ('drive-1','room_main','drive','link.pdf','application/pdf',10,? ,0,'synthetic:alpha',?,'abcdefghij','https://drive.google.com/file/d/abcdefghij/view')")
      .bind(SHA, created).all();
    await rejectsWith(
      () => db.prepare("UPDATE shared_files SET web_link='https://docs.google.com/document/d/abcdefghij/edit' WHERE id='drive-1'").all(),
      /shared file rows change only by tombstone/,
    );

    await db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m1','room_main','synthetic:alpha','see the file','text','2026-10-23T12:00:00.000Z')").all();
    await db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m2','room_other','synthetic:alpha','other room','text','2026-10-23T12:00:00.000Z')").all();
    await db.prepare("INSERT INTO message_file_refs(message_id,file_id,position) VALUES ('m1','file-1',0)").all();
    await rejectsWith(() => db.prepare("DELETE FROM message_file_refs WHERE message_id='m1'").all(), /message file refs are immutable/);
    await rejectsWith(() => db.prepare("UPDATE message_file_refs SET position=1 WHERE message_id='m1'").all(), /message file refs are immutable/);
    await rejectsWith(
      () => db.prepare("INSERT INTO message_file_refs(message_id,file_id,position) VALUES ('m2','file-1',0)").all(),
      /file and message are in different rooms/,
    );
    assert.equal(await count(db, 'message_file_refs'), 1);

    const before = {
      messages: await count(db, 'messages'),
      shared_files: await count(db, 'shared_files'),
      message_file_refs: await count(db, 'message_file_refs'),
    };
    const now = Date.parse('2026-10-23T12:00:00.000Z');
    await retain(db, now, 'dry_run');
    await retain(db, now, 'delete');
    assert.deepEqual({
      messages: await count(db, 'messages'),
      shared_files: await count(db, 'shared_files'),
      message_file_refs: await count(db, 'message_file_refs'),
    }, before);
    const text = await db.prepare("SELECT text FROM messages WHERE id='m1'").first<{ text: string }>();
    assert.equal(text?.text, 'see the file');
    const tomb = await db.prepare('SELECT deleted_at_ms, tombstone_reason FROM shared_files WHERE id=?').bind('file-1')
      .first<{ deleted_at_ms: number; tombstone_reason: string }>();
    assert.equal(tomb?.deleted_at_ms, expires);
    assert.equal(tomb?.tombstone_reason, 'expired');
  } finally { await close(); }
});
