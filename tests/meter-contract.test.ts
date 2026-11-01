// METER-CONTRACT round 2 — test contract (docs/meter-contract.md v2).
// This file pins, as executable tests:
//  (a) the zod schema fix6 must adopt unchanged into the real schema path
//      (closed discriminated unions for percent / resets_at / source
//      results, closed enums for agent/method/plan/basis/flags/reasons,
//      per-source field families), and
//  (b) the v1 inventory completeness rule: every v1 field named in the
//      inventory below must be addressed by name in the contract doc.
// These tests exercise the CONTRACT shapes only. They are not a runtime
// PASS: no producer, collector, MCP or live path is wired to this schema
// yet — that is fix6, gated on a contract PASS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';

// --- METER-PROVENANCE (split piece 1): strict timestamp primitive ---------
// A timestamp is valid only as an exact ISO-8601 UTC string whose components
// survive a Date.UTC round-trip (Feb 30, month 13, and free strings are not
// timestamps). This helper is the contract primitive fix6 adopts for every
// timestamp slot (resets_at / observed_at / failed_at / provenance times).
export function isStrictTimestamp(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?Z$/.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), se = Number(m[6]);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
    && dt.getUTCHours() === h && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === se;
}
export const strictTs = z.string().refine(isStrictTimestamp, 'strict timestamp');

const AGENTS = ['codex', 'grok_cli', 'grokbot', 'muse', 'ssu', 'openrouter', 'agy', 'claude'] as const;
const METHODS = ['measured', 'ledger', 'estimated', 'unavailable'] as const;
const PLANS = ['free', 'plus', 'pro', 'team', 'business', 'enterprise', 'edu', 'unrecognized'] as const;
const CALL_STATUSES = ['measured', 'failed', 'not_attempted'] as const;
const REASONS = [
  'no_valid_entries', 'malformed_source', 'fs_error', 'overflow', 'missing',
  'gateway_read_failed', 'gateway_timeout', 'parse_failed', 'key_not_set',
  'ledger_missing', 'ledger_read_failed', 'ledger_malformed', 'no_local_source', 'conflict',
] as const;
const BASIS_CODES = [
  'codex_rate_limits', 'codex_stale_reset', 'codex_no_rate_limits', 'ccusage_tokens',
  'grokbot_no_source', 'muse_ledger', 'ledger_missing', 'ledger_read_failed', 'ledger_malformed',
  'ssu_gateway', 'ssu_no_numeric_fields', 'ssu_partial', 'openrouter_key',
  'openrouter_no_usage_field', 'openrouter_key_not_set', 'openrouter_read_failed',
  'agy_usage', 'agy_no_numeric_bucket', 'agy_unavailable', 'agy_parse_failed',
  'claude_credit_ledger', 'legacy_unmapped',
] as const;

const percentField = z.union([
  z.object({ used_percent: z.number().min(0).max(100) }).strict(),
  z.object({ used_percent: z.null(), used_percent_flag: z.literal('out_of_range'), used_percent_raw: z.number().finite() }).strict(),
  z.object({ used_percent: z.null() }).strict(),
]);
const resetsAtField = z.union([
  z.object({ resets_at: strictTs }).strict(),
  z.object({ resets_at: z.null(), resets_at_flag: z.literal('invalid_timestamp') }).strict(),
  z.object({ resets_at: z.null() }).strict(),
]);
const groupKey = z.string().regex(/^group_[1-9]\d*$/);
const fieldOutcome = z.object({
  field: z.enum(['credits', 'usage', 'key', 'buckets', 'ledger', 'sessions', 'credit_ledger', 'wake_log']),
  status: z.enum(['measured', 'failed', 'not_attempted', 'ok']),
  reason: z.enum(REASONS).optional(),
}).strict();
const skippedEntry = z.object({
  reason: z.enum([...REASONS, 'invalid_entry', 'negative_value', 'non_numeric']),
}).strict();

/** R3 (doc 16.8): UnitUsage values in a canonical record — every value is
 * a finite non-negative number (a negative unit value is invalid in
 * conversion, S20). Mirrors UnitUsage in src/server/usage-contract.ts. */
const unitUsage = z.object({
  wakes: z.number().finite().nonnegative(),
  input: z.number().finite().nonnegative(),
  output: z.number().finite().nonnegative(),
  cache_read: z.number().finite().nonnegative(),
  cache_write: z.number().finite().nonnegative(),
  tokens_total: z.number().finite().nonnegative(),
  cost_usd: z.number().finite().nonnegative(),
  api_wakes: z.number().finite().nonnegative(),
}).strict();

/** R3 (doc 16.8): a canonical window is the flat PercentField &
 * ResetsAtField & { window_minutes } of CanonicalWindow in the src types:
 * a window's own resets_at_flag rides in the window itself (S21), and the
 * percent flag/raw pair stays exclusive exactly as at the top level. */
const canonicalWindow = z.object({
  used_percent: z.number().min(0).max(100).nullable(),
  used_percent_flag: z.literal('out_of_range').optional(),
  used_percent_raw: z.number().finite().optional(),
  resets_at: strictTs.nullable(),
  resets_at_flag: z.literal('invalid_timestamp').optional(),
  window_minutes: z.number().finite().positive().nullable(),
}).strict().superRefine((w, ctx) => {
  if (w.used_percent_flag !== undefined && (w.used_percent !== null || w.used_percent_raw === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'out_of_range window percent is exactly null+flag+finite raw' });
  }
  if (w.used_percent_flag === undefined && w.used_percent_raw !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'window percent raw requires the out_of_range flag' });
  }
  if (w.resets_at_flag !== undefined && w.resets_at !== null) {
    ctx.addIssue({ code: 'custom', message: 'a flagged window reset is null+flag, never a copied raw value' });
  }
});

export const canonicalRecord = z.object({
  source: z.enum(AGENTS),
  method: z.enum(METHODS),
  percent: percentField,
  resets: resetsAtField,
  plan: z.enum(PLANS).optional(),
  basis_code: z.enum(BASIS_CODES),
  basis_params: z.object({
    window_minutes: z.union([z.number().finite().positive(), z.literal('unknown')]).optional(),
    plan: z.enum(PLANS).optional(),
    entries: z.number().int().nonnegative().optional(),
    group_key: groupKey.optional(),
    out_of_range: z.boolean().optional(),
    invalid_timestamp: z.boolean().optional(),
    expired: z.boolean().optional(),
  }).strict().optional(),
  tokens_total: z.number().nonnegative().nullable().optional(),
  tokens_today: z.number().nonnegative().nullable().optional(),
  budget_tokens: z.number().nonnegative().nullable().optional(),
  remaining_tokens: z.number().nullable().optional(),
  credits_remaining: z.number().nullable().optional(),
  credits_total: z.number().nullable().optional(),
  credits_used: z.number().nullable().optional(),
  credits_status: z.enum(CALL_STATUSES).optional(),
  usage_status: z.enum(CALL_STATUSES).optional(),
  usage_usd: z.number().nullable().optional(),
  limit_usd: z.number().nullable().optional(),
  remaining_usd: z.number().nullable().optional(),
  spent_usd: z.number().nullable().optional(),
  remaining_credit_usd: z.number().nullable().optional(),
  credit_expired: z.boolean().optional(),
  credit_expires_at: strictTs.nullable().optional(),
  agy_groups_min_remaining_fraction: z.record(groupKey, z.number().min(0).max(1)).optional(),
  units: z.record(z.string(), unitUsage).optional(),
  windows: z.array(canonicalWindow).optional(),
  observed_at: strictTs.nullable(),
  provenance: z.object({
    snapshot_message_id: z.string().optional(),
    posted_by: z.string().optional(),
    collected_at: strictTs.optional(),
    ledger_source_message_id: z.string().optional(),
  }).strict(),
}).strict().superRefine((r, ctx) => {
  // Per-source field families: SSU credits and OpenRouter/Claude USD never mix.
  if (r.credits_total !== undefined && r.usage_usd !== undefined) {
    ctx.addIssue({ code: 'custom', message: 'credits and usd families must not mix' });
  }
  if (r.plan !== undefined && r.source !== 'codex') {
    ctx.addIssue({ code: 'custom', message: 'plan is codex-only' });
  }
});

export const sourceResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), record: canonicalRecord, fields: z.array(fieldOutcome), skipped: z.array(skippedEntry) }).strict(),
  z.object({ kind: z.literal('partial'), record: canonicalRecord, fields: z.array(fieldOutcome).min(1), skipped: z.array(skippedEntry) }).strict(),
  z.object({
    kind: z.literal('unavailable'), source: z.enum(AGENTS), reason: z.enum(REASONS),
    failed_at: strictTs.nullable(), fields: z.array(fieldOutcome),
  }).strict(),
]);

const base = {
  source: 'ssu' as const, method: 'measured' as const,
  percent: { used_percent: 42.5 }, resets: { resets_at: null },
  basis_code: 'ssu_gateway' as const, observed_at: '2026-10-27T10:00:00.000Z',
  credits_remaining: 1200, credits_total: 3000, credits_used: 1800,
  credits_status: 'measured' as const, usage_status: 'measured' as const,
  provenance: { snapshot_message_id: 'msg-1', posted_by: 'agent:grok', collected_at: '2026-10-27T10:00:00.000Z' },
};

test('C1: a measured SSU record passes the v2 schema', () => {
  assert.equal(canonicalRecord.safeParse(base).success, true);
});

test('C2: SSU partial (credits ok, usage failed) is a partial SourceResult, valid fields kept', () => {
  const partial = {
    kind: 'partial', record: { ...base, percent: { used_percent: null }, basis_code: 'ssu_partial', usage_status: 'failed' },
    fields: [
      { field: 'credits', status: 'measured' },
      { field: 'usage', status: 'failed', reason: 'gateway_read_failed' },
    ],
    skipped: [],
  };
  assert.equal(sourceResult.safeParse(partial).success, true);
});

test('C3: out_of_range percent is exactly null+flag+finite raw', () => {
  const okShape = { ...base, percent: { used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: 150 } };
  assert.equal(canonicalRecord.safeParse(okShape).success, true);
  const flagNoRaw = { ...base, percent: { used_percent: null, used_percent_flag: 'out_of_range' } };
  assert.equal(canonicalRecord.safeParse(flagNoRaw).success, false);
  const measuredWithFlag = { ...base, percent: { used_percent: 50, used_percent_flag: 'out_of_range', used_percent_raw: 150 } };
  assert.equal(canonicalRecord.safeParse(measuredWithFlag).success, false);
  const measured150 = { ...base, percent: { used_percent: 150 } };
  assert.equal(canonicalRecord.safeParse(measured150).success, false);
});

test('C4: invalid resets_at can only be null+flag, never a copied raw value', () => {
  const okShape = { ...base, resets: { resets_at: null, resets_at_flag: 'invalid_timestamp' } };
  assert.equal(canonicalRecord.safeParse(okShape).success, true);
  // Flag + a string value together match no union branch (strict objects):
  // the flag exists only paired with null, so a copied raw value cannot ride along.
  const flagged = { ...base, resets: { resets_at: '2026-02-30T00:00:00.000Z', resets_at_flag: 'invalid_timestamp' } };
  assert.equal(canonicalRecord.safeParse(flagged).success, false);
});

test('C5: basis is a closed code — free-text basis is rejected in v2', () => {
  const freeText = { ...base, basis_code: 'SSU gateway GET /credits (some free text)' };
  assert.equal(canonicalRecord.safeParse(freeText).success, false);
  const withOldField = { ...base, basis: 'free text' };
  assert.equal(canonicalRecord.safeParse(withOldField).success, false);
});

test('C6: plan is a closed codex-only enum', () => {
  const codex = { ...base, source: 'codex', plan: 'pro', credits_remaining: undefined, credits_total: undefined, credits_used: undefined, credits_status: undefined, usage_status: undefined };
  assert.equal(canonicalRecord.safeParse(codex).success, true);
  assert.equal(canonicalRecord.safeParse({ ...codex, plan: 'SECRET-MARKER' }).success, false);
  assert.equal(canonicalRecord.safeParse({ ...base, plan: 'pro' }).success, false); // plan on ssu rejected
});

test('C7: agy group keys are positional group_N only', () => {
  const agy = { ...base, source: 'agy', basis_code: 'agy_usage', credits_remaining: undefined, credits_total: undefined, credits_used: undefined, credits_status: undefined, usage_status: undefined, agy_groups_min_remaining_fraction: { group_1: 0.5, group_12: 0.25 } };
  assert.equal(canonicalRecord.safeParse(agy).success, true);
  const evil = { ...agy, agy_groups_min_remaining_fraction: { 'evil-name': 0.5 } };
  assert.equal(canonicalRecord.safeParse(evil).success, false);
  const zeroBased = { ...agy, agy_groups_min_remaining_fraction: { group_0: 0.5 } };
  assert.equal(canonicalRecord.safeParse(zeroBased).success, false);
});

test('C8: unavailable carries reason + failed_at and no record', () => {
  const un = { kind: 'unavailable', source: 'muse', reason: 'ledger_missing', failed_at: '2026-10-27T10:00:00.000Z', fields: [{ field: 'ledger', status: 'failed', reason: 'ledger_missing' }] };
  assert.equal(sourceResult.safeParse(un).success, true);
  assert.equal(sourceResult.safeParse({ ...un, record: base }).success, false);
  assert.equal(sourceResult.safeParse({ ...un, reason: 'some free text' }).success, false);
});

test('C9: credits and USD families never mix in one record', () => {
  assert.equal(canonicalRecord.safeParse({ ...base, usage_usd: 3.2 }).success, false);
  const or = { ...base, source: 'openrouter', basis_code: 'openrouter_key', credits_remaining: undefined, credits_total: undefined, credits_used: undefined, credits_status: undefined, usage_status: undefined, usage_usd: 3.2, limit_usd: 10, remaining_usd: 6.8 };
  assert.equal(canonicalRecord.safeParse(or).success, true);
});

test('C10: unknown agent / method values are rejected', () => {
  assert.equal(canonicalRecord.safeParse({ ...base, source: 'nobody' }).success, false);
  assert.equal(canonicalRecord.safeParse({ ...base, method: 'guessed' }).success, false);
});

