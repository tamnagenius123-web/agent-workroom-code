// Shared parsing for phase-boundary validators. No zod. Callers collect every problem.

export type PhaseCheck<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class Problems {
  readonly errors: string[] = [];
  add(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }
  get bad(): boolean {
    return this.errors.length > 0;
  }
  fail(): PhaseCheck<never> {
    return { ok: false, errors: this.errors };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readObject(problems: Problems, value: unknown, path: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    problems.add(path, 'expected an object');
    return null;
  }
  return value;
}

export function checkKeys(problems: Problems, obj: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) problems.add(path, `unknown field ${JSON.stringify(key)}`);
  }
}

export function includesConst<T extends string>(allowed: readonly T[], value: string): value is T {
  return (allowed as readonly string[]).includes(value);
}

export function readEnum<T extends string>(
  problems: Problems, obj: Record<string, unknown>, key: string, path: string, allowed: readonly T[],
): T | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !includesConst(allowed, value)) {
    problems.add(`${path}.${key}`, `expected one of ${allowed.join('|')}`);
    return undefined;
  }
  return value;
}

export function readId(problems: Problems, obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    problems.add(`${path}.${key}`, 'expected an id of 1..128 characters [A-Za-z0-9_.:-]');
    return undefined;
  }
  return value;
}

export function readNullableId(problems: Problems, obj: Record<string, unknown>, key: string, path: string): string | null | undefined {
  if (!(key in obj)) {
    problems.add(`${path}.${key}`, 'required');
    return undefined;
  }
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    problems.add(`${path}.${key}`, 'expected an id or null');
    return undefined;
  }
  return value;
}

export function readText(
  problems: Problems, obj: Record<string, unknown>, key: string, path: string, max = 4000,
): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) {
    problems.add(`${path}.${key}`, `expected non-empty text up to ${max} characters`);
    return undefined;
  }
  return value;
}

export function readNullableText(
  problems: Problems, obj: Record<string, unknown>, key: string, path: string, max = 2000,
): string | null | undefined {
  if (!(key in obj)) {
    problems.add(`${path}.${key}`, 'required');
    return undefined;
  }
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) {
    problems.add(`${path}.${key}`, `expected text up to ${max} characters, or null`);
    return undefined;
  }
  return value;
}

export function readBool(problems: Problems, obj: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    problems.add(`${path}.${key}`, 'expected a boolean');
    return undefined;
  }
  return value;
}

export function readNullableBool(problems: Problems, obj: Record<string, unknown>, key: string, path: string): boolean | null | undefined {
  if (!(key in obj)) {
    problems.add(`${path}.${key}`, 'required');
    return undefined;
  }
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'boolean') {
    problems.add(`${path}.${key}`, 'expected a boolean or null');
    return undefined;
  }
  return value;
}

/** Integer micro-USD and counts. Floats and numeric strings are rejected. */
export function readInt(
  problems: Problems, obj: Record<string, unknown>, key: string, path: string, min = 0,
): number | undefined {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    problems.add(`${path}.${key}`, `expected an integer >= ${min}`);
    return undefined;
  }
  return value;
}

export function readNullableInt(
  problems: Problems, obj: Record<string, unknown>, key: string, path: string, min = 0,
): number | null | undefined {
  if (!(key in obj)) {
    problems.add(`${path}.${key}`, 'required');
    return undefined;
  }
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    problems.add(`${path}.${key}`, `expected an integer >= ${min}, or null`);
    return undefined;
  }
  return value;
}

export function readIso(problems: Problems, obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !ISO_RE.test(value)) {
    problems.add(`${path}.${key}`, 'expected an ISO-8601 timestamp with a timezone');
    return undefined;
  }
  return value;
}

export function readNullableIso(problems: Problems, obj: Record<string, unknown>, key: string, path: string): string | null | undefined {
  if (!(key in obj)) {
    problems.add(`${path}.${key}`, 'required');
    return undefined;
  }
  const value = obj[key];
  if (value === null) return null;
  if (typeof value !== 'string' || !ISO_RE.test(value)) {
    problems.add(`${path}.${key}`, 'expected an ISO-8601 timestamp with a timezone, or null');
    return undefined;
  }
  return value;
}

export function readSha40(problems: Problems, obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !SHA40_RE.test(value)) {
    problems.add(`${path}.${key}`, 'expected a full 40-hex sha (lowercase)');
    return undefined;
  }
  return value;
}

