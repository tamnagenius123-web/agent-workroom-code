import { Fault } from './contracts.ts';
import { instant } from './canonical.ts';
import type { Database, Value } from './db.ts';

// OCG-W W2: propose-only memory items and edges.
// A model supersede stays pending and closes nothing (ABSORB_DESIGN §0, §0.2).
// valid_view returns approved rows in the time window; pending is opt-in (§4).
// Items are not written to memory_fts. Kind filters are exact (no LIKE).

const utf8 = new TextEncoder();
const BODY_MAX = 8192;
const TITLE_MAX = 200;
const KINDS = new Set(['decision', 'fact', 'skill']);
// Known credential prefixes, a PEM private key, or a long hex/base64 token after token|secret|key|password=.
const PREFIXES: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-/,
  /(?<![A-Za-z0-9])ghp_/,
  /(?<![A-Za-z0-9])xox[bap]-/,
  /(?<![A-Za-z0-9])AKIA/,
  /-----BEGIN .*PRIVATE KEY/,
];

export type MemoryKind = 'decision' | 'fact' | 'skill';
export type ReviewState = 'pending' | 'approved' | 'rejected';
export type EdgeType = 'SUPERSEDED_BY' | 'PROMOTED_FROM' | 'DERIVED_FROM';

export interface MemoryItem {
  id: string;
  room_id: string;
  kind: MemoryKind;
  tier: number;
  title: string;
  body: string;
  source_message_id: string;
  source_version: number | null;
  /** rev2c (0020): 'pinned' = recorded at proposal time; 'inferred' = 0018 timestamp backfill or any pre-0020 row. Not proof of what was read. */
  version_basis: 'pinned' | 'inferred';
  proposed_by: string;
  review_state: ReviewState;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
}

export interface MemoryEdge {
  id: string;
  src_id: string;
  dst_id: string;
  type: EdgeType;
  proposed_by: string;
  review_state: ReviewState;
  created_at: string;
}

export interface ProposeItemInput {
  id?: string;
  room_id: string;
  kind: MemoryKind;
  tier: number;
  title: string;
  body: string;
  source_message_id: string;
  valid_from: string;
  valid_until?: string | null;
}

export interface ViewOptions {
  kinds?: readonly MemoryKind[];
  at?: string;
  includePending?: boolean;
  /** Room brief (Codex ec45569a): highest tier, newest first, at most this many rows. Default: all rows, oldest first. */
  topByTier?: number;
  /** Room brief (Codex d5c3553b): newest first (valid_from, created_at, id DESC), at most this many rows. */
  newest?: number;
}

const ITEM_COLUMNS = `id, room_id, kind, tier, title, body, source_message_id, source_version, version_basis, proposed_by, review_state, valid_from, valid_until, created_at`;

function text(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw new Fault('INVALID_INPUT', `${field} is invalid`);
  const chars = [...value].length;
  if (chars < 1 || chars > maxChars) throw new Fault('INVALID_INPUT', `${field} must be 1 to ${maxChars} characters`);
  return value;
}

// rev2: normalized to UTC milliseconds so the text comparisons below are instant comparisons.
function timestamp(value: unknown, field: string): string {
  return instant(value, field);
}

function ident(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !value.isWellFormed() || value.includes('\0')) {
    throw new Fault('INVALID_INPUT', `${field} is invalid`);
  }
  return value;
}

function isKind(value: string): value is MemoryKind {
  return KINDS.has(value);
}

// Hex of 40+ or a base64 token of 40+ counts. A lowercase snake/kebab enum does not (ABSORB_DESIGN §2.6).
function tokenIsSecret(raw: string): boolean {
  const value = raw.replace(/[,;]+$/, '');
  if (value.length < 40) return false;
  if (/^\$\{[^}]+\}$/.test(value) || /^\$[A-Z_][A-Z0-9_]*$/.test(value) || /^%[A-Za-z0-9_]+%$/.test(value) || /^<[^>\s]+>$/.test(value)) return false;
  if (/^[0-9a-fA-F]{40,}$/.test(value)) return true;
  if (/^[a-z0-9]+(?:[_-][a-z0-9]+)+$/.test(value)) return false;
  return /^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(value);
}

