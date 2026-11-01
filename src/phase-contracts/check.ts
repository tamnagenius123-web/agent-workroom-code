// BOUNDARY CONTRACT — mirrors src/phase-contracts/check.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime validator
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; contract validation behavior is not implemented or simulated in
// this repo.

import { boundaryUnavailable } from '../boundary.ts';

export type PhaseCheck<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

export class Problems {
  readonly errors: string[] = [];

  add(_path: string, _message: string): void {
    boundaryUnavailable('src/phase-contracts/check.ts', 'Problems.add', _path, _message);
  }

  get bad(): boolean {
    return boundaryUnavailable('src/phase-contracts/check.ts', 'Problems.bad');
  }

  fail(): PhaseCheck<never> {
    return boundaryUnavailable('src/phase-contracts/check.ts', 'Problems.fail');
  }
}

export function isRecord(_value: unknown): _value is Record<string, unknown> {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'isRecord', _value);
}

export function readObject(
  _problems: Problems, _value: unknown, _path: string,
): Record<string, unknown> | null {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readObject', _problems, _value, _path);
}

export function checkKeys(
  _problems: Problems, _obj: Record<string, unknown>, _allowed: readonly string[], _path: string,
): void {
  boundaryUnavailable('src/phase-contracts/check.ts', 'checkKeys', _problems, _obj, _allowed, _path);
}

export function includesConst<T extends string>(
  _allowed: readonly T[], _value: string,
): _value is T {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'includesConst', _allowed, _value);
}

export function readEnum<T extends string>(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string, _allowed: readonly T[],
): T | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readEnum', _problems, _obj, _key, _path, _allowed);
}

export function readId(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): string | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readId', _problems, _obj, _key, _path);
}

export function readNullableId(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): string | null | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readNullableId', _problems, _obj, _key, _path);
}

export function readText(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string, _max = 4000,
): string | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readText', _problems, _obj, _key, _path, _max);
}

export function readNullableText(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string, _max = 2000,
): string | null | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readNullableText', _problems, _obj, _key, _path, _max);
}

export function readBool(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): boolean | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readBool', _problems, _obj, _key, _path);
}

export function readNullableBool(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): boolean | null | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readNullableBool', _problems, _obj, _key, _path);
}

export function readInt(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string, _min = 0,
): number | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readInt', _problems, _obj, _key, _path, _min);
}

export function readNullableInt(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string, _min = 0,
): number | null | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readNullableInt', _problems, _obj, _key, _path, _min);
}

export function readIso(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): string | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readIso', _problems, _obj, _key, _path);
}

export function readNullableIso(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): string | null | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readNullableIso', _problems, _obj, _key, _path);
}

export function readSha40(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): string | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readSha40', _problems, _obj, _key, _path);
}

export function readSha256(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): string | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readSha256', _problems, _obj, _key, _path);
}

export function readArray(
  _problems: Problems, _obj: Record<string, unknown>, _key: string, _path: string,
): unknown[] | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readArray', _problems, _obj, _key, _path);
}

export function distinctIds(
  _problems: Problems, _entries: ReadonlyArray<readonly [string, string | undefined]>, _path: string,
): void {
  boundaryUnavailable('src/phase-contracts/check.ts', 'distinctIds', _problems, _entries, _path);
}

export function defined<T>(_value: T | undefined): _value is T {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'defined', _value);
}

export const SCHEMA_VERSION = '1' as const;

export const PHASE_CONSUMERS = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;
export type PhaseConsumer = typeof PHASE_CONSUMERS[number];

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

export function readEnvelope(
  _problems: Problems, _obj: Record<string, unknown>, _path: string,
): PhaseEnvelope | undefined {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'readEnvelope', _problems, _obj, _path);
}

export function recordIsLiveProof(_record: PhaseEnvelope): boolean {
  return boundaryUnavailable('src/phase-contracts/check.ts', 'recordIsLiveProof', _record);
}
