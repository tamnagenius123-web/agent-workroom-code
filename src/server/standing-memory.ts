import type { Database } from './db.ts';
import { instant } from './canonical.ts';
import { Fault } from './contracts.ts';
import type { MemoryItem, MemoryKind } from './memory-items.ts';

/** Opt-in is part of the reviewed title, so normal item approval binds it. */
export const STANDING_TITLE_MARKER = '[standing]';
export const STANDING_MEMORY_POLICY = 'approved-standing-title-tier2-v1';
const STANDING_MAX_CHARS = 20000;
const STANDING_MAX_ITEMS = 1000;

export interface StandingNotice {
  kind: MemoryKind;
  id: string;
  title: string;
  body: string;
  source_message_id: string;
  source_version: number | null;
  source_version_basis: 'pinned' | 'inferred';
}

export interface StandingMemory {
  policy: typeof STANDING_MEMORY_POLICY;
  notices: StandingNotice[];
}

/**
 * Certified memory is not automatically a standing instruction. Only an approved
 * tier >= 2 item with the exact title prefix opts in. Normal proposal/review and
 * supersession determine membership; this read path never edits or approves it.
 * The block keeps complete approved text, ordered decision/fact/skill then id.
 * No query, current clock, score, or current source revision enters the prefix.
 */
export function buildStandingMemory(items: readonly MemoryItem[], room: string, at: string): StandingMemory | null {
  const order: Record<MemoryKind, number> = { decision: 0, fact: 1, skill: 2 };
  const notices = items.filter(item => item.room_id === room && item.review_state === 'approved'
    && item.tier >= 2 && item.title.startsWith(STANDING_TITLE_MARKER)
    && item.valid_from <= at && (item.valid_until === null || item.valid_until > at))
    .sort((a, b) => order[a.kind] - order[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(item => ({
      kind: item.kind, id: item.id, title: item.title, body: item.body,
      source_message_id: item.source_message_id,
      source_version: item.source_version,
      source_version_basis: item.version_basis === 'pinned' ? 'pinned' as const : 'inferred' as const,
    }));
  return notices.length ? { policy: STANDING_MEMORY_POLICY, notices } : null;
}

export async function standingMemory(db: Database, room: string, at: string): Promise<StandingMemory | null> {
  const atTime = instant(at, 'at');
  const rows = await db.prepare(`SELECT id, room_id, kind, tier, title, body, source_message_id,
      source_version, version_basis, proposed_by, review_state, valid_from, valid_until, created_at,
      EXISTS (SELECT 1 FROM message_history h WHERE h.room_id=memory_items.room_id
        AND h.message_id=memory_items.source_message_id AND h.version=memory_items.source_version) AS source_present
    FROM memory_items WHERE room_id=? AND review_state='approved' AND tier>=2
      AND substr(title,1,?)=? AND valid_from<=? AND (valid_until IS NULL OR valid_until>?)
    ORDER BY id LIMIT ?`)
    .bind(room, STANDING_TITLE_MARKER.length, STANDING_TITLE_MARKER, atTime, atTime, STANDING_MAX_ITEMS + 1)
    .all<MemoryItem & { source_present: number }>();
  if (rows.results.length > STANDING_MAX_ITEMS) {
    throw new Fault('MANDATORY_EXCEEDS_BUDGET', 'Too many standing notices to fit the context limit. No partial notice block was emitted.');
  }
  if (rows.results.some(row => !row.source_present)) {
    throw new Fault('MANDATORY_SOURCE_MISSING', 'A standing notice has no readable pinned source revision in this room. Re-propose and review it against a current source.');
  }
  const block = buildStandingMemory(rows.results, room, atTime);
  if (block && JSON.stringify(block).length > STANDING_MAX_CHARS) {
    throw new Fault('MANDATORY_EXCEEDS_BUDGET', 'Standing notices exceed the 20000 UTF-16-unit context limit. No partial notice block was emitted.');
  }
  return block;
}
