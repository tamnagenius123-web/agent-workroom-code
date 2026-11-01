// P0 consumer-bound handoff gate. Pure: no I/O, no clock, no migration.
// The receipt and the proof are the W0 types. This module does not redefine them.
//
// A handoff is accepted only when a HandoffReceipt is present and joinHandoff
// ties it to the WakeProof (correlation ids, all three stage ids, proof mode).
// The binding the consumer can read is handoff_receipt{wake_stage_id, checkpoint_hash, consumer_id}.
// wake_stage_id is the authenticated exact-read stage. Joining only the relay
// stage does not deliver the handoff to the next consumer.
// The caller passes injection ids already accepted. This module stores nothing,
// so the same attempt evaluated twice returns the same verdict.

import type { PhaseCheck, PhaseConsumer } from '../phase-contracts/check.ts';
import {
  joinHandoff,
  proofIsProvenLive,
  type HandoffReceipt,
  type WakeProof,
} from '../phase-contracts/wake-proof.ts';

export interface HandoffBinding {
  wake_stage_id: string;
  checkpoint_hash: string;
  consumer_id: PhaseConsumer;
}

export interface AcceptedHandoff {
  handoff_receipt: HandoffBinding;
  proof: WakeProof;
  receipt: HandoffReceipt;
  proven_live: boolean;
}

export interface HandoffAttempt {
  consumer_id: string;
  checkpoint_hash: string;
  wake_stage_id: string;
  proof: unknown;
  receipt: unknown;
  seen_injection_ids?: readonly string[];
}

export function acceptHandoff(attempt: HandoffAttempt): PhaseCheck<AcceptedHandoff> {
  if (attempt.receipt === null || attempt.receipt === undefined) {
    return { ok: false, errors: ['handoff_receipt: required'] };
  }
  const joined = joinHandoff(attempt.proof, attempt.receipt);
  if (!joined.ok) return { ok: false, errors: joined.errors };
  const { proof, receipt } = joined.value;
  const errors: string[] = [];
  if (attempt.consumer_id !== receipt.consumer || proof.consumer !== receipt.consumer) {
    errors.push('handoff_receipt.consumer_id: does not match the wake consumer');
  }
  if (attempt.checkpoint_hash !== receipt.sealed_checkpoint_hash) {
    errors.push('handoff_receipt.checkpoint_hash: does not match the sealed checkpoint');
  }
  if (attempt.wake_stage_id !== receipt.authenticated_exact_read_stage_id) {
    errors.push('handoff_receipt.wake_stage_id: does not join the authenticated exact-read stage');
  }
  if ((attempt.seen_injection_ids ?? []).includes(receipt.injection_receipt_id)) {
    errors.push('handoff_receipt.injection_receipt_id: duplicate');
  }
  if (errors.length > 0) return { ok: false, errors };
  const handoff_receipt: HandoffBinding = {
    wake_stage_id: receipt.authenticated_exact_read_stage_id,
    checkpoint_hash: receipt.sealed_checkpoint_hash,
    consumer_id: receipt.consumer,
  };
  return {
    ok: true,
    value: { handoff_receipt, proof, receipt, proven_live: proofIsProvenLive(proof) },
  };
}
