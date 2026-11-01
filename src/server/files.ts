import { Fault } from './contracts.ts';
import type { Database, Statement } from './db.ts';

// Path B stores one-hour bytes in object storage. Path A stores a Drive link and no bytes.
// Room auth is the caller's authorize(). Every read here is scoped to the room argument, so an id from another room is the same as a missing id.
// The body is hashed while it is streamed to put. The row is inserted only after put resolves. A failed insert deletes that key.

export const FILE_UPLOAD = 'file.upload';
export const FILE_REGISTER_LINK = 'file.register_link';
export const FILE_DEFAULTS = {
  FILE_MAX_BYTES: 26_214_400,
  FILE_TTL_SECONDS: 3600,
  FILE_HOUR_BYTES: 104_857_600,
  FILE_ROOM_MAX_BYTES: 524_288_000,
} as const;

const CAP_BOUNDS = {
  FILE_MAX_BYTES: { min: 1, max: FILE_DEFAULTS.FILE_MAX_BYTES, fallback: FILE_DEFAULTS.FILE_MAX_BYTES },
  FILE_TTL_SECONDS: { min: 60, max: FILE_DEFAULTS.FILE_TTL_SECONDS, fallback: FILE_DEFAULTS.FILE_TTL_SECONDS },
  FILE_HOUR_BYTES: { min: 1, max: FILE_DEFAULTS.FILE_HOUR_BYTES, fallback: FILE_DEFAULTS.FILE_HOUR_BYTES },
  FILE_ROOM_MAX_BYTES: { min: 1, max: FILE_DEFAULTS.FILE_ROOM_MAX_BYTES, fallback: FILE_DEFAULTS.FILE_ROOM_MAX_BYTES },
} as const;

const HOUR_MS = 3_600_000;
const GC_RETAIN_MS = 7 * 24 * HOUR_MS;
const GC_BATCH = 50;
const DRIVE_SIZE_MAX = 5 * 2 ** 40;
const NAME_MAX_BYTES = 240;
const KEY_RE = /^[A-Za-z0-9_.-]{8,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MIME_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,128}$/;
const DANGEROUS_MIME = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);
const AVAILABILITIES = ['live', 'expired', 'tombstone', 'external'] as const;
const utf8 = new TextEncoder();

export type FileAvailability = (typeof AVAILABILITIES)[number];

export interface FileEnv {
  FILE_MAX_BYTES?: string;
  FILE_TTL_SECONDS?: string;
  FILE_HOUR_BYTES?: string;
  FILE_ROOM_MAX_BYTES?: string;
}

export interface FileCaps {
  maxBytes: number;
  ttlSeconds: number;
  hourBytes: number;
  roomBytes: number;
}

/** put must consume a stream before it resolves. Chunk views are only valid until that pull returns. */
export interface FileObjectBody {
  body: ReadableStream<Uint8Array>;
  size?: number;
}

export interface FileBucket {
  put(key: string, value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): Promise<unknown>;
  get(key: string): Promise<FileObjectBody | null>;
  delete(key: string): Promise<void>;
}

export type UploadBody = ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array;

export interface UploadFileInput {
  room: string;
  principal: string;
  name: string;
  mime: string;
  body: UploadBody;
  /** Declared Content-Length. When set, it must equal the bytes read and is checked before the read when it already exceeds a cap. */
  size?: number;
  now: number;
  idempotency_key: string;
  /** Optional X-Workroom-Sha256. When set it must equal the server digest. */
  sha256?: string;
  env?: FileEnv;
}

export interface PublicFile {
  id: string;
  room_id: string;
  storage: 'r2' | 'drive';
  name: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  sha256_verified: 0 | 1;
  uploader_id: string;
  created_at: string;
  expires_at: string | null;
  drive_file_id: string | null;
  web_link: string | null;
  availability: FileAvailability;
  deleted_at: string | null;
  tombstone_reason: string | null;
}

export interface StoredFile {
  file: PublicFile;
  replayed: boolean;
}

export type ReadFileResult =
  | { kind: 'bytes'; file: PublicFile; body: ReadableStream<Uint8Array>; headers: Record<string, string> }
  | { kind: 'metadata'; file: PublicFile };

export interface ListFilesQuery {
  limit?: number;
  cursor?: string | null;
  availability?: FileAvailability | null;
}

export interface FilePage {
  files: PublicFile[];
  next_cursor: string | null;
}

export interface DriveLinkInput {
  room: string;
  principal: string;
  name: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  drive_file_id: string;
  web_link: string;
  idempotency_key: string;
  now: number;
}

export interface FileGcError {
  id: string;
  message: string;
}

export interface FileGcResult {
  examined: number;
  deleted: number;
  already_missing: number;
  marked: number;
  errors: FileGcError[];
}

interface FileRow {
  id: string;
  room_id: string;
  storage: 'r2' | 'drive';
  name: string;
  mime: string;
  size_bytes: number;
  sha256: string;
  sha256_verified: number;
  uploader_id: string;
  created_at_ms: number;
  expires_at_ms: number | null;
  r2_key: string | null;
  drive_file_id: string | null;
  web_link: string | null;
  deleted_at_ms: number | null;
  tombstone_reason: string | null;
}

