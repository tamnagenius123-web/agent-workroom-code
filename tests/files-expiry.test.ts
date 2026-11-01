import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { expireFiles, getFile, readFile, uploadFile, type FileBucket, type FileObjectBody, type UploadFileInput } from '../src/server/files.ts';
import { retain } from '../src/server/retention.ts';

const ROOM = 'room_main';
const ALPHA = 'synthetic:alpha';
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const SHA = 'c'.repeat(64);

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
  gets: string[] = [];
  puts: string[] = [];
  failKeys = new Set<string>();
  async put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): Promise<void> {
    this.objects.set(key, await readAll(value));
    this.puts.push(key);
  }
  async get(key: string): Promise<FileObjectBody | null> {
    this.gets.push(key);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  }
  async delete(key: string): Promise<void> {
    if (this.failKeys.has(key)) throw new Error('delete failed');
    this.objects.delete(key);
  }
}

async function readAll(value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const copy = new Uint8Array(next.value.byteLength);
    copy.set(next.value);
    chunks.push(copy);
    total += copy.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
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

function upload(db: Database, bucket: FileBucket, over: Partial<UploadFileInput> = {}) {
  return uploadFile(db, bucket, {
    room: ROOM, principal: ALPHA, name: 'notes.pdf', mime: 'application/pdf',
    body: new TextEncoder().encode('hello'), now: NOW, idempotency_key: 'upload-key-1', ...over,
  });
}

test('download works until expires_at_ms and then refuses without reading the object', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const hello = new TextEncoder().encode('hello');
    const stored = await upload(db, bucket, { body: hello, env: { FILE_TTL_SECONDS: '60' } });
    const expires = NOW + 60_000;
    const row = await db.prepare('SELECT expires_at_ms, r2_key FROM shared_files WHERE id=?')
      .bind(stored.file.id).first<{ expires_at_ms: number; r2_key: string }>();
    assert.equal(row?.expires_at_ms, expires);
    const live = await readFile(db, bucket, ROOM, stored.file.id, expires - 1);
    assert.equal(live.kind, 'bytes');
    if (live.kind === 'bytes') assert.deepEqual(new Uint8Array(await new Response(live.body).arrayBuffer()), hello);
    const gets = bucket.gets.length;
    await expectFault(() => readFile(db, bucket, ROOM, stored.file.id, expires), 'FILE_EXPIRED', 410);
    assert.equal(bucket.gets.length, gets);
    assert.equal(bucket.objects.has(row?.r2_key ?? ''), true);
    await expectFault(() => readFile(db, null, ROOM, stored.file.id, expires), 'FILE_EXPIRED', 410);
    const meta = await getFile(db, ROOM, stored.file.id, expires);
    assert.equal(meta.availability, 'expired');
    assert.equal(meta.tombstone_reason, null);
    const listed = await (await import('../src/server/files.ts')).listFiles(db, ROOM, expires);
    assert.equal(listed.files[0]?.availability, 'expired');
    const still = await db.prepare('SELECT expires_at_ms FROM shared_files WHERE id=?').bind(stored.file.id).first<{ expires_at_ms: number }>();
    assert.equal(still?.expires_at_ms, expires);
  } finally { await close(); }
});

