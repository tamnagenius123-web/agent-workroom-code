// Sweep pre-screen. Pure: no clock, no network, no ledger.
// An unchanged state hash skips every model call.

import { createHash } from 'node:crypto';

export interface SweepMemory {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, hash: string): Promise<void> | void;
}

export class MapSweepMemory implements SweepMemory {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, hash: string): void {
    this.values.set(key, hash);
  }
}

export function sweepKey(unitId: string, point: string): string {
  return `${unitId}\n${point}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function stateHash(state: unknown): string {
  return createHash('sha256').update(canonicalJson(state)).digest('hex');
}

/** True only when a previous sweep stored this exact state hash. */
export function shouldSkipSweep(previousHash: string | null, nextHash: string): boolean {
  return previousHash !== null && previousHash === nextHash;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}