interface OpRow {
  room_id: string;
  request_hash: string;
  result_json: string;
}

interface StreamLimits {
  maxBytes: number;
  declared?: number;
  hourRemaining: number;
  roomRemaining: number;
  now: number;
}

export function fileCaps(env?: FileEnv): FileCaps {
  return {
    maxBytes: parseCap('FILE_MAX_BYTES', env?.FILE_MAX_BYTES, CAP_BOUNDS.FILE_MAX_BYTES),
    ttlSeconds: parseCap('FILE_TTL_SECONDS', env?.FILE_TTL_SECONDS, CAP_BOUNDS.FILE_TTL_SECONDS),
    hourBytes: parseCap('FILE_HOUR_BYTES', env?.FILE_HOUR_BYTES, CAP_BOUNDS.FILE_HOUR_BYTES),
    roomBytes: parseCap('FILE_ROOM_MAX_BYTES', env?.FILE_ROOM_MAX_BYTES, CAP_BOUNDS.FILE_ROOM_MAX_BYTES),
  };
}

export async function uploadFile(db: Database, bucket: FileBucket | null, input: UploadFileInput): Promise<StoredFile> {
  assertRoom(input.room);
  assertPrincipal(input.principal);
  assertNow(input.now);
  assertKey(input.idempotency_key);
  assertName(input.name);
  assertMime(input.mime);
  if (input.sha256 !== undefined) assertSha256(input.sha256, 'X-Workroom-Sha256');
  if (input.size !== undefined) assertPositiveInt(input.size, 'size');
  if (!isBody(input.body)) throw invalid('body must be a stream or bytes.');

  const existing = await loadOp(db, input.principal, FILE_UPLOAD, input.idempotency_key);
  if (existing) return replayUpload(db, existing, input);

  const caps = fileCaps(input.env);
  if (input.size !== undefined && input.size > caps.maxBytes) throw tooLarge();
  if (!bucket) throw storeUnavailable();

  if (await minuteCount(db, input.principal, input.now) >= 60) throw rateLimited(input.now, 'minute');
  const hourUsed = await hourBytes(db, input.principal, input.now);
  const roomUsed = await roomBytes(db, input.room, input.now);
  if (input.size !== undefined) {
    if (hourUsed > caps.hourBytes - input.size) throw rateLimited(input.now, 'hour');
    if (roomUsed > caps.roomBytes - input.size) throw rateLimited(input.now, 'room');
  } else if (hourUsed >= caps.hourBytes) throw rateLimited(input.now, 'hour');
  else if (roomUsed >= caps.roomBytes) throw rateLimited(input.now, 'room');

  const id = crypto.randomUUID();
  const r2Key = `rooms/${input.room}/files/${id}`;
  const hashed = await putHashed(bucket, r2Key, input.body, {
    maxBytes: caps.maxBytes,
    declared: input.size,
    hourRemaining: caps.hourBytes - hourUsed,
    roomRemaining: caps.roomBytes - roomUsed,
    now: input.now,
  });
  try {
    if (input.size !== undefined && input.size !== hashed.size) throw invalid('Content-Length does not match the body.');
    if (hashed.size <= 0) throw invalid('File body is empty.');
    if (input.sha256 !== undefined && input.sha256 !== hashed.sha256) throw invalid('X-Workroom-Sha256 does not match the body.');
    const expires = input.now + caps.ttlSeconds * 1000;
    if (!Number.isSafeInteger(expires)) throw invalid('now is out of range.');
    const row = r2Row({
      id, room: input.room, name: input.name, mime: input.mime, size: hashed.size, sha256: hashed.sha256,
      principal: input.principal, now: input.now, expires, r2Key,
    });
    const request = await requestHash({ room: input.room, name: input.name, mime: input.mime, size: hashed.size, sha256: hashed.sha256 });
    const quota: R2Quota = { size: hashed.size, hourCap: caps.hourBytes, roomCap: caps.roomBytes };
    const committed = await commitFile(db, input.principal, FILE_UPLOAD, input.idempotency_key, input.room, request, row, input.now, insertR2(db, row, input.principal, input.idempotency_key), quota);
    if (!committed.ok) throw committed.fault;
    return { file: toPublic(committed.row, input.now), replayed: false };
  } catch (error) {
    // Codex HOLD d0792c2 (files 2/3): delete the object only when the row is known to be absent. A lost ACK or a
    // failed readback may hide a committed row; deleting then would leave a live row and receipt without bytes.
    let persisted: FileRow | null;
    try {
      persisted = await loadFile(db, input.room, id);
    } catch {
      throw unknownOutcome();
    }
    if (persisted) return { file: toPublic(persisted, input.now), replayed: false };
    await removeObject(bucket, r2Key);
    if (error instanceof Fault) throw error;
    throw notStored();
  }
}

