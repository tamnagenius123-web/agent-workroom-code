// P0 wake proof and the handoff receipt that joins it.
// caller_claimed never counts as verified. proof_mode synthetic cannot validate as live.

import {
  Problems, checkKeys, defined, distinctIds, readEnum, readEnvelope, readId, readNullableIso, readNullableText,
  readObject, readSha256, recordIsLiveProof, type PhaseCheck, type PhaseEnvelope,
} from './check.ts';

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

const PROOF_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'event_id', 'message_id', 'attempt_id', 'relay_receipt', 'native_host_run', 'authenticated_exact_read',
] as const;
const STAGE_KEYS = ['stage_id', 'evidence_source', 'evidence_ref', 'observed_at'] as const;
const HANDOFF_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'injection_receipt_id', 'sealed_checkpoint_hash', 'event_id', 'message_id', 'attempt_id',
  'relay_receipt_stage_id', 'native_host_run_stage_id', 'authenticated_exact_read_stage_id',
] as const;
type StageName = 'relay_receipt' | 'native_host_run' | 'authenticated_exact_read';

/** Only server_observed evidence counts. A caller claim is recorded and unverified. */
export function stageCountsAsVerified(stage: WakeStage): boolean {
  return stage.evidence_source === 'server_observed' && stage.evidence_ref !== null && stage.observed_at !== null;
}

/** Live only when the envelope is server-observed live and every stage was server-observed. */
export function proofIsProvenLive(proof: WakeProof): boolean {
  return recordIsLiveProof(proof)
    && stageCountsAsVerified(proof.relay_receipt)
    && stageCountsAsVerified(proof.native_host_run)
    && stageCountsAsVerified(proof.authenticated_exact_read);
}

function readStage(problems: Problems, obj: Record<string, unknown>, key: StageName): WakeStage | undefined {
  const path = `wake_proof.${key}`;
  const stage = readObject(problems, obj[key], path);
  if (!stage) return undefined;
  checkKeys(problems, stage, STAGE_KEYS, path);
  const stage_id = readId(problems, stage, 'stage_id', path);
  const evidence_source = readEnum(problems, stage, 'evidence_source', path, EVIDENCE_SOURCES);
  const evidence_ref = readNullableText(problems, stage, 'evidence_ref', path, 500);
  const observed_at = readNullableIso(problems, stage, 'observed_at', path);
  if (!defined(stage_id) || !defined(evidence_source) || evidence_ref === undefined || observed_at === undefined) return undefined;
  if (evidence_source === 'server_observed') {
    if (evidence_ref === null) problems.add(path, 'server_observed requires evidence_ref');
    if (observed_at === null) problems.add(path, 'server_observed requires observed_at');
  } else {
    if (evidence_ref !== null) problems.add(path, 'caller_claimed is not verified and cannot carry evidence_ref');
    if (observed_at !== null) problems.add(path, 'caller_claimed is not verified and cannot carry observed_at');
  }
  return { stage_id, evidence_source, evidence_ref, observed_at };
}

export function validateWakeProof(input: unknown): PhaseCheck<WakeProof> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'wake_proof');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, PROOF_KEYS, 'wake_proof');
  const envelope = readEnvelope(problems, obj, 'wake_proof');
  const event_id = readId(problems, obj, 'event_id', 'wake_proof');
  const message_id = readId(problems, obj, 'message_id', 'wake_proof');
  const attempt_id = readId(problems, obj, 'attempt_id', 'wake_proof');
  const relay_receipt = readStage(problems, obj, 'relay_receipt');
  const native_host_run = readStage(problems, obj, 'native_host_run');
  const authenticated_exact_read = readStage(problems, obj, 'authenticated_exact_read');
  distinctIds(problems, [
    ['event_id', event_id], ['message_id', message_id], ['attempt_id', attempt_id],
    ['relay_receipt.stage_id', relay_receipt?.stage_id],
    ['native_host_run.stage_id', native_host_run?.stage_id],
    ['authenticated_exact_read.stage_id', authenticated_exact_read?.stage_id],
  ], 'wake_proof');
  if (envelope?.proof_mode === 'live') {
    const stages = [relay_receipt, native_host_run, authenticated_exact_read];
    if (stages.some(stage => !stage || stage.evidence_source !== 'server_observed')) {
      problems.add('wake_proof.proof_mode', 'caller_claimed or mock evidence cannot validate as live proof');
    }
  }
  if (!defined(envelope) || !defined(event_id) || !defined(message_id) || !defined(attempt_id)
    || !defined(relay_receipt) || !defined(native_host_run) || !defined(authenticated_exact_read) || problems.bad) {
    return problems.fail();
  }
  return {
    ok: true,
    value: { ...envelope, event_id, message_id, attempt_id, relay_receipt, native_host_run, authenticated_exact_read },
  };
}

