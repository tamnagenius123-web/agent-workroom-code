// BOUNDARY CONTRACT — mirrors src/server/unit-cost.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime entry point
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; no gate or verdict behavior is implemented or simulated here.

import { boundaryUnavailable } from '../boundary.ts';
import type { PhaseCheck } from '../phase-contracts/check.ts';
import type { SpendCategory, UnitCostRecord } from '../phase-contracts/dispatch.ts';

export const UNKNOWN_COST = 'UNKNOWN' as const;
export type CostUsdMicros = number | typeof UNKNOWN_COST;

export interface RecordedUnitCost {
  /** W0 projection. category and cost_usd_micros are not fields on this object. */
  record: UnitCostRecord;
  category: SpendCategory;
  cost_usd_micros: CostUsdMicros;
}

export interface CategoryCostTotal {
  record_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd_micros: CostUsdMicros;
  known_usd_micros: number;
  unknown_count: number;
}

export interface UnitCostAggregate extends CategoryCostTotal {
  by_category: Record<SpendCategory, CategoryCostTotal>;
}

/** Dollar view of a W0 record. A null usd_micros is UNKNOWN. Subscription usage is not added in. */
export function costUsdMicrosOf(_record: UnitCostRecord): CostUsdMicros {
  return boundaryUnavailable('src/server/unit-cost.ts', 'costUsdMicrosOf', _record);
}

export function recordUnitCost(_input: unknown): PhaseCheck<RecordedUnitCost> {
  return boundaryUnavailable('src/server/unit-cost.ts', 'recordUnitCost', _input);
}

export function aggregateUnitCosts(_records: readonly RecordedUnitCost[]): PhaseCheck<UnitCostAggregate> {
  return boundaryUnavailable('src/server/unit-cost.ts', 'aggregateUnitCosts', _records);
}
