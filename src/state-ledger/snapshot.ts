import { createHash } from 'node:crypto';
import { extractGates, extractVerdicts } from './extract.ts';
import type {
  ProgressStore,
  RoomMessage,
  RoomPageSource,
  SourceReaders,
  StateSnapshot,
} from './types.ts';

/** Deterministic JSON: object keys sorted recursively, arrays keep order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Reads the whole room through a paged source. Progress is saved after every
 * page, so a crash or a killed process resumes from the last cursor instead
 * of rescanning from the first message. Messages are deduplicated by id,
 * keeping first-seen order.
 */
export async function collectRoomMessages(
  source: RoomPageSource,
  store: ProgressStore,
): Promise<RoomMessage[]> {
  const saved = await store.load();
  let cursor: string | null = saved?.cursor ?? null;
  const out: RoomMessage[] = [];
  const seen = new Set<string>();
  for (const m of saved?.messages ?? []) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  for (;;) {
    const page = await source.fetchPage(cursor);
    for (const m of page.messages) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    }
    if (!page.hasMore || page.nextCursor === null) break;
    cursor = page.nextCursor;
    await store.save({ cursor, messages: out });
  }
  await store.clear();
  return out;
}

export interface BuildOptions {
  now?: () => Date;
  room?: string;
}

/**
 * Builds one snapshot from the four sources. Same inputs give the same
 * snapshot except for `builtAt` (each source section carries a content hash
 * so two snapshots can be diffed without a deep compare).
 */
export async function buildSnapshot(readers: SourceReaders, opts: BuildOptions = {}): Promise<StateSnapshot> {
  const messages = await collectRoomMessages(readers.room, readers.roomProgress);
  const [refsRaw, prsRaw, decisions] = await Promise.all([
    readers.readRefs(),
    readers.readPrs(),
    readers.readDecisions(),
  ]);
  const refs = [...refsRaw].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const prs = [...prsRaw].sort((a, b) => a.number - b.number);
  const lastMsg = messages[messages.length - 1];
  const lastDecision = decisions[decisions.length - 1];
  return {
    schema: 'state-ledger/1',
    builtAt: (opts.now?.() ?? new Date()).toISOString(),
    room: opts.room ?? 'room_main',
    anchors: {
      room: {
        messageCount: messages.length,
        lastMessageId: lastMsg?.id ?? null,
        lastMessageAt: lastMsg?.created_at ?? null,
        hash: contentHash(messages),
      },
      refs: {
        count: refs.length,
        mainSha: refs.find((r) => r.name === 'refs/heads/main')?.sha ?? null,
        hash: contentHash(refs),
      },
      prs: {
        total: prs.length,
        open: prs.filter((p) => p.state === 'OPEN').length,
        hash: contentHash(prs),
      },
      decisions: {
        rows: decisions.length,
        lastTs: lastDecision?.ts ?? null,
        hash: contentHash(decisions),
      },
    },
    refs,
    prs,
    decisions,
    verdicts: extractVerdicts(messages),
    gates: extractGates(messages, decisions),
  };
}
