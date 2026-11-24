import type { Database, Rows, Statement, Value } from './db.ts';
import { DB_NOW } from './tasks.ts';
import { claimUnitLease, releaseUnitLease, type UnitLease } from './unit-leases.ts';

/** These are admission limits, not claims about physical OS processes or model internals. */
export interface ExecutionLimits {
  logical_agents: number;
  model_calls: number;
  processes: number;
  tools: number;
}

export const DEFAULT_EXECUTION_LIMITS: Readonly<ExecutionLimits> = Object.freeze({
  logical_agents: 4, model_calls: 2, processes: 4, tools: 2,
});
export const EXECUTION_LEASE_MS = 5 * 60_000;

export class ExecutionFenceLost extends Error {
  constructor() { super('execution_fence_lost'); this.name = 'ExecutionFenceLost'; }
}

export interface ExecutionFence {
  holder: string;
  leases: UnitLease[];
  limits: ExecutionLimits;
}

export type ExecutionAdmission =
  | { admitted: true; fence: ExecutionFence }
  | { admitted: false; reason: 'run_busy' | 'task_busy' | 'agent_busy' | 'capacity'; plane: string };

export function executionLimits(input: Partial<ExecutionLimits> = {}): ExecutionLimits {
  const out = { ...DEFAULT_EXECUTION_LIMITS, ...input };
  for (const [key, value] of Object.entries(out)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 64) throw new Error(`invalid execution limit: ${key}`);
  }
  return out;
}

export async function executionNow(db: Database): Promise<number> {
  const row = await db.prepare(`SELECT ${DB_NOW} AS now_ms`).first<{ now_ms: number }>();
  if (!row || !Number.isSafeInteger(row.now_ms) || row.now_ms < 0) throw new Error('invalid database clock');
  return row.now_ms;
}

function segment(value: string): string { return encodeURIComponent(value); }

/** Every invocation has a distinct holder, even when its authenticated principal is the same. */
export async function admitExecution(db: Database, input: {
  run_id: string; task_id: string; principal: string; model: string; limits?: Partial<ExecutionLimits>;
}): Promise<ExecutionAdmission> {
  const limits = executionLimits(input.limits);
  const fence: ExecutionFence = { holder: `execution:${crypto.randomUUID()}`, leases: [], limits };
  const now = await executionNow(db);
  const claim = async (unitId: string): Promise<boolean> => {
    const result = await claimUnitLease(db, unitId, fence.holder, now, EXECUTION_LEASE_MS);
    if (!result.acquired || !result.lease) return false;
    fence.leases.push(result.lease);
    return true;
  };
  const deny = async (reason: 'run_busy' | 'task_busy' | 'agent_busy' | 'capacity', plane: string): Promise<ExecutionAdmission> => {
    await releaseExecution(db, fence);
    return { admitted: false, reason, plane };
  };
  try {
    if (!await claim(`execution/run/${segment(input.run_id)}`)) return deny('run_busy', 'run');
    if (!await claim(`execution/task/${segment(input.task_id)}`)) return deny('task_busy', 'task');
    if (!await claim(`execution/agent/${segment(input.principal)}`)) return deny('agent_busy', 'logical_agent');
    // Separate pools make the three concurrency dimensions explicit. Admission is
    // bounded and fail-fast; this is not a starvation-free scheduler guarantee.
    for (const [plane, prefix, size] of [
      ['logical_agents', 'execution/logical', limits.logical_agents],
      ['processes', 'execution/process', limits.processes],
      ['model_calls', `execution/model/${segment(input.model)}`, limits.model_calls],
    ] as const) {
      let acquired = false;
      for (let slot = 0; slot < size; slot++) {
        if (await claim(`${prefix}/${slot}`)) { acquired = true; break; }
      }
      if (!acquired) return deny('capacity', plane);
    }
    return { admitted: true, fence };
  } catch (error) {
    await releaseExecution(db, fence);
    throw error;
  }
}

export async function admitTool(db: Database, fence: ExecutionFence): Promise<UnitLease | null> {
  const now = await executionNow(db);
  for (let slot = 0; slot < fence.limits.tools; slot++) {
    const result = await claimUnitLease(db, `execution/tool/${slot}`, fence.holder, now, EXECUTION_LEASE_MS);
    if (result.acquired && result.lease) { fence.leases.push(result.lease); return result.lease; }
  }
  return null;
}

export async function releaseExecution(db: Database, fence: ExecutionFence): Promise<void> {
  // Do not mask the actual run failure with best-effort cleanup; an unavailable
  // database leaves counted leases until their explicit expiry.
  for (const lease of fence.leases.toReversed()) {
    try { await releaseUnitLease(db, lease.unit_id, fence.holder, lease.generation); } catch { /* expiry recovers */ }
  }
}

export function executionPredicate(fence: ExecutionFence): { sql: string; args: Value[] } {
  return {
    sql: fence.leases.length ? fence.leases.map(() => `EXISTS (
      SELECT 1 FROM unit_leases WHERE unit_id=? AND holder=? AND generation=?
        AND state='held' AND lease_until>${DB_NOW})`).join(' AND ') : '0',
    args: fence.leases.flatMap(row => [row.unit_id, fence.holder, row.generation]),
  };
}

export async function executionLive(db: Database, fence: ExecutionFence): Promise<boolean> {
  const p = executionPredicate(fence);
  return !!await db.prepare(`SELECT 1 WHERE ${p.sql}`).bind(...p.args).first();
}

/**
 * D1 batch is a transaction. The first statement is an assertion: malformed JSON
 * is evaluated only on a lost fence and aborts the complete batch. Consequently
 * a check cannot be separated from the writes it protects by another claimant.
 * This adapter never grants task/intent authority; those are checked separately.
 */
export function fencedDatabase(db: Database, fence: ExecutionFence): Database {
  const guarded = async <T>(statements: Statement[]): Promise<Rows<T>[]> => {
    const p = executionPredicate(fence);
    const assertion = db.prepare(`SELECT json(CASE WHEN ${p.sql} THEN '{}' ELSE 'execution_fence_lost' END)`).bind(...p.args);
    try { return (await db.batch<T>([assertion, ...statements])).slice(1); }
    catch (error) {
      if (!await executionLive(db, fence)) throw new ExecutionFenceLost();
      throw error;
    }
  };
  class FencedStatement implements Statement {
    constructor(readonly raw: Statement) {}
    bind(...args: Value[]): Statement { return new FencedStatement(this.raw.bind(...args)); }
    async first<T>(): Promise<T | null> { return (await this.all<T>()).results[0] ?? null; }
    async all<T>(): Promise<Rows<T>> { return (await guarded<T>([this.raw]))[0]!; }
  }
  return {
    prepare(sql: string) { return new FencedStatement(db.prepare(sql)); },
    batch<T>(statements: Statement[]) {
      const raw = statements.map(statement => {
        if (!(statement instanceof FencedStatement)) throw new Error('statement belongs to another database');
        return statement.raw;
      });
      return guarded<T>(raw);
    },
  };
}
