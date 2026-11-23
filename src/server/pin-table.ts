import type { ContextSections, PackEntry } from './context-pack.ts';
import type { FoldContextSections } from './fold-pack.ts';

// U7/G4 pin comparison table: every pack entry's pinned source revision set against the
// current revision of that source, in pack order (decisions, skills, facts, folds, messages).
// Derived only from the entries the pack already carries; no extra reads. A row is 'stale'
// when the source was edited after the pin, 'inferred' when the pin itself is a backfill
// (rev2c: not proof of what was read), and 'current' when the pin is the live revision.
// Fold rows expand per pinned source; a stale fold source reports null for the current
// version because the fold entry carries only the stale flag, not the newer revision
// number (its raw message stays in the pack and has its own row under messages).

export type PinStatus = 'current' | 'stale' | 'inferred';

export interface PinRow {
  section: 'decisions' | 'skills' | 'facts' | 'folds' | 'messages';
  /** PackEntry id, or the fold id for fold rows. */
  entry_id: string;
  source_message_id: string;
  source_version: number;
  /** Null only for a stale fold source, whose newer revision number the fold entry does not carry. */
  source_current_version: number | null;
  basis: 'pinned' | 'inferred' | 'current';
  status: PinStatus;
}

function entryRow(section: PinRow['section'], entry: PackEntry): PinRow {
  const status: PinStatus = entry.source_version_basis === 'inferred'
    ? 'inferred'
    : entry.source_version < entry.source_current_version ? 'stale' : 'current';
  return {
    section,
    entry_id: entry.id,
    source_message_id: entry.source_message_id,
    source_version: entry.source_version,
    source_current_version: entry.source_current_version,
    basis: entry.source_version_basis,
    status,
  };
}

/** Pin rows for a context pack or a folded context pack, in section order, then entry order. */
export function pinTable(sections: ContextSections | FoldContextSections): PinRow[] {
  const rows: PinRow[] = [
    ...sections.decisions.map(entry => entryRow('decisions', entry)),
    ...sections.skills.map(entry => entryRow('skills', entry)),
    ...sections.facts.map(entry => entryRow('facts', entry)),
  ];
  if ('folds' in sections) {
    for (const fold of sections.folds) {
      const stale = new Set(fold.stale_message_ids);
      fold.source_message_ids.forEach((sourceId, index) => {
        const isStale = stale.has(sourceId);
        rows.push({
          section: 'folds',
          entry_id: fold.fold_id,
          source_message_id: sourceId,
          source_version: fold.source_versions[index] ?? 0,
          source_current_version: isStale ? null : fold.source_versions[index] ?? 0,
          basis: 'pinned',
          status: isStale ? 'stale' : 'current',
        });
      });
    }
  }
  rows.push(...sections.messages.map(entry => entryRow('messages', entry)));
  return rows;
}
