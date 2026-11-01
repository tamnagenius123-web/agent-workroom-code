// IW-04 counting unit (roadmap P6). The key is candidate, parent hash, task/case,
// split, artifact revision, and evaluator epoch. Records that share it are one case.
// Retries, judgment seeds, and repeated runs aggregate as repeated measurements
// (n and spread: min, max, sample standard deviation) and never count as new cases.
// Results use PhaseCheck. Pure: no I/O, no clock, no network, no DB.

import {
  Problems, defined, readObject, readText, type PhaseCheck,
} from './check.ts';

export const DEDUP_KEY_VERSION = 'iw04.dedup.v1';

export const DEDUP_KEY_FIELDS = [
  'candidate',
  'parentHash',
  'taskCase',
  'split',
  'artifactRevision',
  'evaluatorEpoch',
] as const;

export type DedupKeyField = (typeof DEDUP_KEY_FIELDS)[number];

const KEY_TEXT_MAX = 256;

export interface Iw04DedupKey {
  candidate: string;
  parentHash: string;
  taskCase: string;
  split: string;
  artifactRevision: string;
  evaluatorEpoch: string;
}

/** A measured run. retry, judgmentSeed, runId, and any other extras do not split cases. */
export interface Iw04Measurement extends Iw04DedupKey {
  value: number;
  retry?: number | string;
  judgmentSeed?: string | number;
  runId?: string;
}

export interface Iw04Spread {
  min: number;
  max: number;
  stddev: number;
}

export interface Iw04Case {
  id: string;
  key: Iw04DedupKey;
  n: number;
  spread: Iw04Spread;
}

function readKeyField(
  problems: Problems, obj: Record<string, unknown>, key: DedupKeyField, path: string,
): string | undefined {
  const value = readText(problems, obj, key, path, KEY_TEXT_MAX);
  if (value === undefined) return undefined;
  if (!value.isWellFormed()) {
    problems.add(`${path}.${key}`, 'expected well-formed text');
    return undefined;
  }
  return value;
}

function readKey(problems: Problems, obj: Record<string, unknown>, path: string): Iw04DedupKey | undefined {
  const candidate = readKeyField(problems, obj, 'candidate', path);
  const parentHash = readKeyField(problems, obj, 'parentHash', path);
  const taskCase = readKeyField(problems, obj, 'taskCase', path);
  const split = readKeyField(problems, obj, 'split', path);
  const artifactRevision = readKeyField(problems, obj, 'artifactRevision', path);
  const evaluatorEpoch = readKeyField(problems, obj, 'evaluatorEpoch', path);
  if (!defined(candidate) || !defined(parentHash) || !defined(taskCase) || !defined(split)
    || !defined(artifactRevision) || !defined(evaluatorEpoch)) return undefined;
  return { candidate, parentHash, taskCase, split, artifactRevision, evaluatorEpoch };
}

function encodeValidated(key: Iw04DedupKey): string {
  return JSON.stringify([DEDUP_KEY_VERSION, ...DEDUP_KEY_FIELDS.map(field => key[field])]);
}

/** Measurement values are finite numbers. Integer counts and micro-USD stay on readInt. */
function readFinite(problems: Problems, value: unknown, path: string): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.add(path, 'expected a finite number');
    return undefined;
  }
  return value;
}

/** Raw sum and squared deviations stay finite and normal inside this magnitude. */
function rawMomentsFit(n: number, maxAbs: number): boolean {
  if (maxAbs === 0) return true;
  if (maxAbs > Number.MAX_VALUE / n) return false;
  const span = maxAbs * 2;
  const sq = span * span;
  // 2^-1022 is the smallest normal binary64. A subnormal or zero square has
  // underflowed; a non-finite square has overflowed. Either loses a deviation.
  if (sq < 2 ** -1022 || !Number.isFinite(sq)) return false;
  return sq <= Number.MAX_VALUE / n;
}

function rawMoments(values: readonly number[]): { mean: number; stddev: number } {
  const n = values.length;
  let sum = 0;
  for (const value of values) sum += value;
  const mean = sum / n;
  let sq = 0;
  for (const value of values) {
    const delta = value - mean;
    sq += delta * delta;
  }
  return { mean, stddev: Math.sqrt(sq / (n - 1)) };
}

/** Two-pass moments on values / maxAbs, then scaled back. maxAbs is positive. */
function scaledMoments(values: readonly number[], maxAbs: number): { mean: number; stddev: number } {
  const n = values.length;
  let sum = 0;
  for (const value of values) sum += value / maxAbs;
  const meanUnit = sum / n;
  let sq = 0;
  for (const value of values) {
    const delta = value / maxAbs - meanUnit;
    sq += delta * delta;
  }
  return { mean: meanUnit * maxAbs, stddev: Math.sqrt(sq / (n - 1)) * maxAbs };
}

