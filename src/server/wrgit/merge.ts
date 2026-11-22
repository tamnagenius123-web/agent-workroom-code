// Fail-closed stand-in. The merge implementation lives in agent-workroom-gate-mcp.
// This file keeps the timer helper the workerd abort check reads, and every
// merge operation throws Fault from the shared contract.
import { Fault } from '../contracts.ts';

const closed = () => new Fault('UNAVAILABLE', 'WR-GIT merge is served by the gate MCP repo.', 503);

export const ARTIFACTS_CALL_TIMEOUT_MS = 20_000;
export const MERGE_CLOCK_SKEW_MS = 1_000;
export const WRITE_OPEN_LEASE_MS = ARTIFACTS_CALL_TIMEOUT_MS + MERGE_CLOCK_SKEW_MS + 1;

export function lockAbortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

export function artifactsCallBudget(..._discarded: unknown[]): never {
  void _discarded;
  throw closed();
}

export const mergeClock = { now: (): never => { throw closed(); } };

export async function submitWorkspace(..._discarded: unknown[]): Promise<never> {
  void _discarded;
  throw closed();
}

export async function mergeTask(..._discarded: unknown[]): Promise<never> {
  void _discarded;
  throw closed();
}

export async function reclaimWriteOpen(..._discarded: unknown[]): Promise<never> {
  void _discarded;
  throw closed();
}

export async function takeoverExpiredLease(..._discarded: unknown[]): Promise<never> {
  void _discarded;
  throw closed();
}

export async function reconcileMergeIntents(..._discarded: unknown[]): Promise<never> {
  void _discarded;
  throw closed();
}
