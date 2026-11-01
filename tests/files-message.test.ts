import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import {
  expireFiles, getFile, registerDriveLink, requireAttachableFiles, uploadFile,
  type DriveLinkInput, type FileBucket, type UploadFileInput,
} from '../src/server/files.ts';

// Post, MCP, and READ_TOOLS stay with the integrator. These tests cover the cite gate the module owns.
const ROOM = 'room_main';
const OTHER = 'room_other';
const ALPHA = 'synthetic:alpha';
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const DRIVE_ID = 'abc_def-gh';

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

class Bucket implements FileBucket {
  objects = new Map<string, Uint8Array>();
  async put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): Promise<void> {
    if (value instanceof Uint8Array) this.objects.set(key, value);
    else if (value instanceof ArrayBuffer) this.objects.set(key, new Uint8Array(value));
    else {
      const reader = value.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value);
        total += next.value.byteLength;
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
      this.objects.set(key, out);
    }
  }
  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
}

async function count(db: Database, table: 'messages' | 'shared_files' | 'message_file_refs' | 'operations'): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function expectFault(run: () => Promise<unknown>, code: string, status: number): Promise<Fault> {
  try { await run(); } catch (error) {
    assert.ok(error instanceof Fault, error instanceof Error ? error.message : String(error));
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return error;
  }
  assert.fail('expected ' + code);
}

function upload(db: Database, bucket: Bucket, over: Partial<UploadFileInput> = {}) {
  return uploadFile(db, bucket, {
    room: ROOM, principal: ALPHA, name: 'notes.pdf', mime: 'application/pdf',
    body: new TextEncoder().encode('hello'), now: NOW, idempotency_key: 'upload-key-1',
    env: { FILE_TTL_SECONDS: '60' }, ...over,
  });
}

test('a cite keeps caller order and refuses expired, unknown, duplicate, and other-room ids', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const first = await upload(db, bucket, { idempotency_key: 'cite-file-1', name: 'a.pdf' });
    const second = await upload(db, bucket, { idempotency_key: 'cite-file-2', name: 'b.pdf', now: NOW + 1 });
    const link: DriveLinkInput = {
      room: ROOM, principal: ALPHA, name: 'remote.pdf', mime: 'application/pdf', size_bytes: 10,
      sha256: 'd'.repeat(64), drive_file_id: DRIVE_ID, web_link: `https://drive.google.com/file/d/${DRIVE_ID}/view`,
      idempotency_key: 'cite-link', now: NOW,
    };
    const drive = await registerDriveLink(db, link);
    const cited = await requireAttachableFiles(db, ROOM, [second.file.id, drive.file.id, first.file.id], NOW + 1);
    assert.deepEqual(cited.map(file => file.id), [second.file.id, drive.file.id, first.file.id]);
    assert.equal(cited[1]?.availability, 'external');
    const ops = await count(db, 'operations');
    const files = await count(db, 'shared_files');
    await expectFault(() => requireAttachableFiles(db, ROOM, [first.file.id, 'missing-file'], NOW + 1), 'NOT_FOUND', 404);
    const foreign = await expectFault(() => requireAttachableFiles(db, OTHER, [first.file.id], NOW + 1), 'NOT_FOUND', 404);
    const absent = await expectFault(() => requireAttachableFiles(db, ROOM, ['missing-file'], NOW + 1), 'NOT_FOUND', 404);
    assert.equal(foreign.message, absent.message);
    await expectFault(() => requireAttachableFiles(db, ROOM, [first.file.id, first.file.id], NOW + 1), 'INVALID_INPUT', 400);
    const many = Array.from({ length: 9 }, () => first.file.id);
    await expectFault(() => requireAttachableFiles(db, ROOM, many, NOW + 1), 'INVALID_INPUT', 400);
    await expectFault(() => requireAttachableFiles(db, ROOM, [first.file.id], NOW + 60_000), 'FILE_EXPIRED', 410);
    assert.equal(await count(db, 'operations'), ops);
    assert.equal(await count(db, 'shared_files'), files);
    assert.equal(await count(db, 'messages'), 0);
    assert.equal(await count(db, 'message_file_refs'), 0);
    const ids = [first.file.id];
    for (let i = 0; i < 6; i++) ids.push((await registerDriveLink(db, { ...link, idempotency_key: `cite-extra-${i}` })).file.id);
    ids.push(drive.file.id);
    const eight = await requireAttachableFiles(db, ROOM, ids, NOW + 1);
    assert.deepEqual(eight.map(file => file.id), ids);
  } finally { await close(); }
});

test('a message that already cites a file keeps the text and the ref after expiry and GC', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const stored = await upload(db, bucket);
    await db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m1','room_main','synthetic:alpha','the note stays','text','2026-10-23T12:00:00.000Z')").all();
    await db.prepare('INSERT INTO message_file_refs(message_id,file_id,position) VALUES (?,?,0)').bind('m1', stored.file.id).all();
    const at = NOW + 60_000;
    const expired = await getFile(db, ROOM, stored.file.id, at);
    assert.equal(expired.availability, 'expired');
    await expectFault(() => requireAttachableFiles(db, ROOM, [stored.file.id], at), 'FILE_EXPIRED', 410);
    await expireFiles(db, bucket, at);
    const tomb = await getFile(db, ROOM, stored.file.id, at);
    assert.equal(tomb.availability, 'tombstone');
    assert.equal(tomb.tombstone_reason, 'expired');
    const message = await db.prepare("SELECT text FROM messages WHERE id='m1'").first<{ text: string }>();
    assert.equal(message?.text, 'the note stays');
    const ref = await db.prepare('SELECT file_id, position FROM message_file_refs WHERE message_id=?').bind('m1').first<{ file_id: string; position: number }>();
    assert.equal(ref?.file_id, stored.file.id);
    assert.equal(ref?.position, 0);
    assert.equal(await count(db, 'shared_files'), 1);
  } finally { await close(); }
});
