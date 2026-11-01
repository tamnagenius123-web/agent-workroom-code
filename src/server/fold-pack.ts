import { instant } from './canonical.ts';
import { Fault } from './contracts.ts';
import type { Database } from './db.ts';
import { searchMessages, type Hit } from './memory.ts';
import { validView, type MemoryItem } from './memory-items.ts';
import type { PackEntry } from './context-pack.ts';

// Fold-aware context pack and pending-fold queue count.
// context-pack.ts and room-brief.ts stay untouched. The integrator calls
// foldedContextPack in place of contextPack, and copies pending_folds onto
// review_queue. Ranking of decisions, skills, facts, and message hits matches
// contextPack. Folds fill after items and before unfolded messages.

const BUDGET_MIN = 500;
const BUDGET_MAX = 20000;
const EXCERPT_CHARS = 280;
const MESSAGE_LIMIT = 200;
const TASK_TERMS = 12;

export interface FoldPackEntry {
  fold_id: string;
  snippet: string;
  valid_from: string;
  span_from: string;
  span_to: string;
  /** Descendant message ids in source_seq order. Not limited by the depth-4 view walk. */
  source_message_ids: string[];
  /** Hashes aligned with source_message_ids. */
  source_hashes: string[];
  /** Pinned versions aligned with source_message_ids. */
  source_versions: number[];
  /** Sources whose current version is newer than the pin. Their raw messages stay in the pack (HOLD P2, d1def20). */
  stale_message_ids: string[];
  source_message_id: string;
  source_version_basis: 'pinned';
}

/** Key order is part of the budget: decisions, skills, facts, folds, messages. */
export interface FoldContextSections {
  decisions: PackEntry[];
  skills: PackEntry[];
  facts: PackEntry[];
  folds: FoldPackEntry[];
  messages: PackEntry[];
}

export interface FoldContextPack {
  sections: FoldContextSections;
  used_chars: number;
  truncated: boolean;
  /** Message ids from decisions, skills, facts, and unfolded messages. Fold ids stay in fold_ids. */
  lineage: string[];
  fold_ids: string[];
}

export interface FoldReviewQueue {
  /** Pending memory_folds in the room, plus pending fold_edges whose source fold is in the room. */
  pending_folds: number;
}

type SectionName = 'decisions' | 'skills' | 'facts';

interface Placed {
  section: SectionName;
  entry: PackEntry;
}

interface FoldRow {
  id: string;
  summary: string;
  first_message_id: string;
  span_from: string;
  span_to: string;
  valid_from: string;
}

interface PinRow {
  root: string;
  message_id: string;
  source_hash: string;
  source_version: number;
  current_version: number;
  source_seq: number;
}

function termsOf(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length > 0);
}

function taskTerms(task: string): string[] {
  const window = termsOf(task).slice(0, TASK_TERMS);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const term of window) {
    if (seen.has(term)) continue;
    seen.add(term);
    unique.push(term);
  }
  return unique;
}

function overlapScore(terms: readonly string[], text: string): number {
  const present = new Set(termsOf(text));
  let score = 0;
  for (const term of terms) if (present.has(term)) score += 1;
  return score;
}

function timeValue(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareRecency(a: MemoryItem, b: MemoryItem): number {
  const byValid = timeValue(b.valid_from) - timeValue(a.valid_from);
  if (byValid !== 0) return byValid;
  const byCreated = timeValue(b.created_at) - timeValue(a.created_at);
  if (byCreated !== 0) return byCreated;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

function byOverlapThenRecency(terms: readonly string[]): (a: MemoryItem, b: MemoryItem) => number {
  return (a, b) => {
    const score = overlapScore(terms, `${b.title}\n${b.body}`) - overlapScore(terms, `${a.title}\n${a.body}`);
    if (score !== 0) return score;
    return compareRecency(a, b);
  };
}

function byTierThenOverlap(terms: readonly string[]): (a: MemoryItem, b: MemoryItem) => number {
  const byOverlap = byOverlapThenRecency(terms);
  return (a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    return byOverlap(a, b);
  };
}

function rankOf(hit: Hit): number {
  const rank = Number(hit.rank);
  return Number.isFinite(rank) ? rank : 0;
}

function compareHits(a: Hit, b: Hit): number {
  const byRank = rankOf(a) - rankOf(b);
  if (byRank !== 0) return byRank;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.message_id !== b.message_id) return a.message_id < b.message_id ? -1 : 1;
  return 0;
}

function atOrBefore(createdAt: string, atTime: string): boolean {
  const created = timeValue(createdAt);
  const at = timeValue(atTime);
  if (created !== Number.NEGATIVE_INFINITY && at !== Number.NEGATIVE_INFINITY) return created <= at;
  return createdAt <= atTime;
}

function clip(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= EXCERPT_CHARS) return text;
  return chars.slice(0, EXCERPT_CHARS).join('');
}