export function looksLikeSecret(value: string): boolean {
  if (PREFIXES.some(re => re.test(value))) return true;
  const assigned = /(?:token|secret|key|password)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/gi;
  for (const match of value.matchAll(assigned)) {
    let token = match[1] ?? '';
    if (token.startsWith('"') || token.startsWith("'")) token = token.slice(1, -1);
    if (tokenIsSecret(token)) return true;
  }
  return false;
}

function rejectSecrets(title: string, body: string): void {
  if (looksLikeSecret(title) || looksLikeSecret(body)) throw new Fault('INVALID_INPUT', 'Title or body looks like a secret');
}

function row<T>(out: { results: T[] }[], index: number, message: string): T {
  const found = out[index]?.results[0];
  if (!found) throw new Fault('INVALID_INPUT', message);
  return found;
}

/** Insert one pending item. Tier 3 is a skill, and this path never approves it. */
export async function proposeItem(db: Database, actor: string, input: ProposeItemInput): Promise<MemoryItem> {
  const proposedBy = ident(actor, 'actor');
  const id = input.id === undefined ? crypto.randomUUID() : ident(input.id, 'id');
  const room = ident(input.room_id, 'room_id');
  const source = ident(input.source_message_id, 'source_message_id');
  if (typeof input.kind !== 'string' || !isKind(input.kind)) throw new Fault('INVALID_INPUT', 'kind must be decision, fact, or skill');
  if (!Number.isInteger(input.tier) || input.tier < 0 || input.tier > 3) throw new Fault('INVALID_INPUT', 'tier must be an integer from 0 to 3');
  // L3 is a skill. The proposer may only leave it pending; approval belongs to a different reviewer.
  if (input.tier === 3 && input.kind !== 'skill') throw new Fault('INVALID_INPUT', 'Tier 3 is only valid for a skill, and a skill proposal stays pending');
  const title = text(input.title, 'title', TITLE_MAX);
  if (typeof input.body !== 'string' || !input.body.isWellFormed() || input.body.includes('\0')) throw new Fault('INVALID_INPUT', 'body is invalid');
  if ([...input.body].length < 1) throw new Fault('INVALID_INPUT', 'body is empty');
  if (utf8.encode(input.body).length > BODY_MAX) throw new Fault('INVALID_INPUT', 'body exceeds 8 KiB');
  rejectSecrets(title, input.body);
  const validFrom = timestamp(input.valid_from, 'valid_from');
  const validUntil = input.valid_until == null || input.valid_until === '' ? null : timestamp(input.valid_until, 'valid_until');
  if (validUntil !== null && validUntil <= validFrom) throw new Fault('INVALID_INPUT', 'valid_until must be after valid_from');
  const createdAt = new Date().toISOString();
  // One batch: the insert is conditional on the room, the source message in that room, and the actor.
  const out = await db.batch<MemoryItem>([
    // rev2: source_version pins the revision of the evidence message seen at proposal time.
    db.prepare(`INSERT INTO memory_items(id, room_id, kind, tier, title, body, source_message_id, source_version, proposed_by, review_state, valid_from, valid_until, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, (SELECT max(h.version) FROM message_history h WHERE h.message_id=?), ?, 'pending', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM rooms WHERE id=?)
        AND EXISTS (SELECT 1 FROM messages WHERE id=? AND room_id=?)
        AND EXISTS (SELECT 1 FROM principals WHERE id=?)`)
      .bind(id, room, input.kind, input.tier, title, input.body, source, source, proposedBy, validFrom, validUntil, createdAt, room, source, room, proposedBy),
    db.prepare(`SELECT ${ITEM_COLUMNS} FROM memory_items WHERE id=?`).bind(id),
  ]);
  return row(out, 1, 'Item was not stored. Check the room, source message, and actor.');
}

/**
 * Propose old superseded-by new. The edge is pending and this writes no valid_until.
 * Pending edges count toward cycle detection; a new cycle is refused.
 */
