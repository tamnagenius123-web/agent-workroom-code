// P5 freshness boundary owned by W0. The evaluator (cache, wall clock, live adapters) is not this module.
// source_status and intent_status stay separate. Freshness never grants release, security, or budget authority.
// canProceed needs FRESH + VALID, body coverage that was actually emitted, evidence, and a matching revision vector.

import {
  ID_RE, Problems, checkKeys, defined, readArray, readBool, readEnum, readEnvelope, readId, readIso, readObject,
  readSha256, type PhaseCheck, type PhaseEnvelope,
} from './check.ts';

export const SOURCE_STATUSES = ['FRESH', 'RECHECK_REQUIRED', 'STALE'] as const;
export type SourceStatus = typeof SOURCE_STATUSES[number];

export const INTENT_STATUSES = ['VALID', 'RECHECK_REQUIRED', 'CHANGED', 'DENIED'] as const;
export type IntentStatus = typeof INTENT_STATUSES[number];

export const COVERAGE_LEVELS = ['body', 'partial', 'pointer_only', 'none'] as const;
export type CoverageLevel = typeof COVERAGE_LEVELS[number];

export interface FreshnessManifestEntry {
  source_id: string;
  representation: string;
  revision: string;
  actually_emitted: boolean;
  freshness: SourceStatus;
  coverage: CoverageLevel;
}

export interface FreshnessCheck extends PhaseEnvelope {
  check_id: string;
  action_digest: string;
  context_digest: string;
  source_status: SourceStatus;
  intent_status: IntentStatus;
  intent_revision: string;
  permission_revision: string;
  manifest: FreshnessManifestEntry[];
  checked_at: string;
  expires_at: string;
  evidence_refs: string[];
  reasons: string[];
}

export interface RevisionVector {
  action_digest: string;
  context_digest: string;
  intent_revision: string;
  permission_revision: string;
  manifest: readonly { source_id: string; revision: string }[];
}

const CHECK_KEYS = [
  'schema_version', 'check_id', 'action_digest', 'context_digest', 'source_status', 'intent_status',
  'intent_revision', 'permission_revision', 'manifest', 'checked_at', 'expires_at', 'evidence_refs',
  'reasons', 'consumer', 'provenance', 'proof_mode',
] as const;
const MANIFEST_KEYS = ['source_id', 'representation', 'revision', 'actually_emitted', 'freshness', 'coverage'] as const;

/** A pointer, a partial, or a source that was not emitted cannot satisfy body exposure. */
function classifyEntry(entry: FreshnessManifestEntry): { status: SourceStatus } | { invalid: string } {
  const bodyExposed = entry.coverage === 'body' && entry.actually_emitted;
  if (entry.freshness === 'FRESH' && !bodyExposed) {
    if (!entry.actually_emitted) return { invalid: 'not-emitted cannot satisfy body exposure' };
    return { invalid: `${entry.coverage} cannot satisfy body exposure` };
  }
  if (entry.coverage === 'none' || entry.freshness === 'STALE') return { status: 'STALE' };
  if (!bodyExposed || entry.freshness === 'RECHECK_REQUIRED') return { status: 'RECHECK_REQUIRED' };
  return { status: 'FRESH' };
}

function aggregateStatus(statuses: readonly SourceStatus[]): SourceStatus {
  if (statuses.length === 0 || statuses.includes('STALE')) return 'STALE';
  if (statuses.includes('RECHECK_REQUIRED')) return 'RECHECK_REQUIRED';
  return 'FRESH';
}