export function validateHandoffReceipt(input: unknown): PhaseCheck<HandoffReceipt> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'handoff_receipt');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, HANDOFF_KEYS, 'handoff_receipt');
  const envelope = readEnvelope(problems, obj, 'handoff_receipt');
  const injection_receipt_id = readId(problems, obj, 'injection_receipt_id', 'handoff_receipt');
  const sealed_checkpoint_hash = readSha256(problems, obj, 'sealed_checkpoint_hash', 'handoff_receipt');
  const event_id = readId(problems, obj, 'event_id', 'handoff_receipt');
  const message_id = readId(problems, obj, 'message_id', 'handoff_receipt');
  const attempt_id = readId(problems, obj, 'attempt_id', 'handoff_receipt');
  const relay_receipt_stage_id = readId(problems, obj, 'relay_receipt_stage_id', 'handoff_receipt');
  const native_host_run_stage_id = readId(problems, obj, 'native_host_run_stage_id', 'handoff_receipt');
  const authenticated_exact_read_stage_id = readId(problems, obj, 'authenticated_exact_read_stage_id', 'handoff_receipt');
  distinctIds(problems, [
    ['injection_receipt_id', injection_receipt_id],
    ['event_id', event_id], ['message_id', message_id], ['attempt_id', attempt_id],
    ['relay_receipt_stage_id', relay_receipt_stage_id],
    ['native_host_run_stage_id', native_host_run_stage_id],
    ['authenticated_exact_read_stage_id', authenticated_exact_read_stage_id],
  ], 'handoff_receipt');
  if (!defined(envelope) || !defined(injection_receipt_id) || !defined(sealed_checkpoint_hash) || !defined(event_id)
    || !defined(message_id) || !defined(attempt_id) || !defined(relay_receipt_stage_id) || !defined(native_host_run_stage_id)
    || !defined(authenticated_exact_read_stage_id) || problems.bad) {
    return problems.fail();
  }
  return {
    ok: true,
    value: {
      ...envelope,
      injection_receipt_id, sealed_checkpoint_hash, event_id, message_id, attempt_id,
      relay_receipt_stage_id, native_host_run_stage_id, authenticated_exact_read_stage_id,
    },
  };
}

/** Join a handoff to the wake proof's correlation ids, the three stage ids, and the proof mode. */
export function joinHandoff(proof: unknown, receipt: unknown): PhaseCheck<{ proof: WakeProof; receipt: HandoffReceipt }> {
  const parsedProof = validateWakeProof(proof);
  const parsedReceipt = validateHandoffReceipt(receipt);
  const errors = [
    ...(parsedProof.ok ? [] : parsedProof.errors),
    ...(parsedReceipt.ok ? [] : parsedReceipt.errors),
  ];
  if (!parsedProof.ok || !parsedReceipt.ok) return { ok: false, errors };
  const proofValue = parsedProof.value;
  const receiptValue = parsedReceipt.value;
  const pairs: ReadonlyArray<readonly [string, string, string]> = [
    ['event_id', receiptValue.event_id, proofValue.event_id],
    ['message_id', receiptValue.message_id, proofValue.message_id],
    ['attempt_id', receiptValue.attempt_id, proofValue.attempt_id],
    ['relay_receipt_stage_id', receiptValue.relay_receipt_stage_id, proofValue.relay_receipt.stage_id],
    ['native_host_run_stage_id', receiptValue.native_host_run_stage_id, proofValue.native_host_run.stage_id],
    ['authenticated_exact_read_stage_id', receiptValue.authenticated_exact_read_stage_id, proofValue.authenticated_exact_read.stage_id],
    ['proof_mode', receiptValue.proof_mode, proofValue.proof_mode],
  ];
  for (const [label, got, expected] of pairs) {
    if (got !== expected) errors.push(`handoff_receipt.${label}: does not join the wake proof`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { proof: proofValue, receipt: receiptValue } };
}