export async function proposeSupersede(db: Database, actor: string, oldId: string, newId: string): Promise<MemoryEdge> {
  const proposedBy = ident(actor, 'actor');
  const src = ident(oldId, 'oldId');
  const dst = ident(newId, 'newId');
  if (src === dst) throw new Fault('INVALID_INPUT', 'A memory item cannot supersede itself');
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const out = await db.batch<MemoryEdge>([
    db.prepare(`INSERT INTO memory_edges(id, src_id, dst_id, type, proposed_by, review_state, created_at)
      SELECT ?, o.id, n.id, 'SUPERSEDED_BY', ?, 'pending', ?
      FROM memory_items o
      JOIN memory_items n ON n.id=? AND n.room_id=o.room_id AND n.id<>o.id AND n.valid_from>o.valid_from
      WHERE o.id=?
        AND EXISTS (SELECT 1 FROM principals WHERE id=?)
        AND NOT EXISTS (
          WITH RECURSIVE walk(id) AS (
            SELECT e.dst_id FROM memory_edges e
            WHERE e.src_id=? AND e.type='SUPERSEDED_BY' AND e.review_state IN ('pending', 'approved')
            UNION
            SELECT e.dst_id FROM memory_edges e
            JOIN walk w ON e.src_id=w.id
            WHERE e.type='SUPERSEDED_BY' AND e.review_state IN ('pending', 'approved')
          )
          SELECT 1 FROM walk WHERE id=?
        )`)
      .bind(id, proposedBy, createdAt, dst, src, proposedBy, dst, src),
    db.prepare('SELECT id, src_id, dst_id, type, proposed_by, review_state, created_at FROM memory_edges WHERE id=?').bind(id),
  ]);
  return row(out, 1, 'Supersede was not stored. The items must exist in one room, the new item must start after the old one, and they must not form a cycle.');
}

/** Approved items with valid_from <= at and (valid_until IS NULL or valid_until > at). Pending only when asked. */
export async function validView(db: Database, room: string, opts: ViewOptions = {}): Promise<MemoryItem[]> {
  const roomId = ident(room, 'room');
  const at = opts.at === undefined ? new Date().toISOString() : timestamp(opts.at, 'at');
  if (opts.topByTier !== undefined && (!Number.isInteger(opts.topByTier) || opts.topByTier < 1 || opts.topByTier > 1000)) throw new Fault('INVALID_INPUT', 'topByTier must be an integer from 1 to 1000');
  const states: ReviewState[] = opts.includePending ? ['approved', 'pending'] : ['approved'];
  if (opts.newest !== undefined && (!Number.isInteger(opts.newest) || opts.newest < 1 || opts.newest > 1000)) throw new Fault('INVALID_INPUT', 'newest must be an integer from 1 to 1000');
  if (opts.newest !== undefined && opts.topByTier !== undefined) throw new Fault('INVALID_INPUT', 'newest and topByTier are exclusive');
  const args: Value[] = [roomId, ...states, at, at];
  let kindSql = '';
  if (opts.kinds) {
    if (opts.kinds.length === 0) return [];
    for (const kind of opts.kinds) {
      if (typeof kind !== 'string' || !isKind(kind)) throw new Fault('INVALID_INPUT', 'kind must be decision, fact, or skill');
    }
    kindSql = ` AND kind IN (${opts.kinds.map(() => '?').join(',')})`;
    args.push(...opts.kinds);
  }
  const listed = await db.prepare(`SELECT ${ITEM_COLUMNS} FROM memory_items
    WHERE room_id=? AND review_state IN (${states.map(() => '?').join(',')})
      AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)
      ${kindSql}
    ${opts.topByTier !== undefined ? 'ORDER BY tier DESC, valid_from DESC, created_at DESC, id DESC LIMIT ?' : opts.newest !== undefined ? 'ORDER BY valid_from DESC, created_at DESC, id DESC LIMIT ?' : 'ORDER BY valid_from, created_at, id'}`).bind(...args, ...(opts.topByTier !== undefined ? [opts.topByTier] : opts.newest !== undefined ? [opts.newest] : [])).all<MemoryItem>();
  return listed.results;
}

export interface PromoteInput {
  id?: string;
  from_id: string;
  title: string;
  body: string;
}

export interface Promotion {
  item: MemoryItem;
  edge: MemoryEdge;
}

/**
 * OCG-W W7: propose a one-step tier promotion of an approved item (TencentDB-style S0->S3, OCG §2.5 promoted_from).
 * Writes a NEW pending item one tier up plus a pending PROMOTED_FROM edge (new -> source) in one batch.
 * P3 guard: the new item copies kind, room, valid_from, valid_until and source_message_id from the source,
 * and the source item is never closed or replaced. Tier 3 is only reachable by a skill.
 * Migration 0016 enforces the same shape in a trigger, so a direct insert cannot skip it.
 */
