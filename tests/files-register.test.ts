import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { getFile, listFiles, registerDriveLink, type DriveLinkInput, type FileBucket } from '../src/server/files.ts';

const ROOM = 'room_main';
const OTHER = 'room_other';
const ALPHA = 'synthetic:alpha';
const BETA = 'synthetic:beta';
const NOW = Date.parse('2026-10-23T12:34:56.789Z');
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
    ...['alpha', 'beta', 'reader', 'outsider'].map(name => db.prepare('INSERT INTO principals(id) VALUES (?)').bind('synthetic:' + name)),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
}

function link(over: Partial<DriveLinkInput> = {}): DriveLinkInput {
  const drive_file_id = over.drive_file_id ?? DRIVE_ID;
  return {
    room: ROOM, principal: ALPHA, name: 'notes.pdf', mime: 'application/pdf', size_bytes: 1200,
    sha256: 'ab'.repeat(32), drive_file_id, web_link: `https://drive.google.com/file/d/${drive_file_id}/view`,
    idempotency_key: 'drive-key-1', now: NOW, ...over,
  };
}

class Bucket implements FileBucket {
  objects = new Map<string, Uint8Array>();
  puts: string[] = [];
  async put(key: string): Promise<void> { this.puts.push(key); this.objects.set(key, new Uint8Array()); }
  async get(): Promise<null> { return null; }
  async delete(): Promise<void> { /* register never calls this */ }
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

function forbidNetwork(): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('network is forbidden'); }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

test('register stores the caller, an unverified digest, and no object', async () => {
  const { db, close } = await start();
  const bucket = new Bucket();
  const restore = forbidNetwork();
  try {
    const stored = await registerDriveLink(db, link());
    assert.equal(stored.replayed, false);
    assert.equal(stored.file.uploader_id, ALPHA);
    assert.equal(stored.file.sha256_verified, 0);
    assert.equal(stored.file.expires_at, null);
    assert.equal(stored.file.availability, 'external');
    assert.equal(stored.file.web_link, link().web_link);
    assert.equal(stored.file.drive_file_id, DRIVE_ID);
    assert.equal(Object.hasOwn(stored.file, 'r2_key'), false);
    const row = await db.prepare('SELECT r2_key, expires_at_ms, sha256_verified, uploader_id, storage FROM shared_files WHERE id=?')
      .bind(stored.file.id).first<{ r2_key: string | null; expires_at_ms: number | null; sha256_verified: number; uploader_id: string; storage: string }>();
    assert.equal(row?.r2_key, null);
    assert.equal(row?.expires_at_ms, null);
    assert.equal(row?.sha256_verified, 0);
    assert.equal(row?.uploader_id, ALPHA);
    assert.equal(row?.storage, 'drive');
    assert.equal(bucket.puts.length, 0);
    assert.equal(bucket.objects.size, 0);

    const got = await getFile(db, ROOM, stored.file.id, NOW);
    assert.equal(got.availability, 'external');
    assert.equal(got.web_link, stored.file.web_link);
    const page = await listFiles(db, ROOM, NOW);
    assert.equal(page.files.length, 1);
    assert.equal(page.files[0]?.availability, 'external');
    assert.equal(page.files[0]?.web_link, stored.file.web_link);
    assert.equal(JSON.stringify(page).includes('r2_key'), false);
    const missing = await expectFault(() => getFile(db, ROOM, 'missing-id', NOW), 'NOT_FOUND', 404);
    const foreign = await expectFault(() => getFile(db, OTHER, stored.file.id, NOW), 'NOT_FOUND', 404);
    assert.equal(foreign.message, missing.message);
    assert.equal((await listFiles(db, OTHER, NOW)).files.length, 0);

    const folderId = 'folder_id1';
    const folder = await registerDriveLink(db, link({
      drive_file_id: folderId, idempotency_key: 'drive-key-2', now: NOW + 1,
      web_link: `https://drive.google.com/drive/folders/${folderId}`,
    }));
    const docs = await registerDriveLink(db, link({
      drive_file_id: DRIVE_ID, idempotency_key: 'drive-key-3', now: NOW + 2, name: '한글 문서',
      web_link: `https://docs.google.com/document/d/${DRIVE_ID}/edit`,
    }));
    assert.equal(folder.file.web_link?.includes('/folders/'), true);
    assert.equal(docs.file.name, '한글 문서');
    const ordered = await listFiles(db, ROOM, NOW + 2, { limit: 2 });
    assert.deepEqual(ordered.files.map(file => file.id), [docs.file.id, folder.file.id]);
    assert.ok(ordered.next_cursor);
    const rest = await listFiles(db, ROOM, NOW + 2, { limit: 2, cursor: ordered.next_cursor });
    assert.deepEqual(rest.files.map(file => file.id), [stored.file.id]);
    assert.equal(rest.next_cursor, null);
    const external = await listFiles(db, ROOM, NOW + 2, { availability: 'external' });
    assert.equal(external.files.length, 3);
    await expectFault(() => listFiles(db, ROOM, NOW, { cursor: 'not-a-cursor' }), 'INVALID_INPUT', 400);
    await expectFault(() => listFiles(db, ROOM, NOW, { limit: 101 }), 'INVALID_INPUT', 400);
  } finally { restore(); await close(); }
});