export async function readFile(db: Database, bucket: FileBucket | null, room: string, id: string, now: number): Promise<ReadFileResult> {
  assertRoom(room);
  assertNow(now);
  const row = await loadFile(db, room, id);
  if (!row) throw notFound();
  const file = toPublic(row, now);
  if (row.storage === 'drive') return { kind: 'metadata', file };
  if (closed(row, now)) throw fileExpired();
  if (!bucket) throw storeUnavailable();
  if (!row.r2_key) throw missingBytes();
  const object = await bucket.get(row.r2_key);
  if (!object?.body) throw missingBytes();
  return { kind: 'bytes', file, body: object.body, headers: downloadHeaders(file) };
}

export async function getFile(db: Database, room: string, id: string, now: number): Promise<PublicFile> {
  assertRoom(room);
  assertNow(now);
  const row = await loadFile(db, room, id);
  if (!row) throw notFound();
  return toPublic(row, now);
}

export async function listFiles(db: Database, room: string, now: number, query: ListFilesQuery = {}): Promise<FilePage> {
  assertRoom(room);
  assertNow(now);
  const limit = query.limit === undefined ? 50 : query.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid('limit must be an integer from 1 to 100.');
  const availability = query.availability ?? null;
  if (availability !== null && !AVAILABILITIES.includes(availability)) throw invalid('availability is not a known filter.');
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const rows = await db.prepare(
    `SELECT ${FILE_COLUMNS} FROM shared_files
     WHERE room_id=?
       AND (?=0 OR created_at_ms<? OR (created_at_ms=? AND id<?))
       AND (?=1
         OR (?='external' AND storage='drive')
         OR (?='tombstone' AND deleted_at_ms IS NOT NULL)
         OR (?='expired' AND storage='r2' AND deleted_at_ms IS NULL AND expires_at_ms<=?)
         OR (?='live' AND storage='r2' AND deleted_at_ms IS NULL AND expires_at_ms>?))
     ORDER BY created_at_ms DESC, id DESC
     LIMIT ?`,
  ).bind(
    room,
    cursor ? 1 : 0, cursor?.createdAtMs ?? 0, cursor?.createdAtMs ?? 0, cursor?.id ?? '',
    availability === null ? 1 : 0,
    availability, availability, availability, now, availability, now,
    limit + 1,
  ).all<FileRow>();
  const page = rows.results.slice(0, limit).map(asRow);
  const last = page[page.length - 1];
  return {
    files: page.map(row => toPublic(row, now)),
    next_cursor: rows.results.length > limit && last ? encodeCursor(last.created_at_ms, last.id) : null,
  };
}

export async function registerDriveLink(db: Database, input: DriveLinkInput): Promise<StoredFile> {
  if (Object.prototype.hasOwnProperty.call(input, 'uploader_id')) throw invalid('uploader_id is set by the authenticated caller.');
  assertRoom(input.room);
  assertPrincipal(input.principal);
  assertNow(input.now);
  assertKey(input.idempotency_key);
  assertName(input.name);
  assertMime(input.mime);
  assertDriveSize(input.size_bytes);
  assertSha256(input.sha256, 'sha256');
  assertDriveId(input.drive_file_id);
  assertWebLink(input.web_link, input.drive_file_id);

  const request = await requestHash({
    room: input.room, name: input.name, mime: input.mime, size_bytes: input.size_bytes,
    sha256: input.sha256, drive_file_id: input.drive_file_id, web_link: input.web_link,
  });
  const existing = await loadOp(db, input.principal, FILE_REGISTER_LINK, input.idempotency_key);
  if (existing) {
    if (existing.request_hash !== request || existing.room_id !== input.room) throw conflict(FILE_REGISTER_LINK, input.idempotency_key);
    const row = await rowFromOp(db, existing, input.room);
    return { file: toPublic(row, input.now), replayed: true };
  }
  if (await minuteCount(db, input.principal, input.now) >= 60) throw rateLimited(input.now, 'minute');
  const row = driveRow(input);
  const committed = await commitFile(db, input.principal, FILE_REGISTER_LINK, input.idempotency_key, input.room, request, row, input.now, insertDrive(db, row, input.principal, input.idempotency_key));
  if (!committed.ok) throw committed.fault;
  return { file: toPublic(committed.row, input.now), replayed: false };
}