function compareFolds(terms: readonly string[]): (a: FoldRow, b: FoldRow) => number {
  return (a, b) => {
    const score = overlapScore(terms, b.summary) - overlapScore(terms, a.summary);
    if (score !== 0) return score;
    if (a.span_to !== b.span_to) return a.span_to < b.span_to ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  };
}

interface SourceTexts {
  byVersion: Map<string, string>;
  current: Map<string, number>;
}

function pinned(texts: SourceTexts, id: string, version: number | null): Pick<PackEntry, 'source_version' | 'source_current_version' | 'source_excerpt'> {
  const current = texts.current.get(id) ?? 1;
  const at = version ?? current;
  return { source_version: at, source_current_version: current, source_excerpt: clip(texts.byVersion.get(`${at}\u0000${id}`) ?? '') };
}

function itemEntry(item: MemoryItem, texts: SourceTexts): PackEntry {
  return {
    id: item.id,
    title: item.title,
    snippet: item.body,
    valid_from: item.valid_from,
    source_message_id: item.source_message_id,
    ...pinned(texts, item.source_message_id, item.source_version),
    source_version_basis: item.version_basis === 'pinned' ? 'pinned' : 'inferred',
  };
}

function messageEntry(hit: Hit, texts: SourceTexts): PackEntry {
  return {
    id: hit.message_id,
    snippet: hit.snippet,
    valid_from: hit.created_at,
    source_message_id: hit.message_id,
    ...pinned(texts, hit.message_id, null),
    source_version_basis: 'current',
  };
}

