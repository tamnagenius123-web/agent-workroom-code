// METER shared validation for untrusted usage fields (fix round 4, ruling 5da30952).
// ONE validator that every untrusted output field goes through, and ONE strict date
// parser. Producers (scripts/meter-readers.mts, scripts/usage-collect.mts) and the
// server read path (src/server/usage.ts latestByAgent/parseSnapshot) all route through
// here, so a new field cannot skip validation: tests/meter-fix4.test.ts enumerates
// every producer with poisoned payloads. Rules: fixed enums / numeric ranges pass,
// anything else is dropped to null — never echoed, never clamped into a measured value,
// and a bad field never fails the whole source.

const ISO_TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Strict ISO 8601 timestamp AND a real calendar date/time. Component ranges and
 * days-in-month are checked explicitly and the result is round-tripped through
 * Date.UTC, so calendar overflow (Feb 30 rolling into Mar 2 under Date.parse) is
 * rejected. Returns the original string when valid, null otherwise. */
export function strictTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = ISO_TS.exec(v); if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const hh = Number(m[4]), mi = Number(m[5]), ss = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || hh > 23 || mi > 59 || ss > 59) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  if (d < 1 || d > dim) return null;
  // Round-trip: rebuild the instant from components and confirm nothing rolled over.
  const utc = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const rt = new Date(utc);
  if (rt.getUTCFullYear() !== y || rt.getUTCMonth() !== mo - 1 || rt.getUTCDate() !== d
    || rt.getUTCHours() !== hh || rt.getUTCMinutes() !== mi || rt.getUTCSeconds() !== ss) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

/** Epoch ms for ordering: strict timestamps only. Anything else is -Infinity so an
 * unparseable or rollover date sorts last and can never beat a valid one. */
export function strictEpoch(v: unknown): number {
  const t = strictTimestamp(v);
  return t === null ? Number.NEGATIVE_INFINITY : Date.parse(t);
}

export const finiteNumber = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Percent field contract: only a finite number may be a percent. Inside [0,100] it is
 * measured; outside it is flagged (null + flag + numeric raw), never clamped; a
 * non-number is dropped to plain null and never echoed. */
export function percentField(raw: unknown): { used_percent: number | null; used_percent_flag?: string; used_percent_raw?: number } {
  const n = finiteNumber(raw);
  if (n === null) return { used_percent: null };
  if (n < 0 || n > 100) return { used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: n };
  return { used_percent: n };
}

const NUMERIC_FIELDS = ['tokens_total', 'tokens_today', 'budget_tokens', 'remaining_tokens',
  'credits_remaining', 'credits_total', 'credits_used', 'usage_usd', 'limit_usd', 'remaining_usd',
  'spent_usd', 'remaining_credit_usd'] as const;
/** Fields the read-path schema requires to be nonnegative: a negative value is not a
 * measurement, it is dropped to null rather than failing the whole snapshot. */
const NONNEG_FIELDS = new Set(['tokens_total', 'tokens_today', 'budget_tokens']);
const CALL_STATUSES = new Set(['measured', 'failed', 'not_attempted']);
/** The sanitizer is an ALLOWLIST boundary (fix round 5, Dots 48a0a4f6 #2): only these
 * known output fields may survive it. Anything else on an untrusted source record —
 * extra fields carrying arbitrary payload text — is deleted, so a new field cannot
 * reach an output or a render without being added here and validated below. */
const ALLOWED_FIELDS = new Set(['agent', 'method', 'used_percent', 'used_percent_flag', 'used_percent_raw',
  'resets_at', 'resets_at_flag', 'observed_at', 'basis', 'agy_groups_min_remaining_fraction',
  'credits_status', 'usage_status', ...NUMERIC_FIELDS]);

/** Sanitize one untrusted source record in place (and return it). Covers every field
 * that can carry payload content into an output or a render: used_percent, resets_at,
 * observed_at (only when `nullObserved` — the read path; producers pass their own
 * fallback instead), the numeric meter fields, and the agy per-group fractions.
 * `basis` is NOT passed through here: producers build it from fixed strings only. */
export function sanitizeSourceFields(s: Record<string, unknown>, opts?: { nullObserved?: boolean }): Record<string, unknown> {
  for (const k of Object.keys(s)) if (!ALLOWED_FIELDS.has(k)) delete s[k];
  if ('used_percent' in s) {
    // A producer that already flagged an out-of-range percent stores used_percent as
    // null + flag + raw; recomputing from the null would delete that explanation
    // (Dots 48a0a4f6 #1), so a well-formed flag/raw pair is preserved verbatim.
    const prevFlag = s.used_percent_flag;
    const prevRaw = finiteNumber(s.used_percent_raw);
    const p = percentField(s.used_percent);
    s.used_percent = p.used_percent;
    if (p.used_percent_flag) { s.used_percent_flag = p.used_percent_flag; s.used_percent_raw = p.used_percent_raw; }
    else if (p.used_percent === null && prevFlag === 'out_of_range' && prevRaw !== null && (prevRaw < 0 || prevRaw > 100)) {
      s.used_percent_flag = 'out_of_range'; s.used_percent_raw = prevRaw;
    } else { delete s.used_percent_flag; delete s.used_percent_raw; }
  } else { delete s.used_percent_flag; delete s.used_percent_raw; }
  if ('resets_at' in s && s.resets_at !== null && s.resets_at !== undefined) {
    const ok = strictTimestamp(s.resets_at);
    if (ok === null) { s.resets_at = null; s.resets_at_flag = 'invalid_timestamp'; }
    else { s.resets_at = ok; delete s.resets_at_flag; }
  } else if (s.resets_at_flag !== 'invalid_timestamp') {
    // resets_at is null/absent: the flag survives only as the one fixed code, never
    // as payload text (Dots 48a0a4f6 #2).
    delete s.resets_at_flag;
  }
  if (opts?.nullObserved && 'observed_at' in s) {
    s.observed_at = strictTimestamp(s.observed_at);
  }
  for (const k of NUMERIC_FIELDS) {
    if (k in s && s[k] !== null && s[k] !== undefined) {
      const n = finiteNumber(s[k]);
      s[k] = n !== null && NONNEG_FIELDS.has(k) && n < 0 ? null : n;
    }
  }
  for (const k of ['credits_status', 'usage_status'] as const) {
    if (k in s && !(typeof s[k] === 'string' && CALL_STATUSES.has(s[k]))) delete s[k];
  }
  if ('agy_groups_min_remaining_fraction' in s) {
    const groups = s.agy_groups_min_remaining_fraction;
    if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
      // Group keys are untrusted payload text too: producers label groups positionally
      // (group_1, group_2, ...), so only that exact shape survives (Dots 48a0a4f6 #2).
      // Values are fractions (schema side: min 0, max 1): only finite numbers inside
      // [0,1] survive — an out-of-range value is not a measurement, it is dropped,
      // never clamped into one.
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(groups as Record<string, unknown>)) { const n = finiteNumber(v); if (n !== null && n >= 0 && n <= 1 && /^group_\d+$/.test(k)) clean[k] = n; }
      s.agy_groups_min_remaining_fraction = clean;
    } else if (groups !== null && groups !== undefined) {
      // Wrong shape entirely (string, array, scalar, boolean): the field is a
      // per-group fraction map or nothing. It sits in ALLOWED_FIELDS, so without
      // this branch it passed through the sanitizer untouched into the read path
      // (Dots d1060027) — delete it like the invalid enum fields above.
      delete s.agy_groups_min_remaining_fraction;
    }
  }
  return s;
}
