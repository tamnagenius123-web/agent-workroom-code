import { Fault } from './contracts.ts';
import type { Database } from './db.ts';
import type { MemoryEdge, MemoryItem, ReviewState } from './memory-items.ts';
import { edgeCanonical, itemCanonical, sha256Hex, type EdgeCanonFields, type ItemCanonFields } from './canonical.ts';

// OCG-W W3: listed reviewer, and the reviewer is not the proposer (ABSORB_DESIGN §0).
// A pending supersede closes nothing. Approving SUPERSEDED_BY sets the old item's
// valid_until to the new item's valid_from when that column is still null, so an
// earlier as-of time still returns the old item (P3). D1 has no sha256(), so the
// conditional insert re-checks every hashed column against the values that were hashed.
// Direct review_state updates are refused by the migration triggers unless that row exists.

const REASON_MAX = 4000;
const REFUSED = 'Review was not stored. The reviewer must be listed, must not be the proposer, the target must be pending, and the digest must match the content.';
const ITEM_COLUMNS = `id, room_id, kind, tier, title, body, source_message_id, source_version, proposed_by, review_state, valid_from, valid_until, created_at`;
const EDGE_COLUMNS = `id, src_id, dst_id, type, proposed_by, review_state, created_at`;
// One fault per target kind for missing, other-room and rejected ids, so callers cannot tell them apart.
export const unknownItem = () => new Fault('INVALID_INPUT', 'Unknown memory item in this room');
export const unknownEdge = () => new Fault('INVALID_INPUT', 'Unknown memory edge in this room');

export type Verdict = 'approve' | 'reject';


export { itemCanonical, edgeCanonical } from './canonical.ts';

/** rev2: sha256 hex of the versioned JSON item preimage (canonical.ts itemCanonical). */
export async function itemContentDigest(item: ItemCanonFields): Promise<string> {
  return sha256Hex(itemCanonical(item));
}

/** rev2: sha256 hex of the versioned JSON edge preimage (canonical.ts edgeCanonical). */
export async function edgeContentDigest(edge: EdgeCanonFields): Promise<string> {
  return sha256Hex(edgeCanonical(edge));
}

export type ReviewPrepared =
  | { target: 'item'; id: string; review_state: ReviewState; content: ItemCanonFields; content_digest: string }
  | { target: 'edge'; id: string; review_state: ReviewState; content: EdgeCanonFields; content_digest: string };

/**
 * UXB-07: the exact hashed fields and the digest workroom_memory_review expects back.
 * Rejected targets read as unknown, the same exposure as memory_view(include_pending=true).
 */
export async function prepareReview(db: Database, target: 'item' | 'edge', id: string): Promise<ReviewPrepared> {
  const targetId = ident(id, 'id');
  if (target === 'item') {
    const r = await db.prepare("SELECT id, room_id, kind, tier, title, body, valid_from, source_message_id, source_version, review_state FROM memory_items WHERE id=? AND review_state<>'rejected'").bind(targetId).first<ItemCanonFields & { review_state: ReviewState }>();
    if (!r) throw unknownItem();
    const { review_state, ...content } = r;
    return { target, id: targetId, review_state, content, content_digest: await itemContentDigest(content) };
  }
  const r = await db.prepare("SELECT id, src_id, dst_id, type, review_state FROM memory_edges WHERE id=? AND review_state<>'rejected'").bind(targetId).first<EdgeCanonFields & { review_state: ReviewState }>();
  if (!r) throw unknownEdge();
  const { review_state, ...content } = r;
  return { target, id: targetId, review_state, content, content_digest: await edgeContentDigest(content) };
}

/** Pending items in this room that this listed reviewer did not propose. Same gate as reviewItem. */
export async function reviewsAwaiting(db: Database, reviewerId: string, roomId: string): Promise<{ id: string }[]> {
  const rows = await db.prepare(
    `SELECT i.id AS id FROM memory_items i
     WHERE i.room_id=? AND i.review_state='pending' AND i.proposed_by<>?
       AND EXISTS (SELECT 1 FROM memory_reviewers r WHERE r.principal_id=?)
     ORDER BY i.created_at, i.id`).bind(roomId, reviewerId, reviewerId).all<{ id: string }>();
  return rows.results;
}

function ident(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !value.isWellFormed() || value.includes('\0')) {
    throw new Fault('INVALID_INPUT', `${field} is invalid`);
  }
  return value;
}

function reasonText(value: unknown): string {
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw new Fault('INVALID_INPUT', 'reason is invalid');
  const chars = [...value].length;
  if (chars < 1 || chars > REASON_MAX) throw new Fault('INVALID_INPUT', `reason must be 1 to ${REASON_MAX} characters`);
  return value;
}

function verdictOf(value: unknown): Verdict {
  if (value !== 'approve' && value !== 'reject') throw new Fault('INVALID_INPUT', 'verdict must be approve or reject');
  return value;
}

function digestOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Fault('INVALID_INPUT', 'content digest must be 64 lowercase hex characters');
  return value;
}

function decided(verdict: Verdict): ReviewState {
  return verdict === 'approve' ? 'approved' : 'rejected';
}

function row<T>(out: { results: T[] }[], index: number): T | undefined {
  return out[index]?.results[0];
}