test('C11: v1 inventory — every v1 field is addressed by name in the contract doc', () => {
  const doc = readFileSync(new URL('../docs/meter-contract.md', import.meta.url), 'utf8');
  const v1Fields = [
    'kind', 'collected_at', 'agent', 'method', 'used_percent', 'used_percent_flag', 'used_percent_raw',
    'resets_at', 'resets_at_flag', 'window_minutes', 'tokens_total', 'tokens_today', 'budget_tokens',
    'remaining_tokens', 'credits_remaining', 'credits_total', 'credits_used', 'credits_status', 'usage_status',
    'usage_usd', 'limit_usd', 'remaining_usd', 'spent_usd', 'remaining_credit_usd', 'credit_expired',
    'credit_expires_at', 'null_reason', 'agy_groups_min_remaining_fraction', 'units', 'observed_at',
    'basis', 'plan_type', 'source_message_id', 'message_id', 'posted_by',
  ];
  for (const f of v1Fields) assert.ok(doc.includes(f), `contract doc must address v1 field: ${f}`);
});

test('C12: fixed probe registry is stated in the doc with its expected counts', () => {
  const doc = readFileSync(new URL('../docs/meter-contract.md', import.meta.url), 'utf8');
  for (const needle of ['62', '09cb3679', '4a216b5b', '99d9daa3', 'dcae077b', 'a1a07ded', '328d8067', 'c2812000', '6ecc72e7', '656ffd9a']) {
    assert.ok(doc.includes(needle), `contract doc must pin probe/count: ${needle}`);
  }
});

// ===========================================================================
// METER-PROVENANCE — split piece 1 of 3 (ruling 3f88ce38, Dots frozen list
// 0f0a30a7). Pins, as executable contract for fix6:
//  (a) every timestamp slot is the strict primitive above — never a free
//      string (closes the r2 safety HOLD on resets_at/observed_at/
//      failed_at/provenance);
//  (b) trusted DB provenance (message id / actor / room / room time, read
//      server-side from the DB) is a DIFFERENT shape from untrusted payload
//      claims, and the two are cross-checked deterministically;
//  (c) same-id conflicts are decided on an evidence path (id + full content
//      sha256), never on a message_current pointer alone;
//  (d) stale-success redisplay: latest failure is shown, display has a max
//      age, and automated decisions fail closed whenever not fresh+verified.
// These tests exercise the CONTRACT shapes and reference decisions only.
// They are not a runtime PASS: fix6 adopts them after all three split
// pieces PASS (PROVENANCE -> SCHEMA-V1 -> PARTIAL).
// ===========================================================================

export const trustedProvenance = z.object({
  db_message_id: z.string().min(1),
  db_actor: z.string().min(1),
  db_room: z.string().min(1),
  db_created_at: strictTs,
}).strict();

export const payloadProvenanceClaims = z.object({
  claimed_snapshot_message_id: z.string().min(1).optional(),
  claimed_posted_by: z.string().min(1).optional(),
  claimed_collected_at: strictTs.optional(),
  claimed_ledger_source_message_id: z.string().min(1).optional(),
}).strict();

export const PROVENANCE_STATES = ['verified', 'malformed', 'conflict', 'stale', 'unavailable'] as const;

export const provenanceEnvelope = z.object({
  trusted: trustedProvenance.nullable(),
  payload_claims: payloadProvenanceClaims,
  state: z.enum(PROVENANCE_STATES),
}).strict();

export const evidenceRef = z.object({
  db_message_id: z.string().min(1),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  db_created_at: strictTs,
}).strict();

export const attemptProvenance = z.object({
  trusted: trustedProvenance,
  failed_at: strictTs.nullable(),
  reason: z.enum(REASONS),
}).strict();

type Trusted = z.infer<typeof trustedProvenance>;
type Claims = z.infer<typeof payloadProvenanceClaims>;

/** Deterministic cross-check (contract decision, doc section 15): a present
 * claim that differs from the trusted DB value is a conflict; absent claims
 * are verified against the trusted record alone; a payload that cannot be
 * parsed into the claims shape is malformed (decided at the parse layer). */
export function crossCheckProvenance(trusted: Trusted, claims: Claims): 'verified' | 'conflict' {
  if (claims.claimed_snapshot_message_id !== undefined && claims.claimed_snapshot_message_id !== trusted.db_message_id) return 'conflict';
  if (claims.claimed_posted_by !== undefined && claims.claimed_posted_by !== trusted.db_actor) return 'conflict';
  if (claims.claimed_collected_at !== undefined && claims.claimed_collected_at !== trusted.db_created_at) return 'conflict';
  return 'verified';
}

/** Same-id evidence verdict: identity is (db_message_id, content_sha256).
 * Equal id + equal hash is an idempotent duplicate; equal id + different
 * hash is a conflict; different id is a distinct record. A current-pointer
 * (message_current) plays no part in this decision. */
export function evidenceVerdict(a: z.infer<typeof evidenceRef>, b: z.infer<typeof evidenceRef>): 'duplicate' | 'conflict' | 'distinct' {
  if (a.db_message_id !== b.db_message_id) return 'distinct';
  return a.content_sha256 === b.content_sha256 ? 'duplicate' : 'conflict';
}

export const STALE_DISPLAY_MAX_AGE_MS = 86_400_000; // 24h

/** Stale-success redisplay decision (contract decision, doc section 15).
 * `display` is what a human render may show; `automated` is whether an
 * automated decision may rely on the record. Automated use requires a
 * verified provenance state, no failure at/after the valid observation,
 * and age within the max-age bound — anything else fails closed. */
export function staleDecision(input: {
  provenance_state: (typeof PROVENANCE_STATES)[number];
  valid_observed_at: string | null;
  latest_failure_at: string | null;
  now: string;
}): { display: 'fresh' | 'stale_with_failure' | 'unavailable'; automated: boolean } {
  if (input.provenance_state === 'conflict' || input.provenance_state === 'malformed') {
    return { display: 'unavailable', automated: false };
  }
  if (input.valid_observed_at === null || !isStrictTimestamp(input.valid_observed_at) || !isStrictTimestamp(input.now)) {
    return { display: 'unavailable', automated: false };
  }
  const age = Date.parse(input.now) - Date.parse(input.valid_observed_at);
  if (age < 0 || age > STALE_DISPLAY_MAX_AGE_MS) return { display: 'unavailable', automated: false };
  if (input.latest_failure_at !== null && isStrictTimestamp(input.latest_failure_at)
    && Date.parse(input.latest_failure_at) >= Date.parse(input.valid_observed_at)) {
    return { display: 'stale_with_failure', automated: false };
  }
  if (input.provenance_state !== 'verified') return { display: 'stale_with_failure', automated: false };
  return { display: 'fresh', automated: true };
}

const TRUSTED = {
  db_message_id: 'b43975ef-0531-4de8-9c3e-a1634797f5a1',
  db_actor: 'agent:muse',
  db_room: 'room_main',
  db_created_at: '2026-10-27T10:46:21.649Z',
};
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('P1: every timestamp slot rejects non-strict values (Feb 30, month 13, free strings)', () => {
  for (const bad of ['2026-02-30T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-02-29T00:00:00.000Z', 'not-a-date', 'SECRET-MARKER', '2026-10-27 10:00:00']) {
    assert.equal(canonicalRecord.safeParse({ ...base, resets: { resets_at: bad } }).success, false, `resets_at must reject ${bad}`);
    assert.equal(canonicalRecord.safeParse({ ...base, observed_at: bad }).success, false, `observed_at must reject ${bad}`);
    assert.equal(sourceResult.safeParse({ kind: 'unavailable', source: 'muse', reason: 'missing', failed_at: bad, fields: [] }).success, false, `failed_at must reject ${bad}`);
    assert.equal(canonicalRecord.safeParse({ ...base, provenance: { ...base.provenance, collected_at: bad } }).success, false, `provenance.collected_at must reject ${bad}`);
  }
  assert.equal(canonicalRecord.safeParse({ ...base, resets: { resets_at: '2024-02-29T00:00:00.000Z' } }).success, true, 'leap day 2024-02-29 is strict-valid');
});

test('P2: trusted DB provenance is its own strict shape, separate from payload claims', () => {
  assert.equal(trustedProvenance.safeParse(TRUSTED).success, true);
  assert.equal(trustedProvenance.safeParse({ ...TRUSTED, db_room: undefined }).success, false, 'room is required');
  assert.equal(trustedProvenance.safeParse({ ...TRUSTED, claimed_snapshot_message_id: 'x' }).success, false, 'payload claim keys cannot ride inside the trusted shape');
  assert.equal(trustedProvenance.safeParse({ ...TRUSTED, db_created_at: '2026-02-30T00:00:00.000Z' }).success, false, 'room time is strict');
  assert.equal(provenanceEnvelope.safeParse({ trusted: TRUSTED, payload_claims: {}, state: 'verified' }).success, true);
  assert.equal(provenanceEnvelope.safeParse({ trusted: TRUSTED, payload_claims: {}, state: 'looks-fine' }).success, false, 'state is a closed enum');
});

test('P3: cross-check — matching claims verify, any differing claim is a conflict', () => {
  assert.equal(crossCheckProvenance(TRUSTED, {}), 'verified');
  assert.equal(crossCheckProvenance(TRUSTED, { claimed_snapshot_message_id: TRUSTED.db_message_id, claimed_posted_by: TRUSTED.db_actor, claimed_collected_at: TRUSTED.db_created_at }), 'verified');
  assert.equal(crossCheckProvenance(TRUSTED, { claimed_snapshot_message_id: 'other-id' }), 'conflict');
  assert.equal(crossCheckProvenance(TRUSTED, { claimed_posted_by: 'agent:mallory' }), 'conflict');
  assert.equal(crossCheckProvenance(TRUSTED, { claimed_collected_at: '2026-10-27T10:46:22.649Z' }), 'conflict');
  assert.equal(payloadProvenanceClaims.safeParse({ claimed_collected_at: '2026-02-30T00:00:00.000Z' }).success, false, 'a malformed claimed time is decided at the parse layer');
});

test('P4: same-id evidence — duplicate is idempotent, different full hash is a conflict', () => {
  const a = { db_message_id: TRUSTED.db_message_id, content_sha256: HASH_A, db_created_at: TRUSTED.db_created_at };
  assert.equal(evidenceVerdict(a, { ...a }), 'duplicate');
  assert.equal(evidenceVerdict(a, { ...a, content_sha256: HASH_B }), 'conflict');
  assert.equal(evidenceVerdict(a, { ...a, db_message_id: 'another-id' }), 'distinct');
  assert.equal(evidenceRef.safeParse({ ...a, content_sha256: HASH_A.slice(0, 16) }).success, false, 'a hash prefix is not evidence — the full sha256 is required');
  assert.equal(evidenceRef.safeParse({ ...a, content_sha256: HASH_A.toUpperCase() }).success, false, 'hash is lowercase hex');
});

test('P5: an unavailable attempt still carries trusted provenance, room time and failure time', () => {
  const attempt = { trusted: TRUSTED, failed_at: '2026-10-27T10:50:00.000Z', reason: 'gateway_read_failed' as const };
  assert.equal(attemptProvenance.safeParse(attempt).success, true);
  assert.equal(attemptProvenance.safeParse({ ...attempt, failed_at: 'SECRET-MARKER' }).success, false);
  assert.equal(attemptProvenance.safeParse({ ...attempt, reason: 'some free text' }).success, false, 'failure reason is a fixed code');
  assert.equal(provenanceEnvelope.safeParse({ trusted: null, payload_claims: {}, state: 'unavailable' }).success, true, 'no trusted record yet is representable, as unavailable only');
});

test('P6: stale redisplay — latest failure shown, max age bounds display, automated use fails closed', () => {
  const valid = '2026-10-27T10:00:00.000Z';
  assert.deepEqual(staleDecision({ provenance_state: 'verified', valid_observed_at: valid, latest_failure_at: null, now: '2026-10-27T11:00:00.000Z' }), { display: 'fresh', automated: true });
  assert.deepEqual(staleDecision({ provenance_state: 'stale', valid_observed_at: valid, latest_failure_at: '2026-10-27T10:30:00.000Z', now: '2026-10-27T11:00:00.000Z' }), { display: 'stale_with_failure', automated: false }, 'failure after success: human sees value WITH the latest failure; automated decisions refuse');
  assert.deepEqual(staleDecision({ provenance_state: 'verified', valid_observed_at: valid, latest_failure_at: null, now: '2026-10-28T10:00:00.001Z' }), { display: 'unavailable', automated: false }, 'older than STALE_DISPLAY_MAX_AGE_MS (24h) is not displayed at all');
  assert.deepEqual(staleDecision({ provenance_state: 'conflict', valid_observed_at: valid, latest_failure_at: null, now: '2026-10-27T11:00:00.000Z' }), { display: 'unavailable', automated: false });
  assert.deepEqual(staleDecision({ provenance_state: 'verified', valid_observed_at: null, latest_failure_at: null, now: '2026-10-27T11:00:00.000Z' }), { display: 'unavailable', automated: false });
});

test('P7: doc addresses the PROVENANCE checklist by name (trusted/payload separation, evidence path, stale policy)', () => {
  const doc = readFileSync(new URL('../docs/meter-contract.md', import.meta.url), 'utf8');
  for (const needle of ['METER-PROVENANCE', 'db_message_id', 'db_actor', 'db_room', 'db_created_at', 'payload_claims', 'content_sha256', 'message_current', 'STALE_DISPLAY_MAX_AGE_MS', '86400000', 'crossCheckProvenance', 'evidenceVerdict', 'staleDecision']) {
    assert.ok(doc.includes(needle), `contract doc must address PROVENANCE item: ${needle}`);
  }
});

// ===========================================================================
// METER-PROVENANCE round 2 — Dots FAIL 209ec950 + grok fix list 597e9bba
// (item 8 as corrected by 51049288). Pins Q1-Q8 for doc section 15A:
//  Q1 verified excludes trusted=null
//  Q2 failure time is at | unknown | none — unknown is not none
//  Q3 same-timestamp tie-break is a total order
//  Q4 missing DB history fails closed; the hash covers exactly the stored
//     content string's UTF-8 bytes
//  Q5 collected_at is not required to equal the posting time; canonical
//     slot format is UTC Z, offsets normalize at the boundary
//  Q6 an unavailable attempt links to the canonical chain by its own
//     trusted row (predecessor rule)
//  Q7 an empty claim never verifies; a DB actor match alone does not prove
//     reporting authority; unverified source ids render as a closed
//     unknown variant, never raw
//  Q8 the doc addresses round 2 by name
// RED state: the R2 names below are not yet defined, so Q1-Q8 fail while
// C1-C12 and P1-P7 stay green.
// ===========================================================================

