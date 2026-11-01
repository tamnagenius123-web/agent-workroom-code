// BOUNDARY CONTRACT — mirrors src/phase-contracts/wake-proof.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime entry point
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; no gate or verdict behavior is implemented or simulated here.

import { boundaryUnavailable } from '../boundary.ts';
import type { PhaseCheck, PhaseEnvelope } from './check.ts';

export const EVIDENCE_SOURCES = ['server_observed', 'caller_claimed'] as const;
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];

export interface WakeStage {
  stage_id: string;
  evidence_source: EvidenceSource;
  evidence_ref: string | null;
  observed_at: string | null;
}

export interface WakeProof extends PhaseEnvelope {
  event_id: string;
  message_id: string;
  attempt_id: string;
  relay_receipt: WakeStage;
  native_host_run: WakeStage;
  authenticated_exact_read: WakeStage;
}

export interface HandoffReceipt extends PhaseEnvelope {
  injection_receipt_id: string;
  sealed_checkpoint_hash: string;
  event_id: string;
  message_id: string;
  attempt_id: string;
  relay_receipt_stage_id: string;
  native_host_run_stage_id: string;
  authenticated_exact_read_stage_id: string;
}

/** Only server_observed evidence counts. A caller claim is recorded and unverified. */
export function stageCountsAsVerified(_stage: WakeStage): boolean {
  return boundaryUnavailable('src/phase-contracts/wake-proof.ts', 'stageCountsAsVerified', _stage);
}

/** Live only when the envelope is server-observed live and every stage was server-observed. */
export function proofIsProvenLive(_proof: WakeProof): boolean {
  return boundaryUnavailable('src/phase-contracts/wake-proof.ts', 'proofIsProvenLive', _proof);
}

export function validateWakeProof(_input: unknown): PhaseCheck<WakeProof> {
  return boundaryUnavailable('src/phase-contracts/wake-proof.ts', 'validateWakeProof', _input);
}

export function validateHandoffReceipt(_input: unknown): PhaseCheck<HandoffReceipt> {
  return boundaryUnavailable('src/phase-contracts/wake-proof.ts', 'validateHandoffReceipt', _input);
}

/** Join a handoff to the wake proof's correlation ids, the three stage ids, and the proof mode. */
export function joinHandoff(_proof: unknown, _receipt: unknown): PhaseCheck<{ proof: WakeProof; receipt: HandoffReceipt }> {
  return boundaryUnavailable('src/phase-contracts/wake-proof.ts', 'joinHandoff', _proof, _receipt);
}
