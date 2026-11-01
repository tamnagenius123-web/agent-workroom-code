import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import {
  FILE_DEFAULTS, readFile, uploadFile, type FileBucket, type FileObjectBody, type UploadFileInput,
} from '../src/server/files.ts';

const ROOM = 'room_main';
const OTHER = 'room_other';
const ALPHA = 'synthetic:alpha';
const BETA = 'synthetic:beta';
const NOW = Date.parse('2026-10-23T12:34:56.789Z');

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
    ...['alpha', 'beta', 'reader', 'outsider'].map(name => db.prepare('INSERT INTO principals(id) VALUES (?)').bind('synthetic:' + name)),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

class Bucket implements FileBucket {
  objects = new Map<string, Uint8Array>();
  gets: string[] = [];
  puts: string[] = [];
  deletes: string[] = [];
  failPut = false;
  failDelete = false;
  async put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): Promise<void> {
    if (this.failPut) throw new Error('put failed');
    const bytes = await readAll(value);
    this.objects.set(key, bytes);
    this.puts.push(key);
  }
  async get(key: string): Promise<FileObjectBody | null> {
    this.gets.push(key);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { size: bytes.byteLength, body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
  }
  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    if (this.failDelete) throw new Error('delete failed');
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

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function count(db: Database, table: 'shared_files' | 'operations'): Promise<number> {
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

function upload(db: Database, bucket: FileBucket | null, over: Partial<UploadFileInput> = {}) {
  return uploadFile(db, bucket, {
    room: ROOM, principal: ALPHA, name: 'notes.pdf', mime: 'application/pdf',
    body: new TextEncoder().encode('hello'), now: NOW, idempotency_key: 'upload-key-1', ...over,
  });
}

function zeros(total: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024);
  let left = total;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) { controller.close(); return; }
      const n = Math.min(chunk.byteLength, left);
      controller.enqueue(n === chunk.byteLength ? chunk : chunk.subarray(0, n));
      left -= n;
    },
  });
}

test('upload hashes the bytes it stores and rejects a mismatched digest', async () => {
  const { db, close } = await start();
  try {
    assert.equal(FILE_DEFAULTS.FILE_MAX_BYTES, 26_214_400);
    const bucket = new Bucket();
    const hello = new TextEncoder().encode('hello');
    const stored = await upload(db, bucket, { body: hello });
    assert.equal(stored.replayed, false);
    assert.equal(stored.file.sha256_verified, 1);
    assert.equal(stored.file.sha256, await digest(hello));
    assert.equal(stored.file.uploader_id, ALPHA);
    assert.equal(stored.file.expires_at, new Date(NOW + 3_600_000).toISOString());
    assert.equal(stored.file.availability, 'live');
    assert.equal(Object.hasOwn(stored.file, 'r2_key'), false);
    const row = await db.prepare('SELECT r2_key, sha256_verified, expires_at_ms, created_at_ms FROM shared_files WHERE id=?')
      .bind(stored.file.id).first<{ r2_key: string; sha256_verified: number; expires_at_ms: number; created_at_ms: number }>();
    assert.equal(row?.sha256_verified, 1);
    assert.equal(row?.r2_key, `rooms/${ROOM}/files/${stored.file.id}`);
    assert.equal(row?.created_at_ms, NOW);
    assert.equal(row?.expires_at_ms, NOW + 3_600_000);
    assert.deepEqual(bucket.objects.get(row?.r2_key ?? ''), hello);

    const parts = [hello.subarray(0, 2), hello.subarray(2)];
    let index = 0;
    const streamed = await upload(db, bucket, {
      idempotency_key: 'upload-stream',
      body: new ReadableStream({ pull(controller) { const chunk = parts[index++]; if (!chunk) controller.close(); else controller.enqueue(chunk); } }),
    });
    assert.equal(streamed.file.sha256, stored.file.sha256);

    for (const length of [1, 55, 56, 63, 64, 65]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 17 + 3) & 255;
      const file = await upload(db, bucket, { idempotency_key: `length-${length}`, body: bytes, name: `n${length}.bin` });
      assert.equal(file.file.sha256, await digest(bytes));
    }

    const wrong = new Bucket();
    await expectFault(() => upload(db, wrong, { idempotency_key: 'upload-bad-hash', sha256: '0'.repeat(64) }), 'INVALID_INPUT', 400);
    assert.equal(wrong.objects.size, 0);
    assert.equal(wrong.puts.length, 1);
    assert.equal(wrong.deletes.length, 1);
    const files = await db.prepare("SELECT COUNT(*) AS n FROM shared_files WHERE sha256<>?")
      .bind(await digest(hello)).first<{ n: number }>();
    assert.equal(Number(files?.n), 6);
    const badOps = await db.prepare("SELECT COUNT(*) AS n FROM operations WHERE key='upload-bad-hash'").first<{ n: number }>();
    assert.equal(Number(badOps?.n), 0);

    let pulls = 0;
    const unread = new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array([1])); } });
    await Promise.resolve();
    const pullsBefore = pulls;
    const putsBefore = bucket.puts.length;
    await expectFault(() => upload(db, bucket, { idempotency_key: 'upload-declared-over', size: FILE_DEFAULTS.FILE_MAX_BYTES + 1, body: unread }), 'FILE_TOO_LARGE', 413);
    assert.equal(pulls, pullsBefore);
    assert.equal(bucket.puts.length, putsBefore);
    await expectFault(() => upload(db, bucket, { idempotency_key: 'upload-empty', body: new Uint8Array() }), 'INVALID_INPUT', 400);
    await expectFault(() => upload(db, bucket, { idempotency_key: 'upload-short', size: 4, body: hello }), 'INVALID_INPUT', 400);
    assert.equal(bucket.objects.has(`rooms/${ROOM}/files/missing`), false);
  } finally { await close(); }
});