test('Q1: verified excludes trusted=null', () => {
  assert.equal(provenanceEnvelopeR2.safeParse({ trusted: null, payload_claims: {}, state: 'verified' }).success, false, 'trusted=null can never be verified');
  assert.equal(provenanceEnvelopeR2.safeParse({ trusted: null, payload_claims: {}, state: 'unavailable' }).success, true, 'trusted=null is representable only as unavailable');
  assert.equal(provenanceEnvelopeR2.safeParse({ trusted: TRUSTED, payload_claims: {}, state: 'verified' }).success, true);
  assert.equal(resolveProvenanceR2({ trusted: null, claims: {}, authority: { kind: 'shown' } }), 'unavailable');
});

test('Q2: failure time distinguishes at | unknown | none', () => {
  assert.equal(failureTime.safeParse({ kind: 'at', at: '2026-10-27T10:50:00.000Z' }).success, true);
  assert.equal(failureTime.safeParse({ kind: 'unknown' }).success, true, 'a failure whose time is unknown is representable');
  assert.equal(failureTime.safeParse({ kind: 'none' }).success, true, 'no failure is a different value from unknown failure time');
  assert.equal(failureTime.safeParse({ kind: 'at', at: '2026-02-30T00:00:00.000Z' }).success, false, 'the at slot is strict');
  assert.equal(failureTime.safeParse({ kind: 'at' }).success, false, 'at requires the time');
  assert.equal(failureTime.safeParse(null).success, false, 'null is ambiguous and is not a failure time');
  const attempt = { trusted: TRUSTED, failure_time: { kind: 'unknown' }, reason: 'gateway_read_failed' as const };
  assert.equal(attemptProvenanceR2.safeParse(attempt).success, true);
  assert.equal(attemptProvenanceR2.safeParse({ ...attempt, failure_time: { kind: 'none' } }).success, false, 'a failed attempt cannot claim no failure');
  const valid = '2026-10-27T10:00:00.000Z';
  assert.deepEqual(staleDecisionR2({ provenance_state: 'verified', valid_observed_at: valid, latest_failure: { kind: 'none' }, now: '2026-10-27T11:00:00.000Z' }), { display: 'fresh', automated: true }, 'no failure: fresh');
  assert.deepEqual(staleDecisionR2({ provenance_state: 'verified', valid_observed_at: valid, latest_failure: { kind: 'unknown' }, now: '2026-10-27T11:00:00.000Z' }), { display: 'stale_with_failure', automated: false }, 'a failure with unknown time cannot be ordered after the valid record, so it fails closed');
  assert.deepEqual(staleDecisionR2({ provenance_state: 'verified', valid_observed_at: valid, latest_failure: { kind: 'at', at: '2026-10-27T09:00:00.000Z' }, now: '2026-10-27T11:00:00.000Z' }), { display: 'fresh', automated: true }, 'a failure strictly before the valid observation does not stale it');
});

test('Q3: same-timestamp tie-break is a deterministic total order', () => {
  const baseRef = { db_message_id: 'id-b', content_sha256: HASH_A, db_created_at: '2026-10-27T10:00:00.000Z', observed_at: '2026-10-27T10:00:00.000Z' };
  const laterRoom = { ...baseRef, db_message_id: 'id-a', db_created_at: '2026-10-27T10:05:00.000Z' };
  assert.equal(selectLatestEvidence([baseRef, laterRoom])?.db_message_id, 'id-a', 'equal observed_at: later trusted room time wins');
  assert.equal(selectLatestEvidence([laterRoom, baseRef])?.db_message_id, 'id-a', 'order of the input array does not matter');
  const laterObs = { ...baseRef, db_message_id: 'id-c', observed_at: '2026-10-27T10:10:00.000Z', db_created_at: '2026-10-27T09:00:00.000Z' };
  assert.equal(selectLatestEvidence([laterRoom, laterObs])?.db_message_id, 'id-c', 'observed_at is the primary key');
  const biggerId = { ...baseRef, db_message_id: 'id-z' };
  assert.equal(selectLatestEvidence([baseRef, biggerId])?.db_message_id, 'id-z', 'full tie on both times: lexicographically greater message id wins');
  const biggerHash = { ...baseRef, content_sha256: HASH_B };
  assert.equal(selectLatestEvidence([baseRef, biggerHash]), null, 'full tie on times and id with divergent hashes: rejected with a conflict reason — superseded by PM ruling on c99fc03d (fail-closed > tie-break); see R3-1 and doc 15B');
  assert.equal(compareEvidenceOrder(baseRef, { ...baseRef }), 0, 'identical refs are equal (duplicate, section 15.4)');
  assert.equal(Math.sign(compareEvidenceOrder(baseRef, laterRoom)), -1);
  assert.equal(Math.sign(compareEvidenceOrder(laterRoom, baseRef)), 1, 'the order is antisymmetric');
  assert.equal(selectLatestEvidence([]), null, 'no records: no selection');
});

test('Q4: missing DB history fails closed, and the hash covers exactly the stored content bytes', () => {
  assert.equal(hashStoredContent('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256 of the UTF-8 bytes of the stored content string');
  assert.equal(hashStoredContent(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'empty content hashes as empty input — no metadata is mixed in');
  const a = { db_message_id: TRUSTED.db_message_id, content_sha256: HASH_A, db_created_at: TRUSTED.db_created_at };
  assert.equal(evidenceVerdictR2(a, null), 'unknown_history', 'a missing counterpart row is not distinct, duplicate or conflict — it is unknown');
  assert.equal(evidenceVerdictR2(null, a), 'unknown_history');
  assert.equal(evidenceVerdictR2({ ...a, content_sha256: null }, a), 'unknown_history', 'a row without a recorded hash has no evidence');
  assert.equal(evidenceVerdictR2(a, { ...a }), 'duplicate');
  assert.equal(evidenceVerdictR2(a, { ...a, content_sha256: HASH_B }), 'conflict');
  assert.equal(evidenceVerdictR2(a, { ...a, db_message_id: 'another-id' }), 'distinct');
});

test('Q5: collected_at need not equal posting time; canonical slots are UTC Z', () => {
  assert.equal(POSTING_DELAY_MAX_MS, 3_600_000);
  assert.equal(crossCheckProvenanceR2(TRUSTED, { claimed_collected_at: '2026-10-27T10:36:21.649Z' }), 'verified', 'collected 10 minutes before the room time is normal delay, not a conflict');
  assert.equal(crossCheckProvenanceR2(TRUSTED, { claimed_collected_at: TRUSTED.db_created_at }), 'verified', 'zero delay verifies');
  assert.equal(crossCheckProvenanceR2(TRUSTED, { claimed_collected_at: '2026-10-27T09:46:21.649Z' }), 'verified', 'delay exactly at the max bound verifies');
  assert.equal(crossCheckProvenanceR2(TRUSTED, { claimed_collected_at: '2026-10-27T09:46:20.649Z' }), 'conflict', 'delay beyond the max bound is a conflict');
  assert.equal(crossCheckProvenanceR2(TRUSTED, { claimed_collected_at: '2026-10-27T10:46:22.649Z' }), 'conflict', 'collected after posting is impossible and conflicts');
  assert.equal(crossCheckProvenanceR2(TRUSTED, { claimed_snapshot_message_id: 'other-id', claimed_collected_at: '2026-10-27T10:36:21.649Z' }), 'conflict', 'id and actor claims still compare exactly');
  assert.equal(isStrictTimestamp('2026-10-27T19:00:00.000+09:00'), false, 'an offset form is not a canonical slot value');
  assert.equal(normalizeTimestamp('2026-10-27T19:00:00.000+09:00'), '2026-10-27T10:00:00.000Z', 'offsets normalize to UTC Z at the boundary');
  assert.equal(normalizeTimestamp('2026-10-27T10:00:00.000Z'), '2026-10-27T10:00:00.000Z');
  assert.equal(normalizeTimestamp('2026-02-30T19:00:00.000+09:00'), null, 'a nonexistent date does not normalize');
  assert.equal(normalizeTimestamp('SECRET-MARKER'), null);
});

test('Q6: an unavailable attempt links to the canonical chain by its own trusted row', () => {
  const before = { db_message_id: 'id-before', content_sha256: HASH_A, db_created_at: '2026-10-27T10:00:00.000Z', observed_at: '2026-10-27T10:00:00.000Z' };
  const after = { db_message_id: 'id-after', content_sha256: HASH_B, db_created_at: '2026-10-27T11:00:00.000Z', observed_at: '2026-10-27T11:00:00.000Z' };
  const linked = linkUnavailable(TRUSTED, [before, after]);
  assert.equal(linked.link_state, 'linked');
  assert.equal(linked.predecessor_message_id, 'id-before', 'the predecessor is the latest verified record at or before the attempt room time (10:46) — the 11:00 record is not a predecessor');
  assert.equal(linked.attempt_message_id, TRUSTED.db_message_id, 'the attempt is anchored by its own trusted row id');
  const early = { ...TRUSTED, db_message_id: 'id-early', db_created_at: '2026-10-27T09:00:00.000Z' };
  const unlinked = linkUnavailable(early, [before, after]);
  assert.equal(unlinked.link_state, 'no_predecessor');
  assert.equal(unlinked.predecessor_message_id, null);
  assert.equal(unlinked.attempt_message_id, 'id-early', 'even with no predecessor the attempt keeps its own anchor');
});

test('Q7: empty claims never verify, authority must be shown, unverified source ids never echo raw', () => {
  const shown = { kind: 'shown' } as const;
  const notShown = { kind: 'not_shown' } as const;
  const matching = { claimed_snapshot_message_id: TRUSTED.db_message_id, claimed_posted_by: TRUSTED.db_actor, claimed_collected_at: '2026-10-27T10:36:21.649Z' };
  assert.equal(resolveProvenanceR2({ trusted: TRUSTED, claims: {}, authority: shown }), 'unverified', 'an empty claim asserts nothing and never resolves to verified');
  assert.equal(resolveProvenanceR2({ trusted: TRUSTED, claims: matching, authority: notShown }), 'unverified', 'a DB actor match alone does not prove reporting authority for the source');
  assert.equal(resolveProvenanceR2({ trusted: TRUSTED, claims: matching, authority: shown }), 'verified');
  assert.equal(resolveProvenanceR2({ trusted: TRUSTED, claims: { claimed_posted_by: 'agent:mallory' }, authority: shown }), 'conflict');
  assert.equal(resolveProvenanceR2({ trusted: TRUSTED, claims: { claimed_collected_at: '2026-02-30T00:00:00.000Z' }, authority: shown }), 'malformed', 'an unparseable claim is decided at the parse layer');
  assert.deepEqual(renderSourceId('unverified', 'SECRET-MARKER', TRUSTED), { kind: 'unknown_source' }, 'an unverified source id is the closed unknown variant');
  assert.equal(JSON.stringify(renderSourceId('unverified', 'SECRET-MARKER', TRUSTED)).includes('SECRET-MARKER'), false, 'the raw unverified id never appears in the rendered value');
  assert.deepEqual(renderSourceId('verified', 'anything', TRUSTED), { kind: 'known', id: TRUSTED.db_actor }, 'a verified render names the trusted DB actor, not the claim');
});

test('Q8: doc addresses PROVENANCE round 2 by name (section 15A)', () => {
  const doc = readFileSync(new URL('../docs/meter-contract.md', import.meta.url), 'utf8');
  for (const needle of ['15A', 'POSTING_DELAY_MAX_MS', 'unknown_history', 'unverified', 'failure_time', 'no_predecessor', 'unknown_source', 'UTF-8']) {
    assert.ok(doc.includes(needle), `contract doc must address PROVENANCE r2 item: ${needle}`);
  }
});

// ===========================================================================
// METER-PROVENANCE round 2 — reference implementation (doc section 15A).
// These names supersede the r1 readings where section 15A says so; the r1
// names above stay unchanged so C1-C12 and P1-P7 keep their exact r1
// meaning (no existing assertion weakened or deleted).
// ===========================================================================

export const PROVENANCE_STATES_R2 = [...PROVENANCE_STATES, 'unverified'] as const;

/** Q1 (doc 15A.1): state 'verified' requires a trusted record; trusted=null
 * is representable only as 'unavailable'. */
export const provenanceEnvelopeR2 = z.object({
  trusted: trustedProvenance.nullable(),
  payload_claims: payloadProvenanceClaims,
  state: z.enum(PROVENANCE_STATES_R2),
}).strict().superRefine((e, ctx) => {
  if (e.state === 'verified' && e.trusted === null) {
    ctx.addIssue({ code: 'custom', message: 'verified requires a trusted record' });
  }
  if (e.trusted === null && e.state !== 'unavailable') {
    ctx.addIssue({ code: 'custom', message: 'trusted=null is representable only as unavailable' });
  }
});

/** Q2 (doc 15A.2): a failure time is a discriminated value — the time is
 * known ('at'), the failure happened but its time is unknown ('unknown'),
 * or there was no failure ('none'). null is not a failure time. */
export const failureTime = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: strictTs }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
]);
type FailureTime = z.infer<typeof failureTime>;

const failureTimeAtOrUnknown = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('at'), at: strictTs }).strict(),
  z.object({ kind: z.literal('unknown') }).strict(),
]);

/** Q2/Q6 (doc 15A.2/15A.6): the r2 attempt shape — failure_time replaces
 * the ambiguous failed_at null, and the attempt keeps its trusted row. */
export const attemptProvenanceR2 = z.object({
  trusted: trustedProvenance,
  failure_time: failureTimeAtOrUnknown,
  reason: z.enum(REASONS),
}).strict();

/** Q2 (doc 15A.2): stale decision on the discriminated failure time. A
 * failure of unknown time cannot be ordered against the valid record, so
 * it fails closed; 'none' never stales a verified record. */
