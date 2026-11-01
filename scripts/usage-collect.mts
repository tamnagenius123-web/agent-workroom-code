// Box-side USAGE-METER collector. Prints a snapshot message (marker + fenced JSON) to stdout; post it with
//   npx tsx scripts/usage-collect.mts > /tmp/u.md && (cd /workspace/tools/grok-workroom && npx tsx gw.mts post /tmp/u.md usage-<ts>)
// Deterministic: same logs + ledger in => same numbers out. Prints no secrets (reads only usage fields).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { USAGE_MARKER, type UsageSource } from '../src/server/usage.ts';
import { strictTimestamp, finiteNumber, percentField } from '../src/server/usage-validate.ts';

export function codexFromLines(lines: string[], observedFile: string): UsageSource | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!line.includes('"rate_limits"')) continue;
    try {
      const find = (o: unknown): Record<string, unknown> | null => { if (!o || typeof o !== 'object') return null; const r = o as Record<string, unknown>; if (r.rate_limits) return r.rate_limits as Record<string, unknown>; for (const v of Object.values(r)) { const f = find(v); if (f) return f; } return null; };
      const j = JSON.parse(line); const rl = find(j); if (!rl) continue;
      // Every session-log field is untrusted and goes through the shared validator
      // (fix round 4): a window counts only with a finite-number used_percent (a
      // string percent is dropped, never echoed — Dots 9c9d6cdf), percents are
      // flagged out-of-range rather than clamped (Dots b4c39f8b #3), the plan label
      // is a fixed enum, and observed_at is the strict-validated log timestamp or
      // the file mtime — never the raw payload string.
      const win = [rl.primary, rl.secondary].filter(w => w && typeof w === 'object' && finiteNumber((w as { used_percent?: unknown }).used_percent) !== null) as { used_percent: number; resets_at: unknown; window_minutes: unknown }[];
      if (!win.length) continue;
      const top = win.reduce((a, b) => (b.used_percent > a.used_percent ? b : a));
      const pct = percentField(top.used_percent);
      const CODEX_PLANS = new Set(['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu']);
      const planLabel = typeof rl.plan_type === 'string' && CODEX_PLANS.has(rl.plan_type) ? rl.plan_type : 'unrecognized';
      const winLabel = finiteNumber(top.window_minutes) !== null ? String(top.window_minutes) : 'unknown';
      // A reset is isolated per window (fix round 5, Dots 48a0a4f6 #3): a finite but
      // out-of-Date-range value makes toISOString throw, which used to abort the whole
      // line and drop the source incl. its valid secondary window. Convert defensively:
      // an unrepresentable reset drops to null, the source and its windows survive.
      const resetDate = (() => { const sec = finiteNumber(top.resets_at); if (sec === null || sec <= 0) return null; const d = new Date(sec * 1000); return Number.isNaN(d.getTime()) ? null : d; })();
      return { agent: 'codex', method: 'measured', ...pct, resets_at: resetDate !== null ? resetDate.toISOString() : null,
        observed_at: strictTimestamp(j.timestamp) ?? new Date(statSync(observedFile).mtimeMs).toISOString(),
        basis: `~/.codex/sessions rate_limits (window ${winLabel}m, plan ${planLabel}); box Codex only, Dots host self-reports${pct.used_percent_flag ? '; raw used_percent outside [0,100] flagged as out_of_range, not presented as measured' : ''}` };
    } catch { /* skip malformed */ }
  }
  return null;
}
function newestFiles(dir: string, ext: string, n: number): string[] {
  const out: { p: string; m: number }[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); const s = statSync(p); if (s.isDirectory()) walk(p); else if (p.endsWith(ext)) out.push({ p, m: s.mtimeMs }); } };
  if (existsSync(dir)) walk(dir);
  return out.sort((a, b) => b.m - a.m).slice(0, n).map(x => x.p);
}
function ccusage(cmd: string): { total: number; today: number } | null {
  try {
    const d = JSON.parse(execFileSync('npx', ['-y', 'ccusage@latest', cmd, 'daily', '--json'], { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] }));
    const days = (d.daily ?? d.data ?? []) as { date: string; totalTokens: number }[];
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    return { total: d.totals?.totalTokens ?? 0, today: days.find(x => x.date === today)?.totalTokens ?? 0 };
  } catch { return null; }
}
/** Ledger: {"budget_tokens":280000000,"entries":[{"at":"ISO","tokens":n,"source_message_id":"..."}]} — tokens self-reported by Muse in the room. */
export function museFromLedger(ledger: { budget_tokens: number; entries: { at: string; tokens: number }[] }, now: string): UsageSource {
  // Ledger fields are untrusted (fix round 4): token counts count only as finite
  // numbers, and the last entry's `at` becomes observed_at only when the shared
  // strict parser accepts it — otherwise the collection time is used and the raw
  // value is never copied (Dots 9c9d6cdf).
  // Per-source isolation (fix round 5, Dots 48a0a4f6 #3): a malformed ledger degrades
  // THIS source to unavailable instead of throwing through the whole collector, a
  // null/non-object entry is skipped on its own, and token counts are nonnegative —
  // a negative entry is rejected (contributes 0), never negative usage.
  if (!ledger || typeof ledger !== 'object' || !Array.isArray((ledger as { entries?: unknown }).entries)) {
    return { agent: 'muse', method: 'unavailable', used_percent: null, observed_at: now,
      basis: 'muse ledger malformed (no entries array); source isolated, other sources unaffected' };
  }
  const entries = (ledger.entries as unknown[]).filter(e => e !== null && typeof e === 'object') as { at?: unknown; tokens?: unknown }[];
  const nonneg = (v: unknown): number | null => { const n = finiteNumber(v); return n !== null && n >= 0 ? n : null; };
  const used = entries.reduce((a, e) => a + (nonneg(e.tokens) ?? 0), 0);
  const budget = nonneg(ledger.budget_tokens);
  const pct = budget !== null && budget > 0 ? percentField(Math.round((used / budget) * 1000) / 10) : { used_percent: null };
  return { agent: 'muse', method: 'ledger', budget_tokens: budget, tokens_total: used, remaining_tokens: budget !== null ? budget - used : null,
    ...pct, observed_at: strictTimestamp(entries.at(-1)?.at) ?? now,
    basis: `ledger budget minus ${entries.length} Muse-reported entries; no external meter exists for Muse` };
}
export function collect(home = homedir(), now = new Date().toISOString()) {
  const sources: UsageSource[] = [];
  let codex: UsageSource | null = null;
  for (const f of newestFiles(join(home, '.codex/sessions'), '.jsonl', 5)) { codex = codexFromLines(readFileSync(f, 'utf8').split('\n'), f); if (codex) break; }
  if (codex?.resets_at && codex.resets_at < now) codex = { ...codex, method: 'estimated', used_percent: 0, basis: `${codex.basis}; STALE: window reset at ${codex.resets_at} after last observation, 0% assumed until a new session logs` };
  const cc = ccusage('codex');
  sources.push({ ...(codex ?? { agent: 'codex', method: 'unavailable', observed_at: now, basis: 'no rate_limits in ~/.codex/sessions' }), tokens_total: cc?.total ?? null, tokens_today: cc?.today ?? null });
  const g = ccusage('grok');
  sources.push({ agent: 'grok_cli', method: g ? 'measured' : 'unavailable', used_percent: null, tokens_total: g?.total ?? null, tokens_today: g?.today ?? null, observed_at: now,
    basis: 'ccusage grok over ~/.grok sessions (tokens). Plan % unavailable: no "billing: fetched" lines in ~/.grok/logs/unified.jsonl on this box (fulcrum-grok-meter needs them)' });
  sources.push({ agent: 'grokbot', method: 'unavailable', used_percent: null, observed_at: now, basis: 'no local log or API exposes Grok Bot plan usage; capacity treated as available unless the owner reports a limit' });
  const lp = join(home, '.workroom/muse-ledger.json');
  // The ledger read degrades its own source only (fix round 5): a parse/read failure
  // never aborts the other sources in this snapshot.
  try {
    sources.push(existsSync(lp) ? museFromLedger(JSON.parse(readFileSync(lp, 'utf8')), now)
      : { agent: 'muse', method: 'unavailable', observed_at: now, basis: `ledger ${lp} missing` });
  } catch {
    sources.push({ agent: 'muse', method: 'unavailable', observed_at: now, basis: 'ledger read failed (LEDGER_READ_FAILED); source isolated, other sources unaffected' });
  }
  return { kind: 'usage.snapshot.v1' as const, collected_at: now, sources };
}
export function render(snap: ReturnType<typeof collect>) {
  return `${USAGE_MARKER}\nUsage snapshot ${snap.collected_at} (USAGE-METER). Read with workroom_usage_read.\n\n\`\`\`json\n${JSON.stringify(snap, null, 2)}\n\`\`\`\n`;
}
/** Stage 2: local sources (collect) + gateway/plan sources (meter-readers). Gateway calls happen
 * only when the matching API key is present in env; agy is read through its CLI when available. */
export async function collectAll(home = homedir(), now = new Date().toISOString()) {
  const { fetchGatewaySources } = await import('./meter-readers.mts');
  const snap = collect(home, now);
  const agyRun = () => {
    try {
      const raw = execFileSync('agy', ['-p', '/usage', '--output-format', 'json'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
      const start = raw.indexOf('{'); return start >= 0 ? JSON.parse(raw.slice(start)) : null;
    } catch { return null; }
  };
  const extra = await fetchGatewaySources({ env: process.env, fetchFn: (url, init) => fetch(url, init), now, agyRun });
  return { ...snap, sources: [...snap.sources, ...extra] };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  void collectAll().then(snap => process.stdout.write(render(snap as ReturnType<typeof collect>)));
}