test('dangerous downloads are attachments and a missing key stays a live row', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const html = new TextEncoder().encode('<p>hi</p>');
    const cases: [string, string, string][] = [
      ['text/html', 'page.html', 'application/octet-stream'],
      ['application/xhtml+xml', 'page.xhtml', 'application/octet-stream'],
      ['image/svg+xml', 'icon.svg', 'application/octet-stream'],
      ['application/pdf', 'notes.pdf', 'application/pdf'],
    ];
    for (const [mime, name, expected] of cases) {
      const stored = await upload(db, bucket, { mime, name, body: html, idempotency_key: `mime-${name}` });
      const read = await readFile(db, bucket, ROOM, stored.file.id, NOW);
      assert.equal(read.kind, 'bytes');
      if (read.kind !== 'bytes') continue;
      assert.equal(read.headers['Content-Type'], expected);
      assert.match(read.headers['Content-Disposition'] ?? '', /^attachment/);
      assert.match(read.headers['Content-Disposition'] ?? '', /filename=/);
      assert.equal(read.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(read.headers['Cache-Control'], 'private, no-store');
      assert.equal(read.headers['X-Workroom-Sha256'], stored.file.sha256);
      assert.equal(read.headers['Content-Length'], String(html.byteLength));
      const body = new Uint8Array(await new Response(read.body).arrayBuffer());
      assert.deepEqual(body, html);
    }
    const stored = await upload(db, bucket, { idempotency_key: 'upload-gone', body: html });
    const key = `rooms/${ROOM}/files/${stored.file.id}`;
    bucket.objects.delete(key);
    await expectFault(() => readFile(db, bucket, ROOM, stored.file.id, NOW), 'FILE_BYTES_MISSING', 404);
    const live = await db.prepare('SELECT deleted_at_ms, expires_at_ms FROM shared_files WHERE id=?')
      .bind(stored.file.id).first<{ deleted_at_ms: number | null; expires_at_ms: number }>();
    assert.equal(live?.deleted_at_ms, null);
    assert.ok((live?.expires_at_ms ?? 0) > NOW);
    const missing = await expectFault(() => readFile(db, bucket, ROOM, 'no-such-file', NOW), 'NOT_FOUND', 404);
    const foreign = await expectFault(() => readFile(db, bucket, OTHER, stored.file.id, NOW), 'NOT_FOUND', 404);
    assert.equal(foreign.message, missing.message);
  } finally { await close(); }
});