export function staleDecisionR2(input: {
  provenance_state: (typeof PROVENANCE_STATES_R2)[number];
  valid_observed_at: string | null;
  latest_failure: FailureTime;
  now: string;
}): { display: 'fresh' | 'stale_with_failure' | 'unavailable'; automated: boolean } {
  if (input.provenance_state === 'conflict' || input.provenance_state === 'malformed') {
    return { display: 'unavailable', automated: false };
  }
  if (input.valid_observed_at === null || !isStrictTimestamp(input.valid_observed_at) || !isStrictTimestamp(input.now)) {
    return { display: 'unavailable', automated: false };
  }
  const age = Date.parse(input.now) - Date.parse(input.valid_observed_at);
  if (age < 0 || age > STALE_DISPLAY_MAX_AGE_MS) return { display: 'unavailable', automated: false };
  if (input.latest_failure.kind === 'unknown') return { display: 'stale_with_failure', automated: false };
  if (input.latest_failure.kind === 'at'
    && Date.parse(input.latest_failure.at) >= Date.parse(input.valid_observed_at)) {
    return { display: 'stale_with_failure', automated: false };
  }
  if (input.provenance_state !== 'verified') return { display: 'stale_with_failure', automated: false };
  return { display: 'fresh', automated: true };
}

/** Q3 (doc 15A.3): evidence refs carry the observation time as well, so
 * selection is a total order: observed_at, then trusted room time
 * (db_created_at), then message id, then content hash. */
export const evidenceRefR2 = z.object({
  db_message_id: z.string().min(1),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  db_created_at: strictTs,
  observed_at: strictTs,
}).strict();
type EvidenceRefR2 = z.infer<typeof evidenceRefR2>;

export function compareEvidenceOrder(a: EvidenceRefR2, b: EvidenceRefR2): number {
  const keys: Array<[number | string, number | string]> = [
    [Date.parse(a.observed_at), Date.parse(b.observed_at)],
    [Date.parse(a.db_created_at), Date.parse(b.db_created_at)],
    [a.db_message_id, b.db_message_id],
    [a.content_sha256 ?? '', b.content_sha256 ?? ''],
  ];
  for (const [x, y] of keys) {
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export type EvidenceSelectionR3 =
  | { kind: 'selected'; ref: EvidenceRefR2 | null }
  | { kind: 'conflict'; reason: 'same_id_divergent_hash' }
  | { kind: 'unknown_history'; reason: 'missing_content_hash' };

/** R3 (doc 15B): selection fails closed BEFORE it picks a record. Within
 * one db_message_id group, a missing hash is 'unknown_history' and two
 * different hashes are a 'conflict' — neither is ever resolved by picking
 * a winner (PM ruling bf53da51: fail-closed > tie-break). */
export function evidenceSelectionR3(refs: EvidenceRefR2[]): EvidenceSelectionR3 {
  const byId = new Map<string, EvidenceRefR2[]>();
  for (const r of refs) {
    const g = byId.get(r.db_message_id) ?? [];
    g.push(r); byId.set(r.db_message_id, g);
  }
  for (const g of byId.values()) {
    if (g.some((r) => !r.content_sha256)) return { kind: 'unknown_history', reason: 'missing_content_hash' };
    if (new Set(g.map((r) => r.content_sha256)).size > 1) return { kind: 'conflict', reason: 'same_id_divergent_hash' };
  }
  if (refs.length === 0) return { kind: 'selected', ref: null };
  return { kind: 'selected', ref: refs.reduce((best, r) => (compareEvidenceOrder(r, best) > 0 ? r : best)) };
}

export function selectLatestEvidence(refs: EvidenceRefR2[]): EvidenceRefR2 | null {
  const sel = evidenceSelectionR3(refs);
  return sel.kind === 'selected' ? sel.ref : null;
}

/** Q4 (doc 15A.4): the content hash covers exactly the UTF-8 bytes of the
 * stored content string — no id, timestamp or metadata is mixed in. */
export function hashStoredContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Q4 (doc 15A.4): a missing counterpart row, or a row whose hash was
 * never recorded, is 'unknown_history' — fail-closed, never a verdict. */
export function evidenceVerdictR2(
  a: { db_message_id: string; content_sha256: string | null } | null,
  b: { db_message_id: string; content_sha256: string | null } | null,
): 'duplicate' | 'conflict' | 'distinct' | 'unknown_history' {
  if (a === null || b === null || !a.content_sha256 || !b.content_sha256) return 'unknown_history';
  if (a.db_message_id !== b.db_message_id) return 'distinct';
  return a.content_sha256 === b.content_sha256 ? 'duplicate' : 'conflict';
}

/** Q5 (doc 15A.5): posting may lag collection by at most this bound. */
export const POSTING_DELAY_MAX_MS = 3_600_000; // 1h

/** Q5 (doc 15A.5): boundary normalization — the canonical slot value is
 * UTC Z; an offset form is converted at the boundary, never stored. A
 * value that is neither strict-Z nor a valid offset form is null. */
export function normalizeTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (isStrictTimestamp(v)) return v.includes('.') ? v : v.replace('Z', '.000Z');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{3})?([+-])(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), se = Number(m[6]);
  const offH = Number(m[9]), offM = Number(m[10]);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59 || offH > 23 || offM > 59) return null;
  const ms = m[7] ? Number(m[7].slice(1)) : 0;
  const local = Date.UTC(y, mo - 1, d, h, mi, se, ms);
  const dt = new Date(local);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d
    || dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== se) return null;
  const offsetMs = (offH * 60 + offM) * 60_000 * (m[8] === '+' ? 1 : -1);
  return new Date(local - offsetMs).toISOString();
}

/** Q5 (doc 15A.5): the r2 cross-check — id and actor claims still compare
 * exactly, but collected_at is a delay relation, not an equality: the
 * collection happened at or before the posting, within the max bound. */
export function crossCheckProvenanceR2(trusted: Trusted, claims: Claims): 'verified' | 'conflict' {
  if (claims.claimed_snapshot_message_id !== undefined && claims.claimed_snapshot_message_id !== trusted.db_message_id) return 'conflict';
  if (claims.claimed_posted_by !== undefined && claims.claimed_posted_by !== trusted.db_actor) return 'conflict';
  if (claims.claimed_collected_at !== undefined) {
    const delay = Date.parse(trusted.db_created_at) - Date.parse(claims.claimed_collected_at);
    if (!(delay >= 0 && delay <= POSTING_DELAY_MAX_MS)) return 'conflict';
  }
  return 'verified';
}

/** Q6 (doc 15A.6): at the contract boundary an unavailable attempt joins
 * the canonical chain by its own trusted row: its predecessor is the
 * latest verified record whose room time is at or before the attempt's.
 * With none, the link is 'no_predecessor' and the attempt still carries
 * its own anchor id. */
export function linkUnavailable(attemptTrusted: Trusted, verifiedRefs: EvidenceRefR2[]): {
  link_state: 'linked' | 'no_predecessor' | 'conflict' | 'unknown_history';
  attempt_message_id: string;
  predecessor_message_id: string | null;
  reason: string | null;
} {
  const preds = verifiedRefs.filter((r) => Date.parse(r.db_created_at) <= Date.parse(attemptTrusted.db_created_at));
  const sel = evidenceSelectionR3(preds);
  if (sel.kind !== 'selected') {
    return { link_state: sel.kind, attempt_message_id: attemptTrusted.db_message_id, predecessor_message_id: null, reason: sel.reason };
  }
  return sel.ref === null
    ? { link_state: 'no_predecessor', attempt_message_id: attemptTrusted.db_message_id, predecessor_message_id: null, reason: null }
    : { link_state: 'linked', attempt_message_id: attemptTrusted.db_message_id, predecessor_message_id: sel.ref.db_message_id, reason: null };
}

/** Q7 (doc 15A.7): collector authority is shown by evidence external to
 * the payload (a registration / capability record for that source); a DB
 * actor match alone never shows it. */
export type CollectorAuthority = { kind: 'shown' } | { kind: 'not_shown' };

/** Q7 (doc 15A.7): the r2 resolver. Parse failure is 'malformed'; a
 * differing claim is 'conflict'; an empty claim, or authority not shown,
 * is 'unverified' — never 'verified'. */
export function resolveProvenanceR2(input: {
  trusted: Trusted | null;
  claims: unknown;
  authority: CollectorAuthority;
}): (typeof PROVENANCE_STATES_R2)[number] {
  if (input.trusted === null) return 'unavailable';
  const parsed = payloadProvenanceClaims.safeParse(input.claims);
  if (!parsed.success) return 'malformed';
  const claims = parsed.data;
  if (crossCheckProvenanceR2(input.trusted, claims) === 'conflict') return 'conflict';
  // R3 (doc 15B): a ledger id is a claim, not evidence — on its own it
  // never counts as a present claim for verification (R3-5).
  const present = claims.claimed_snapshot_message_id !== undefined
    || claims.claimed_posted_by !== undefined
    || claims.claimed_collected_at !== undefined;
  if (!present) return 'unverified';
  if (input.authority.kind !== 'shown') return 'unverified';
  return 'verified';
}

/** Q7 (doc 15A.7): render names a source only from the trusted record of
 * a verified envelope. Anything else is the closed 'unknown_source'
 * variant — the raw claimed id is never echoed. */
export function renderSourceId(
  state: string,
  _claimedSourceId: string | undefined,
  trusted: Trusted | null,
): { kind: 'known'; id: string } | { kind: 'unknown_source' } {
  if (state === 'verified' && trusted !== null) return { kind: 'known', id: trusted.db_actor };
  return { kind: 'unknown_source' };
}

// ===========================================================================
// METER-PROVENANCE round 3 — RED (Dots FAIL round 2, 5d1ee935; acceptance
// branch dots/provenance-acceptance-41f @ 45681126, Claude zod run
// db0fd2a6: INDEPENDENT 2 pass / 5 fail / 5 todo). These tests pin the r3
// contract BEFORE the fix: selection must fail closed before it picks a
// record, offset normalization must keep milliseconds, the R2 envelope
// must be able to store every state the R2 resolver can return, an
// unchecked ledger id must never verify, and collector authority must be
// bound to actor + source + room + evidence (the five TODOs become tests
// against the r3 bound-authority API named here). The Q3 tie-break clash
// is resolved by PM ruling bf53da51 (fail-closed wins): in GREEN, the Q3
// hash-tie assertion above is changed — not deleted — to "reject with a
// conflict reason", with that note recorded in the doc (section 15B).
// ===========================================================================

const R3_REF = { db_message_id: 'snapshot-1', content_sha256: HASH_A, db_created_at: '2026-10-27T10:00:00.000Z', observed_at: '2026-10-27T09:59:00.000Z' };

test('R3-1: same-id divergent hashes fail closed before selection (no record is selected)', () => {
  const conflicting = { ...R3_REF, content_sha256: HASH_B };
  assert.equal(selectLatestEvidence([R3_REF, conflicting]), null, 'a same-id hash conflict is rejected, never resolved by picking a hash');
  assert.equal(selectLatestEvidence([conflicting, R3_REF]), null, 'input order does not change the rejection');
  assert.deepEqual(evidenceSelectionR3([R3_REF, conflicting]), { kind: 'conflict', reason: 'same_id_divergent_hash' }, 'the rejection carries the conflict reason (PM ruling bf53da51)');
  assert.deepEqual(evidenceSelectionR3([R3_REF, { ...R3_REF }]), { kind: 'selected', ref: R3_REF }, 'same id + same hash stays an idempotent dedupe and still selects');
});

test('R3-2: a missing evidence hash fails closed before selection', () => {
  const missing = { ...R3_REF, content_sha256: null };
  assert.equal(selectLatestEvidence([missing]), null, 'a record without a recorded hash has no evidence and cannot be selected');
  assert.deepEqual(evidenceSelectionR3([missing, R3_REF]), { kind: 'unknown_history', reason: 'missing_content_hash' }, 'a missing hash in the same-id group poisons selection for that id, with the reason named');
});

test('R3-3: offset normalization preserves nonzero milliseconds', () => {
  assert.equal(normalizeTimestamp('2026-10-27T19:00:00.456+09:00'), '2026-10-27T10:00:00.456Z');
  assert.equal(normalizeTimestamp('2026-10-27T05:00:00.007-05:00'), '2026-10-27T10:00:00.007Z');
});

test('R3-4: the R2 envelope stores every state the R2 resolver can return (unverified included)', () => {
  assert.equal(provenanceEnvelopeR2.safeParse({ trusted: TRUSTED, payload_claims: {}, state: 'unverified' }).success, true, 'unverified is in the R2 closed state set (PROVENANCE_STATES_R2) and the envelope schema must use that same set');
  assert.equal(provenanceEnvelopeR2.safeParse({ trusted: null, payload_claims: {}, state: 'unverified' }).success, false, 'trusted=null stays representable only as unavailable (Q1 control, unchanged)');
});

test('R3-5: an unchecked ledger id alone never verifies', () => {
  const shown = { kind: 'shown' } as const;
  assert.notEqual(resolveProvenanceR2({ trusted: TRUSTED, claims: { claimed_ledger_source_message_id: 'synthetic-unchecked-ledger-id' }, authority: shown }), 'verified', 'a ledger id is a claim, not evidence: without a cross-check against the trusted ledger row it proves nothing');
  assert.equal(resolveProvenanceR2({ trusted: TRUSTED, claims: { claimed_ledger_source_message_id: 'synthetic-unchecked-ledger-id' }, authority: shown }), 'unverified');
});

test('R3-6: bound authority — a fully bound collector verifies; a different DB actor does not', () => {
  const bound = {
    trusted: TRUSTED,
    claims: { claimed_snapshot_message_id: TRUSTED.db_message_id, claimed_posted_by: TRUSTED.db_actor, claimed_collected_at: '2026-10-27T10:36:21.649Z' },
    authority: { kind: 'shown' as const, bound_actor: TRUSTED.db_actor, bound_source: 'muse', bound_room: TRUSTED.db_room, evidence_message_id: TRUSTED.db_message_id, evidence_expires_at: '2026-10-28T10:46:21.649Z' },
    now: '2026-10-27T11:00:00.000Z',
  };
  assert.equal(resolveBoundProvenanceR3(bound), 'verified', 'authority evidence bound to the same actor, source, room and evidence record verifies');
  assert.equal(resolveBoundProvenanceR3({ ...bound, authority: { ...bound.authority, bound_actor: 'agent:mallory' } }), 'conflict', 'authority bound to a different DB actor is a conflict, not a pass');
});