function finiteSpread(min: number, max: number, mean: number, stddev: number): PhaseCheck<Iw04Spread> {
  const stats = { min, max, mean, stddev };
  const problems = new Problems();
  for (const field of ['min', 'max', 'mean', 'stddev'] as const) {
    if (!Number.isFinite(stats[field])) problems.add(`spread.${field}`, 'expected a finite number');
  }
  if (problems.bad) return problems.fail();
  return { ok: true, value: { min, max, stddev } };
}

/** Sample standard deviation (n-1). A single measurement reports stddev 0.
 *  Huge or tiny samples are scaled by the max absolute value so a representable
 *  deviation stays finite. A non-finite min, max, mean, or stddev is rejected.
 */
function spreadOf(values: readonly number[]): PhaseCheck<Iw04Spread> {
  const first = values[0] ?? 0;
  let min = first;
  let max = first;
  let maxAbs = Math.abs(first);
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
    const abs = Math.abs(value);
    if (abs > maxAbs) maxAbs = abs;
  }
  const n = values.length;
  if (n < 2) return finiteSpread(min, max, first, 0);
  let moments = rawMomentsFit(n, maxAbs) ? rawMoments(values) : undefined;
  // A zero deviation of unequal samples means the squares flushed to zero.
  const flushed = moments !== undefined && moments.stddev === 0 && min !== max;
  if (!moments || flushed || !Number.isFinite(moments.mean) || !Number.isFinite(moments.stddev)) {
    moments = scaledMoments(values, maxAbs);
  }
  return finiteSpread(min, max, moments.mean, moments.stddev);
}

/** Stable, delimiter-safe encoding of the six-field counting key. Extras are ignored. */
export function encodeDedupKey(parts: unknown): PhaseCheck<string> {
  const problems = new Problems();
  const obj = readObject(problems, parts, 'dedup_key');
  if (!obj) return problems.fail();
  const key = readKey(problems, obj, 'dedup_key');
  if (!defined(key) || problems.bad) return problems.fail();
  return { ok: true, value: encodeValidated(key) };
}

export function decodeDedupKey(encoded: unknown): PhaseCheck<Iw04DedupKey> {
  const problems = new Problems();
  if (typeof encoded !== 'string') {
    problems.add('dedup_key', 'expected a string');
    return problems.fail();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    problems.add('dedup_key', 'expected JSON');
    return problems.fail();
  }
  if (!Array.isArray(parsed) || parsed.length !== DEDUP_KEY_FIELDS.length + 1) {
    problems.add('dedup_key', `expected a ${DEDUP_KEY_FIELDS.length + 1}-element key array`);
    return problems.fail();
  }
  if (parsed[0] !== DEDUP_KEY_VERSION) {
    problems.add('dedup_key', `expected ${JSON.stringify(DEDUP_KEY_VERSION)}`);
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < DEDUP_KEY_FIELDS.length; i += 1) {
    const field = DEDUP_KEY_FIELDS[i];
    if (field === undefined) continue;
    obj[field] = parsed[i + 1];
  }
  const key = readKey(problems, obj, 'dedup_key');
  if (!defined(key) || problems.bad) return problems.fail();
  return { ok: true, value: key };
}

export function measurementSpread(values: unknown): PhaseCheck<Iw04Spread> {
  const problems = new Problems();
  if (!Array.isArray(values) || values.length < 1) {
    problems.add('values', 'expected a non-empty array');
    return problems.fail();
  }
  const nums: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const value = readFinite(problems, values[i], `values[${i}]`);
    if (defined(value)) nums.push(value);
  }
  if (problems.bad) return problems.fail();
  return spreadOf(nums);
}

/**
 * Group records by the IW-04 counting key and aggregate repeated runs as one case.
 * Case count is the number of distinct keys, never the number of retries or seeds.
 */
export function dedupCases(records: unknown): PhaseCheck<Iw04Case[]> {
  const problems = new Problems();
  if (!Array.isArray(records)) {
    problems.add('records', 'expected an array');
    return problems.fail();
  }
  const groups = new Map<string, { key: Iw04DedupKey; values: number[] }>();
  for (let i = 0; i < records.length; i += 1) {
    const path = `records[${i}]`;
    const obj = readObject(problems, records[i], path);
    if (!obj) continue;
    const key = readKey(problems, obj, path);
    const value = readFinite(problems, obj.value, `${path}.value`);
    if (!defined(key) || !defined(value)) continue;
    const id = encodeValidated(key);
    const group = groups.get(id);
    if (group) group.values.push(value);
    else groups.set(id, { key, values: [value] });
  }
  if (problems.bad) return problems.fail();
  const cases: Iw04Case[] = [];
  const ordered = [...groups.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  for (const [id, group] of ordered) {
    const spread = spreadOf(group.values);
    if (!spread.ok) return spread;
    cases.push({
      id,
      key: group.key,
      n: group.values.length,
      spread: spread.value,
    });
  }
  return { ok: true, value: cases };
}
