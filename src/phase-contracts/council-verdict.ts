// BOUNDARY CONTRACT — mirrors src/phase-contracts/council-verdict.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime validator
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; contract validation behavior is not implemented or simulated in
// this repo.

import { boundaryUnavailable } from '../boundary.ts';
import type { PhaseCheck, PhaseEnvelope } from './check.ts';

export const COUNCIL_AUTHORITY_CONFLICT = 'unresolved' as const;

export const FORBIDDEN_AUTHORITY = ['release', 'security', 'budget'] as const;
export type ForbiddenAuthority = typeof FORBIDDEN_AUTHORITY[number];

export const ROUND_NAMES = ['blind_r1', 'cross_r2'] as const;
export type RoundName = typeof ROUND_NAMES[number];

export interface CouncilRound {
  name: RoundName;
  record_ref: string;
}

export interface ChairRecord {
  chair_id: string;
  record_ref: string;
  summary: string;
}

export interface DissentEntry {
  member_id: string;
  text: string;
}

export interface UnknownEntry {
  topic: string;
  note: string;
}

export interface CouncilCorrection {
  correction_id: string;
  seq: number;
  text: string;
  at: string;
}

export interface CouncilVerdict extends PhaseEnvelope {
  agenda_id: string;
  rounds: CouncilRound[];
  chair: ChairRecord;
  dissent: DissentEntry[];
  unknowns: UnknownEntry[];
  executes_immediately: true;
  owner_report_ref: string;
  owner_accepted: boolean | null;
  corrections: CouncilCorrection[];
  authority: [];
}

export function validateCouncilVerdict(_input: unknown): PhaseCheck<CouncilVerdict> {
  return boundaryUnavailable('src/phase-contracts/council-verdict.ts', 'validateCouncilVerdict', _input);
}

export function appendCorrection(
  _verdict: CouncilVerdict, _correction: unknown,
): PhaseCheck<CouncilVerdict> {
  return boundaryUnavailable('src/phase-contracts/council-verdict.ts', 'appendCorrection', _verdict, _correction);
}