test('idempotency, config, a missing bucket, and the shared minute cap write nothing new', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const hello = new TextEncoder().encode('hello');
    const first = await upload(db, bucket, { body: hello });
    const replay = await upload(db, bucket, { body: hello });
    assert.equal(replay.replayed, true);
    assert.equal(replay.file.id, first.file.id);
    assert.equal(bucket.puts.length, 1);
    assert.equal(await count(db, 'shared_files'), 1);
    const conflict = await expectFault(() => upload(db, bucket, { body: new TextEncoder().encode('other') }), 'IDEMPOTENCY_CONFLICT', 409);
    assert.equal(conflict.outcome, 'not_applied');
    assert.deepEqual(bucket.objects.get(`rooms/${ROOM}/files/${first.file.id}`), hello);
    assert.equal(bucket.puts.length, 1);

    const bare = new Bucket();
    await expectFault(() => upload(db, null, { idempotency_key: 'upload-no-bucket' }), 'FILE_STORE_UNAVAILABLE', 503);
    for (const env of [{ FILE_MAX_BYTES: '26214401' }, { FILE_TTL_SECONDS: '3601' }, { FILE_TTL_SECONDS: '59' }, { FILE_HOUR_BYTES: '0' }, { FILE_MAX_BYTES: '060' }]) {
      const error = await expectFault(() => upload(db, bare, { idempotency_key: 'upload-bad-config', env }), 'FILE_CONFIG_INVALID', 503);
      assert.equal(error.outcome, 'not_applied');
    }
    assert.equal(bare.puts.length, 0);
    assert.equal(bare.objects.size, 0);

    const iso = new Date(NOW).toISOString();
    const earlier = new Date(NOW - 60_000).toISOString();
    const fills = [
      db.prepare("INSERT INTO operations(principal_id,operation,key,room_id,request_hash,result_json,created_at) VALUES (?,'message.post',?,'room_main',?,'{}',?)")
        .bind(ALPHA, 'old-minute', 'ab'.repeat(32), earlier),
    ];
    for (let i = 0; i < 58; i++) {
      fills.push(db.prepare("INSERT INTO operations(principal_id,operation,key,room_id,request_hash,result_json,created_at) VALUES (?,'message.post',?,'room_main',?,'{}',?)")
        .bind(ALPHA, `fill-${i}`, 'ab'.repeat(32), iso));
    }
    await db.batch(fills);
    const sixtieth = await upload(db, bucket, { idempotency_key: 'upload-60', body: hello });
    assert.equal(sixtieth.replayed, false);
    const blocked = await expectFault(() => upload(db, bucket, { idempotency_key: 'upload-61', body: hello }), 'RATE_LIMITED', 429);
    assert.equal(blocked.details.limit, 'minute');
    assert.equal(blocked.details.retry_after, 60 - new Date(NOW).getUTCSeconds());
    assert.equal(bucket.objects.has(`rooms/${ROOM}/files/not-created`), false);
    const keysBeforeBeta = bucket.puts.length;
    const beta = await upload(db, bucket, { principal: BETA, idempotency_key: 'upload-61', body: hello });
    assert.equal(beta.file.uploader_id, BETA);
    assert.equal(bucket.puts.length, keysBeforeBeta + 1);
    const replayAtLimit = await upload(db, bucket, { body: hello });
    assert.equal(replayAtLimit.replayed, true);
    assert.equal(replayAtLimit.file.id, first.file.id);
  } finally { await close(); }
});