export async function proposePromotion(db: Database, actor: string, input: PromoteInput): Promise<Promotion> {
  const proposedBy = ident(actor, 'actor');
  const fromId = ident(input.from_id, 'from_id');
  const id = input.id === undefined ? crypto.randomUUID() : ident(input.id, 'id');
  if (id === fromId) throw new Fault('INVALID_INPUT', 'A memory item cannot promote itself');
  const title = text(input.title, 'title', TITLE_MAX);
  if (typeof input.body !== 'string' || !input.body.isWellFormed() || input.body.includes('\0')) throw new Fault('INVALID_INPUT', 'body is invalid');
  if ([...input.body].length < 1) throw new Fault('INVALID_INPUT', 'body is empty');
  if (utf8.encode(input.body).length > BODY_MAX) throw new Fault('INVALID_INPUT', 'body exceeds 8 KiB');
  rejectSecrets(title, input.body);
  const source = await db.prepare(`SELECT ${ITEM_COLUMNS} FROM memory_items WHERE id=?`).bind(fromId).first<MemoryItem>();
  if (!source) throw new Fault('INVALID_INPUT', 'Unknown source item');
  if (source.review_state !== 'approved') throw new Fault('INVALID_INPUT', 'Only an approved item can be promoted');
  if (source.tier >= 3) throw new Fault('INVALID_INPUT', 'Tier 3 is the top tier');
  if (source.tier + 1 === 3 && source.kind !== 'skill') throw new Fault('INVALID_INPUT', 'Only a skill can be promoted to tier 3');
  const edgeId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  try {
    const out = await db.batch<MemoryItem | MemoryEdge>([
      db.prepare(`INSERT INTO memory_items(id, room_id, kind, tier, title, body, source_message_id, source_version, version_basis, proposed_by, review_state, valid_from, valid_until, created_at)
        SELECT ?, o.room_id, o.kind, o.tier + 1, ?, ?, o.source_message_id, o.source_version, o.version_basis, ?, 'pending', o.valid_from, o.valid_until, ?
        FROM memory_items o
        WHERE o.id=? AND o.review_state='approved' AND o.tier < 3
          AND EXISTS (SELECT 1 FROM principals WHERE id=?)`)
        .bind(id, title, input.body, proposedBy, createdAt, fromId, proposedBy),
      db.prepare(`INSERT INTO memory_edges(id, src_id, dst_id, type, proposed_by, review_state, created_at)
        SELECT ?, ?, ?, 'PROMOTED_FROM', ?, 'pending', ? WHERE EXISTS (SELECT 1 FROM memory_items WHERE id=?)`)
        .bind(edgeId, id, fromId, proposedBy, createdAt, id),
      db.prepare(`SELECT ${ITEM_COLUMNS} FROM memory_items WHERE id=?`).bind(id),
      db.prepare('SELECT id, src_id, dst_id, type, proposed_by, review_state, created_at FROM memory_edges WHERE id=?').bind(edgeId),
    ]);
    return { item: row(out as { results: MemoryItem[] }[], 2, 'Promotion was not stored.'), edge: row(out as { results: MemoryEdge[] }[], 3, 'Promotion was not stored.') };
  } catch (err) {
    if (err instanceof Fault) throw err;
    const message = err instanceof Error ? err.message : '';
    if (/open promotion/.test(message)) throw new Fault('INVALID_INPUT', 'This item already has an open promotion');
    if (/promotion must be/.test(message)) throw new Fault('INVALID_INPUT', 'Promotion was refused: one tier up from an approved item, same kind, room, validity and source');
    if (/UNIQUE|constraint/i.test(message)) throw new Fault('INVALID_INPUT', 'Promotion was not stored. Check the id.');
    throw err;
  }
}

/** PROMOTED_FROM chain of an item, newest tier first, down to the original source (approved or pending edges). */
export async function promotionChain(db: Database, id: string): Promise<string[]> {
  const start = ident(id, 'id');
  const rows = await db.prepare(`WITH RECURSIVE walk(id, depth) AS (
      SELECT ?, 0
      UNION
      SELECT e.dst_id, w.depth + 1 FROM memory_edges e JOIN walk w ON e.src_id=w.id
      WHERE e.type='PROMOTED_FROM' AND e.review_state IN ('pending','approved') AND w.depth < 4
    ) SELECT id FROM walk ORDER BY depth`).bind(start).all<{ id: string }>();
  return rows.results.map(r => r.id);
}