export async function expireFiles(db: Database, bucket: FileBucket | null, now: number): Promise<FileGcResult> {
  assertNow(now);
  const selected = await db.prepare(
    `SELECT id, r2_key FROM shared_files
     WHERE storage='r2' AND deleted_at_ms IS NULL AND expires_at_ms<=?
     ORDER BY expires_at_ms ASC, id ASC
     LIMIT ?`,
  ).bind(now, GC_BATCH).all<{ id: string; r2_key: string | null }>();
  const result: FileGcResult = { examined: selected.results.length, deleted: 0, already_missing: 0, marked: 0, errors: [] };
  for (const row of selected.results) {
    if (!bucket) {
      result.errors.push({ id: row.id, message: 'file store unavailable' });
      continue;
    }
    if (!row.r2_key) {
      result.errors.push({ id: row.id, message: 'r2 key is missing' });
      continue;
    }
    let kind: 'deleted' | 'missing';
    try {
      const object = await bucket.get(row.r2_key);
      if (!object) kind = 'missing';
      else {
        await release(object);
        await bucket.delete(row.r2_key);
        kind = 'deleted';
      }
    } catch (error) {
      result.errors.push({ id: row.id, message: clip(error) });
      continue;
    }
    if (kind === 'deleted') result.deleted += 1;
    else result.already_missing += 1;
    try {
      const updated = await db.prepare(
        `UPDATE shared_files SET deleted_at_ms=?, tombstone_reason='expired'
         WHERE id=? AND storage='r2' AND deleted_at_ms IS NULL AND expires_at_ms<=?`,
      ).bind(now, row.id, now).all() as { meta?: { changes?: number } };
      if (updated.meta?.changes !== 1) throw new Error('tombstone was not recorded');
      result.marked += 1;
    } catch (error) {
      result.errors.push({ id: row.id, message: clip(error) });
    }
  }
  await db.prepare('INSERT INTO file_gc_runs(id, at_ms, result_json) VALUES (?,?,?)')
    .bind(crypto.randomUUID(), now, JSON.stringify(result)).all();
  await db.prepare('DELETE FROM file_gc_runs WHERE at_ms<?').bind(now - GC_RETAIN_MS).all();
  return result;
}

/** Ids that may be cited on a message. Expired, tombstoned, unknown, and other-room ids write nothing. */
export async function requireAttachableFiles(db: Database, room: string, fileIds: readonly string[], now: number): Promise<PublicFile[]> {
  assertRoom(room);
  assertNow(now);
  if (!Array.isArray(fileIds)) throw invalid('file_ids must be a list of ids.');
  if (fileIds.length > 8) throw invalid('At most eight files can be cited.');
  if (new Set(fileIds).size !== fileIds.length) throw invalid('file_ids contains a duplicate.');
  for (const id of fileIds) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 128 || id.includes('\0')) throw invalid('file_ids contains an invalid id.');
  }
  if (fileIds.length === 0) return [];
  const marks = fileIds.map(() => '?').join(',');
  const loaded = await db.prepare(`SELECT ${FILE_COLUMNS} FROM shared_files WHERE room_id=? AND id IN (${marks})`)
    .bind(room, ...fileIds).all<FileRow>();
  const byId = new Map(loaded.results.map(row => [asRow(row).id, asRow(row)]));
  const files: PublicFile[] = [];
  for (const id of fileIds) {
    const row = byId.get(id);
    if (!row || row.room_id !== room) throw notFound();
    if (row.storage === 'r2' && closed(row, now)) throw fileExpired();
    files.push(toPublic(row, now));
  }
  return files;
}

const FILE_COLUMNS = `id, room_id, storage, name, mime, size_bytes, sha256, sha256_verified, uploader_id,
  created_at_ms, expires_at_ms, r2_key, drive_file_id, web_link, deleted_at_ms, tombstone_reason`;

function r2Row(input: { id: string; room: string; name: string; mime: string; size: number; sha256: string; principal: string; now: number; expires: number; r2Key: string }): FileRow {
  return {
    id: input.id, room_id: input.room, storage: 'r2', name: input.name, mime: input.mime, size_bytes: input.size,
    sha256: input.sha256, sha256_verified: 1, uploader_id: input.principal, created_at_ms: input.now,
    expires_at_ms: input.expires, r2_key: input.r2Key, drive_file_id: null, web_link: null, deleted_at_ms: null, tombstone_reason: null,
  };
}

function driveRow(input: DriveLinkInput): FileRow {
  return {
    id: crypto.randomUUID(), room_id: input.room, storage: 'drive', name: input.name, mime: input.mime,
    size_bytes: input.size_bytes, sha256: input.sha256, sha256_verified: 0, uploader_id: input.principal,
    created_at_ms: input.now, expires_at_ms: null, r2_key: null, drive_file_id: input.drive_file_id,
    web_link: input.web_link, deleted_at_ms: null, tombstone_reason: null,
  };
}

function insertR2(db: Database, row: FileRow, principal: string, key: string): Statement {
  return db.prepare(
    `INSERT INTO shared_files(
      id, room_id, storage, name, mime, size_bytes, sha256, sha256_verified, uploader_id,
      created_at_ms, expires_at_ms, r2_key, drive_file_id, web_link, deleted_at_ms, tombstone_reason)
     SELECT ?, ?, 'r2', ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, NULL, NULL, NULL
     WHERE EXISTS (
       SELECT 1 FROM operations WHERE principal_id=? AND operation=? AND key=? AND room_id=?
         AND json_extract(result_json, '$.id')=?)`,
  ).bind(
    row.id, row.room_id, row.name, row.mime, row.size_bytes, row.sha256, row.uploader_id,
    row.created_at_ms, row.expires_at_ms, row.r2_key, principal, FILE_UPLOAD, key, row.room_id, row.id,
  );
}