export function readSha256(problems: Problems, obj: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    problems.add(`${path}.${key}`, 'expected a 64-hex sha256 (lowercase)');
    return undefined;
  }
  return value;
}

export function readArray(problems: Problems, obj: Record<string, unknown>, key: string, path: string): unknown[] | undefined {
  const value = obj[key];
  if (!Array.isArray(value)) {
    problems.add(`${path}.${key}`, 'expected an array');
    return undefined;
  }
  return value;
}

export function distinctIds(problems: Problems, entries: ReadonlyArray<readonly [string, string | undefined]>, path: string): void {
  const seen = new Map<string, string>();
  for (const [label, value] of entries) {
    if (value === undefined) continue;
    const previous = seen.get(value);
    if (previous !== undefined) problems.add(path, `${label} duplicates ${previous}`);
    else seen.set(value, label);
  }
}

export function defined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

/** Shared W0 envelope. schema_version is the only accepted contract version. */
export const SCHEMA_VERSION = '1' as const;

/** Downstream phase that may consume the record. P0 through P6 only. */
export const PHASE_CONSUMERS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;
export type PhaseConsumer = typeof PHASE_CONSUMERS[number];

/** synthetic is a fixture or mock. live is a server-observed proof and is never implied. */
export const PROOF_MODES = ['synthetic', 'live'] as const;
export type ProofMode = typeof PROOF_MODES[number];

export const PROVENANCE_KINDS = ['synthetic_fixture', 'server_observed'] as const;
export type ProvenanceKind = typeof PROVENANCE_KINDS[number];

export interface Provenance {
  kind: ProvenanceKind;
  producer_id: string;
  source_ref: string;
}

export interface PhaseEnvelope {
  schema_version: typeof SCHEMA_VERSION;
  consumer: PhaseConsumer;
  provenance: Provenance;
  proof_mode: ProofMode;
}

export const ENVELOPE_KEYS = ['schema_version', 'consumer', 'provenance', 'proof_mode'] as const;
const PROVENANCE_KEYS = ['kind', 'producer_id', 'source_ref'] as const;

/**
 * Mock and synthetic records cannot validate as live proof.
 * synthetic_fixture pairs only with proof_mode synthetic.
 * server_observed pairs only with proof_mode live.
 */
export function readEnvelope(problems: Problems, obj: Record<string, unknown>, path: string): PhaseEnvelope | undefined {
  if (obj.schema_version !== SCHEMA_VERSION) {
    problems.add(`${path}.schema_version`, `expected ${JSON.stringify(SCHEMA_VERSION)}`);
  }
  const consumer = readEnum(problems, obj, 'consumer', path, PHASE_CONSUMERS);
  const proof_mode = readEnum(problems, obj, 'proof_mode', path, PROOF_MODES);
  let provenance: Provenance | undefined;
  const raw = obj.provenance;
  const provenancePath = `${path}.provenance`;
  if (!isRecord(raw)) {
    problems.add(provenancePath, 'expected an object');
  } else {
    checkKeys(problems, raw, PROVENANCE_KEYS, provenancePath);
    const kind = readEnum(problems, raw, 'kind', provenancePath, PROVENANCE_KINDS);
    const producer_id = readId(problems, raw, 'producer_id', provenancePath);
    const source_ref = readId(problems, raw, 'source_ref', provenancePath);
    if (defined(kind) && defined(producer_id) && defined(source_ref)) provenance = { kind, producer_id, source_ref };
  }
  if (provenance && proof_mode) {
    if (provenance.kind === 'synthetic_fixture' && proof_mode === 'live') {
      problems.add(`${path}.proof_mode`, 'synthetic proof cannot validate as live');
    }
    if (provenance.kind === 'server_observed' && proof_mode === 'synthetic') {
      problems.add(`${path}.proof_mode`, 'server_observed provenance is not synthetic proof');
    }
  }
  if (obj.schema_version !== SCHEMA_VERSION || !defined(consumer) || !defined(proof_mode) || !defined(provenance)) return undefined;
  return { schema_version: SCHEMA_VERSION, consumer, provenance, proof_mode };
}

/** True only for a server-observed live record. Synthetic fixtures are never live. */
export function recordIsLiveProof(record: PhaseEnvelope): boolean {
  return record.proof_mode === 'live' && record.provenance.kind === 'server_observed';
}