test('replay returns the same row and a different link conflicts', async () => {
  const { db, close } = await start();
  const restore = forbidNetwork();
  try {
    const first = await registerDriveLink(db, link());
    const again = await registerDriveLink(db, link());
    assert.equal(again.replayed, true);
    assert.equal(again.file.id, first.file.id);
    assert.equal(await count(db, 'shared_files'), 1);
    assert.equal(await count(db, 'operations'), 1);
    const other = `https://docs.google.com/document/d/${DRIVE_ID}/edit`;
    const conflict = await expectFault(() => registerDriveLink(db, link({ web_link: other })), 'IDEMPOTENCY_CONFLICT', 409);
    assert.equal(conflict.outcome, 'not_applied');
    assert.equal(await count(db, 'shared_files'), 1);
    const kept = await getFile(db, ROOM, first.file.id, NOW);
    assert.equal(kept.web_link, first.file.web_link);
    const beta = await registerDriveLink(db, link({ principal: BETA, idempotency_key: 'drive-key-1' }));
    assert.equal(beta.replayed, false);
    assert.notEqual(beta.file.id, first.file.id);
    assert.equal(beta.file.uploader_id, BETA);
  } finally { restore(); await close(); }
});

test('rejected link metadata writes nothing and does not call fetch', async () => {
  const { db, close } = await start();
  const restore = forbidNetwork();
  try {
    const before = await count(db, 'shared_files');
    const cases: Partial<DriveLinkInput>[] = [
      { web_link: `http://drive.google.com/file/d/${DRIVE_ID}/view` },
      { web_link: `https://user:pass@drive.google.com/file/d/${DRIVE_ID}/view` },
      { web_link: `https://drive.google.com.evil/file/d/${DRIVE_ID}/view` },
      { web_link: `https://drive.google.com:444/file/d/${DRIVE_ID}/view` },
      { drive_file_id: 'other_id_ok', web_link: `https://drive.google.com/file/d/${DRIVE_ID}/view` },
      { sha256: 'AB'.repeat(32) },
      { sha256: 'abc' },
      { size_bytes: 0 },
      { size_bytes: 5 * 2 ** 40 + 1 },
      { name: '.' },
      { name: '..' },
      { name: 'a/b' },
      { name: 'a\\b' },
      { name: 'bad\0name' },
      { mime: 'text/html; charset=utf-8' },
      { mime: 'not-a-mime' },
      { drive_file_id: 'short' },
      { idempotency_key: 'short' },
    ];
    for (const over of cases) {
      await expectFault(() => registerDriveLink(db, link(over)), 'INVALID_INPUT', 400);
    }
    await expectFault(
      () => registerDriveLink(db, { ...link(), uploader_id: BETA } as DriveLinkInput),
      'INVALID_INPUT', 400,
    );
    assert.equal(await count(db, 'shared_files'), before);
    assert.equal(await count(db, 'operations'), 0);
    const max = await registerDriveLink(db, link({ size_bytes: 5 * 2 ** 40, idempotency_key: 'drive-max-size' }));
    assert.equal(max.file.size_bytes, 5 * 2 ** 40);
  } finally { restore(); await close(); }
});