function insertDrive(db: Database, row: FileRow, principal: string, key: string): Statement {
  return db.prepare(
    `INSERT INTO shared_files(
      id, room_id, storage, name, mime, size_bytes, sha256, sha256_verified, uploader_id,
      created_at_ms, expires_at_ms, r2_key, drive_file_id, web_link, deleted_at_ms, tombstone_reason)
     SELECT ?, ?, 'drive', ?, ?, ?, ?, 0, ?, ?, NULL, NULL, ?, ?, NULL, NULL
     WHERE EXISTS (
       SELECT 1 FROM operations WHERE principal_id=? AND operation=? AND key=? AND room_id=?
         AND json_extract(result_json, '$.id')=?)`,
  ).bind(
    row.id, row.room_id, row.name, row.mime, row.size_bytes, row.sha256, row.uploader_id, row.created_at_ms,
    row.drive_file_id, row.web_link, principal, FILE_REGISTER_LINK, key, row.room_id, row.id,
  );
}

interface R2Quota { size: number; hourCap: number; roomCap: number }

async function commitFile(db: Database, principal: string, operation: string, key: string, room: string, request: string, row: FileRow, now: number, insert: Statement, quota?: R2Quota): Promise<{ ok: true; row: FileRow } | { ok: false; fault: Fault }> {
  const resultJson = JSON.stringify(toPublic(row, now));
  const createdAt = new Date(now).toISOString();
  // Codex HOLD d0792c2 (files 4): hour and room byte caps are re-checked inside the committing batch, so parallel
  // uploads that each passed the early check cannot together exceed a cap. D1 serializes batches.
  const q = quota ?? null;
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO operations(principal_id, operation, key, room_id, request_hash, result_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM operations WHERE principal_id=? AND created_at>=?)<60
           AND (? IS NULL OR (
             (SELECT COALESCE(SUM(size_bytes), 0) FROM shared_files WHERE uploader_id=? AND storage='r2' AND created_at_ms>=?) + ? <= ?
             AND (SELECT COALESCE(SUM(size_bytes), 0) FROM shared_files WHERE room_id=? AND storage='r2' AND deleted_at_ms IS NULL AND expires_at_ms>?) + ? <= ?))
         ON CONFLICT(principal_id, operation, key) DO NOTHING`,
      ).bind(principal, operation, key, room, request, resultJson, createdAt, principal, minuteStart(now),
        q ? 1 : null, principal, now - HOUR_MS, q?.size ?? 0, q?.hourCap ?? 0, room, now, q?.size ?? 0, q?.roomCap ?? 0),
      insert,
    ]);
  } catch {
    return { ok: false, fault: notStored() };
  }
  const stored = await loadFile(db, room, row.id);
  if (stored) return { ok: true, row: stored };
  const op = await loadOp(db, principal, operation, key);
  if (op) return { ok: false, fault: conflict(operation, key) };
  if (q && await minuteCount(db, principal, now) < 60) {
    if (await hourBytes(db, principal, now) + q.size > q.hourCap) return { ok: false, fault: rateLimited(now, 'hour') };
    return { ok: false, fault: rateLimited(now, 'room') };
  }
  return { ok: false, fault: rateLimited(now, 'minute') };
}

async function replayUpload(db: Database, existing: OpRow, input: UploadFileInput): Promise<StoredFile> {
  const hashed = await hashBody(input.body, FILE_DEFAULTS.FILE_MAX_BYTES, input.size, input.now);
  if (input.size !== undefined && input.size !== hashed.size) throw invalid('Content-Length does not match the body.');
  if (hashed.size <= 0) throw invalid('File body is empty.');
  if (input.sha256 !== undefined && input.sha256 !== hashed.sha256) throw invalid('X-Workroom-Sha256 does not match the body.');
  const storedSha = shaFromResult(existing.result_json);
  if (!storedSha || hashed.sha256 !== storedSha || existing.room_id !== input.room) throw conflict(FILE_UPLOAD, input.idempotency_key);
  const row = await rowFromOp(db, existing, input.room);
  if (row.sha256 !== hashed.sha256 || row.room_id !== input.room) throw conflict(FILE_UPLOAD, input.idempotency_key);
  return { file: toPublic(row, input.now), replayed: true };
}

async function hashBody(body: UploadBody, maxBytes: number, declared: number | undefined, now: number): Promise<{ size: number; sha256: string }> {
  const reader = readerFor(body);
  const hasher = new Sha256();
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const grown = size + next.value.byteLength;
      const fault = limitFault(grown, { maxBytes, declared, hourRemaining: Number.POSITIVE_INFINITY, roomRemaining: Number.POSITIVE_INFINITY, now });
      if (fault) {
        await reader.cancel(fault);
        throw fault;
      }
      hasher.update(next.value);
      size = grown;
    }
  } catch (error) {
    if (error instanceof Fault) throw error;
    throw invalid('body is not readable.');
  }
  return { size, sha256: hasher.digestHex() };
}

async function putHashed(bucket: FileBucket, key: string, body: UploadBody, limits: StreamLimits): Promise<{ size: number; sha256: string }> {
  const reader = readerFor(body);
  const hasher = new Sha256();
  let size = 0;
  let problem: Fault | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        const grown = size + next.value.byteLength;
        const fault = limitFault(grown, limits);
        if (fault) {
          problem = fault;
          await reader.cancel(fault);
          controller.error(fault);
          return;
        }
        hasher.update(next.value);
        size = grown;
        controller.enqueue(next.value);
      } catch (error) {
        if (!problem) problem = error instanceof Fault ? error : invalid('body is not readable.');
        controller.error(problem);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  // Workers R2 rejects a stream of unknown length; the declared Content-Length is pinned with FixedLengthStream when the runtime has it.
  const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  let upload: ReadableStream<Uint8Array> = stream;
  if (Fixed && limits.declared !== undefined && limits.declared !== null) {
    const fixed = new Fixed(limits.declared);
    stream.pipeTo(fixed.writable).catch(() => undefined);
    upload = fixed.readable;
  }
  try {
    await bucket.put(key, upload);
  } catch (error) {
    await removeObject(bucket, key);
    if (problem) throw problem;
    if (error instanceof Fault) throw error;
    throw storeUnavailable();
  }
  if (problem) {
    await removeObject(bucket, key);
    throw problem;
  }
  return { size, sha256: hasher.digestHex() };
}

function limitFault(next: number, limits: StreamLimits): Fault | null {
  if (next > limits.maxBytes) return tooLarge();
  if (limits.declared !== undefined && next > limits.declared) return invalid('Content-Length does not match the body.');
  if (limits.declared === undefined && (next > limits.hourRemaining || next > limits.roomRemaining)) {
    return rateLimited(limits.now, next > limits.hourRemaining ? 'hour' : 'room');
  }
  return null;
}

function readerFor(body: UploadBody): ReadableStreamDefaultReader<Uint8Array> {
  try {
    return bodyToStream(body).getReader();
  } catch {
    throw invalid('body is not readable.');
  }
}

function bodyToStream(body: UploadBody): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  let offset = 0;
  const chunkSize = 64 * 1024;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

async function removeObject(bucket: FileBucket, key: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch {
    throw unknownOutcome();
  }
}

async function release(object: FileObjectBody): Promise<void> {
  try { await object.body.cancel(); } catch { /* the GC pass does not read bytes */ }
}

function closed(row: FileRow, now: number): boolean {
  return row.deleted_at_ms != null || row.expires_at_ms == null || now >= row.expires_at_ms;
}

function availabilityOf(row: FileRow, now: number): FileAvailability {
  if (row.storage === 'drive') return 'external';
  if (row.deleted_at_ms != null) return 'tombstone';
  if (row.expires_at_ms == null || now >= row.expires_at_ms) return 'expired';
  return 'live';
}

function toPublic(row: FileRow, now: number): PublicFile {
  return {
    id: row.id,
    room_id: row.room_id,
    storage: row.storage,
    name: row.name,
    mime: row.mime,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    sha256_verified: row.sha256_verified === 1 ? 1 : 0,
    uploader_id: row.uploader_id,
    created_at: new Date(row.created_at_ms).toISOString(),
    expires_at: row.expires_at_ms == null ? null : new Date(row.expires_at_ms).toISOString(),
    drive_file_id: row.drive_file_id,
    web_link: row.web_link,
    availability: availabilityOf(row, now),
    deleted_at: row.deleted_at_ms == null ? null : new Date(row.deleted_at_ms).toISOString(),
    tombstone_reason: row.tombstone_reason,
  };
}

function asRow(row: FileRow): FileRow {
  if (row.storage !== 'r2' && row.storage !== 'drive') throw new Fault('TEMPORARY_FAILURE', 'Stored file row is invalid.', 503, 'unknown', true);
  return row;
}

async function loadFile(db: Database, room: string, id: string): Promise<FileRow | null> {
  if (typeof id !== 'string' || id.length < 1) return null;
  const row = await db.prepare(`SELECT ${FILE_COLUMNS} FROM shared_files WHERE id=? AND room_id=?`).bind(id, room).first<FileRow>();
  return row ? asRow(row) : null;
}

async function loadOp(db: Database, principal: string, operation: string, key: string): Promise<OpRow | null> {
  return db.prepare('SELECT room_id, request_hash, result_json FROM operations WHERE principal_id=? AND operation=? AND key=?')
    .bind(principal, operation, key).first<OpRow>();
}

async function rowFromOp(db: Database, op: OpRow, room: string): Promise<FileRow> {
  let id: string | null = null;
  try {
    const parsed = JSON.parse(op.result_json) as { id?: unknown };
    if (typeof parsed.id === 'string') id = parsed.id;
  } catch { id = null; }
  const row = id ? await loadFile(db, room, id) : null;
  if (!row || row.room_id !== room) throw unknownOutcome();
  return row;
}

function shaFromResult(resultJson: string): string | null {
  try {
    const parsed = JSON.parse(resultJson) as { sha256?: unknown };
    return typeof parsed.sha256 === 'string' ? parsed.sha256 : null;
  } catch {
    return null;
  }
}

async function minuteCount(db: Database, principal: string, now: number): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM operations WHERE principal_id=? AND created_at>=?')
    .bind(principal, minuteStart(now)).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function hourBytes(db: Database, principal: string, now: number): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM shared_files
     WHERE uploader_id=? AND storage='r2' AND created_at_ms>=?`,
  ).bind(principal, now - HOUR_MS).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function roomBytes(db: Database, room: string, now: number): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM shared_files
     WHERE room_id=? AND storage='r2' AND deleted_at_ms IS NULL AND expires_at_ms>?`,
  ).bind(room, now).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

function minuteStart(now: number): string {
  return new Date(now).toISOString().slice(0, 16) + ':00.000Z';
}

function downloadHeaders(file: PublicFile): Record<string, string> {
  const type = DANGEROUS_MIME.has(file.mime.toLowerCase()) ? 'application/octet-stream' : file.mime;
  return {
    'Content-Type': type,
    'Content-Length': String(file.size_bytes),
    'Content-Disposition': contentDisposition(file.name),
    'X-Workroom-Sha256': file.sha256,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  };
}

function contentDisposition(name: string): string {
  const star = encodeURIComponent(name).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  let ascii = true;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e || ch === '"' || ch === '\\') ascii = false;
  }
  return ascii
    ? `attachment; filename="${name}"; filename*=UTF-8''${star}`
    : `attachment; filename*=UTF-8''${star}`;
}

function encodeCursor(createdAtMs: number, id: string): string {
  return btoa(`${createdAtMs}\n${id}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string): { createdAtMs: number; id: string } {
  if (!/^[-A-Za-z0-9_]+$/.test(cursor) || cursor.length > 512) throw invalid('cursor is invalid.');
  const pad = cursor.replaceAll('-', '+').replaceAll('_', '/');
  const padded = pad + '='.repeat((4 - (pad.length % 4)) % 4);
  let text = '';
  try { text = atob(padded); } catch { throw invalid('cursor is invalid.'); }
  const split = text.indexOf('\n');
  if (split <= 0) throw invalid('cursor is invalid.');
  const createdAtMs = Number(text.slice(0, split));
  const id = text.slice(split + 1);
  if (!Number.isSafeInteger(createdAtMs) || id.length < 1 || id.length > 128) throw invalid('cursor is invalid.');
  return { createdAtMs, id };
}