function readManifest(problems: Problems, obj: Record<string, unknown>): FreshnessManifestEntry[] | undefined {
  const rows = readArray(problems, obj, 'manifest', 'freshness');
  if (!rows) return undefined;
  if (rows.length < 1) problems.add('freshness.manifest', 'at least one source is required');
  const manifest: FreshnessManifestEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const path = `freshness.manifest[${i}]`;
    const row = readObject(problems, rows[i], path);
    if (!row) continue;
    checkKeys(problems, row, MANIFEST_KEYS, path);
    const source_id = readId(problems, row, 'source_id', path);
    const representation = typeof row.representation === 'string' ? row.representation : undefined;
    if (representation === undefined || representation.length === 0 || representation.length > 300) {
      problems.add(`${path}.representation`, 'expected source-namespaced representation text');
    }
    const revision = readId(problems, row, 'revision', path);
    const actually_emitted = readBool(problems, row, 'actually_emitted', path);
    const freshness = readEnum(problems, row, 'freshness', path, SOURCE_STATUSES);
    const coverage = readEnum(problems, row, 'coverage', path, COVERAGE_LEVELS);
    if (!defined(source_id) || representation === undefined || !defined(revision) || !defined(actually_emitted)
      || !defined(freshness) || !defined(coverage)) {
      continue;
    }
    if (!representation.startsWith(`${source_id}:`) || representation.length === source_id.length + 1) {
      problems.add(`${path}.representation`, 'representation must be source-namespaced as source_id:name');
    }
    if (seen.has(source_id)) problems.add(path, `duplicate source_id ${source_id}`);
    seen.add(source_id);
    manifest.push({ source_id, representation, revision, actually_emitted, freshness, coverage });
  }
  return manifest;
}

function readIdList(problems: Problems, obj: Record<string, unknown>, key: string): string[] | undefined {
  const rows = readArray(problems, obj, key, 'freshness');
  if (!rows) return undefined;
  const values: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const item = rows[i];
    if (typeof item !== 'string' || !ID_RE.test(item)) {
      problems.add(`freshness.${key}[${i}]`, 'expected an id');
      continue;
    }
    if (seen.has(item)) problems.add(`freshness.${key}`, `duplicate ${item}`);
    seen.add(item);
    values.push(item);
  }
  return values;
}

function readReasons(problems: Problems, obj: Record<string, unknown>): string[] | undefined {
  const rows = readArray(problems, obj, 'reasons', 'freshness');
  if (!rows) return undefined;
  const reasons: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const item = rows[i];
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 500) {
      problems.add(`freshness.reasons[${i}]`, 'expected reason text');
      continue;
    }
    reasons.push(item);
  }
  return reasons;
}