/** Approve or reject one pending item. The write is a single batch. */
export async function reviewItem(db: Database, reviewer: string, id: string, verdict: Verdict, reason: string, digest: string): Promise<MemoryItem> {
  const reviewerId = ident(reviewer, 'reviewer');
  const itemId = ident(id, 'id');
  const decision = verdictOf(verdict);
  const why = reasonText(reason);
  const claimed = digestOf(digest);
  const current = await db.prepare('SELECT id, room_id, kind, tier, title, body, valid_from, source_message_id, source_version FROM memory_items WHERE id=?').bind(itemId).first<ItemCanonFields>();
  if (!current) throw new Fault('INVALID_INPUT', REFUSED);
  if (await itemContentDigest(current) !== claimed) throw new Fault('INVALID_INPUT', 'Content digest does not match the item.');
  const reviewId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const state = decided(decision);
  const out = await db.batch<MemoryItem>([
    db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      SELECT ?, 'item', i.id, ?, ?, ?, ?, ?
      FROM memory_items i
      WHERE i.id=?
        AND i.review_state='pending'
        AND i.proposed_by<>?
        AND EXISTS (SELECT 1 FROM memory_reviewers r WHERE r.principal_id=?)
        AND i.room_id=? AND i.kind=? AND i.tier=? AND i.title=? AND i.body=? AND i.valid_from=? AND i.source_message_id=? AND i.source_version IS ?`)
      .bind(reviewId, decision, reviewerId, why, claimed, createdAt, itemId, reviewerId, reviewerId, current.room_id, current.kind, current.tier, current.title, current.body, current.valid_from, current.source_message_id, current.source_version),
    db.prepare(`UPDATE memory_items SET review_state=?
      WHERE id=? AND review_state='pending'
        AND EXISTS (
          SELECT 1 FROM memory_reviews rv
          WHERE rv.id=? AND rv.target_kind='item' AND rv.target_id=memory_items.id
            AND rv.verdict=? AND rv.reviewer_id=? AND rv.reviewer_id<>memory_items.proposed_by
            AND rv.content_digest=?
            AND EXISTS (SELECT 1 FROM memory_reviewers r WHERE r.principal_id=rv.reviewer_id)
        )`)
      .bind(state, itemId, reviewId, decision, reviewerId, claimed),
    db.prepare(`SELECT ${ITEM_COLUMNS} FROM memory_items
      WHERE id=? AND review_state=?
        AND EXISTS (SELECT 1 FROM memory_reviews WHERE id=? AND target_kind='item' AND target_id=?)`)
      .bind(itemId, state, reviewId, itemId),
  ]);
  const saved = row(out, 2);
  if (!saved) throw new Fault('INVALID_INPUT', REFUSED);
  return saved;
}

/**
 * Approve or reject one pending edge. Approving SUPERSEDED_BY also closes the old
 * item at the new item's valid_from when valid_until is still null, in this same batch.
 */
export async function reviewEdge(db: Database, reviewer: string, id: string, verdict: Verdict, reason: string, digest: string): Promise<MemoryEdge> {
  const reviewerId = ident(reviewer, 'reviewer');
  const edgeId = ident(id, 'id');
  const decision = verdictOf(verdict);
  const why = reasonText(reason);
  const claimed = digestOf(digest);
  const current = await db.prepare('SELECT id, src_id, dst_id, type FROM memory_edges WHERE id=?').bind(edgeId).first<EdgeCanonFields>();
  if (!current) throw new Fault('INVALID_INPUT', REFUSED);
  if (await edgeContentDigest(current) !== claimed) throw new Fault('INVALID_INPUT', 'Content digest does not match the edge.');
  const reviewId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const state = decided(decision);
  const out = await db.batch<MemoryEdge>([
    db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      SELECT ?, 'edge', e.id, ?, ?, ?, ?, ?
      FROM memory_edges e
      WHERE e.id=?
        AND e.review_state='pending'
        AND e.proposed_by<>?
        AND EXISTS (SELECT 1 FROM memory_reviewers r WHERE r.principal_id=?)
        AND e.src_id=? AND e.dst_id=? AND e.type=?`)
      .bind(reviewId, decision, reviewerId, why, claimed, createdAt, edgeId, reviewerId, reviewerId, current.src_id, current.dst_id, current.type),
    db.prepare(`UPDATE memory_edges SET review_state=?
      WHERE id=? AND review_state='pending'
        AND EXISTS (
          SELECT 1 FROM memory_reviews rv
          WHERE rv.id=? AND rv.target_kind='edge' AND rv.target_id=memory_edges.id
            AND rv.verdict=? AND rv.reviewer_id=? AND rv.reviewer_id<>memory_edges.proposed_by
            AND rv.content_digest=?
            AND EXISTS (SELECT 1 FROM memory_reviewers r WHERE r.principal_id=rv.reviewer_id)
        )`)
      .bind(state, edgeId, reviewId, decision, reviewerId, claimed),
    db.prepare(`UPDATE memory_items SET valid_until=(
        SELECT n.valid_from FROM memory_edges e
        JOIN memory_items n ON n.id=e.dst_id
        WHERE e.id=? AND e.type='SUPERSEDED_BY' AND e.review_state='approved'
      )
      WHERE valid_until IS NULL
        AND id=(SELECT e.src_id FROM memory_edges e WHERE e.id=? AND e.type='SUPERSEDED_BY' AND e.review_state='approved')
        AND EXISTS (
          SELECT 1 FROM memory_reviews rv
          WHERE rv.id=? AND rv.target_kind='edge' AND rv.target_id=? AND rv.verdict='approve'
        )`)
      .bind(edgeId, edgeId, reviewId, edgeId),
    db.prepare(`SELECT ${EDGE_COLUMNS} FROM memory_edges
      WHERE id=? AND review_state=?
        AND EXISTS (SELECT 1 FROM memory_reviews WHERE id=? AND target_kind='edge' AND target_id=?)`)
      .bind(edgeId, state, reviewId, edgeId),
  ]);
  const saved = row(out, 3);
  if (!saved) throw new Fault('INVALID_INPUT', REFUSED);
  return saved;
}
