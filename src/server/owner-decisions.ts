// BOUNDARY CONTRACT — mirrors src/server/owner-decisions.ts in the gate MCP
// repo (agent-workroom-gate-mcp), split out under owner decision D5-cm
// (2026-11-01). Owner-decision data lives on the decision data server in the
// multi-server split (D5-cn); this repo keeps only the contract surface.
//
// Runtime behavior fails closed: the route dispatcher returns null (route not
// served here); activeOwnerDecisions returns null and lookupOwnerDecisions
// returns [] — the values the real module itself produces when the decision
// data is absent, which callers already handle; and the pure helpers normTs
// and groupBySource throw BoundaryUnavailableError rather than shaping
// decision data locally. No decision is ever fabricated. Phase 2 replaces
// this seam with decision-data-server calls.
import { boundaryUnavailable } from '../boundary.ts';
import type { Database } from './db.ts';

export type OwnerDecision = {
  id: string; ts_kst: string; source: string; verbatim: string; normalized: string;
  topics: string[]; supersedes: string[]; direct: boolean; active: boolean; ts_approx?: boolean;
};

// The route's service parameter type, mirrored from the real module.
type Service = { database: Database; authorize: (room?: string) => Promise<unknown> };

export function normTs(_ts: string): { ts_kst: string; ts_approx?: boolean } {
  return boundaryUnavailable('src/server/owner-decisions.ts', 'normTs', _ts);
}

export async function activeOwnerDecisions(_db: Database, _includeInactive = false): Promise<OwnerDecision[] | null> {
  void _db; void _includeInactive;
  // The real module returns null when the owner_directives table is absent;
  // in this repo the decision data is never present, so null (callers omit
  // the owner memory block) is the truthful fail-closed value.
  return null;
}

export async function lookupOwnerDecisions(_db: Database, _q: string): Promise<OwnerDecision[]> {
  void _db; void _q;
  // No owner decisions are served from this repo: the empty result.
  return [];
}

export function groupBySource(_hits: OwnerDecision[]): { source: string; ts_kst: string; decisions: OwnerDecision[] }[] {
  return boundaryUnavailable('src/server/owner-decisions.ts', 'groupBySource', _hits);
}

export async function ownerDecisionRoute(
  _service: Service,
  _request: Request,
  _url: URL,
): Promise<{ data: unknown; meta: { matched: number } } | null> {
  void _service; void _request; void _url;
  return null;
}