export function validateFreshnessCheck(input: unknown): PhaseCheck<FreshnessCheck> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'freshness');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, CHECK_KEYS, 'freshness');
  const envelope = readEnvelope(problems, obj, 'freshness');
  const check_id = readId(problems, obj, 'check_id', 'freshness');
  const action_digest = readSha256(problems, obj, 'action_digest', 'freshness');
  const context_digest = readSha256(problems, obj, 'context_digest', 'freshness');
  const source_status = readEnum(problems, obj, 'source_status', 'freshness', SOURCE_STATUSES);
  const intent_status = readEnum(problems, obj, 'intent_status', 'freshness', INTENT_STATUSES);
  const intent_revision = readId(problems, obj, 'intent_revision', 'freshness');
  const permission_revision = readId(problems, obj, 'permission_revision', 'freshness');
  const manifest = readManifest(problems, obj);
  const checked_at = readIso(problems, obj, 'checked_at', 'freshness');
  const expires_at = readIso(problems, obj, 'expires_at', 'freshness');
  const evidence_refs = readIdList(problems, obj, 'evidence_refs');
  const reasons = readReasons(problems, obj);
  if (defined(checked_at) && defined(expires_at)) {
    const checkedMs = Date.parse(checked_at);
    const expiresMs = Date.parse(expires_at);
    if (!Number.isFinite(checkedMs) || !Number.isFinite(expiresMs) || expiresMs <= checkedMs) {
      problems.add('freshness.expires_at', 'must be after checked_at');
    }
  }
  if (defined(manifest)) {
    const contributions: SourceStatus[] = [];
    for (let i = 0; i < manifest.length; i += 1) {
      const entry = manifest[i];
      if (!entry) continue;
      const classified = classifyEntry(entry);
      if ('invalid' in classified) problems.add(`freshness.manifest[${i}]`, classified.invalid);
      else contributions.push(classified.status);
    }
    if (defined(source_status) && contributions.length === manifest.length && manifest.length > 0) {
      const expected = aggregateStatus(contributions);
      if (source_status !== expected) problems.add('freshness.source_status', `expected ${expected}`);
    }
  }
  if (defined(source_status) && defined(intent_status) && defined(reasons) && defined(evidence_refs)) {
    if ((source_status !== 'FRESH' || intent_status !== 'VALID') && reasons.length < 1) {
      problems.add('freshness.reasons', 'a non-FRESH source or a non-VALID intent requires a reason');
    }
    if (source_status === 'FRESH' && evidence_refs.length < 1) {
      problems.add('freshness.evidence_refs', 'FRESH requires complete evidence_refs');
    }
  }
  if (!defined(envelope) || !defined(check_id) || !defined(action_digest) || !defined(context_digest)
    || !defined(source_status) || !defined(intent_status) || !defined(intent_revision) || !defined(permission_revision)
    || !defined(manifest) || !defined(checked_at) || !defined(expires_at) || !defined(evidence_refs) || !defined(reasons)
    || problems.bad) {
    return problems.fail();
  }
  const value: FreshnessCheck = {
    ...envelope,
    check_id, action_digest, context_digest, source_status, intent_status, intent_revision, permission_revision,
    manifest, checked_at, expires_at, evidence_refs, reasons,
  };
  return { ok: true, value };
}

export function revisionVectorMatches(check: FreshnessCheck, expected: RevisionVector): boolean {
  if (check.action_digest !== expected.action_digest || check.context_digest !== expected.context_digest) return false;
  if (check.intent_revision !== expected.intent_revision || check.permission_revision !== expected.permission_revision) return false;
  if (check.manifest.length !== expected.manifest.length) return false;
  for (let i = 0; i < expected.manifest.length; i += 1) {
    const want = expected.manifest[i];
    const got = check.manifest[i];
    if (!want || !got || want.source_id !== got.source_id || want.revision !== got.revision) return false;
  }
  return true;
}

/** Structural proceed gate. Does not grant authority and does not read a wall clock; P5 owns expiry races. */
export function canProceed(check: FreshnessCheck, expected?: RevisionVector): boolean {
  if (check.source_status !== 'FRESH' || check.intent_status !== 'VALID') return false;
  if (check.manifest.length < 1 || check.evidence_refs.length < 1) return false;
  if (Date.parse(check.expires_at) <= Date.parse(check.checked_at)) return false;
  for (const entry of check.manifest) {
    if (entry.coverage !== 'body' || entry.actually_emitted !== true || entry.freshness !== 'FRESH') return false;
  }
  if (expected && !revisionVectorMatches(check, expected)) return false;
  return true;
}

/** Dispatch refuses unless the source is FRESH and the intent is VALID. A changed permission stays refused. */
export function requireFreshForDispatch(input: unknown): PhaseCheck<FreshnessCheck> {
  const parsed = validateFreshnessCheck(input);
  if (!parsed.ok) return parsed;
  if (!canProceed(parsed.value)) {
    return {
      ok: false,
      errors: [
        `dispatch refused unless source_status is FRESH and intent_status is VALID (source_status is ${parsed.value.source_status}, intent_status is ${parsed.value.intent_status})`,
      ],
    };
  }
  return parsed;
}

/** Freshness never grants release, security, or budget authority, including a FRESH + VALID live-shaped check. */
export function freshnessGrantsAuthority(check: FreshnessCheck): false {
  if (check.source_status === 'FRESH' && check.intent_status === 'VALID' && check.proof_mode === 'live') return false;
  return false;
}
