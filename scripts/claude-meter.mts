// CLAUDE-METER: agent:claude usage per tracker unit (runner state/wake.log JSONL) and the remaining
// Anthropic prepaid API credit (199.99 USD, expires 2026-11-01 00:00 KST) from the runner spend ledger
// state/api-spend.json. Pure module: no side effects at import. A missing or unreadable ledger yields
// remaining_credit_usd=null with null_reason (never the full credit, unlike claude-runner readSpend()).
// Output follows the USAGE-METER UsageSource shape (agent, method, tokens_total, observed_at, basis).
// CLI: npx tsx scripts/claude-meter.mts [wake.log] [api-spend.json] -> one JSON object on stdout.
import { readFileSync } from 'node:fs';

export const CREDIT_USD = 199.99;
export const CREDIT_EXPIRES_AT = Date.parse('2026-11-01T00:00:00+09:00');
const UNIT = /(?:\[unit:\s*|\b(?:[Tt]racker\s+)?[Uu]nit[:\s]+\**`?)([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)/;

export interface WakeEntry { ev?: string; id?: string; unit?: string | null; auth?: string; cost_usd?: number; usage?: Record<string, number | undefined> }
export interface UnitUsage { wakes: number; input: number; output: number; cache_read: number; cache_write: number; tokens_total: number; cost_usd: number; api_wakes: number }
export interface Credit { method: 'ledger' | 'unavailable'; spent_usd: number | null; remaining_credit_usd: number | null; expired: boolean; expires_at: string; null_reason: string | null }

const cents = (n: number): number => Math.round(n * 100) / 100;
const micro = (n: number): number => Math.round(n * 1e6) / 1e6;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function unitOf(text?: string): string | null {
  return text ? (UNIT.exec(text)?.[1] ?? null) : null;
}

export function readWakeLog(f: string): { entries: WakeEntry[]; reason: string | null } {
  let raw: string;
  try { raw = readFileSync(f, 'utf8'); } catch { return { entries: [], reason: 'wake.log missing' }; }
  const entries: WakeEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line) as WakeEntry; if (o && o.ev === 'replied') entries.push(o); } catch { /* skip malformed line */ }
  }
  return { entries, reason: null };
}

export function usageByUnit(entries: WakeEntry[]): Record<string, UnitUsage> {
  const out: Record<string, UnitUsage> = {};
  for (const e of entries) {
    const k = e.unit || 'unattributed';
    const u = (out[k] ??= { wakes: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, tokens_total: 0, cost_usd: 0, api_wakes: 0 });
    const g = e.usage ?? {};
    u.wakes++; u.input += num(g.input); u.output += num(g.output); u.cache_read += num(g.cache_read); u.cache_write += num(g.cache_write);
    u.tokens_total = u.input + u.output + u.cache_read + u.cache_write;
    u.cost_usd = micro(u.cost_usd + num(e.cost_usd));
    if (e.auth === 'api') u.api_wakes++;
  }
  return out;
}

export function creditRemaining(f: string, now: number): Credit {
  const base = { expires_at: new Date(CREDIT_EXPIRES_AT).toISOString() };
  let usd: unknown;
  try { usd = (JSON.parse(readFileSync(f, 'utf8')) as { usd?: unknown }).usd; }
  catch (e) { return { ...base, method: 'unavailable', spent_usd: null, remaining_credit_usd: null, expired: now >= CREDIT_EXPIRES_AT, null_reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'ledger missing' : 'ledger unreadable' }; }
  if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return { ...base, method: 'unavailable', spent_usd: null, remaining_credit_usd: null, expired: now >= CREDIT_EXPIRES_AT, null_reason: 'ledger usd not a non-negative number' };
  const expired = now >= CREDIT_EXPIRES_AT;
  return { ...base, method: 'ledger', spent_usd: micro(usd), remaining_credit_usd: expired ? 0 : Math.max(0, cents(CREDIT_USD - usd)), expired, null_reason: null };
}

export function meterSnapshot(o: { wakeLog: string; ledger: string; now: number }) {
  const w = readWakeLog(o.wakeLog), c = creditRemaining(o.ledger, o.now), units = usageByUnit(w.entries);
  const tokens = Object.values(units).reduce((s, u) => s + u.tokens_total, 0);
  const basis = [`remaining=${CREDIT_USD}-ledger usd (runner total_cost_usd sum)`, c.expired ? 'credit expired 2026-11-01 KST' : null, c.null_reason, w.reason].filter(Boolean).join('; ').slice(0, 400);
  return { agent: 'claude', method: c.method, tokens_total: w.reason ? null : tokens, observed_at: new Date(o.now).toISOString(), basis,
    remaining_credit_usd: c.remaining_credit_usd, spent_usd: c.spent_usd, credit_expired: c.expired, credit_expires_at: c.expires_at, null_reason: c.null_reason, units };
}

if (process.argv[1]?.endsWith('claude-meter.mts')) {
  const d = process.env.CLAUDE_AGENT_DIR ?? '/workspace/tools/claude-agent';
  console.log(JSON.stringify(meterSnapshot({ wakeLog: process.argv[2] ?? d + '/state/wake.log', ledger: process.argv[3] ?? d + '/state/api-spend.json', now: Date.now() }), null, 2));
}
