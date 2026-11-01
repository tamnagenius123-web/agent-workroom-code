// BOUNDARY CONTRACT — mirrors src/server/verifier-receipt.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime entry point
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; no gate or verdict behavior is implemented or simulated here.

import { boundaryUnavailable } from '../boundary.ts';
import type { PhaseConsumer } from '../phase-contracts/check.ts';
import type {
  FailurePacket, MethodLineage, RedCaseId, VerifierReceipt,
} from '../phase-contracts/verifier-receipt.ts';

export const GATE_VERSION = 'p1.0' as const;
export const SEPARATE_GATES = ['trusted_auth', 'atomic_approval'] as const;

export interface CaseRun {
  case_id: RedCaseId;
  evidence: string | null;
  evidence_sha256: string | null;
}

export interface ReceiptObservation {
  consumer: PhaseConsumer;
  producer_id: string;
  acceptor_id: string;
  next_maker: string;
  author_lineage: MethodLineage;
  verifier_lineage: MethodLineage;
  sha: string;
  observed_sha: string;
  claimed_gate_version: string;
  task_id: string;
  attempt_id: string;
  artifact_digest: string;
  verifier_id: string;
  lease: { epoch: string; stale: boolean } | null;
  capability_label_as_authority: boolean;
  approval_events: readonly ('accept' | 'revoke')[];
  observation_ok: boolean;
  runs: readonly CaseRun[];
}

export interface ReceiptEvaluation {
  disposition: 'PASS' | 'HOLD';
  receipt: VerifierReceipt | null;
  reasons: readonly string[];
  failure_packet: FailurePacket | null;
  observation_report: 'RETAINED' | 'UNKNOWN';
  separate_gates: typeof SEPARATE_GATES;
}

export function evaluateVerifierReceipt(_input: ReceiptObservation): ReceiptEvaluation {
  return boundaryUnavailable('src/server/verifier-receipt.ts', 'evaluateVerifierReceipt', _input);
}