test('R3-7: bound authority — a different reported source or a different room does not verify', () => {
  const bound = {
    trusted: TRUSTED,
    claims: { claimed_snapshot_message_id: TRUSTED.db_message_id, claimed_posted_by: TRUSTED.db_actor, claimed_collected_at: '2026-10-27T10:36:21.649Z' },
    authority: { kind: 'shown' as const, bound_actor: TRUSTED.db_actor, bound_source: 'muse', bound_room: TRUSTED.db_room, evidence_message_id: TRUSTED.db_message_id, evidence_expires_at: '2026-10-28T10:46:21.649Z' },
    now: '2026-10-27T11:00:00.000Z',
  };
  assert.notEqual(resolveBoundProvenanceR3({ ...bound, authority: { ...bound.authority, bound_source: 'codex' } }), 'verified', 'authority shown for a different source proves nothing for this source');
  assert.notEqual(resolveBoundProvenanceR3({ ...bound, authority: { ...bound.authority, bound_room: 'room_other' } }), 'verified', 'authority shown for a different room proves nothing for this room');
});

test('R3-8: bound authority — missing, expired or mismatched authority evidence does not verify', () => {
  const bound = {
    trusted: TRUSTED,
    claims: { claimed_snapshot_message_id: TRUSTED.db_message_id, claimed_posted_by: TRUSTED.db_actor, claimed_collected_at: '2026-10-27T10:36:21.649Z' },
    authority: { kind: 'shown' as const, bound_actor: TRUSTED.db_actor, bound_source: 'muse', bound_room: TRUSTED.db_room, evidence_message_id: TRUSTED.db_message_id, evidence_expires_at: '2026-10-28T10:46:21.649Z' },
    now: '2026-10-27T11:00:00.000Z',
  };
  assert.notEqual(resolveBoundProvenanceR3({ ...bound, authority: { kind: 'not_shown' } }), 'verified', 'no authority evidence: unverified');
  assert.notEqual(resolveBoundProvenanceR3({ ...bound, authority: { ...bound.authority, evidence_expires_at: '2026-10-27T10:00:00.000Z' } }), 'verified', 'expired authority evidence: unverified');
  assert.notEqual(resolveBoundProvenanceR3({ ...bound, authority: { ...bound.authority, evidence_message_id: 'some-other-record' } }), 'verified', 'authority evidence pointing at a different record: unverified');
});

test('R3-9: predecessor boundary — only a verified record from the same source and room is a predecessor', () => {
  const attempt = { ...TRUSTED, db_created_at: '2026-10-27T10:46:21.649Z' };
  const sameSource = { db_message_id: 'id-before', content_sha256: HASH_A, db_created_at: '2026-10-27T10:00:00.000Z', observed_at: '2026-10-27T10:00:00.000Z', db_actor: TRUSTED.db_actor, db_room: TRUSTED.db_room };
  const otherSource = { ...sameSource, db_message_id: 'id-other-source', db_actor: 'agent:codex' };
  const otherRoom = { ...sameSource, db_message_id: 'id-other-room', db_room: 'room_other' };
  assert.equal(linkUnavailableR3(attempt, [otherSource, otherRoom]).link_state, 'no_predecessor', 'records from a different source or room are not predecessors, however recent');
  assert.equal(linkUnavailableR3(attempt, [otherSource, sameSource]).predecessor_message_id, 'id-before', 'the same-source, same-room verified record is the predecessor');
});

test('R3-11: linkUnavailableR3 surfaces a conflicting or hash-less predecessor history instead of a clean chain head', () => {
  const attempt = { ...TRUSTED, db_created_at: '2026-10-27T12:00:00.000Z' };
  const ref = (h: string | null) => ({ db_message_id: 'p1', db_actor: TRUSTED.db_actor, db_room: TRUSTED.db_room, db_created_at: '2026-10-27T09:00:00.000Z', observed_at: '2026-10-27T09:00:00.000Z', content_sha256: h });
  const conflict = linkUnavailableR3(attempt, [ref(HASH_A), ref(HASH_B)]);
  assert.equal(conflict.link_state, 'conflict', 'same-id divergent-hash predecessor history is a conflict, never no_predecessor (Claude repro, 4c19577b)');
  assert.equal(conflict.reason, 'same_id_divergent_hash');
  assert.equal(conflict.predecessor_message_id, null);
  const unknown = linkUnavailableR3(attempt, [ref(null)]);
  assert.equal(unknown.link_state, 'unknown_history', 'a hash-less predecessor record makes the history unknown, never a clean chain head');
  assert.equal(unknown.reason, 'missing_content_hash');
  assert.equal(unknown.predecessor_message_id, null);
  const r2 = linkUnavailable(attempt, [ref(HASH_A), ref(HASH_B)]);
  assert.equal(r2.link_state, 'conflict', 'the R2 linkUnavailable passes the same fail-closed states through');
  assert.equal(r2.reason, 'same_id_divergent_hash');
});

test('R3-10: doc addresses PROVENANCE round 3 by name (section 15B)', () => {
  const doc = readFileSync(new URL('../docs/meter-contract.md', import.meta.url), 'utf8');
  for (const needle of ['15B', 'same_id_divergent_hash', 'missing_content_hash', 'bound_actor', 'superseded by PM ruling']) {
    assert.ok(doc.includes(needle), `contract doc must address PROVENANCE r3 item: ${needle}`);
  }
});

// ===========================================================================
// METER-PROVENANCE round 3 — reference implementation (doc section 15B).
// ===========================================================================

/** R3 (doc 15B): bound collector authority. 'verified' requires, on top
 * of the R2 resolver rules, authority evidence bound to the trusted
 * record itself: bound_actor == db_actor, bound_source == the source
 * named by db_actor, bound_room == db_room, evidence_message_id ==
 * db_message_id, and the evidence unexpired at `now`. An actor mismatch
 * is a 'conflict'; every other binding failure is 'unverified'. */
export function resolveBoundProvenanceR3(input: {
  trusted: Trusted | null;
  claims: unknown;
  authority: { kind: 'shown'; bound_actor: string; bound_source: string; bound_room: string; evidence_message_id: string; evidence_expires_at: string } | { kind: 'not_shown' };
  now: string;
}): (typeof PROVENANCE_STATES_R2)[number] {
  if (input.trusted === null) return 'unavailable';
  const parsed = payloadProvenanceClaims.safeParse(input.claims);
  if (!parsed.success) return 'malformed';
  if (crossCheckProvenanceR2(input.trusted, parsed.data) === 'conflict') return 'conflict';
  const present = parsed.data.claimed_snapshot_message_id !== undefined
    || parsed.data.claimed_posted_by !== undefined
    || parsed.data.claimed_collected_at !== undefined;
  if (!present) return 'unverified';
  const a = input.authority;
  if (a.kind !== 'shown') return 'unverified';
  if (a.bound_actor !== input.trusted.db_actor) return 'conflict';
  const source = input.trusted.db_actor.split(':')[1] ?? input.trusted.db_actor;
  if (a.bound_source !== source) return 'unverified';
  if (a.bound_room !== input.trusted.db_room) return 'unverified';
  if (a.evidence_message_id !== input.trusted.db_message_id) return 'unverified';
  if (!isStrictTimestamp(a.evidence_expires_at) || !isStrictTimestamp(input.now)) return 'unverified';
  if (Date.parse(a.evidence_expires_at) <= Date.parse(input.now)) return 'unverified';
  return 'verified';
}

/** R3 (doc 15B): the predecessor of an unavailable attempt is the latest
 * verified record from the SAME source (db_actor) and the SAME room at
 * or before the attempt's room time — records from another source or
 * room are never predecessors, however recent. */
export function linkUnavailableR3(attemptTrusted: Trusted, verifiedRefs: Array<EvidenceRefR2 & { db_actor: string; db_room: string }>): {
  link_state: 'linked' | 'no_predecessor' | 'conflict' | 'unknown_history';
  attempt_message_id: string;
  predecessor_message_id: string | null;
  reason: string | null;
} {
  const preds = verifiedRefs.filter((r) => r.db_actor === attemptTrusted.db_actor
    && r.db_room === attemptTrusted.db_room
    && Date.parse(r.db_created_at) <= Date.parse(attemptTrusted.db_created_at));
  const sel = evidenceSelectionR3(preds);
  if (sel.kind !== 'selected') {
    return { link_state: sel.kind, attempt_message_id: attemptTrusted.db_message_id, predecessor_message_id: null, reason: sel.reason };
  }
  return sel.ref === null
    ? { link_state: 'no_predecessor', attempt_message_id: attemptTrusted.db_message_id, predecessor_message_id: null, reason: null }
    : { link_state: 'linked', attempt_message_id: attemptTrusted.db_message_id, predecessor_message_id: sel.ref.db_message_id, reason: null };
}

// --- METER-SCHEMA-V1 (split piece 2 of 3): v1 acceptance + lossless conversion
// The v1 shape schema: envelope and per-source shape with fixed enums.
// Semantic classification (agent closure, percent states, family separation)
// happens in conversion with per-field tracking, so one poisoned field
// degrades its own source and is never silently dropped or silently kept.
export const v1SourceSchema = z.object({
  agent: z.string().min(1).max(64),
  method: z.enum(METHODS),
  used_percent: z.number().nullable().optional(),
  used_percent_flag: z.literal('out_of_range').optional(),
  used_percent_raw: z.number().optional(),
  resets_at: z.string().nullable().optional(),
  resets_at_flag: z.literal('invalid_timestamp').optional(),
  tokens_total: z.number().nullable().optional(),
  tokens_today: z.number().nullable().optional(),
  budget_tokens: z.number().nullable().optional(),
  remaining_tokens: z.number().nullable().optional(),
  credits_remaining: z.number().nullable().optional(),
  credits_total: z.number().nullable().optional(),
  credits_used: z.number().nullable().optional(),
  credits_status: z.enum(CALL_STATUSES).optional(),
  usage_status: z.enum(CALL_STATUSES).optional(),
  usage_usd: z.number().nullable().optional(),
  limit_usd: z.number().nullable().optional(),
  remaining_usd: z.number().nullable().optional(),
  spent_usd: z.number().nullable().optional(),
  remaining_credit_usd: z.number().nullable().optional(),
  credit_expired: z.boolean().optional(),
  credit_expires_at: z.string().nullable().optional(),
  units: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  windows: z.array(z.object({
    used_percent: z.number().nullable().optional(),
    used_percent_flag: z.literal('out_of_range').optional(),
    used_percent_raw: z.number().optional(),
    resets_at: z.string().nullable().optional(),
    resets_at_flag: z.literal('invalid_timestamp').optional(),
    window_minutes: z.number().nullable().optional(),
  }).passthrough()).optional(),
  agy_groups_min_remaining_fraction: z.record(z.string(), z.number()).optional(),
  null_reason: z.string().nullable().optional(),
  observed_at: z.string(),
  basis: z.string().max(400),
}).passthrough();
export const v1SnapshotSchema = z.object({
  kind: z.literal('usage.snapshot.v1'),
  collected_at: strictTs,
  sources: z.array(v1SourceSchema).min(1).max(20),
}).strict();

export type V1FieldState = 'normal' | 'out_of_range' | 'invalid';
export interface FieldConversion { field: string; state: V1FieldState; action: 'carried' | 'mapped' | 'dropped'; reason?: string }
/** R3 (doc 16.8, F1): ONE converted shape, mirroring SourceConversion in
 * src/server/usage-contract.ts exactly in its keys — the src type is the
 * source of truth because fix6 consumes it. There is NO top-level
 * provenance: provenance lives inside the record
 * (`record.provenance.collected_at` carries the envelope time), the
 * record itself is the canonical record, and the source is the variant's
 * `source` (and `record.source`). */
export type SourceConversion =
  | { outcome: 'converted'; source: string; fields: FieldConversion[]; record: z.infer<typeof canonicalRecord>; null_reason_code?: string }
  | { outcome: 'unknown_source'; fields: FieldConversion[] }
  | { outcome: 'invalid_source'; fields: FieldConversion[] };
export type SnapshotConversion =
  | { outcome: 'converted'; sources: SourceConversion[] }
  | { outcome: 'unsupported_version' }
  | { outcome: 'invalid_snapshot'; reason: string };

/** Percent classification primitive: exactly one state per percent triple.
 * normal = finite in [0,100] (or plain null, J6); out_of_range = finite raw
 * outside [0,100]; invalid = NaN, +/-Infinity, or a non-numeric value.
 * out_of_range NEVER applies to a non-finite raw (Dots 823fc50e item 2). */
export function classifyPercentField(src: Record<string, unknown>): V1FieldState {
  const flag = src.used_percent_flag;
  const rawStored = src.used_percent_raw;
  if (flag === 'out_of_range') {
    return typeof rawStored === 'number' && Number.isFinite(rawStored) && (rawStored < 0 || rawStored > 100)
      ? 'out_of_range' : 'invalid';
  }
  const v = src.used_percent;
  if (v === null || v === undefined) return 'normal';
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'invalid';
  return v >= 0 && v <= 100 ? 'normal' : 'out_of_range';
}

/** Offset-form ISO timestamp with component round-trip (Feb 30 rejected).
 * Conversion maps it to canonical UTC Z (doc 15A.5); strict Z is carried.
 * R2: the offset itself is range-checked — hours 00–14, minutes 00–59, and
 * +14:00 is the maximum (so +99:99 is invalid, never mapped). */
const OFFSET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?([+-])(\d{2}):(\d{2})$/;
function isOffsetTimestamp(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const m = OFFSET_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), se = Number(m[6]);
  const oh = Number(m[9]), om = Number(m[10]);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false;
  if (om > 59 || oh > 14 || (oh === 14 && om > 0)) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
    && dt.getUTCHours() === h && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === se;
}

/** Canonical UTC Z value for a strict or valid offset timestamp, else null.
 * R2: conversion returns VALUES, so an offset form becomes the actual Z
 * string (epoch arithmetic), not just a "mapped" label. */
