import type { Database } from './db.ts';

// Server-side non-peek unread selection latency: first time a non-author principal is handed a message by
// workroom_unread (peek=false), minus created_at. workroom_mentions/read/peek are NOT instrumented.
// One row per (message, reader); INSERT OR IGNORE keeps the first sighting.
// Best effort: telemetry must never fail delivery, because the unread cursor has already advanced by the time
// this runs. Any error (missing table, constraint, D1 outage) is swallowed and only logged by class.
export async function recordReads(db: Database, principal: string, via: string, messages: { id: string; actor_id: string; created_at: string }[], now = Date.now()) {
  const rows = messages.filter(m => m.actor_id !== principal && !Number.isNaN(Date.parse(m.created_at)));
  if (!rows.length) return;
  try {
    await db.batch(rows.map(m => db.prepare('INSERT OR IGNORE INTO message_reads(message_id,principal_id,via,first_seen_at,latency_ms) VALUES (?,?,?,?,?)')
      .bind(m.id, principal, via, now, Math.max(0, now - Date.parse(m.created_at)))));
  } catch (e) { console.warn('latency_record_failed', (e as Error)?.name ?? 'Error'); }
}
// Percentile estimator: standard nearest-rank, 1-based rank ceil(p*n), i.e. 0-based index ceil(p*n)-1 on the sorted
// sample (Codex 17ea0f72: the earlier floor(p*n) index was one rank high whenever p*n is integral). Not a midpoint median.
// baseline_ready means >=20 (message, reader) pairs observed; pairs are not independent trials and this is not an SLO.
const pct = (s: number[], p: number) => s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] : null;
export async function latencyStats(db: Database, sinceMs: number, now = Date.now()) {
  const res = await db.prepare('SELECT principal_id, latency_ms FROM message_reads WHERE first_seen_at>=? ORDER BY latency_ms').bind(now - sinceMs).all<{ principal_id: string; latency_ms: number }>();
  const by = new Map<string, number[]>();
  for (const r of res.results) (by.get(r.principal_id) ?? by.set(r.principal_id, []).get(r.principal_id)!).push(r.latency_ms);
  return { window_hours: sinceMs / 3600_000, agents: [...by].map(([principal_id, s]) => ({ principal_id, samples: s.length, p50_ms: pct(s, 0.5), p90_ms: pct(s, 0.9), max_ms: s.at(-1) ?? null, baseline_ready: s.length >= 20 })) };
}