test('hour and room caps reject before put, and a failed insert deletes the object', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const eighty = new Uint8Array(80);
    const thirty = new Uint8Array(30);
    const first = await upload(db, bucket, {
      body: eighty, size: eighty.byteLength, idempotency_key: 'cap-hour-1', env: { FILE_TTL_SECONDS: '60', FILE_HOUR_BYTES: '100' },
    });
    const blocked = await expectFault(() => upload(db, bucket, {
      body: thirty, size: thirty.byteLength, idempotency_key: 'cap-hour-2', now: NOW + 1, env: { FILE_TTL_SECONDS: '60', FILE_HOUR_BYTES: '100' },
    }), 'RATE_LIMITED', 429);
    assert.equal(blocked.details.limit, 'hour');
    assert.equal(bucket.puts.length, 1);
    assert.equal(await count(db, 'shared_files'), 1);

    const roomBucket = new Bucket();
    await upload(db, roomBucket, { room: OTHER, body: eighty, size: eighty.byteLength, idempotency_key: 'cap-room-1', env: { FILE_ROOM_MAX_BYTES: '100' } });
    const roomBlocked = await expectFault(() => upload(db, roomBucket, {
      room: OTHER, body: thirty, size: thirty.byteLength, idempotency_key: 'cap-room-2', now: NOW + 1, env: { FILE_ROOM_MAX_BYTES: '100' },
    }), 'RATE_LIMITED', 429);
    assert.equal(roomBlocked.details.limit, 'room');
    assert.equal(roomBucket.puts.length, 1);

    const failing: Database = { prepare: sql => db.prepare(sql), batch: async () => { throw new Error('insert failed'); } };
    const lost = new Bucket();
    const notStored = await expectFault(() => upload(failing, lost, { idempotency_key: 'upload-insert-fail', body: eighty }), 'TEMPORARY_FAILURE', 503);
    assert.equal(notStored.outcome, 'not_applied');
    assert.equal(lost.objects.size, 0);
    assert.equal(lost.puts.length, 1);
    assert.equal(lost.deletes.length, 1);
    const unknownBucket = new Bucket();
    unknownBucket.failDelete = true;
    const unknown = await expectFault(() => upload(failing, unknownBucket, { idempotency_key: 'upload-delete-unknown', body: eighty }), 'TEMPORARY_FAILURE', 503);
    assert.equal(unknown.outcome, 'unknown');
    assert.equal(unknownBucket.objects.size, 1);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM shared_files WHERE id IN (?,?)").bind(first.file.id, 'nope').first<{ n: number }>();
    assert.equal(Number(rows?.n), 1);

    const ttl = await upload(db, bucket, { idempotency_key: 'upload-ttl-60', env: { FILE_TTL_SECONDS: '60' }, body: thirty });
    const expires = await db.prepare('SELECT expires_at_ms FROM shared_files WHERE id=?').bind(ttl.file.id).first<{ expires_at_ms: number }>();
    assert.equal(expires?.expires_at_ms, NOW + 60_000);
    await upload(db, bucket, { idempotency_key: 'upload-ttl-max', now: NOW + 2, env: { FILE_TTL_SECONDS: '3600' }, body: thirty });
    const still = await db.prepare('SELECT expires_at_ms FROM shared_files WHERE id=?').bind(ttl.file.id).first<{ expires_at_ms: number }>();
    assert.equal(still?.expires_at_ms, NOW + 60_000);
  } finally { await close(); }
});

test('the default cap accepts 25 MiB and one more byte writes nothing', { timeout: 60_000 }, async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const size = FILE_DEFAULTS.FILE_MAX_BYTES;
    const stored = await upload(db, bucket, { idempotency_key: 'upload-25mib', body: zeros(size), name: 'bundle.zip', mime: 'application/zip' });
    assert.equal(stored.file.size_bytes, size);
    assert.equal(stored.file.sha256_verified, 1);
    const key = `rooms/${ROOM}/files/${stored.file.id}`;
    assert.equal(bucket.objects.get(key)?.byteLength, size);
    assert.equal(stored.file.sha256, await digest(new Uint8Array(size)));
    const over = new Bucket();
    await expectFault(() => upload(db, over, { idempotency_key: 'upload-25mib-plus', body: zeros(size + 1) }), 'FILE_TOO_LARGE', 413);
    assert.equal(over.objects.size, 0);
    const extra = await db.prepare('SELECT COUNT(*) AS n FROM shared_files WHERE size_bytes>?').bind(size).first<{ n: number }>();
    assert.equal(Number(extra?.n), 0);
  } finally { await close(); }
});

