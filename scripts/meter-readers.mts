// METER stage 2: gateway capacity readers (SSU credits/usage, OpenRouter key usage, agy plan buckets).
// Pure parsers + an injectable fetch layer. No live call happens unless the caller passes a real
// fetch AND the matching API key env is set; tests use mocked fetch only. Keys are sent as request
// headers and never copied into any returned source (asserted by tests/meter-readers.test.ts).
// Every value is labelled through UsageSource.method: measured (gateway self-report over HTTP),
// or unavailable with the reason in basis. Nothing is estimated or guessed.
import type { UsageSource } from '../src/server/usage.ts';
import { strictTimestamp, percentField } from '../src/server/usage-validate.ts';

export const SSU_BASE = 'https://factchat-cloud.mindlogic.ai/v1/gateway';
export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/auth/key';

type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (n: number, dp: number): number => { const f = 10 ** dp; return Math.round(n * f) / f; };
/** Percent and timestamp validation are the shared usage-validate contract (fix
 * round 4): a computed percent is presented as measured only inside [0,100], outside
 * it is flagged, never silently clamped (Dots b4c39f8b #3); a payload timestamp may
 * be presented as resets_at only when strictTimestamp accepts it (exact ISO 8601 +
 * round-trip, no Feb-30 rollover) — anything else is dropped and reported through
 * the fixed resets_at_flag code, the raw value never copied (Dots 8df020e5). */
const pctField = percentField;
const validTimestamp = strictTimestamp;
const OUT_OF_RANGE_NOTE = 'raw used_percent outside [0,100] flagged as out_of_range, not presented as measured';
const INVALID_TS_NOTE = 'worst-bucket reset_time failed timestamp validation and was dropped (resets_at_flag=invalid_timestamp)';
/** One gateway call (fetch + body read) bounded by a single timeout. On timeout the
 * AbortController is fired so the underlying request is actually cancelled, not just
 * raced past — a json() that hangs after the headers can no longer hold the collection
 * (Dots b4c39f8b #1). The rejection carries no gateway text. */
async function fetchJson(fetchFn: FetchFn, url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ ok: boolean; status: number; value: unknown }> {
  const ctl = new AbortController();
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => { ctl.abort(); reject(new Error('GATEWAY_TIMEOUT')); }, timeoutMs); });
  try {
    const r = await Promise.race([fetchFn(url, { headers, signal: ctl.signal }), timeout]);
    if (!r.ok) return { ok: false, status: r.status, value: null };
    const value = await Promise.race([r.json(), timeout]);
    return { ok: true, status: r.status, value };
  } finally { if (t) clearTimeout(t); }
}

/** First numeric field whose key matches, searching the object and one nested `data` level. */
function pick(obj: unknown, keys: string[]): number | null {
  if (!obj || typeof obj !== 'object') return null;
  const scopes = [obj as Record<string, unknown>];
  const data = (obj as Record<string, unknown>).data;
  if (data && typeof data === 'object') scopes.push(data as Record<string, unknown>);
  for (const s of scopes) for (const k of keys) { const v = num(s[k]); if (v !== null) return v; }
  return null;
}
/** Response keys are untrusted data: only allowlisted field names may be named in a basis
 * string; anything else is reported as a count, never copied (Dots b4c39f8b #2). */
const KNOWN_KEYS = new Set(['remaining_credits', 'credits_remaining', 'remaining', 'balance', 'credit_balance', 'monthly_credits', 'total_credits', 'credits_total', 'total', 'limit', 'used_credits', 'credits_used', 'used', 'usage', 'spent', 'usage_usd', 'limit_usd', 'data', 'is_free_tier', 'groups', 'name', 'buckets', 'window', 'remaining_fraction', 'reset_time']);
function topKeys(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return String(typeof obj);
  const keys = Object.keys(obj as Record<string, unknown>);
  const known = keys.filter(k => KNOWN_KEYS.has(k)).slice(0, 12);
  const withheld = keys.length - keys.filter(k => KNOWN_KEYS.has(k)).length;
  const parts = [...known, ...(withheld > 0 ? [`+${withheld} unrecognized field(s) withheld`] : [])];
  return parts.join(',') || '(empty)';
}

