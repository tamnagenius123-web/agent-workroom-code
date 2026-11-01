// BOUNDARY CONTRACT — mirrors src/phase-contracts/verifier-receipt.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime entry point
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; no gate or verdict behavior is implemented or simulated here.

import { boundaryUnavailable } from '../boundary.ts';
import type { PhaseCheck, PhaseEnvelope } from './check.ts';

export const VERDICTS = ['PASS', 'HOLD', 'NOT_RUN'] as const;
export type Verdict = typeof VERDICTS[number];

export const RED_CASE_IDS = ['RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'RC6', 'RC7', 'RC8'] as const;
export type RedCaseId = typeof RED_CASE_IDS[number];

/** Descriptions are not defined in W0. Dots publishes them. Do not treat TBD as a definition. */
export const RED_CASE_DESCRIPTIONS: { readonly [K in RedCaseId]: 'TBD' } = {
  RC1: 'TBD', RC2: 'TBD', RC3: 'TBD', RC4: 'TBD', RC5: 'TBD', RC6: 'TBD', RC7: 'TBD', RC8: 'TBD',
};

export const CASE_STATES = ['passed', 'missing', 'not_run'] as const;
export type CaseState = typeof CASE_STATES[number];

export interface UnpublishedGateField {
  id: 'F2' | 'F3' | 'F6';
  description: 'TBD';
}

export interface MethodLineage {
  method: string;
  dependencies: string[];
}

export interface VerifierCase {
  case_id: RedCaseId;
  state: CaseState;
  evidence: string | null;
}

export interface FailurePacket {
  failed_cases: RedCaseId[];
  evidence: string[];
  next_maker: string;
}

export interface VerifierReceipt extends PhaseEnvelope {
  sha: string;
  observed_sha: string;
  gate_version: string;
  cases: VerifierCase[];
  author_lineage: MethodLineage;
  verifier_lineage: MethodLineage;
  producer_id: string;
  acceptor_id: string;
  verdict: Verdict;
  failure_packet: FailurePacket | null;
  f2: UnpublishedGateField;
  f3: UnpublishedGateField;
  f6: UnpublishedGateField;
}

/** NOT_RUN and HOLD both withhold a pass. Only a verdict of PASS passes the gate. */
export function gateDisposition(_receipt: VerifierReceipt): 'PASS' | 'HOLD' {
  return boundaryUnavailable('src/phase-contracts/verifier-receipt.ts', 'gateDisposition', _receipt);
}

/** A synthetic, NOT_RUN, or evidence-missing receipt is not live proof. */
export function receiptIsLiveProof(_receipt: VerifierReceipt): boolean {
  return boundaryUnavailable('src/phase-contracts/verifier-receipt.ts', 'receiptIsLiveProof', _receipt);
}

export function validateVerifierReceipt(_input: unknown): PhaseCheck<VerifierReceipt> {
  return boundaryUnavailable('src/phase-contracts/verifier-receipt.ts', 'validateVerifierReceipt', _input);
}