function flakyReads(db: Database, failures: { n: number }): Database {
  let armed = false;
  const wrap = (stmt: ReturnType<Database['prepare']>, sql: string): ReturnType<Database['prepare']> => new Proxy(stmt, {
    get(target, prop, recv) {
      if (prop === 'bind') return (...args: unknown[]) => wrap((target.bind as (...a: unknown[]) => ReturnType<Database['prepare']>)(...args), sql);
      if ((prop === 'first' || prop === 'all') && /^\s*SELECT/i.test(sql) && /FROM shared_files/.test(sql) && armed && failures.n > 0) {
        return async () => { failures.n -= 1; throw new Error('readback failed'); };
      }
      const value = Reflect.get(target, prop, recv);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { prepare: sql => wrap(db.prepare(sql), sql), batch: async <T,>(stmts: Parameters<Database["batch"]>[0]) => { const out = await db.batch<T>(stmts); armed = true; return out; } };
}

test('a lost ACK after commit keeps the object, so the row, receipt, replay, and download agree (HOLD d0792c2)', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const lostAck: Database = { prepare: sql => db.prepare(sql), batch: async stmts => { await db.batch(stmts); throw new Error('ack lost'); } };
    const body = new TextEncoder().encode('lost ack body');
    const stored = await upload(lostAck, bucket, { idempotency_key: 'lost-ack', body });
    assert.equal(stored.replayed, false);
    assert.equal(bucket.deletes.length, 0);
    assert.equal(bucket.objects.size, 1);
    const replay = await upload(db, bucket, { idempotency_key: 'lost-ack', body });
    assert.equal(replay.replayed, true);
    assert.equal(replay.file.id, stored.file.id);
    const read = await readFile(db, bucket, ROOM, stored.file.id, NOW);
    assert.equal(read.kind, 'bytes');
  } finally { await close(); }
});

test('a readback failure after commit keeps the object; an unresolvable outcome deletes nothing (HOLD d0792c2)', async () => {
  const { db, close } = await start();
  try {
    const bucket = new Bucket();
    const once = await upload(flakyReads(db, { n: 1 }), bucket, { idempotency_key: 'readback-1' });
    assert.equal(bucket.deletes.length, 0);
    assert.equal((await readFile(db, bucket, ROOM, once.file.id, NOW)).kind, 'bytes');

    const twice = new Bucket();
    const unknown = await expectFault(() => upload(flakyReads(db, { n: 2 }), twice, { idempotency_key: 'readback-2' }), 'TEMPORARY_FAILURE', 503);
    assert.equal(unknown.outcome, 'unknown');
    assert.equal(twice.deletes.length, 0);
    assert.equal(twice.objects.size, 1);
    const replay = await upload(db, twice, { idempotency_key: 'readback-2' });
    assert.equal(replay.replayed, true);
    assert.equal((await readFile(db, twice, ROOM, replay.file.id, NOW)).kind, 'bytes');
  } finally { await close(); }
});

test('parallel uploads cannot exceed the hour or room byte cap (HOLD d0792c2)', async () => {
  const { db, close } = await start();
  try {
    const sixty = new Uint8Array(60);
    for (const [cap, env, room] of [['hour', { FILE_HOUR_BYTES: '100' }, ROOM], ['room', { FILE_ROOM_MAX_BYTES: '100' }, OTHER]] as const) {
      const bucket = new Bucket();
      const results = await Promise.allSettled([1, 2, 3].map(i => upload(db, bucket, {
        room, principal: cap === 'room' ? (i === 1 ? ALPHA : BETA) : ALPHA, body: sixty, size: 60, idempotency_key: `par-${cap}-${i}`, env,
      })));
      const ok = results.filter(r => r.status === 'fulfilled');
      const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.equal(ok.length, 1, cap);
      for (const r of bad) {
        assert.ok(r.reason instanceof Fault);
        assert.equal(r.reason.code, 'RATE_LIMITED');
        assert.equal(r.reason.details.limit, cap);
      }
      assert.equal(bucket.objects.size, 1);
    }
    const sum = await db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS n FROM shared_files WHERE storage='r2'").first<{ n: number }>();
    assert.equal(Number(sum?.n), 120);
  } finally { await close(); }
});