function assertWebLink(webLink: string, driveFileId: string): void {
  if (typeof webLink !== 'string' || webLink.length < 1 || webLink.length > 2048 || /[\s\\]/.test(webLink)) {
    throw invalid('web_link is not an allowed Drive URL.');
  }
  const schemeEnd = webLink.indexOf('://');
  if (schemeEnd < 0) throw invalid('web_link is not an allowed Drive URL.');
  const rest = webLink.slice(schemeEnd + 3);
  const slash = rest.search(/[/?#]/);
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  if (authority.length === 0 || authority.includes('@') || authority.includes(':')) throw invalid('web_link is not an allowed Drive URL.');
  let url: URL;
  try { url = new URL(webLink); } catch { throw invalid('web_link is not an allowed Drive URL.'); }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') throw invalid('web_link is not an allowed Drive URL.');
  if (url.hostname !== 'drive.google.com' && url.hostname !== 'docs.google.com') throw invalid('web_link is not an allowed Drive URL.');
  if (!pathHasId(url.pathname, driveFileId)) throw invalid('web_link path id does not equal drive_file_id.');
}

function pathHasId(pathname: string, id: string): boolean {
  for (const marker of [`/d/${id}`, `/folders/${id}`]) {
    let from = 0;
    while (from < pathname.length) {
      const at = pathname.indexOf(marker, from);
      if (at < 0) break;
      const next = pathname.charAt(at + marker.length);
      if (next === '' || next === '/') return true;
      from = at + marker.length;
    }
  }
  return false;
}

function assertDriveId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !DRIVE_ID_RE.test(id)) throw invalid('drive_file_id must be 10 to 128 characters of letters, digits, "_" or "-".');
}