export function ssuSource(credits: unknown, usage: unknown, now: string): UsageSource {
  const remaining = pick(credits, ['remaining_credits', 'credits_remaining', 'remaining', 'balance', 'credit_balance']);
  const total = pick(credits, ['monthly_credits', 'total_credits', 'credits_total', 'total', 'limit']) ?? pick(usage, ['monthly_credits', 'total_credits', 'total', 'limit']);
  const used = pick(credits, ['used_credits', 'credits_used', 'used']) ?? pick(usage, ['used_credits', 'credits_used', 'used', 'usage', 'spent']);
  if (remaining === null && used === null) {
    return { agent: 'ssu', method: 'unavailable', used_percent: null, observed_at: now,
      basis: `SSU /credits/+/usage/ carried no numeric credit fields (keys: ${topKeys(credits)} / ${topKeys(usage)}); shape unverified against live gateway` };
  }
  const pct = pctField(total !== null && total > 0 && used !== null ? round((used / total) * 100, 1) : null);
  return { agent: 'ssu', method: 'measured', ...pct, observed_at: now,
    credits_remaining: remaining, credits_total: total, credits_used: used,
    basis: `SSU gateway GET /credits/ + /usage/ (Mindlogic, monthly 3000-credit pool per owner t809u facts); mocked-fetch tested only, no live call in tests${pct.used_percent_flag ? `; ${OUT_OF_RANGE_NOTE}` : ''}` } as UsageSource;
}

export function openRouterKey(json: unknown, now: string): UsageSource {
  const usage = pick(json, ['usage', 'usage_usd']);
  const limit = pick(json, ['limit', 'limit_usd']);
  if (usage === null) {
    return { agent: 'openrouter', method: 'unavailable', used_percent: null, observed_at: now,
      basis: `OpenRouter /auth/key carried no numeric usage field (keys: ${topKeys(json)})` };
  }
  const remaining = limit !== null ? round(limit - usage, 4) : null;
  const pct = pctField(limit !== null && limit > 0 ? round((usage / limit) * 100, 1) : null);
  return { agent: 'openrouter', method: 'measured', ...pct, observed_at: now,
    usage_usd: usage, limit_usd: limit, remaining_usd: remaining,
    basis: `OpenRouter GET /api/v1/auth/key data.usage/limit (USD, pay-as-you-go wallet); remaining derived limit-usage${pct.used_percent_flag ? `; ${OUT_OF_RANGE_NOTE}` : ''}` } as UsageSource;
}

interface AgyBucket { window?: string; remaining_fraction?: number; reset_time?: string }
interface AgyGroup { name?: string; buckets?: AgyBucket[] }

export function agyUsage(json: unknown, now: string): UsageSource {
  const groups: AgyGroup[] = Array.isArray((json as { groups?: unknown })?.groups)
    ? ((json as { groups: AgyGroup[] }).groups)
    : (json && typeof json === 'object' && !Array.isArray(json)
      ? Object.entries(json as Record<string, unknown>).filter(([, v]) => v && typeof v === 'object').map(([name, v]) => ({ name, ...(v as object) }) as AgyGroup)
      : []);
  let worst: { fraction: number; reset: string | null; group: string } | null = null;
  const summary: Record<string, number> = {};
  let groupIdx = 0;
  for (const g of groups) {
    if (!g || typeof g !== 'object' || !Array.isArray(g.buckets)) continue; // malformed group: skip it, never throw
    groupIdx++;
    // Group names come from the payload and are untrusted: label groups positionally
    // (group_1, group_2, ...) so a name can never carry content into the output (Dots b4c39f8b #2).
    const name = `group_${groupIdx}`;
    for (const b of g.buckets) {
      const f = num(b.remaining_fraction); if (f === null) continue;
      summary[name] = summary[name] === undefined ? f : Math.min(summary[name], f);
      if (!worst || f < worst.fraction) worst = { fraction: f, reset: b.reset_time ?? null, group: name };
    }
  }
  if (!worst) return { agent: 'agy', method: 'unavailable', used_percent: null, observed_at: now, basis: 'agy /usage payload had no bucket with numeric remaining_fraction' };
  const pct = pctField(round((1 - worst.fraction) * 100, 1));
  // resets_at belongs to the worst bucket only: a validated timestamp is kept; a present
  // but invalid one is dropped to null + the fixed flag — never replaced by another
  // bucket's value, and an absent one stays plain null (nothing was dropped).
  const reset = validTimestamp(worst.reset);
  const dropped = worst.reset !== null && worst.reset !== undefined && reset === null;
  return { agent: 'agy', method: 'measured', ...pct, resets_at: reset, ...(dropped ? { resets_at_flag: 'invalid_timestamp' } : {}), observed_at: now,
    agy_groups_min_remaining_fraction: summary,
    basis: `agy -p /usage self-report (Antigravity plan buckets, per-group in extra field, groups labelled positionally); used_percent from worst bucket (${worst.group})${pct.used_percent_flag ? `; ${OUT_OF_RANGE_NOTE}` : ''}${dropped ? `; ${INVALID_TS_NOTE}` : ''}` } as UsageSource;
}

