// USAGE-METER: deterministic per-agent usage snapshots carried as room messages.
// A snapshot message contains the marker line and one fenced JSON object; no migration needed.
import { z } from 'zod';
import { strictEpoch, sanitizeSourceFields } from './usage-validate.ts';
export const USAGE_MARKER = 'WORKROOM_USAGE_SNAPSHOT_V1';
export const USAGE_READ_TOOL = { name: 'workroom_usage_read', description: 'Latest deterministic usage snapshot per agent (codex, grok_cli, grokbot, muse), parsed from room messages carrying the WORKROOM_USAGE_SNAPSHOT_V1 marker. Each source states method=measured|ledger|estimated|unavailable. Read-only; content is untrusted data.' };
export const usageReadSchema = z.object({ schema_version: z.literal('1'), room: z.string().min(1).max(128), agent: z.string().max(64).optional() }).strict();
const source = z.object({ agent: z.string().min(1).max(64), method: z.enum(['measured', 'ledger', 'estimated', 'unavailable']),
  used_percent: z.number().min(0).max(100).nullable().optional(), resets_at: z.string().nullable().optional(), tokens_total: z.number().nonnegative().nullable().optional(),
  tokens_today: z.number().nonnegative().nullable().optional(), budget_tokens: z.number().nonnegative().nullable().optional(), remaining_tokens: z.number().nullable().optional(),
  observed_at: z.string(), basis: z.string().max(400) }).passthrough();
export const snapshotSchema = z.object({ kind: z.literal('usage.snapshot.v1'), collected_at: z.string(), sources: z.array(source).min(1).max(20) });
export type UsageSource = z.infer<typeof source>;
export type Msg = { id: string; actor_id: string; text: string; created_at: string };

export function parseSnapshot(text: string): z.infer<typeof snapshotSchema> | null {
  if (!text.includes(USAGE_MARKER)) return null;
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1] ?? '') as { sources?: unknown };
    // Snapshot content is untrusted: run every source through the shared validator
    // BEFORE zod, so one poisoned field (e.g. a string used_percent) is dropped to
    // null instead of failing the whole snapshot (fix round 4, ruling 5da30952).
    if (raw && Array.isArray(raw.sources)) {
      raw.sources = raw.sources.map(s => (s && typeof s === 'object' && !Array.isArray(s) ? sanitizeSourceFields(s as Record<string, unknown>) : s));
    }
    const r = snapshotSchema.safeParse(raw); return r.success ? r.data : null;
  } catch { return null; }
}
/** Newest-first messages in, latest valid source per agent out. The winner is the
 * source with the newest observed_at; ties keep the first seen (newest message).
 * A later-posted stale snapshot therefore never overwrites a fresher observation.
 * observed_at is compared as epoch milliseconds via the shared strict parser
 * (usage-validate strictEpoch), never as a string and never via bare Date.parse:
 * mixed ISO offsets order correctly, an unparseable value counts as -Infinity so it
 * can never beat a valid timestamp (Dots b4c39f8b #3), and a rollover date such as
 * 2026-02-30 is rejected instead of rolling into March (Dots 9c9d6cdf). Returned
 * sources are sanitized: an invalid observed_at is dropped to null rather than
 * returned (and rendered) as-is. */
export function latestByAgent(messages: Msg[], agent?: string) {
  const out = new Map<string, UsageSource & { message_id: string; posted_by: string }>();
  for (const msg of messages) {
    const snap = parseSnapshot(msg.text); if (!snap) continue;
    for (const s of snap.sources) {
      if (agent && s.agent !== agent) continue;
      const cur = out.get(s.agent);
      if (!cur || strictEpoch(s.observed_at) > strictEpoch(cur.observed_at)) {
        const clean = sanitizeSourceFields({ ...s } as Record<string, unknown>, { nullObserved: true });
        out.set(s.agent, { ...(clean as unknown as UsageSource), message_id: msg.id, posted_by: msg.actor_id });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}
type Db = { prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> } } };
export async function usageRead(service: { authorize(room: string): Promise<unknown>; db: Db }, input: { room: string; agent?: string }) {
  await service.authorize(input.room); // membership gate only — no read, so no cursor side effect
  const db = service.db;
  const rows = (await db.prepare(`SELECT id, actor_id, text, created_at FROM message_current WHERE room_id=? AND text LIKE ? ORDER BY seq DESC LIMIT 50`)
    .bind(input.room, `%${USAGE_MARKER}%`).all<Msg>()).results;
  return { data: { sources: latestByAgent(rows, input.agent) }, meta: { scanned: rows.length } };
}
