import { Fault } from './contracts.ts';
// OCG-W W1: retrieval over room messages. Semantics lineage: hallaon-ocg@29ee25d docs/ocgmem/ABSORB_DESIGN.md (valid_view, source-bound items).
type DB = { prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } } };
export type Hit = { message_id: string; actor_id: string; created_at: string; snippet: string; rank: number };
/** Turn free text into a safe FTS5 query: quoted terms ANDed (no operators/columns from user input). */
export function ftsQuery(q: string): string {
  const terms = q.normalize('NFKC').split(/[^\p{L}\p{N}_]+/u).filter(t => t.length > 0).slice(0, 12);
  if (!terms.length) throw new Fault('INVALID_INPUT', 'query has no searchable terms');
  return terms.map(t => `"${t}"`).join(' ');
}
export async function searchMessages(db: DB, room: string, query: string, limit: number, before?: string): Promise<Hit[]> {
  const r = await db.prepare(`SELECT message_id, actor_id, created_at, snippet(memory_fts,0,'[',']','…',16) AS snippet, bm25(memory_fts) AS rank
    FROM memory_fts WHERE memory_fts MATCH ? AND room_id=? AND (? IS NULL OR created_at < ?) ORDER BY rank LIMIT ?`)
    .bind(ftsQuery(query), room, before ?? null, before ?? null, limit).all<Hit>();
  return r.results;
}