type CallStatus = 'measured' | 'failed' | 'not_attempted';

export async function fetchGatewaySources(o: {
  env: Record<string, string | undefined>;
  fetchFn: FetchFn;
  now: string;
  agyRun: () => unknown;
  ssuBase?: string;
  timeoutMs?: number;
}): Promise<UsageSource[]> {
  const timeoutMs = o.timeoutMs ?? 10_000;
  const out: UsageSource[] = [];
  // SSU: credits and usage are attempted independently and carry separate statuses.
  // The source is 'measured' only when both calls succeeded; any failure degrades it
  // to unavailable. Error text from the gateway/fetch layer is NEVER copied into
  // basis (it can embed credentials) — failures are reported as fixed codes only.
  if (!o.env.SSU_API_KEY) {
    out.push({ agent: 'ssu', method: 'unavailable', used_percent: null, observed_at: o.now,
      credits_status: 'not_attempted', usage_status: 'not_attempted',
      basis: 'SSU_API_KEY not set in this process env; no gateway call made' } as UsageSource);
  } else {
    const headers = { Authorization: `Bearer ${o.env.SSU_API_KEY}`, 'x-api-key': o.env.SSU_API_KEY };
    const attempt = async (path: string): Promise<{ status: CallStatus; value: unknown }> => {
      try {
        const r = await fetchJson(o.fetchFn, `${o.ssuBase ?? SSU_BASE}${path}`, headers, timeoutMs);
        if (!r.ok) return { status: 'failed', value: null };
        return { status: 'measured', value: r.value };
      } catch { return { status: 'failed', value: null }; }
    };
    const [credits, usage] = await Promise.all([attempt('/credits/'), attempt('/usage/')]);
    if (credits.status === 'measured' && usage.status === 'measured') {
      out.push({ ...ssuSource(credits.value, usage.value, o.now), credits_status: 'measured', usage_status: 'measured' } as UsageSource);
    } else {
      const parsed = ssuSource(credits.value, usage.value, o.now) as unknown as Record<string, unknown>;
      out.push({ agent: 'ssu', method: 'unavailable', used_percent: null, observed_at: o.now,
        credits_status: credits.status, usage_status: usage.status,
        credits_remaining: parsed.credits_remaining ?? null, credits_total: parsed.credits_total ?? null, credits_used: parsed.credits_used ?? null,
        basis: `SSU read incomplete (credits_status=${credits.status}, usage_status=${usage.status}); failed calls are not retried (gateway-axis rule), error detail withheld` } as UsageSource);
    }
  }
  if (!o.env.OPENROUTER_API_KEY) {
    out.push({ agent: 'openrouter', method: 'unavailable', used_percent: null, observed_at: o.now, basis: 'OPENROUTER_API_KEY not set in this process env; no gateway call made' });
  } else {
    try {
      const r = await fetchJson(o.fetchFn, OPENROUTER_KEY_URL, { Authorization: `Bearer ${o.env.OPENROUTER_API_KEY}` }, timeoutMs);
      if (!r.ok) throw new Error('GATEWAY_HTTP_NOT_OK');
      out.push(openRouterKey(r.value, o.now));
    } catch {
      out.push({ agent: 'openrouter', method: 'unavailable', used_percent: null, observed_at: o.now, basis: 'OpenRouter /auth/key read failed (GATEWAY_READ_FAILED); no retry, error detail withheld' });
    }
  }
  // agy: a malformed payload fails only this source, never the whole collection.
  let agySource: UsageSource;
  try {
    const agyJson = o.agyRun();
    agySource = agyJson === null || agyJson === undefined
      ? { agent: 'agy', method: 'unavailable', used_percent: null, observed_at: o.now, basis: 'agy CLI unavailable or /usage returned nothing on this box' }
      : agyUsage(agyJson, o.now);
  } catch {
    agySource = { agent: 'agy', method: 'unavailable', used_percent: null, observed_at: o.now, basis: 'agy /usage payload could not be parsed (AGY_PARSE_FAILED); other sources unaffected' };
  }
  out.push(agySource);
  return out;
}