function assertDriveSize(size: unknown): asserts size is number {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > DRIVE_SIZE_MAX) throw invalid('size_bytes is outside the allowed range.');
}

function assertName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.length < 1 || !name.isWellFormed() || name.includes('\0')) throw invalid('name is not a display label.');
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw invalid('name is not a display label.');
  if (utf8.encode(name).length > NAME_MAX_BYTES) throw invalid('name is not a display label.');
}

function assertMime(mime: unknown): asserts mime is string {
  if (typeof mime !== 'string' || mime.length > 127 || !MIME_RE.test(mime)) throw invalid('mime must be a type/subtype token.');
}

function assertSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) throw invalid(`${field} must be 64 lowercase hex characters.`);
}

function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw invalid('idempotency_key must match ^[A-Za-z0-9_.-]{8,128}$.');
}

function assertRoom(room: unknown): asserts room is string {
  if (typeof room !== 'string' || room.length < 1 || room.length > 128) throw invalid('room is required.');
}

function assertPrincipal(principal: unknown): asserts principal is string {
  if (typeof principal !== 'string' || principal.length < 1 || principal.length > 256) throw invalid('principal is required.');
}

function assertNow(now: unknown): asserts now is number {
  if (typeof now !== 'number' || !Number.isSafeInteger(now) || now < 0) throw invalid('now must be a millisecond timestamp.');
}