async function sourceTexts(db: Database, room: string, ids: readonly string[]): Promise<SourceTexts> {
  const unique = [...new Set(ids)];
  const texts: SourceTexts = { byVersion: new Map(), current: new Map() };
  const width = 80;
  for (let offset = 0; offset < unique.length; offset += width) {
    const chunk = unique.slice(offset, offset + width);
    const marks = chunk.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT message_id AS id, version, text FROM message_history WHERE room_id=? AND message_id IN (${marks})`)
      .bind(room, ...chunk).all<{ id: string; version: number; text: string }>();
    for (const row of rows.results) {
      const version = Number(row.version);
      texts.byVersion.set(`${version}\u0000${row.id}`, row.text);
      if (version > (texts.current.get(row.id) ?? 0)) texts.current.set(row.id, version);
    }
  }
  return texts;
}

interface FoldPins {
  folds: FoldRow[];
  byFold: Map<string, Pins>;
}

/** Approved folds valid at `at`, with every descendant message pin. Pending folds are absent and do not cover. */
async function loadFolds(db: Database, room: string, atTime: string): Promise<FoldPins> {
  const listed = await db.prepare(`SELECT id, summary, first_message_id, span_from, span_to, valid_from FROM memory_folds
    WHERE room_id=? AND review_state='approved' AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)`)
    .bind(room, atTime, atTime).all<FoldRow>();
  const pins = await db.prepare(`WITH RECURSIVE walk(root, id) AS (
      SELECT id, id FROM memory_folds
      WHERE room_id=? AND review_state='approved' AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)
      UNION
      SELECT w.root, e.dst_id FROM fold_edges e JOIN walk w ON e.src_id=w.id
      WHERE e.type='FOLDED_FROM' AND e.review_state='approved'
    )
    SELECT w.root AS root, s.message_id AS message_id, s.source_hash AS source_hash, s.source_seq AS source_seq,
      s.source_version AS source_version,
      (SELECT max(h.version) FROM message_history h WHERE h.message_id=s.message_id) AS current_version
    FROM walk w JOIN fold_sources s ON s.fold_id=w.id
    ORDER BY w.root, s.source_seq, s.message_id`).bind(room, atTime, atTime).all<PinRow>();
  const byFold = new Map<string, Pins>();
  for (const fold of listed.results) byFold.set(fold.id, emptyPins());
  const seen = new Map<string, Set<string>>();
  for (const row of pins.results) {
    const bucket = byFold.get(row.root) ?? emptyPins();
    byFold.set(row.root, bucket);
    const have = seen.get(row.root) ?? new Set<string>();
    seen.set(row.root, have);
    if (have.has(row.message_id)) continue;
    have.add(row.message_id);
    bucket.ids.push(row.message_id);
    bucket.hashes.push(row.source_hash);
    bucket.versions.push(Number(row.source_version));
    if (Number(row.current_version) === Number(row.source_version)) bucket.fresh.push(row.message_id);
    else bucket.stale.push(row.message_id);
  }
  return { folds: listed.results, byFold };
}

interface Pins { ids: string[]; hashes: string[]; versions: number[]; fresh: string[]; stale: string[] }
function emptyPins(): Pins { return { ids: [], hashes: [], versions: [], fresh: [], stale: [] }; }

function foldEntry(fold: FoldRow, pins: Pins): FoldPackEntry {
  return {
    fold_id: fold.id,
    snippet: clip(fold.summary),
    valid_from: fold.valid_from,
    span_from: fold.span_from,
    span_to: fold.span_to,
    source_message_ids: pins.ids,
    source_hashes: pins.hashes,
    source_versions: pins.versions,
    stale_message_ids: pins.stale,
    source_message_id: fold.first_message_id,
    source_version_basis: 'pinned',
  };
}

function assemble(items: readonly Placed[], itemCount: number, folds: readonly FoldPackEntry[], foldCount: number, messages: readonly PackEntry[]): FoldContextSections {
  const chosen = items.slice(0, itemCount);
  return {
    decisions: chosen.filter(item => item.section === 'decisions').map(item => item.entry),
    skills: chosen.filter(item => item.section === 'skills').map(item => item.entry),
    facts: chosen.filter(item => item.section === 'facts').map(item => item.entry),
    folds: folds.slice(0, foldCount),
    messages: [...messages],
  };
}

function used(sections: FoldContextSections): number {
  return JSON.stringify(sections).length;
}

function prefixCount(count: number, fits: (take: number) => boolean): number {
  let kept = 0;
  for (let take = 1; take <= count; take += 1) {
    if (!fits(take)) break;
    kept = take;
  }
  return kept;
}

function lineageOf(sections: FoldContextSections): string[] {
  const ordered = [...sections.decisions, ...sections.skills, ...sections.facts, ...sections.messages];
  const seen = new Set<string>();
  const lineage: string[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.source_message_id)) continue;
    seen.add(entry.source_message_id);
    lineage.push(entry.source_message_id);
  }
  return lineage;
}

/**
 * Approved items, then approved folds valid at `at`, then unfolded message hits.
 * A message is omitted only when an emitted approved fold pins its current
 * version. A fold dropped for budget, or a stale pin, never hides raw evidence.
 * Pending folds do not cover. `lineage` is
 * message ids only. Kept fold ids are `fold_ids`.
 */
export async function foldedContextPack(db: Database, room: string, task: string, budgetChars: number, at?: string): Promise<FoldContextPack> {
  if (!Number.isInteger(budgetChars) || budgetChars < BUDGET_MIN || budgetChars > BUDGET_MAX) {
    throw new Fault('INVALID_INPUT', 'budgetChars must be an integer from 500 to 20000');
  }
  if (typeof task !== 'string' || !task.isWellFormed() || task.includes('\0')) throw new Fault('INVALID_INPUT', 'task is invalid');
  const atTime = at === undefined ? new Date().toISOString() : instant(at, 'at');
  const terms = taskTerms(task);
  const [decisionRows, skillRows, factRows, hits, foldPins] = await Promise.all([
    validView(db, room, { kinds: ['decision'], at: atTime }),
    validView(db, room, { kinds: ['skill'], at: atTime }),
    validView(db, room, { kinds: ['fact'], at: atTime }),
    searchMessages(db, room, task, MESSAGE_LIMIT),
    loadFolds(db, room, atTime),
  ]);
  const visible = hits.filter(hit => atOrBefore(hit.created_at, atTime)).sort(compareHits);
  const texts = await sourceTexts(db, room, [
    ...decisionRows.map(item => item.source_message_id),
    ...skillRows.map(item => item.source_message_id),
    ...factRows.map(item => item.source_message_id),
    ...visible.map(hit => hit.message_id),
  ]);
  const items: Placed[] = [
    ...[...decisionRows].sort(byOverlapThenRecency(terms)).map(item => ({ section: 'decisions' as const, entry: itemEntry(item, texts) })),
    ...[...skillRows].sort(byTierThenOverlap(terms)).map(item => ({ section: 'skills' as const, entry: itemEntry(item, texts) })),
    ...[...factRows].sort(byOverlapThenRecency(terms)).map(item => ({ section: 'facts' as const, entry: itemEntry(item, texts) })),
  ];
  const rankedFolds = [...foldPins.folds].sort(compareFolds(terms)).map(fold => foldEntry(fold, foldPins.byFold.get(fold.id) ?? emptyPins()));
  const messages = visible.map(hit => messageEntry(hit, texts));
  const itemCount = prefixCount(items.length, take => used(assemble(items, take, rankedFolds, 0, [])) <= budgetChars);
  const droppedItem = itemCount < items.length;
  let foldCount = 0;
  let chosenMessages: PackEntry[] = [];
  let droppedFold = false;
  let droppedMessage = false;
  if (!droppedItem) {
    foldCount = prefixCount(rankedFolds.length, take => used(assemble(items, itemCount, rankedFolds, take, [])) <= budgetChars);
    droppedFold = foldCount < rankedFolds.length;
    const sources = new Set(items.slice(0, itemCount).map(item => item.entry.source_message_id));
    // HOLD P2 (d1def20): a raw message is suppressed only when a fold that is actually emitted covers its current version.
    const covered = new Set(rankedFolds.slice(0, foldCount).flatMap(fold => (foldPins.byFold.get(fold.fold_id) ?? emptyPins()).fresh));
    const eligible = messages.filter(entry => !sources.has(entry.source_message_id) && !covered.has(entry.source_message_id));
    const messageCount = prefixCount(eligible.length, take => used(assemble(items, itemCount, rankedFolds, foldCount, eligible.slice(0, take))) <= budgetChars);
    chosenMessages = eligible.slice(0, messageCount);
    droppedMessage = messageCount < eligible.length;
  }
  const sections = assemble(items, itemCount, rankedFolds, foldCount, chosenMessages);
  return {
    sections,
    used_chars: used(sections),
    truncated: droppedItem || droppedFold || droppedMessage,
    lineage: lineageOf(sections),
    fold_ids: sections.folds.map(fold => fold.fold_id),
  };
}

/** Count the integrator can place on roomBrief review_queue. A message-span propose with no edges counts as 1. */
export async function foldReviewQueue(db: Database, room: string): Promise<FoldReviewQueue> {
  const row = await db.prepare(`SELECT
      (SELECT count(*) FROM memory_folds WHERE room_id=? AND review_state='pending')
      + (SELECT count(*) FROM fold_edges e JOIN memory_folds s ON s.id=e.src_id WHERE s.room_id=? AND e.review_state='pending')
      AS pending_folds`).bind(room, room).first<{ pending_folds: number }>();
  return { pending_folds: Number(row?.pending_folds ?? 0) };
}