test('expireFiles tombstones after delete, retries a delete error, and marks a missing key', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const ok = await upload(db, bucket, { idempotency_key: 'gc-delete-ok', env: { FILE_TTL_SECONDS: '60' }, body: new Uint8Array([1]) });
    const bad = await upload(db, bucket, { idempotency_key: 'gc-delete-bad', now: NOW + 1, env: { FILE_TTL_SECONDS: '60' }, body: new Uint8Array([2]) });
    const gone = await upload(db, bucket, { idempotency_key: 'gc-already-gone', now: NOW + 2, env: { FILE_TTL_SECONDS: '60' }, body: new Uint8Array([3]) });
    const keys = await db.prepare('SELECT id, r2_key FROM shared_files').all<{ id: string; r2_key: string }>();
    const keyOf = new Map(keys.results.map(row => [row.id, row.r2_key]));
    const badKey = keyOf.get(bad.file.id) ?? '';
    const goneKey = keyOf.get(gone.file.id) ?? '';
    bucket.failKeys.add(badKey);
    bucket.objects.delete(goneKey);
    const at = NOW + 60_002;
    await db.prepare("INSERT INTO file_gc_runs(id,at_ms,result_json) VALUES ('old',?,?)").bind(at - 8 * 86_400_000, '{"examined":0}').all();
    await db.prepare("INSERT INTO file_gc_runs(id,at_ms,result_json) VALUES ('edge',?,?)").bind(at + 1 - 7 * 86_400_000, '{"examined":0}').all();
    const first = await expireFiles(db, bucket, at);
    assert.equal(first.examined, 3);
    assert.equal(first.deleted, 1);
    assert.equal(first.already_missing, 1);
    assert.equal(first.marked, 2);
    assert.equal(first.errors.length, 1);
    assert.equal(first.errors[0]?.id, bad.file.id);
    assert.equal(bucket.objects.has(keyOf.get(ok.file.id) ?? ''), false);
    assert.equal(bucket.objects.has(badKey), true);
    const unmarked = await db.prepare('SELECT deleted_at_ms FROM shared_files WHERE id=?').bind(bad.file.id).first<{ deleted_at_ms: number | null }>();
    assert.equal(unmarked?.deleted_at_ms, null);
    const tomb = await db.prepare('SELECT deleted_at_ms, tombstone_reason FROM shared_files WHERE id=?').bind(ok.file.id)
      .first<{ deleted_at_ms: number; tombstone_reason: string }>();
    assert.equal(tomb?.deleted_at_ms, at);
    assert.equal(tomb?.tombstone_reason, 'expired');
    const missingMarked = await db.prepare('SELECT tombstone_reason FROM shared_files WHERE id=?').bind(gone.file.id).first<{ tombstone_reason: string }>();
    assert.equal(missingMarked?.tombstone_reason, 'expired');
    assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM shared_files").first<{ n: number }>().then(row => Number(row?.n)), 3);

    bucket.failKeys.delete(badKey);
    const second = await expireFiles(db, bucket, at + 1);
    assert.equal(second.examined, 1);
    assert.equal(second.deleted, 1);
    assert.equal(second.marked, 1);
    assert.equal(second.errors.length, 0);
    assert.equal(bucket.objects.has(badKey), false);
    const marked = await db.prepare('SELECT deleted_at_ms, tombstone_reason FROM shared_files WHERE id=?').bind(bad.file.id)
      .first<{ deleted_at_ms: number; tombstone_reason: string }>();
    assert.equal(marked?.tombstone_reason, 'expired');
    assert.equal(marked?.deleted_at_ms, at + 1);
    const gets = bucket.gets.length;
    await expectFault(() => readFile(db, bucket, ROOM, ok.file.id, at + 1), 'FILE_EXPIRED', 410);
    assert.equal(bucket.gets.length, gets);
    const meta = await getFile(db, ROOM, ok.file.id, at + 1);
    assert.equal(meta.availability, 'tombstone');
    assert.equal(meta.tombstone_reason, 'expired');

    const old = await db.prepare("SELECT id FROM file_gc_runs WHERE id='old'").first();
    const edge = await db.prepare("SELECT id FROM file_gc_runs WHERE id='edge'").first<{ id: string }>();
    assert.equal(old, null);
    assert.equal(edge?.id, 'edge');
    const runs = await db.prepare('SELECT COUNT(*) AS n FROM file_gc_runs WHERE at_ms>=?').bind(at).first<{ n: number }>();
    assert.equal(Number(runs?.n), 2);
  } finally { await close(); }
});

test('retain leaves the tombstone and the citing message, and GC stops at 50 rows', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const stored = await upload(db, bucket, { env: { FILE_TTL_SECONDS: '60' } });
    await db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('m1','room_main','synthetic:alpha','cite me','text','2026-10-23T12:00:00.000Z')").all();
    await db.prepare("INSERT INTO message_file_refs(message_id,file_id,position) VALUES ('m1',?,0)").bind(stored.file.id).all();
    const at = NOW + 60_000;
    await expireFiles(db, bucket, at);
    const before = await db.prepare('SELECT deleted_at_ms, tombstone_reason FROM shared_files WHERE id=?').bind(stored.file.id)
      .first<{ deleted_at_ms: number; tombstone_reason: string }>();
    await retain(db, at, 'dry_run');
    await retain(db, at, 'delete');
    const after = await db.prepare('SELECT deleted_at_ms, tombstone_reason FROM shared_files WHERE id=?').bind(stored.file.id)
      .first<{ deleted_at_ms: number; tombstone_reason: string }>();
    assert.deepEqual(after, before);
    const message = await db.prepare("SELECT text FROM messages WHERE id='m1'").first<{ text: string }>();
    assert.equal(message?.text, 'cite me');
    const refs = await db.prepare("SELECT COUNT(*) AS n FROM message_file_refs WHERE message_id='m1'").first<{ n: number }>();
    assert.equal(Number(refs?.n), 1);
    const files = await db.prepare('SELECT COUNT(*) AS n FROM shared_files').first<{ n: number }>();
    assert.equal(Number(files?.n), 1);

    const created = NOW;
    const expires = created + 3_600_000;
    const stmts = [];
    for (let i = 0; i < 51; i++) {
      const id = `gc-${String(i).padStart(2, '0')}`;
      stmts.push(db.prepare(
        `INSERT INTO shared_files(id,room_id,storage,name,mime,size_bytes,sha256,sha256_verified,uploader_id,created_at_ms,expires_at_ms,r2_key)
         VALUES (?,'room_main','r2','n.bin','application/octet-stream',1,?,1,'synthetic:alpha',?,?,?)`,
      ).bind(id, SHA, created, expires, `rooms/room_main/files/${id}`));
    }
    await db.batch(stmts);
    const pass = await expireFiles(db, bucket, expires);
    assert.equal(pass.examined, 50);
    assert.equal(pass.already_missing, 50);
    assert.equal(pass.marked, 50);
    const left = await db.prepare("SELECT id FROM shared_files WHERE storage='r2' AND deleted_at_ms IS NULL AND id LIKE 'gc-%'").all<{ id: string }>();
    assert.deepEqual(left.results.map(row => row.id), ['gc-50']);
    const next = await expireFiles(db, bucket, expires);
    assert.equal(next.marked, 1);
    assert.equal(next.examined, 1);
  } finally { await close(); }
});