function assertPositiveInt(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`${field} must be a positive integer.`);
}

function isBody(body: unknown): body is UploadBody {
  return body instanceof ReadableStream || body instanceof ArrayBuffer || body instanceof Uint8Array;
}

function parseCap(name: string, raw: string | undefined, bound: { min: number; max: number; fallback: number }): number {
  if (raw === undefined) return bound.fallback;
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw)) throw configInvalid(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bound.min || value > bound.max) throw configInvalid(name);
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

async function requestHash(value: object): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', utf8.encode(JSON.stringify(canonical(value))));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function invalid(message: string): Fault {
  return new Fault('INVALID_INPUT', message, 400);
}

function tooLarge(): Fault {
  return new Fault('FILE_TOO_LARGE', 'File exceeds FILE_MAX_BYTES.', 413);
}

function rateLimited(now: number, limit: 'minute' | 'hour' | 'room'): Fault {
  const details: Record<string, unknown> = { limit };
  if (limit === 'minute') details.retry_after = 60 - new Date(now).getUTCSeconds();
  const message = limit === 'minute'
    ? 'Mutation limit reached; retry the same key later.'
    : 'File byte cap reached; retry the same key later.';
  return new Fault('RATE_LIMITED', message, 429, 'not_applied', true, details);
}

function conflict(operation: string, key: string): Fault {
  return new Fault('IDEMPOTENCY_CONFLICT', 'Key already has different content.', 409, 'not_applied', false, {
    operation, idempotency_key: key, lookup: `/api/v1/operations/${operation}/${key}`,
  });
}

function notFound(): Fault {
  return new Fault('NOT_FOUND', 'File not found.', 404);
}

function fileExpired(): Fault {
  return new Fault('FILE_EXPIRED', 'File expired.', 410);
}

function missingBytes(): Fault {
  return new Fault('FILE_BYTES_MISSING', 'File bytes are missing.', 404);
}

function configInvalid(name: string): Fault {
  return new Fault('FILE_CONFIG_INVALID', `${name} is outside the allowed range.`, 503, 'not_applied', false);
}

function storeUnavailable(): Fault {
  return new Fault('FILE_STORE_UNAVAILABLE', 'File storage is not available.', 503, 'not_applied', true);
}

function unknownOutcome(): Fault {
  return new Fault('TEMPORARY_FAILURE', 'Storage or transport result is uncertain. Requery or retry the same key.', 503, 'unknown', true);
}

function notStored(): Fault {
  return new Fault('TEMPORARY_FAILURE', 'The file record was not stored.', 503, 'not_applied', true);
}

function clip(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;
  private block = new Uint8Array(64);
  private blockLen = 0;
  private bytes = 0;
  private readonly w = new Uint32Array(64);
  private finished = false;

  update(data: Uint8Array): void {
    this.bytes += data.byteLength;
    let offset = 0;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.byteLength);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      offset = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    while (offset + 64 <= data.byteLength) {
      this.compressView(view, offset);
      offset += 64;
    }
    if (offset < data.byteLength) {
      this.block.set(data.subarray(offset), 0);
      this.blockLen = data.byteLength - offset;
    }
  }

  digestHex(): string {
    if (this.finished) throw new Error('sha256 digest already taken');
    this.finished = true;
    const saved = this.bytes;
    const marker = new Uint8Array(1);
    marker[0] = 0x80;
    this.update(marker);
    const zero = new Uint8Array(64);
    while (this.blockLen !== 56) {
      const count = this.blockLen < 56 ? 56 - this.blockLen : 64 - this.blockLen;
      this.update(zero.subarray(0, count));
    }
    const len = new Uint8Array(8);
    const view = new DataView(len.buffer);
    view.setUint32(0, Math.floor(saved / 0x20000000));
    view.setUint32(4, (saved * 8) >>> 0);
    this.update(len);
    return [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7]
      .map(word => word.toString(16).padStart(8, '0')).join('');
  }

  private compress(buf: Uint8Array, offset: number): void {
    this.compressView(new DataView(buf.buffer, buf.byteOffset + offset, 64), 0);
  }

  private compressView(view: DataView, offset: number): void {
    const words = this.w;
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = words[i - 15] ?? 0;
      const w2 = words[i - 2] ?? 0;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      words[i] = (((words[i - 16] ?? 0) + s0 + (words[i - 7] ?? 0) + s1) >>> 0);
    }
    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (words[i] ?? 0)) >>> 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }
}