function toCanonicalZ(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (isStrictTimestamp(v)) return v;
  const m = OFFSET_RE.exec(v);
  if (!m || !isOffsetTimestamp(v)) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const h = Number(m[4]), mi = Number(m[5]), se = Number(m[6]), ms = Number(m[7] ?? '0');
  const sign = m[8] === '+' ? 1 : -1;
  const offMs = sign * (Number(m[9]) * 60 + Number(m[10])) * 60000;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se, ms) - offMs).toISOString();
}

/** v1 basis free text -> closed BasisCode (doc section 10 template table,
 * substring recognizers for the producer sentences; anything unrecognized
 * is legacy_unmapped and its text is not carried). */
function basisCodeFor(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('rate_limits') && t.includes('stale')) return 'codex_stale_reset';
  if (t.includes('no rate_limits')) return 'codex_no_rate_limits';
  if (t.includes('rate_limits')) return 'codex_rate_limits';
  if (t.includes('ccusage')) return 'ccusage_tokens';
  if (t.includes('ledger read failed') || t.includes('ledger unreadable')) return 'ledger_read_failed';
  if (t.includes('ledger missing')) return 'ledger_missing';
  if (t.includes('ledger') && t.includes('malformed')) return 'ledger_malformed';
  if (t.includes('ssu') && (t.includes('no numeric') || t.includes('no_numeric'))) return 'ssu_no_numeric_fields';
  if (t.includes('ssu') && t.includes('partial')) return 'ssu_partial';
  if (t.includes('ssu')) return 'ssu_gateway';
  if (t.includes('openrouter') && t.includes('not set')) return 'openrouter_key_not_set';
  if (t.includes('openrouter') && t.includes('no usage')) return 'openrouter_no_usage_field';
  if (t.includes('openrouter') && t.includes('failed')) return 'openrouter_read_failed';
  if (t.includes('openrouter')) return 'openrouter_key';
  if (t.includes('agy') && (t.includes('no numeric') || t.includes('no bucket'))) return 'agy_no_numeric_bucket';
  if (t.includes('agy') && t.includes('unavailable')) return 'agy_unavailable';
  if (t.includes('agy') && t.includes('parse')) return 'agy_parse_failed';
  if (t.includes('agy')) return 'agy_usage';
  if (t.includes('remaining=') || (t.includes('claude') && t.includes('credit'))) return 'claude_credit_ledger';
  if (t.includes('muse') && t.includes('ledger')) return 'muse_ledger';
  if (t.includes('grokbot')) return 'grokbot_no_source';
  return 'legacy_unmapped';
}

/** v1 null_reason free text -> closed reason code (doc section 9 table). */
function nullReasonCodeFor(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('ledger missing')) return 'ledger_missing';
  if (t.includes('ledger unreadable') || t.includes('ledger read failed')) return 'ledger_read_failed';
  if (t.includes('wake.log missing') || t.includes('wake log missing')) return 'missing';
  return 'malformed_source';
}

const CREDITS_FAMILY = ['credits_remaining', 'credits_total', 'credits_used'];
const USD_FAMILY = ['usage_usd', 'limit_usd', 'remaining_usd', 'spent_usd', 'remaining_credit_usd'];

const V1_KNOWN_FIELDS = new Set([
  'agent', 'method', 'used_percent', 'used_percent_flag', 'used_percent_raw',
  'resets_at', 'resets_at_flag', 'tokens_total', 'tokens_today', 'budget_tokens',
  'remaining_tokens', 'credits_remaining', 'credits_total', 'credits_used',
  'credits_status', 'usage_status', 'usage_usd', 'limit_usd', 'remaining_usd',
  'spent_usd', 'remaining_credit_usd', 'credit_expired', 'credit_expires_at',
  'units', 'windows', 'agy_groups_min_remaining_fraction', 'null_reason', 'observed_at', 'basis',
]);

/** Reference conversion (doc section 16). The envelope (kind, strict
 * collected_at, source shape with fixed enums) is validated by
 * v1SnapshotSchema; a failed envelope is invalid_snapshot, and a present but
 * different kind is the closed unsupported_version outcome (the raw kind is
 * never copied into the result). Each source is then classified field by
 * field: every present field is tracked exactly once as carried, mapped, or
 * dropped with a reason — nothing is silently lost and nothing invalid is
 * silently kept. Conversion reasons are exactly the UsageReasonCode list
 * (the same REASONS constant pins the type union and the zod enums). */
export function convertV1Snapshot(input: unknown): SnapshotConversion {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { outcome: 'invalid_snapshot', reason: 'malformed_source' };
  }
  const kind = (input as { kind?: unknown }).kind;
  if (kind === undefined) return { outcome: 'invalid_snapshot', reason: 'malformed_source' };
  if (kind !== 'usage.snapshot.v1') return { outcome: 'unsupported_version' };
  const parsed = v1SnapshotSchema.safeParse(input);
  if (!parsed.success) return { outcome: 'invalid_snapshot', reason: 'malformed_source' };
  const collectedAt = parsed.data.collected_at;
  const sources: SourceConversion[] = parsed.data.sources.map((rawSrc) => {
    const src = rawSrc as Record<string, unknown>;
    const present = Object.keys(src);
    const tracked = (field: string, state: V1FieldState, action: FieldConversion['action'], reason?: string): FieldConversion =>
      ({ field, state, action, ...(reason ? { reason } : {}) });
    // R2: an arbitrary passthrough field is tracked exactly once under the
    // fixed placeholder name — its raw (untrusted) name never enters the
    // ledger or the values.
    const ledgerName = (f: string): string => (V1_KNOWN_FIELDS.has(f) ? f : 'passthrough_field');
    // Unknown source: closed variant, raw agent string nowhere in the output.
    if (!AGENTS.includes(src.agent as typeof AGENTS[number])) {
      return {
        outcome: 'unknown_source',
        fields: present.map((f) => tracked(ledgerName(f), 'invalid', 'dropped', 'malformed_source')),
      } as SourceConversion;
    }
    // Family separation (C9 carried into conversion): ANY credits-family
    // field together with ANY USD-family field invalidates the source
    // (R2 — every combination, not only credits_total + usage_usd);
    // neither family's values are carried.
    const hasCredits = CREDITS_FAMILY.some((f) => src[f] !== undefined);
    const hasUsd = USD_FAMILY.some((f) => src[f] !== undefined);
    if (hasCredits && hasUsd) {
      return {
        outcome: 'invalid_source',
        fields: present.map((f) => (CREDITS_FAMILY.includes(f) || USD_FAMILY.includes(f)
          ? tracked(f, 'invalid', 'dropped', 'malformed_source')
          : tracked(ledgerName(f), 'normal', 'dropped', 'malformed_source'))),
      } as SourceConversion;
    }
    // R2: build the canonical VALUES alongside the ledger. Carried/mapped
    // fields land in `record` with their canonical value (timestamps as
    // UTC Z strings, an out-of-range percent as null+flag+raw, invalid
    // timestamps as null); dropped fields never appear. A stored null
    // stays null; a genuine zero stays zero.
    // R3 (F1): provenance is built INTO the record — the converted variant
    // carries no top-level provenance object (src type is the truth).
    const record: Record<string, unknown> = {
      source: src.agent, method: src.method,
      provenance: { collected_at: collectedAt },
    };
    const percentState = classifyPercentField(src);
    if (percentState === 'normal') {
      record.percent = src.used_percent_flag === 'out_of_range'
        ? { used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: src.used_percent_raw }
        : { used_percent: (src.used_percent ?? null) as number | null };
    } else if (percentState === 'out_of_range') {
      record.percent = src.used_percent_flag === 'out_of_range'
        ? { used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: src.used_percent_raw }
        : { used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: src.used_percent };
    } else {
      record.percent = { used_percent: null };
    }
    if (src.resets_at_flag === 'invalid_timestamp') {
      record.resets = { resets_at: null, resets_at_flag: 'invalid_timestamp' };
    } else if (src.resets_at === null || src.resets_at === undefined) {
      record.resets = { resets_at: null };
    } else {
      const z = toCanonicalZ(src.resets_at);
      record.resets = z !== null ? { resets_at: z } : { resets_at: null, resets_at_flag: 'invalid_timestamp' };
    }
    let nullReasonCode: string | undefined;
    const numField = (f: string, v: unknown): FieldConversion => {
      if (v === null) { record[f] = null; return tracked(f, 'normal', 'carried'); }
      if (typeof v !== 'number' || !Number.isFinite(v)) return tracked(f, 'invalid', 'dropped', 'malformed_source');
      if ((f === 'tokens_total' || f === 'tokens_today' || f === 'budget_tokens') && v < 0) {
        return tracked(f, 'invalid', 'dropped', 'malformed_source');
      }
      record[f] = v; return tracked(f, 'normal', 'carried');
    };
    const tsField = (f: string, v: unknown): FieldConversion => {
      if (v === null) { record[f] = null; return tracked(f, 'normal', 'carried'); }
      const z = toCanonicalZ(v);
      if (z !== null) { record[f] = z; return tracked(f, 'normal', z === v ? 'carried' : 'mapped'); }
      record[f] = null; return tracked(f, 'invalid', 'mapped', 'malformed_source');
    };
    const fields: FieldConversion[] = present.map((f) => {
      if (!V1_KNOWN_FIELDS.has(f)) return tracked('passthrough_field', 'invalid', 'dropped', 'malformed_source');
      switch (f) {
        case 'agent':
        case 'method':
        case 'credits_status':
        case 'usage_status':
          return tracked(f, 'normal', 'carried');
        case 'used_percent':
        case 'used_percent_flag':
        case 'used_percent_raw':
          return percentState === 'normal' ? tracked(f, 'normal', 'carried')
            : percentState === 'out_of_range' ? tracked(f, 'out_of_range', 'mapped')
            : tracked(f, 'invalid', 'dropped', 'malformed_source');
        case 'resets_at':
        case 'resets_at_flag':
          if (src.resets_at_flag === 'invalid_timestamp') return tracked(f, 'invalid', 'carried');
          if (f === 'resets_at' && typeof src.resets_at === 'string' && toCanonicalZ(src.resets_at) === null) {
            return tracked(f, 'invalid', 'mapped', 'malformed_source');
          }
          if (f === 'resets_at' && typeof src.resets_at === 'string' && !isStrictTimestamp(src.resets_at)) {
            return tracked(f, 'normal', 'mapped');
          }
          return tracked(f, 'normal', 'carried');
        case 'observed_at': {
          const z = toCanonicalZ(src.observed_at);
          if (z !== null) {
            record.observed_at = z;
            return tracked(f, 'normal', z === src.observed_at ? 'carried' : 'mapped');
          }
          record.observed_at = null;
          return tracked(f, 'invalid', 'mapped', 'malformed_source');
        }
        case 'credit_expires_at':
          return tsField(f, src[f]);
        case 'basis':
          record.basis_code = basisCodeFor(String(src.basis ?? ''));
          return tracked(f, 'normal', 'mapped');
        case 'null_reason':
          if (src.null_reason === null) return tracked(f, 'normal', 'carried');
          nullReasonCode = nullReasonCodeFor(String(src.null_reason ?? ''));
          return tracked(f, 'normal', 'mapped');
        case 'credit_expired':
          record.credit_expired = src.credit_expired;
          return tracked(f, 'normal', 'carried');
        case 'units': {
          const u = src.units as Record<string, unknown>;
          // R3 (A1): a negative value inside units is invalid, exactly as a
          // negative top-level tokens_total already is — never carried.
          const ok = u && typeof u === 'object' && Object.values(u).every((e) =>
            e && typeof e === 'object' && Object.values(e as Record<string, unknown>)
              .every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0));
          if (!ok) return tracked(f, 'invalid', 'dropped', 'malformed_source');
          record.units = u;
          return tracked(f, 'normal', 'carried');
        }
        case 'agy_groups_min_remaining_fraction': {
          const g = src.agy_groups_min_remaining_fraction as Record<string, unknown>;
          const ok = g && typeof g === 'object' && Object.entries(g)
            .every(([k, n]) => /^group_[1-9]\d*$/.test(k) && typeof n === 'number' && Number.isFinite(n));
          if (!ok) return tracked(f, 'invalid', 'dropped', 'malformed_source');
          record.agy_groups_min_remaining_fraction = g;
          return tracked(f, 'normal', 'carried');
        }
        case 'windows': {
          const ws = src.windows as Record<string, unknown>[];
          let anyOor = false; let anyInvalid = false;
          const canon = (Array.isArray(ws) ? ws : []).map((w) => {
            const ps = classifyPercentField(w);
            if (ps === 'out_of_range') anyOor = true;
            const wm = w.window_minutes;
            const wmOk = wm === null || wm === undefined || (typeof wm === 'number' && Number.isFinite(wm) && wm > 0);
            if (ps === 'invalid' || !wmOk) { anyInvalid = true; return null; }
            // R3 (A3): a window's own resets_at_flag is preserved in the
            // canonical window as null+flag — never silently dropped.
            const wFlagged = w.resets_at_flag === 'invalid_timestamp';
            const pz = wFlagged || w.resets_at === null || w.resets_at === undefined ? null : toCanonicalZ(w.resets_at);
            if (!wFlagged && w.resets_at !== null && w.resets_at !== undefined && pz === null) { anyInvalid = true; return null; }
            return {
              ...(ps === 'out_of_range'
                ? { used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: (w.used_percent_flag === 'out_of_range' ? w.used_percent_raw : w.used_percent) }
                : { used_percent: (w.used_percent ?? null) as number | null }),
              resets_at: pz,
              ...(wFlagged ? { resets_at_flag: 'invalid_timestamp' } : {}),
              window_minutes: (wm ?? null) as number | null,
            };
          }).filter((w) => w !== null);
          record.windows = canon;
          if (anyInvalid) return tracked(f, 'invalid', 'mapped', 'malformed_source');
          return anyOor ? tracked(f, 'out_of_range', 'mapped') : tracked(f, 'normal', 'carried');
        }
        default:
          return numField(f, src[f]);
      }
    });
    return {
      outcome: 'converted', source: src.agent as string, fields, record,
      ...(nullReasonCode ? { null_reason_code: nullReasonCode } : {}),
    } as unknown as SourceConversion;
  });
  return { outcome: 'converted', sources };
}

