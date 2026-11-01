// BOUNDARY CONTRACT — mirrors src/server/council-record.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime entry point
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; no gate or verdict behavior is implemented or simulated here.

import { boundaryUnavailable } from '../boundary.ts';
import type {
  PhaseCheck, PhaseConsumer, ProofMode, Provenance,
} from '../phase-contracts/check.ts';
import type { CouncilVerdict } from '../phase-contracts/council-verdict.ts';

const STANCES = ['assent', 'dissent', 'unknown'] as const;
void STANCES; // referenced by the CouncilRecord contract type below; the runtime reader lives in the gate repo

export interface SeatNote {
  member_id: string;
  stance: typeof STANCES[number];
  text: string;
  topic?: string;
}

export interface AgendaInput {
  agenda_id: string;
  consumer: PhaseConsumer;
  provenance: Provenance;
  proof_mode: ProofMode;
  owner_report_ref: string;
}

export interface AgendaRecord {
  stage: 'agenda';
  agenda_id: string;
  consumer: PhaseConsumer;
  provenance: Provenance;
  proof_mode: ProofMode;
  owner_report_ref: string;
}

export interface RoundInput {
  record_ref: string;
  notes: readonly SeatNote[];
}

export interface BlindRoundRecord {
  stage: 'blind_r1';
  agenda: AgendaRecord;
  record_ref: string;
  notes: readonly SeatNote[];
}

export interface CrossRoundRecord {
  stage: 'cross_r2';
  blind: BlindRoundRecord;
  record_ref: string;
  notes: readonly SeatNote[];
}

export interface ChairInput {
  chair_id: string;
  record_ref: string;
  summary: string;
  executed_at: string;
}

/** Chair seal, or a later correction snapshot. The W0 verdict stays inside `verdict`. */
export interface CouncilRecord {
  verdict: CouncilVerdict;
  /** Caller-supplied instant of the chair seal. Not a W0 verdict field. */
  executed_at: string;
  /** Prior snapshot id. Null on the chair seal. */
  corrects: string | null;
  record_id: string;
}

export interface CorrectionInput {
  correction_id: string;
  text: string;
  at: string;
}

export function openAgenda(_input: AgendaInput): PhaseCheck<AgendaRecord> {
  return boundaryUnavailable('src/server/council-record.ts', 'openAgenda', _input);
}

export function sealBlindRound(_agenda: AgendaRecord, _input: RoundInput): PhaseCheck<BlindRoundRecord> {
  return boundaryUnavailable('src/server/council-record.ts', 'sealBlindRound', _agenda, _input);
}

export function sealCrossRound(_blind: BlindRoundRecord, _input: RoundInput): PhaseCheck<CrossRoundRecord> {
  return boundaryUnavailable('src/server/council-record.ts', 'sealCrossRound', _blind, _input);
}

export function sealChair(_cross: CrossRoundRecord, _input: ChairInput): PhaseCheck<CouncilRecord> {
  return boundaryUnavailable('src/server/council-record.ts', 'sealChair', _cross, _input);
}

export function appendCouncilCorrection(_record: CouncilRecord, _input: CorrectionInput): PhaseCheck<CouncilRecord> {
  return boundaryUnavailable('src/server/council-record.ts', 'appendCouncilCorrection', _record, _input);
}

export function setOwnerAccepted(_record: CouncilRecord, _accepted: boolean): PhaseCheck<CouncilRecord> {
  return boundaryUnavailable('src/server/council-record.ts', 'setOwnerAccepted', _record, _accepted);
}

/** A grant attempt never changes the record. Release, security, and budget are forbidden. */
export function claimCouncilAuthority(_record: CouncilRecord, _claim: string): PhaseCheck<CouncilRecord> {
  return boundaryUnavailable('src/server/council-record.ts', 'claimCouncilAuthority', _record, _claim);
}

/** No council snapshot grants a claim. owner_accepted and a smuggled list do not change this. */
export function councilGrantsAuthority(_record: CouncilRecord, _claim: string): boolean {
  return boundaryUnavailable('src/server/council-record.ts', 'councilGrantsAuthority', _record, _claim);
}
