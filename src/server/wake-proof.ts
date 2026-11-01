// BOUNDARY CONTRACT — mirrors src/server/wake-proof.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; every runtime entry point
// fails closed with a typed error. Phase 2 replaces this seam with gate-MCP
// calls; no gate or verdict behavior is implemented or simulated here.

import { boundaryUnavailable } from '../boundary.ts';

export type WakeSource = 'webhook' | 'relay' | 'poll';
export type WakeCause = 'delivery' | 'schedule' | 'manual';
export type WakeStatus = 'proven' | 'missing' | 'invalid';
export type WakeVerdict = 'proven' | 'partial' | 'unproven';

export interface PersistedMessage {
  message_id: string;
  created_at: string;
  mentions: string[];
}

export interface EmittedDelivery {
  delivery_id: string;
  event_id: string;
  message_id: string;
  agent: string;
  attempt: number;
  emitted_at: string;
}

export interface RelayReceipt {
  delivery_id: string;
  event_id: string;
  message_id: string;
  agent: string;
  received_at: string;
  signature_verified: boolean;
  source: WakeSource;
}

export interface HostRun {
  run_id: string;
  delivery_id: string;
  event_id: string;
  agent: string;
  started_at: string;
  cause: WakeCause;
}

export interface ReadOutcome {
  run_id: string;
  message_id: string;
  agent: string;
  read_at: string;
  principal_authenticated: boolean;
  outcome_ref: string | null;
}

export interface WakeProofInput {
  agent: string;
  message_id: string;
  persisted?: PersistedMessage | null;
  emitted?: EmittedDelivery[];
  relay_receipts?: RelayReceipt[];
  host_runs?: HostRun[];
  read_outcomes?: ReadOutcome[];
  /** Later stages may lead the previous instant by at most this many milliseconds. Default 2000. */
  clockSkewMs?: number;
}

export interface PersistedStage {
  status: WakeStatus;
  reasons: string[];
  ids: { message_id: string | null };
}

export interface EmittedStage {
  status: WakeStatus;
  reasons: string[];
  ids: { delivery_id: string | null; event_id: string | null; message_id: string | null; attempt: number | null };
}

export interface RelayStage {
  status: WakeStatus;
  reasons: string[];
  ids: { delivery_id: string | null; event_id: string | null; message_id: string | null };
}

export interface HostStage {
  status: WakeStatus;
  reasons: string[];
  ids: { run_id: string | null; delivery_id: string | null; event_id: string | null };
}

export interface ReadStage {
  status: WakeStatus;
  reasons: string[];
  ids: { run_id: string | null; message_id: string | null; outcome_ref: string | null };
}

export interface WakeProofDuplicates {
  receipts: { delivery_id: string; count: number }[];
  replays: { delivery_id: string; run_id: string; received_at: string }[];
}

export interface WakeProofResult {
  agent: string;
  message_id: string;
  stages: {
    persisted: PersistedStage;
    emitted: EmittedStage;
    relay_receipt: RelayStage;
    host_run: HostStage;
    read_outcome: ReadStage;
  };
  verdict: WakeVerdict;
  duplicates: WakeProofDuplicates;
  notes: string[];
}

export function evaluateWakeProof(_input: WakeProofInput): WakeProofResult {
  return boundaryUnavailable('src/server/wake-proof.ts', 'evaluateWakeProof', _input);
}