const V1_MAX_SSU = {
  agent: 'ssu', method: 'measured', used_percent: 42.5, resets_at: '2026-10-28T03:00:00.000Z',
  tokens_total: 9000, tokens_today: 1200, budget_tokens: 10000, remaining_tokens: 1000,
  credits_remaining: 1200, credits_total: 3000, credits_used: 1800,
  credits_status: 'measured', usage_status: 'measured',
  observed_at: '2026-10-27T10:00:00.000Z', basis: 'ssu gateway measured',
};
const V1_SNAP = { kind: 'usage.snapshot.v1', collected_at: '2026-10-27T10:00:00.000Z', sources: [V1_MAX_SSU] };

test('S1: the v1 schema accepts the full v1 inventory (all sources, credits/USD/units/windows fields)', () => {
  const snap = {
    kind: 'usage.snapshot.v1', collected_at: '2026-10-27T10:00:00.000Z',
    sources: [
      V1_MAX_SSU,
      { agent: 'openrouter', method: 'measured', used_percent: 10, resets_at: null, usage_usd: 1.5, limit_usd: 10, remaining_usd: 8.5, observed_at: '2026-10-27T10:00:00.000Z', basis: 'openrouter key measured' },
      { agent: 'claude', method: 'ledger', used_percent: null, resets_at: null, spent_usd: 3.25, remaining_credit_usd: 6.75, credit_expired: false, credit_expires_at: '2026-12-01T00:00:00.000Z', units: { 'U-1': { wakes: 4, input: 8000, output: 3000, cache_read: 700, cache_write: 300, tokens_total: 12000, cost_usd: 0.02, api_wakes: 3 } }, null_reason: 'ledger missing', observed_at: '2026-10-27T10:00:00.000Z', basis: 'claude credit ledger' },
      { agent: 'agy', method: 'measured', used_percent: 55, resets_at: null, agy_groups_min_remaining_fraction: { group_1: 0.45, group_2: 0.8 }, observed_at: '2026-10-27T10:00:00.000Z', basis: 'agy usage' },
      { agent: 'codex', method: 'measured', used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: 150, resets_at: null, resets_at_flag: 'invalid_timestamp', observed_at: '2026-10-27T10:00:00.000Z', basis: 'codex rate_limits' },
    ],
  };
  assert.equal(v1SnapshotSchema.safeParse(snap).success, true);
});

test('S2: the v1 schema rejects unknown method, wrong kind, empty sources, non-strict collected_at', () => {
  assert.equal(v1SnapshotSchema.safeParse({ ...V1_SNAP, sources: [{ ...V1_MAX_SSU, method: 'telepathy' }] }).success, false);
  assert.equal(v1SnapshotSchema.safeParse({ ...V1_SNAP, kind: 'usage.snapshot.v2' }).success, false);
  assert.equal(v1SnapshotSchema.safeParse({ ...V1_SNAP, sources: [] }).success, false);
  assert.equal(v1SnapshotSchema.safeParse({ ...V1_SNAP, collected_at: '2026-02-30T10:00:00.000Z' }).success, false);
  assert.equal(v1SnapshotSchema.safeParse({ ...V1_SNAP, collected_at: 'yesterday' }).success, false);
});

test('S3: conversion tracks every present field of a maximal source exactly once (lossless ledger)', () => {
  const out = convertV1Snapshot(V1_SNAP);
  assert.equal(out.outcome, 'converted');
  if (out.outcome !== 'converted') return;
  assert.equal(out.sources.length, 1);
  const sc = out.sources[0];
  assert.equal(sc?.outcome, 'converted');
  const tracked = (sc?.fields ?? []).map((f) => f.field).sort();
  assert.deepEqual(tracked, Object.keys(V1_MAX_SSU).sort());
  for (const f of sc?.fields ?? []) {
    assert.equal(f.state, 'normal', `field ${f.field} must be normal`);
    assert.ok(f.action === 'carried' || f.action === 'mapped', `field ${f.field} must be carried or mapped`);
  }
  const basis = (sc?.fields ?? []).find((f) => f.field === 'basis');
  assert.equal(basis?.action, 'mapped');
});

test('S4: an unsupported snapshot kind is a closed outcome and the raw kind is never echoed', () => {
  const out = convertV1Snapshot({ ...V1_SNAP, kind: 'usage.snapshot.v9-canary' });
  assert.equal(out.outcome, 'unsupported_version');
  assert.ok(!JSON.stringify(out).includes('v9-canary'));
  const missing = convertV1Snapshot({ collected_at: V1_SNAP.collected_at, sources: V1_SNAP.sources });
  assert.equal(missing.outcome, 'invalid_snapshot');
});

test('S5: an unknown source converts to the closed unknown_source variant; the raw agent string never appears', () => {
  const evil = { ...V1_MAX_SSU, agent: 'evil-canary-agent' };
  const out = convertV1Snapshot({ ...V1_SNAP, sources: [evil] });
  assert.equal(out.outcome, 'converted');
  if (out.outcome !== 'converted') return;
  const sc = out.sources[0];
  assert.equal(sc?.outcome, 'unknown_source');
  assert.ok(!JSON.stringify(out).includes('evil-canary-agent'));
  const agentField = (sc?.fields ?? []).find((f) => f.field === 'agent');
  assert.equal(agentField?.state, 'invalid');
  assert.equal(agentField?.action, 'dropped');
  assert.equal(agentField?.reason, 'malformed_source');
  // nothing is carried from an unidentified source
  for (const f of sc?.fields ?? []) assert.equal(f.action, 'dropped');
});

test('S6: percent states are mutually exclusive; out_of_range is finite-only, NaN/Infinity are invalid', () => {
  assert.equal(classifyPercentField({ used_percent: 50 }), 'normal');
  assert.equal(classifyPercentField({ used_percent: null }), 'normal');
  assert.equal(classifyPercentField({ used_percent: 150 }), 'out_of_range');
  assert.equal(classifyPercentField({ used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: 150 }), 'out_of_range');
  assert.equal(classifyPercentField({ used_percent: null, used_percent_flag: 'out_of_range', used_percent_raw: -3 }), 'out_of_range');
  assert.equal(classifyPercentField({ used_percent: Number.NaN }), 'invalid');
  assert.equal(classifyPercentField({ used_percent: Number.POSITIVE_INFINITY }), 'invalid');
  assert.equal(classifyPercentField({ used_percent: Number.NEGATIVE_INFINITY }), 'invalid');
  assert.equal(classifyPercentField({ used_percent: '50' }), 'invalid');
  // and through conversion: a finite 150 is tracked out_of_range, never normal
  const out = convertV1Snapshot({ ...V1_SNAP, sources: [{ ...V1_MAX_SSU, used_percent: 150 }] });
  if (out.outcome !== 'converted') assert.fail('must convert');
  const pf = out.sources[0]?.fields.find((f) => f.field === 'used_percent');
  assert.equal(pf?.state, 'out_of_range');
  assert.equal(pf?.action, 'mapped');
});

test('S7: observed_at — strict Z carried, offset form mapped to canonical Z, invalid mapped to null (J6 kept)', () => {
  const conv = (observed_at: string) => {
    const out = convertV1Snapshot({ ...V1_SNAP, sources: [{ ...V1_MAX_SSU, observed_at }] });
    if (out.outcome !== 'converted') assert.fail('must convert');
    return out.sources[0]?.fields.find((f) => f.field === 'observed_at');
  };
  const strict = conv('2026-10-27T10:00:00.000Z');
  assert.equal(strict?.state, 'normal'); assert.equal(strict?.action, 'carried');
  const offset = conv('2026-10-27T19:00:00.000+09:00');
  assert.equal(offset?.state, 'normal'); assert.equal(offset?.action, 'mapped');
  const invalid = conv('2026-02-30T10:00:00.000Z');
  assert.equal(invalid?.state, 'invalid'); assert.equal(invalid?.action, 'mapped');
  // J6: a plain-null percent stays null through conversion — never fabricated to 0
  const out = convertV1Snapshot({ ...V1_SNAP, sources: [{ ...V1_MAX_SSU, used_percent: null }] });
  if (out.outcome !== 'converted') assert.fail('must convert');
  const pf = out.sources[0]?.fields.find((f) => f.field === 'used_percent');
  assert.equal(pf?.state, 'normal'); assert.equal(pf?.action, 'carried');
});

test('S8: credits and USD families never mix — a mixed source is invalid_source, values not carried', () => {
  const mixed = { ...V1_MAX_SSU, usage_usd: 2.5 };
  const out = convertV1Snapshot({ ...V1_SNAP, sources: [mixed] });
  if (out.outcome !== 'converted') assert.fail('snapshot envelope must convert');
  const sc = out.sources[0];
  assert.equal(sc?.outcome, 'invalid_source');
  const ct = sc?.fields.find((f) => f.field === 'credits_total');
  const uu = sc?.fields.find((f) => f.field === 'usage_usd');
  assert.equal(ct?.state, 'invalid'); assert.equal(uu?.state, 'invalid');
});

test('S9: invalid or absent values never become a measured zero anywhere in the conversion', () => {
  const src = { ...V1_MAX_SSU, method: 'unavailable', used_percent: null, tokens_total: null, credits_total: null };
  const out = convertV1Snapshot({ ...V1_SNAP, sources: [src] });
  if (out.outcome !== 'converted') assert.fail('must convert');
  const sc = out.sources[0];
  assert.equal(sc?.outcome, 'converted');
  for (const name of ['used_percent', 'tokens_total', 'credits_total']) {
    const f: FieldConversion | undefined = sc?.fields.find((x) => x.field === name);
    assert.ok(f, `${name} must be tracked`);
    assert.equal(f?.state, 'normal');
  }
  // R2: the conversion returns canonical values, and a stored null stays
  // null in them — it is never fabricated into a measured zero.
  if (sc?.outcome !== 'converted') assert.fail('must be converted');
  const rec = sc.record as { percent?: { used_percent?: unknown }; tokens_total?: unknown; credits_total?: unknown };
  assert.equal(rec.percent?.used_percent, null);
  assert.equal(rec.tokens_total, null);
  assert.equal(rec.credits_total, null);
});

test('S10: doc section 16 and the canonical types address SCHEMA-V1 by name', () => {
  const doc = readFileSync('docs/meter-contract.md', 'utf8');
  for (const needle of ['## 16. METER-SCHEMA-V1', 'unsupported_version', 'unknown_source', 'out_of_range', 'invalid_snapshot']) {
    assert.ok(doc.includes(needle), `doc must address ${needle}`);
  }
  const types = readFileSync('src/server/usage-contract.ts', 'utf8');
  for (const needle of ['V1FieldState', 'FieldConversion', 'SourceConversion', 'SnapshotConversion']) {
    assert.ok(types.includes(needle), `usage-contract.ts must define ${needle}`);
  }
});

// --- METER-SCHEMA-V1 R2 (Dots FAIL c1270d57, acceptance list b85968ff).
// One failing test per finding. Registry declared before the GREEN run:
// contract file 56 tests at the R2 GREEN head (S11–S18 added, S9 updated
// to the values contract, S1 fixture corrected to the real producer
// units shape); the other meter files unchanged at 62; combined direct
// count 118. RED expectation: 47 pass / 9 fail (S9 + S11–S18).

/** The real v1 Claude producer object, byte-shaped as scripts/claude-meter.mts
 * emits it: units are per-unit OBJECTS (UnitUsage), null_reason is null on
 * success, credit_expires_at is an ISO string. */
const V1_CLAUDE_REAL = {
  agent: 'claude', method: 'ledger', tokens_total: 12000,
  observed_at: '2026-10-27T10:00:00.000Z', basis: 'remaining=10-ledger usd (runner total_cost_usd sum)',
  remaining_credit_usd: 6.75, spent_usd: 3.25, credit_expired: false,
  credit_expires_at: '2026-11-01T00:00:00.000Z', null_reason: null,
  units: {
    'U-1': { wakes: 2, input: 100, output: 50, cache_read: 10, cache_write: 5, tokens_total: 165, cost_usd: 0.01, api_wakes: 1 },
    'U-2': { wakes: 1, input: 0, output: 0, cache_read: 0, cache_write: 0, tokens_total: 0, cost_usd: 0, api_wakes: 0 },
  },
};

test('S11: the v1 schema accepts the REAL Claude producer object (units objects, null_reason null) and conversion preserves its values', () => {
  const snap = { kind: 'usage.snapshot.v1', collected_at: '2026-10-27T10:00:00.000Z', sources: [V1_CLAUDE_REAL] };
  assert.equal(v1SnapshotSchema.safeParse(snap).success, true, 'real producer object must be accepted, not rejected wholesale');
  const out = convertV1Snapshot(snap);
  if (out.outcome !== 'converted') assert.fail('must convert');
  const sc = out.sources[0];
  if (sc?.outcome !== 'converted') assert.fail('source must convert');
  const rec = sc.record as { units?: Record<string, { tokens_total?: number }>; remaining_credit_usd?: number; spent_usd?: number };
  assert.equal(rec.remaining_credit_usd, 6.75);
  assert.equal(rec.spent_usd, 3.25);
  assert.equal(rec.units?.['U-1']?.tokens_total, 165);
  assert.equal(rec.units?.['U-2']?.tokens_total, 0, 'a genuine measured zero inside units is preserved as zero');
  const nr = sc.fields.find((f) => f.field === 'null_reason');
  assert.equal(nr?.state, 'normal');
});

