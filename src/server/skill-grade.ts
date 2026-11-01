import { Fault } from './contracts.ts';
import type { Database } from './db.ts';
import { itemContentDigest } from './memory-review.ts';
import { legacyItemCanonical, sha256Hex, type ItemCanonFields } from './canonical.ts';

// OCG-W W5: a skill letter is computed when read from memory_reviews.
// A row counts when the reviewer is on memory_reviewers, the reviewer is not
// the item's proposed_by, and content_digest equals the server hash of the
// stored title, body, and valid_from. The latest row per reviewer is
// (created_at, id) descending. One, two, and three or more distinct approvals
// are F, C, and A. A pending skill, a rejected skill, a superseded skill
// (approved SUPERSEDED_BY edge), an open rejection, or zero counted approvals
// returns a null letter and a reason. S, B, and D are not produced.
//
// reviewItem records the first outcome and moves review_state off pending.
// endorseSkill records a later approval on an already approved skill. The W3
// triggers allow that insert: they refuse review updates and deletes, and they
// refuse a review_state change that lacks an independent listed reviewer.
// They do not fire on INSERT into memory_reviews. One row per reviewer is the
// INSERT predicate (NOT EXISTS), so this slice adds no table and no migration.
// The read path counts distinct reviewers, so a duplicate row cannot raise the letter.

const REASON_MAX = 4000;
const REFUSED = 'Endorsement was not stored. The reviewer must be listed, must not be the proposer, the skill must already be approved, the digest must match, and this reviewer must not already have an outcome.';

export interface SkillGrade {
  letter: 'F' | 'C' | 'A' | null;
  distinct_pass_reviewers: number;
  rejects: number;
  basis: string[];
  reason: string | null;
  /** rev2c (Codex ec45569a): listed review ids whose digest matches no recoverable preimage of this immutable item
   * (an original 0018 normalized valid_from before 0019 could keep it). While non-empty the grade is withheld. */
  unresolved_provenance: string[];
}

export interface SkillEndorsement {
  id: string;
  target_id: string;
  reviewer_id: string;
  verdict: 'approve';
  reason: string;
  content_digest: string;
  created_at: string;
}

interface GradeItem extends ItemCanonFields {
  /** Pre-rev2 valid_from text (0019), else valid_from. Only the v1 digest uses it. */
  legacy_valid_from: string;
  proposed_by: string;
  review_state: string;
  superseded: number;
}

interface ReviewRow {
  id: string;
  reviewer_id: string;
  verdict: string;
  created_at: string;
}

interface StoredReview {
  id: string;
  target_id: string;
  reviewer_id: string;
  verdict: string;
  reason: string;
  content_digest: string;
  created_at: string;
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

function digestOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new Fault('INVALID_INPUT', 'content digest must be 64 lowercase hex characters');
  return value;
}

function none(reason: string): SkillGrade {
  return { letter: null, distinct_pass_reviewers: 0, rejects: 0, basis: [], reason, unresolved_provenance: [] };
}

function later(row: ReviewRow, prev: ReviewRow): boolean {
  if (row.created_at !== prev.created_at) return row.created_at > prev.created_at;
  return row.id > prev.id;
}

function letterFromPasses(passes: number): 'F' | 'C' | 'A' | null {
  if (passes >= 3) return 'A';
  if (passes === 2) return 'C';
  if (passes === 1) return 'F';
  return null;
}

/**
 * Instant-equivalent spellings a pre-rev2 caller could have stored for a canonical UTC valid_from
 * (pre-rev2 ISO: seconds, optional 1-9 fraction digits, Z or +-HH:MM). Used only to re-match legacy v1 review
 * digests after an original 0018 normalized valid_from away. A SHA-256 match proves the reviewer hashed exactly
 * this title and body and a valid_from naming the same instant, so a recovered review is sound evidence.
 */
export function legacyValidFromCandidates(canonical: string): string[] {
  const ms = Date.parse(canonical);
  if (!Number.isFinite(ms)) return [];
  const out = new Set<string>();
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  for (let q = -48; q <= 56; q++) {
    const off = q * 15;
    const local = new Date(ms + off * 60000);
    const base = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
    const m = local.getUTCMilliseconds();
    const m3 = pad(m, 3);
    const fracs = new Set<string>(['.' + m3, '.' + m3 + '000', '.' + m3 + '000000']);
    if (m === 0) fracs.add('');
    for (let k = 1; k <= 3; k++) if (m3.slice(k).split('').every(c => c === '0')) fracs.add('.' + m3.slice(0, k));
    const zones = off === 0 ? ['Z', '+00:00', '-00:00'] : [`${off < 0 ? '-' : '+'}${pad(Math.trunc(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`];
    for (const f of fracs) for (const z of zones) out.add(base + f + z);
  }
  return [...out];
}

