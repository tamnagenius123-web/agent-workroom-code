import { Fault } from './contracts.ts';
import { instant } from './canonical.ts';
import type { Database } from './db.ts';
import { searchMessages, type Hit } from './memory.ts';
import { validView, type MemoryItem } from './memory-items.ts';
import type { FoldContextPack, FoldContextSections } from './fold-pack.ts';
import type { OwnerMemory } from './memory-hook.ts';
import { pinTable, type PinRow } from './pin-table.ts';
import type { StandingMemory } from './standing-memory.ts';

// OCG-W W4: Context OS pack. Context OS is not a fifth memory. It compiles a
// task-relative active context from the durable stores (Notion 3ec8d918 §7).
// P3: every entry keeps valid_from, the source message id, and a raw excerpt of
// that message's text at the pinned source revision (rev2), plus the latest revision number. Promotion does not replace the room message.
// Pending and rejected rows stay out. JSON.stringify(sections) never exceeds the budget.

const BUDGET_MIN = 500;
const BUDGET_MAX = 20000;
const EXCERPT_CHARS = 280;
const MESSAGE_LIMIT = 200;
const TASK_TERMS = 12;

export interface PackEntry {
  id: string;
  title?: string;
  snippet?: string;
  valid_from: string;
  source_message_id: string;
  /** rev2: the source revision this entry was proposed against; the excerpt is that revision's text. */
  source_version: number;
  /** rev2: latest revision of the source message. Greater than source_version means the evidence was edited after the item was proposed. */
  source_current_version: number;
  source_excerpt: string;
  /** rev2c (0020, Codex ec45569a): how source_version was obtained. 'pinned' = recorded when the item was proposed.
   * 'inferred' = 0018 timestamp backfill (or any pre-0020 row): not proof of what was read or reviewed.
   * 'current' = a raw message hit, which is the latest revision, not a pin. */
  source_version_basis: 'pinned' | 'inferred' | 'current';
}

export interface ContextSections {
  decisions: PackEntry[];
  skills: PackEntry[];
  facts: PackEntry[];
  messages: PackEntry[];
}

export interface ContextPack {
  sections: ContextSections;
  used_chars: number;
  truncated: boolean;
  lineage: string[];
}

type SectionName = 'decisions' | 'skills' | 'facts';

interface Placed {
  section: SectionName;
  entry: PackEntry;
}

function termsOf(value: string): string[] {
  return value.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length > 0);
}

/** First 12 search terms, the same window searchMessages keeps, compared case-insensitively. */
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

/** Latest room text, capped at 280 Unicode code points. A short message is copied whole. */
function sourceExcerpt(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= EXCERPT_CHARS) return text;
  return chars.slice(0, EXCERPT_CHARS).join('');
}

interface SourceTexts {
  byVersion: Map<string, string>;
  current: Map<string, number>;
}