test('S12: the type-level and zod reason lists are the same set (no ledger_unreadable / ledger_read_failed drift)', () => {
  const types = readFileSync('src/server/usage-contract.ts', 'utf8');
  const m = /export type UsageReasonCode =([\s\S]*?);/.exec(types);
  assert.ok(m, 'UsageReasonCode union must be findable');
  const typeReasons = [...(m[1] as string).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual(typeReasons, [...REASONS].sort(), 'type union and REASONS must be set-equal');
});

test('S13: conversion returns canonical VALUES with provenance inside the record — measurements, UTC envelope time, and a genuine zero all survive', () => {
  const src = { ...V1_MAX_SSU, tokens_total: 0 };
  const out = convertV1Snapshot({ ...V1_SNAP, sources: [src] });
  if (out.outcome !== 'converted') assert.fail('must convert');
  const sc = out.sources[0];
  if (sc?.outcome !== 'converted') assert.fail('source must convert');
  const rec = sc.record as { source?: string; credits_total?: number; credits_used?: number; tokens_total?: number; used_percent?: unknown; percent?: { used_percent?: number }; provenance?: { collected_at?: string } };
  assert.equal(rec.credits_total, 3000);
  assert.equal(rec.credits_used, 1800);
  assert.equal(rec.tokens_total, 0, 'a genuinely measured zero is preserved as zero');
  assert.equal(rec.percent?.used_percent, 42.5);
  // R3 (F1): provenance is inside the record (src shape); there is no
  // top-level provenance and no provenance.source — the source is the
  // record's own `source` (S19 pins the full shape).
  assert.equal(rec.provenance?.collected_at, '2026-10-27T10:00:00.000Z');
  assert.equal(rec.source, 'ssu');
  assert.equal('provenance' in sc, false);
});

test('S14: a +99:99 offset is invalid (never mapped); a valid offset converts to the canonical UTC Z value', () => {
  const bad = convertV1Snapshot({ ...V1_SNAP, sources: [{ ...V1_MAX_SSU, observed_at: '2026-10-27T19:00:00.000+99:99' }] });
  if (bad.outcome !== 'converted') assert.fail('must convert');
  const scBad = bad.sources[0];
  if (scBad?.outcome !== 'converted') assert.fail('source must convert');
  const fBad = scBad.fields.find((f) => f.field === 'observed_at');
  assert.equal(fBad?.state, 'invalid', '+99:99 is not a real offset');
  assert.equal((scBad.record as { observed_at?: unknown }).observed_at, null);
  const good = convertV1Snapshot({ ...V1_SNAP, sources: [{ ...V1_MAX_SSU, observed_at: '2026-10-27T19:00:00.000+09:00' }] });
  if (good.outcome !== 'converted') assert.fail('must convert');
  const scGood = good.sources[0];
  if (scGood?.outcome !== 'converted') assert.fail('source must convert');
  assert.equal((scGood.record as { observed_at?: unknown }).observed_at, '2026-10-27T10:00:00.000Z', 'offset form maps to the canonical UTC Z value, not just a mapped label');
});

test('S15: an invalid credit_expires_at is not carried — it converts to null and the raw string appears nowhere in the values', () => {
  const src = { ...V1_CLAUDE_REAL, credit_expires_at: '2026-02-30T00:00:00.000Z' };
  const out = convertV1Snapshot({ kind: 'usage.snapshot.v1', collected_at: '2026-10-27T10:00:00.000Z', sources: [src] });
  if (out.outcome !== 'converted') assert.fail('must convert');
  const sc = out.sources[0];
  if (sc?.outcome !== 'converted') assert.fail('source must convert');
  const f = sc.fields.find((x) => x.field === 'credit_expires_at');
  assert.equal(f?.state, 'invalid');
  assert.equal((sc.record as { credit_expires_at?: unknown }).credit_expires_at, null);
  assert.ok(!JSON.stringify(sc.record).includes('2026-02-30'));
  const ok = convertV1Snapshot({ kind: 'usage.snapshot.v1', collected_at: '2026-10-27T10:00:00.000Z', sources: [V1_CLAUDE_REAL] });
  if (ok.outcome !== 'converted') assert.fail('must convert');
  const scOk = ok.sources[0];
  if (scOk?.outcome !== 'converted') assert.fail('source must convert');
  assert.equal((scOk.record as { credit_expires_at?: unknown }).credit_expires_at, '2026-11-01T00:00:00.000Z');
});

test('S16: credits/USD mixing is invalid_source for EVERY family combination, not only credits_total + usage_usd', () => {
  const combos: Record<string, unknown>[] = [
    { credits_remaining: 5, remaining_usd: 5 },
    { credits_used: 5, spent_usd: 5 },
    { credits_total: 5, limit_usd: 5 },
    { credits_remaining: 5, remaining_credit_usd: 5 },
  ];
  for (const extra of combos) {
    const src = { agent: 'ssu', method: 'measured', observed_at: '2026-10-27T10:00:00.000Z', basis: 'mixed test', ...extra };
    const out = convertV1Snapshot({ ...V1_SNAP, sources: [src] });
    if (out.outcome !== 'converted') assert.fail('envelope must convert');
    assert.equal(out.sources[0]?.outcome, 'invalid_source', `combo ${Object.keys(extra).join('+')} must be invalid_source`);
  }
});

test('S17: arbitrary passthrough field names never appear in the conversion ledger (fixed placeholder name, count preserved)', () => {
  const src = { ...V1_MAX_SSU, evil_canary_field: 1, another_random_key: 'x' };
  const out = convertV1Snapshot({ ...V1_SNAP, sources: [src] });
  if (out.outcome !== 'converted') assert.fail('must convert');
  const sc = out.sources[0];
  if (sc?.outcome !== 'converted') assert.fail('source must convert');
  assert.ok(!JSON.stringify(sc.fields).includes('evil_canary_field'), 'raw passthrough name must not be echoed');
  assert.ok(!JSON.stringify(sc.fields).includes('another_random_key'), 'raw passthrough name must not be echoed');
  assert.equal(sc.fields.length, Object.keys(src).length, 'every present field is still tracked exactly once');
  const pt = sc.fields.filter((f) => f.field === 'passthrough_field');
  assert.equal(pt.length, 2);
  for (const f of pt) { assert.equal(f.state, 'invalid'); assert.equal(f.action, 'dropped'); }
});

test('S18: canonical windows are in the v1 schema and conversion — a stored window keeps its percent, reset and minutes as values', () => {
  const src = {
    agent: 'codex', method: 'measured', used_percent: 25, resets_at: null,
    windows: [{ used_percent: 25, resets_at: '2026-10-28T03:00:00.000Z', window_minutes: 300 }, { used_percent: 60, resets_at: null, window_minutes: 10080 }],
    observed_at: '2026-10-27T10:00:00.000Z', basis: 'codex rate_limits',
  };
  const snap = { ...V1_SNAP, sources: [src] };
  assert.equal(v1SnapshotSchema.safeParse(snap).success, true);
  const out = convertV1Snapshot(snap);
  if (out.outcome !== 'converted') assert.fail('must convert');
  const sc = out.sources[0];
  if (sc?.outcome !== 'converted') assert.fail('source must convert');
  const wins = (sc.record as { windows?: { used_percent?: number; resets_at?: string | null; window_minutes?: number }[] }).windows;
  assert.equal(wins?.length, 2);
  assert.equal(wins?.[0]?.used_percent, 25);
  assert.equal(wins?.[0]?.resets_at, '2026-10-28T03:00:00.000Z');
  assert.equal(wins?.[0]?.window_minutes, 300);
  const wf = sc.fields.find((f) => f.field === 'windows');
  assert.equal(wf?.state, 'normal');
});

// --- METER-SCHEMA-V1 R3 (Claude FAIL ef3b1f66 on a12702d, accepted by grok
// PM 4569097e). Blocking F1: the src SourceConversion 'converted' variant
// (src/server/usage-contract.ts) declares `record: CanonicalUsageRecord`
// — provenance INSIDE the record, no top-level provenance — while the
// reference above returned its own shape (`record: Record<string,unknown>`
// plus a separate top-level `provenance:{collected_at,source}`), S13
// asserted the top-level shape, and canonicalRecord.safeParse(sc.record)
// was false. Grok ruling: the src type is the source of truth (fix6
// consumes it) — align type, doc comment and reference to ONE shape.
// Advisories: A1 units negatives invalid, A3 a window's own
// resets_at_flag preserved, A2 negative spent_usd/credits_used/usage_usd
// documented as intended overspend (behaviour unchanged).
// Registry declared before the GREEN run: contract file 60 tests
// (56 + S19–S22), the other meter files unchanged at 62, combined
// direct count 122. RED expectation: 56 pass / 4 fail (S19–S22).

test('S19 R3-F1: the converted shape is ONE shape — record parses with canonicalRecord, provenance lives inside the record, no top-level provenance', () => {
  const codexWindows = {
    agent: 'codex', method: 'measured', used_percent: 25, resets_at: null,
    windows: [{ used_percent: 25, resets_at: '2026-10-28T03:00:00.000Z', window_minutes: 300 }],
    observed_at: '2026-10-27T10:00:00.000Z', basis: 'codex rate_limits',
  };
  for (const src of [V1_MAX_SSU, V1_CLAUDE_REAL, codexWindows]) {
    const out = convertV1Snapshot({ kind: 'usage.snapshot.v1', collected_at: '2026-10-27T10:00:00.000Z', sources: [src] });
    if (out.outcome !== 'converted') assert.fail('must convert');
    const sc = out.sources[0];
    if (sc?.outcome !== 'converted') assert.fail('source must convert');
    assert.equal('provenance' in sc, false, 'the converted variant has NO top-level provenance (src type is the source of truth)');
    const parsed = canonicalRecord.safeParse(sc.record);
    assert.equal(parsed.success, true, `record for ${src.agent} must parse with the canonicalRecord schema`);
    const rec = sc.record as { source?: string; provenance?: { collected_at?: string } };
    assert.equal(rec.provenance?.collected_at, '2026-10-27T10:00:00.000Z', 'record.provenance.collected_at carries the envelope time');
    assert.equal(rec.source, src.agent, 'the source lives on the record (record.source), not in a separate provenance object');
  }
  // Exact converted-variant key set for a source without null_reason_code.
  const out = convertV1Snapshot(V1_SNAP);
  if (out.outcome !== 'converted') assert.fail('must convert');
  const sc = out.sources[0];
  if (sc?.outcome !== 'converted') assert.fail('source must convert');
  assert.deepEqual(Object.keys(sc).sort(), ['fields', 'outcome', 'record', 'source']);
});

test('S20 R3-A1: negative values inside units are invalid — the units field is dropped, never carried as normal', () => {
  for (const badUnit of [
    { wakes: 2, input: 100, output: 50, cache_read: 10, cache_write: 5, tokens_total: -500, cost_usd: 0.01, api_wakes: 1 },
    { wakes: 2, input: 100, output: 50, cache_read: 10, cache_write: 5, tokens_total: 165, cost_usd: -1, api_wakes: 1 },
  ]) {
    const src = { ...V1_CLAUDE_REAL, units: { 'U-1': badUnit } };
    const snap = { kind: 'usage.snapshot.v1', collected_at: '2026-10-27T10:00:00.000Z', sources: [src] };
    assert.equal(v1SnapshotSchema.safeParse(snap).success, true, 'a negative unit value is a conversion classification, not an envelope rejection');
    const out = convertV1Snapshot(snap);
    if (out.outcome !== 'converted') assert.fail('must convert');
    const sc = out.sources[0];
    if (sc?.outcome !== 'converted') assert.fail('source must convert');
    const f = sc.fields.find((x) => x.field === 'units');
    assert.equal(f?.state, 'invalid', 'units containing a negative value are invalid (top-level negative tokens_total already is)');
    assert.equal(f?.action, 'dropped');
    assert.equal((sc.record as { units?: unknown }).units, undefined, 'dropped units never appear in the canonical values');
  }
});

test('S21 R3-A3: a window\'s own resets_at_flag is preserved in the canonical window, not silently dropped', () => {
  const src = {
    agent: 'codex', method: 'measured', used_percent: 25, resets_at: null,
    windows: [
      { used_percent: 25, resets_at: null, resets_at_flag: 'invalid_timestamp', window_minutes: 300 },
      { used_percent: 60, resets_at: '2026-10-28T03:00:00.000Z', window_minutes: 10080 },
    ],
    observed_at: '2026-10-27T10:00:00.000Z', basis: 'codex rate_limits',
  };
  const out = convertV1Snapshot({ ...V1_SNAP, sources: [src] });
  if (out.outcome !== 'converted') assert.fail('must convert');
  const sc = out.sources[0];
  if (sc?.outcome !== 'converted') assert.fail('source must convert');
  const wins = (sc.record as { windows?: { resets_at?: string | null; resets_at_flag?: string }[] }).windows;
  assert.equal(wins?.length, 2, 'both windows survive conversion');
  assert.equal(wins?.[0]?.resets_at, null);
  assert.equal(wins?.[0]?.resets_at_flag, 'invalid_timestamp', 'the window\'s own invalid_timestamp flag is preserved in the canonical window');
  assert.equal(wins?.[1]?.resets_at, '2026-10-28T03:00:00.000Z');
  assert.equal(wins?.[1]?.resets_at_flag, undefined, 'a valid window carries no flag');
});

test('S22 R3-A2: negative spent_usd / credits_used / usage_usd are carried as normal (intended overspend), and doc section 16 says so', () => {
  const doc = readFileSync('docs/meter-contract.md', 'utf8');
  assert.ok(doc.includes('16.8'), 'doc must carry the R3 section 16.8');
  assert.ok(doc.includes('overspend'), 'doc section 16 must name negative amount fields as intended overspend');
  assert.ok(doc.includes('carried as normal'), 'doc section 16 must state the overspend amounts are carried as normal');
  const cases: Array<[Record<string, unknown>, string, number]> = [
    [{ ...V1_CLAUDE_REAL, spent_usd: -3.25 }, 'spent_usd', -3.25],
    [{ ...V1_MAX_SSU, credits_used: -100 }, 'credits_used', -100],
    [{ agent: 'openrouter', method: 'measured', used_percent: 10, resets_at: null, usage_usd: -1.5, limit_usd: 10, remaining_usd: 8.5, observed_at: '2026-10-27T10:00:00.000Z', basis: 'openrouter key measured' }, 'usage_usd', -1.5],
  ];
  for (const [src, field, value] of cases) {
    const out = convertV1Snapshot({ kind: 'usage.snapshot.v1', collected_at: '2026-10-27T10:00:00.000Z', sources: [src] });
    if (out.outcome !== 'converted') assert.fail('must convert');
    const sc = out.sources[0];
    if (sc?.outcome !== 'converted') assert.fail('source must convert');
    const f = sc.fields.find((x) => x.field === field);
    assert.equal(f?.state, 'normal', `${field} negative is carried as normal (overspend), unlike units/token negatives`);
    assert.equal((sc.record as Record<string, unknown>)[field], value);
  }
});