interface ListedReview extends ReviewRow { content_digest: string }

/** Latest qualifying outcome per reviewer. Reads memory_reviews; writes nothing. */
// rev2: reviews stored before 0018 carry the legacy title\nbody\nvalid_from digest of the same immutable content; they still count (lineage: W5 at 01f1a43).
// rev2c: a listed review whose digest matches neither the v2 nor the stored v1 preimage is re-matched against instant-equivalent
// valid_from spellings; any still unmatched is quarantined (returned in unresolved_provenance, never counted). The API checks the
// digest on every write and item content is immutable, so an unmatched listed row is either a v1 review whose preimage an original
// 0018 erased or a row written outside the API. Fail-safe both ways: an unresolved approve never adds a pass; an unresolved
// reject withholds the letter, because it may be a legacy rejection that would otherwise silently stop blocking.
async function countedReviews(db: Database, item: GradeItem, digests: readonly [string, string]): Promise<{ counted: ReviewRow[]; unresolved: string[]; unresolvedRejects: string[] }> {
  const listed = await db.prepare(`SELECT rv.id, rv.reviewer_id, rv.verdict, rv.created_at, rv.content_digest
    FROM memory_reviews rv
    JOIN memory_items i ON i.id=rv.target_id
    WHERE rv.target_kind='item'
      AND rv.target_id=?
      AND rv.reviewer_id<>i.proposed_by
      AND rv.verdict IN ('approve', 'reject')
      AND EXISTS (SELECT 1 FROM memory_reviewers rr WHERE rr.principal_id=rv.reviewer_id)`)
    .bind(item.id).all<ListedReview>();
  const known = new Set<string>(digests);
  const strays = listed.results.filter(row => !known.has(row.content_digest));
  if (strays.length > 0) {
    for (const vf of legacyValidFromCandidates(item.valid_from)) known.add(await sha256Hex(legacyItemCanonical(item.title, item.body, vf)));
  }
  const stray = listed.results.filter(row => !known.has(row.content_digest));
  const unresolved = stray.map(row => row.id).sort();
  const unresolvedRejects = stray.filter(row => row.verdict === 'reject').map(row => row.id).sort();
  const byReviewer = new Map<string, ReviewRow>();
  for (const row of listed.results) {
    if (!known.has(row.content_digest)) continue;
    const prev = byReviewer.get(row.reviewer_id);
    if (!prev || later(row, prev)) byReviewer.set(row.reviewer_id, { id: row.id, reviewer_id: row.reviewer_id, verdict: row.verdict, created_at: row.created_at });
  }
  const counted = [...byReviewer.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
  return { counted, unresolved, unresolvedRejects };
}

function assemble(counted: readonly ReviewRow[], letter: SkillGrade['letter'], reason: string | null, unresolved: readonly string[] = []): SkillGrade {
  let passes = 0;
  let rejects = 0;
  const basis: string[] = [];
  for (const row of counted) {
    if (row.verdict === 'approve') passes += 1;
    else if (row.verdict === 'reject') rejects += 1;
    else continue;
    basis.push(row.id);
  }
  return { letter, distinct_pass_reviewers: passes, rejects, basis, reason, unresolved_provenance: [...unresolved] };
}

/**
 * Letter for one skill item. Counts recorded review rows only.
 * Pending, rejected, and superseded skills return a null letter with a reason.
 * The counts still list the qualifying rows so the null is explainable.
 */
export async function skillGrade(db: Database, skillItemId: string): Promise<SkillGrade> {
  const itemId = ident(skillItemId, 'skillItemId');
  const item = await db.prepare(`SELECT i.id, i.room_id, i.kind, i.tier, i.title, i.body, i.valid_from, i.source_message_id, i.source_version, i.proposed_by, i.review_state, COALESCE(i.legacy_valid_from, i.valid_from) AS legacy_valid_from,
      CASE WHEN EXISTS (
        SELECT 1 FROM memory_edges e
        WHERE e.src_id=i.id AND e.type='SUPERSEDED_BY' AND e.review_state='approved'
      ) THEN 1 ELSE 0 END AS superseded
    FROM memory_items i WHERE i.id=?`).bind(itemId).first<GradeItem>();
  if (!item) return none('No such memory item.');
  if (item.kind !== 'skill') return none('Only a skill is graded.');
  const digests: [string, string] = [await itemContentDigest(item), await sha256Hex(legacyItemCanonical(item.title, item.body, item.legacy_valid_from))];
  const { counted, unresolved, unresolvedRejects } = await countedReviews(db, item, digests);
  if (item.review_state === 'pending') return assemble(counted, null, 'A pending skill has no grade.', unresolved);
  if (item.review_state === 'rejected') return assemble(counted, null, 'A rejected skill has no grade.', unresolved);
  if (Number(item.superseded) === 1) return assemble(counted, null, 'A superseded skill has no grade.', unresolved);
  if (unresolvedRejects.length > 0) return assemble(counted, null, `Grade withheld: ${unresolvedRejects.length} listed rejection(s) have unresolved provenance (pre-rev2 preimage lost or written outside the API): ${unresolvedRejects.join(', ')}`, unresolved);
  const rejects = counted.filter(row => row.verdict === 'reject');
  if (rejects.length > 0) {
    const who = rejects.map(row => row.reviewer_id).sort();
    return assemble(counted, null, `An open rejection blocks the grade: ${who.join(', ')}`, unresolved);
  }
  const letter = letterFromPasses(counted.length);
  if (letter === null) return assemble(counted, null, 'Needs one independent approval on this content hash.', unresolved);
  return assemble(counted, letter, null, unresolved);
}

/**
 * Record one additional approve on an already approved skill.
 * One conditional batch. Does not change review_state. The first approval
 * remains reviewItem. A second call from the same reviewer inserts nothing.
 */
export async function endorseSkill(db: Database, reviewer: string, id: string, reason: string, digest: string): Promise<SkillEndorsement> {
  const reviewerId = ident(reviewer, 'reviewer');
  const itemId = ident(id, 'id');
  const why = reasonText(reason);
  const claimed = digestOf(digest);
  const current = await db.prepare('SELECT id, room_id, kind, tier, title, body, valid_from, source_message_id, source_version FROM memory_items WHERE id=?').bind(itemId).first<ItemCanonFields>();
  if (!current) throw new Fault('INVALID_INPUT', REFUSED);
  if (await itemContentDigest(current) !== claimed) {
    throw new Fault('INVALID_INPUT', 'Content digest does not match the item.');
  }
  const reviewId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const out = await db.batch<StoredReview>([
    db.prepare(`INSERT INTO memory_reviews(id, target_kind, target_id, verdict, reviewer_id, reason, content_digest, created_at)
      SELECT ?, 'item', i.id, 'approve', ?, ?, ?, ?
      FROM memory_items i
      WHERE i.id=?
        AND i.kind='skill'
        AND i.review_state='approved'
        AND i.proposed_by<>?
        AND EXISTS (SELECT 1 FROM memory_reviewers r WHERE r.principal_id=?)
        AND NOT EXISTS (
          SELECT 1 FROM memory_reviews prev
          WHERE prev.target_kind='item' AND prev.target_id=i.id AND prev.reviewer_id=?
        )
        AND i.room_id=? AND i.tier=? AND i.title=? AND i.body=? AND i.valid_from=? AND i.source_message_id=? AND i.source_version IS ?`)
      .bind(reviewId, reviewerId, why, claimed, createdAt, itemId, reviewerId, reviewerId, reviewerId, current.room_id, current.tier, current.title, current.body, current.valid_from, current.source_message_id, current.source_version),
    db.prepare(`SELECT id, target_id, reviewer_id, verdict, reason, content_digest, created_at
      FROM memory_reviews WHERE id=?`).bind(reviewId),
  ]);
  const saved = out[1]?.results[0];
  if (!saved || saved.verdict !== 'approve' || saved.reviewer_id !== reviewerId || saved.target_id !== itemId || saved.content_digest !== claimed) {
    throw new Fault('INVALID_INPUT', REFUSED);
  }
  return {
    id: saved.id,
    target_id: saved.target_id,
    reviewer_id: saved.reviewer_id,
    verdict: 'approve',
    reason: saved.reason,
    content_digest: saved.content_digest,
    created_at: saved.created_at,
  };
}