function pinned(texts: SourceTexts, id: string, version: number | null): Pick<PackEntry, 'source_version' | 'source_current_version' | 'source_excerpt'> {
  const current = texts.current.get(id) ?? 1;
  const at = version ?? current;
  return { source_version: at, source_current_version: current, source_excerpt: sourceExcerpt(texts.byVersion.get(`${at}\u0000${id}`) ?? '') };
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

/** Every revision of the cited messages in this room (Codex 576d5575: pin the evidence revision, not message_current). */
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

function assemble(items: readonly Placed[], count: number, messages: readonly PackEntry[]): ContextSections {
  const chosen = items.slice(0, count);
  return {
    decisions: chosen.filter(item => item.section === 'decisions').map(item => item.entry),
    skills: chosen.filter(item => item.section === 'skills').map(item => item.entry),
    facts: chosen.filter(item => item.section === 'facts').map(item => item.entry),
    messages: [...messages],
  };
}

function used(sections: ContextSections): number {
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

function lineageOf(sections: ContextSections): string[] {
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
 * Compile approved decisions, skills, facts, and task search hits for one room.
 * Decisions rank by term overlap with `task`, then recency. Skills place tier 3 first,
 * then the same overlap and recency. Facts use overlap, then recency. Message hits
 * follow, except ids already used as an included item's source. `at` defaults to now.
 * `lineage` is each included source message id once, in that section order.
 * The lowest-priority entries are dropped until `JSON.stringify(sections)` fits.
 */
export async function contextPack(db: Database, room: string, task: string, budgetChars: number, at?: string): Promise<ContextPack> {
  if (!Number.isInteger(budgetChars) || budgetChars < BUDGET_MIN || budgetChars > BUDGET_MAX) {
    throw new Fault('INVALID_INPUT', 'budgetChars must be an integer from 500 to 20000');
  }
  if (typeof task !== 'string' || !task.isWellFormed() || task.includes('\0')) throw new Fault('INVALID_INPUT', 'task is invalid');
  const atTime = at === undefined ? new Date().toISOString() : instant(at, 'at');
  const terms = taskTerms(task);
  const [decisionRows, skillRows, factRows, hits] = await Promise.all([
    validView(db, room, { kinds: ['decision'], at: atTime }),
    validView(db, room, { kinds: ['skill'], at: atTime }),
    validView(db, room, { kinds: ['fact'], at: atTime }),
    searchMessages(db, room, task, MESSAGE_LIMIT),
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
  const messages = visible.map(hit => messageEntry(hit, texts));
  // Tail-drop from the low end. A later entry is not kept when a higher one was dropped.
  // Source hits of included items are omitted and do not, by themselves, set truncated.
  const itemCount = prefixCount(items.length, take => used(assemble(items, take, [])) <= budgetChars);
  const droppedItem = itemCount < items.length;
  let chosenMessages: PackEntry[] = [];
  let droppedMessage = false;
  if (!droppedItem) {
    const sources = new Set(items.slice(0, itemCount).map(item => item.entry.source_message_id));
    const eligible = messages.filter(entry => !sources.has(entry.source_message_id));
    const messageCount = prefixCount(eligible.length, take => used(assemble(items, itemCount, eligible.slice(0, take))) <= budgetChars);
    chosenMessages = eligible.slice(0, messageCount);
    droppedMessage = messageCount < eligible.length;
  }
  const sections = assemble(items, itemCount, chosenMessages);
  return { sections, used_chars: used(sections), truncated: droppedItem || droppedMessage, lineage: lineageOf(sections) };
}

export interface ContextSourcePin extends PinRow {
  /** SHA-256 of the exact raw source revision, not of a generated summary. */
  source_sha256: string | null;
  source_present: boolean;
}

export interface ContextData {
  standing_memory?: StandingMemory;
  owner_memory?: OwnerMemory;
  sections: ContextSections | FoldContextSections;
  /** UTF-16 code units in JSON.stringify(this entire data object). */
  used_chars: number;
  truncated: boolean;
  lineage: string[];
  fold_ids?: string[];
  pin_table: ContextSourcePin[];
  manifest: {
    version: 1;
    room: string;
    /** Hash covers data with only used_chars and manifest removed, preserving key order. */
    payload_sha256: string;
    payload_utf8_bytes: number;
    count_unit: 'utf16_code_units';
    token_count: null;
    token_status: 'unknown';
    dropped_entries: number;
    upstream_truncated: boolean;
  };
}

async function hexDigest(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The hashable payload is explicit and contains every emitted context entry and pin. */
export function contextPayload(data: ContextData): string {
  const { used_chars: _size, manifest: _manifest, ...payload } = data;
  void _size; void _manifest;
  return JSON.stringify(payload);
}

function hasFoldSections(sections: ContextSections | FoldContextSections): sections is FoldContextSections {
  return 'folds' in sections;
}

/**
 * Budget the emitted `data` envelope after owner notices, source pins, lineage,
 * and accounting metadata have been attached. The low-level pack budget only
 * selects candidates; this final boundary is shared by plain and folded packs.
 * Transport framing and provider-specific token overhead are not counted here.
 */
export async function fitContextData(
  db: Database, room: string, pack: ContextPack | FoldContextPack, budgetChars: number,
  owner: OwnerMemory | null, standing: StandingMemory | null,
): Promise<ContextData> {
  if (!Number.isInteger(budgetChars) || budgetChars < BUDGET_MIN || budgetChars > BUDGET_MAX) {
    throw new Fault('INVALID_INPUT', 'budgetChars must be an integer from 500 to 20000');
  }
  const mandatoryIds = new Set(standing?.notices.map(entry => entry.id) ?? []);
  const sections: ContextSections | FoldContextSections = {
    decisions: pack.sections.decisions.filter(entry => !mandatoryIds.has(entry.id)),
    skills: pack.sections.skills.filter(entry => !mandatoryIds.has(entry.id)),
    facts: pack.sections.facts.filter(entry => !mandatoryIds.has(entry.id)),
    ...(hasFoldSections(pack.sections) ? { folds: [...pack.sections.folds] } : {}),
    messages: [...pack.sections.messages],
  };
  const candidates = pinTable(sections, standing);
  const texts = await sourceTexts(db, room, candidates.map(entry => entry.source_message_id));
  const digests = new Map<string, string>();
  await Promise.all([...texts.byVersion].map(async ([key, raw]) => { digests.set(key, await hexDigest(raw)); }));
  const withSource = (pin: PinRow): ContextSourcePin => {
    const key = `${pin.source_version}\u0000${pin.source_message_id}`;
    const present = pin.source_version !== null && texts.byVersion.has(key);
    const current = texts.current.get(pin.source_message_id) ?? null;
    return {
      ...pin,
      source_current_version: current,
      status: !present ? 'missing' : pin.basis === 'inferred' ? 'inferred'
        : pin.source_version !== current ? 'stale' : 'current',
      source_sha256: present ? digests.get(key) ?? null : null,
      source_present: present,
    };
  };
  if (candidates.some(pin => pin.section === 'standing' && !withSource(pin).source_present)) {
    throw new Fault('MANDATORY_SOURCE_MISSING', 'A standing notice has no readable pinned source revision in this room. Re-propose and review it against a current source.');
  }
  // Existing ranking is preserved. Notices are never drop candidates.
  const tails = [sections.messages, ...(hasFoldSections(sections) ? [sections.folds] : []), sections.facts, sections.skills, sections.decisions];
  let dropped = 0;
  for (;;) {
    const pins = pinTable(sections, standing).map(withSource);
    const data: ContextData = {
      ...(standing ? { standing_memory: standing } : {}),
      ...(owner ? { owner_memory: owner } : {}),
      sections,
      used_chars: 0,
      truncated: pack.truncated || dropped > 0,
      // Preserve the existing fold lineage contract; fold source pins remain
      // in pin_table while lineage lists standing/items/raw-message sources.
      lineage: [...new Set(pins.filter(pin => pin.section !== 'folds').map(pin => pin.source_message_id))],
      ...(hasFoldSections(sections) ? { fold_ids: sections.folds.map(fold => fold.fold_id) } : {}),
      pin_table: pins,
      manifest: {
        version: 1, room, payload_sha256: '0'.repeat(64), payload_utf8_bytes: 0,
        count_unit: 'utf16_code_units', token_count: null, token_status: 'unknown',
        dropped_entries: dropped, upstream_truncated: pack.truncated,
      },
    };
    const payload = contextPayload(data);
    data.manifest.payload_utf8_bytes = new TextEncoder().encode(payload).length;
    // used_chars includes its own decimal representation; converge to the exact size.
    let size = JSON.stringify(data).length;
    while (data.used_chars !== size) { data.used_chars = size; size = JSON.stringify(data).length; }
    if (size <= budgetChars) {
      data.manifest.payload_sha256 = await hexDigest(payload);
      return data;
    }
    const tail = tails.find(entries => entries.length > 0);
    if (!tail) {
      throw new Fault('MANDATORY_EXCEEDS_BUDGET', `Mandatory context data renders to ${size} UTF-16 code units, over budget_chars=${budgetChars}. Standing and owner notices are never truncated.`);
    }
    tail.pop();
    dropped += 1;
  }
}
