import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { acceptHandoff, type HandoffAttempt } from '../src/server/handoff-receipt.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phase-contracts');
const SEAL = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function load(name: string): Record<string, unknown> {
  return asRecord(JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')), name);
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${key} is not a string`);
  return value;
}

function stageId(proof: Record<string, unknown>, key: string): string {
  return text(asRecord(proof[key], key), 'stage_id');
}

function attempt(over: Partial<HandoffAttempt> = {}): HandoffAttempt {
  const proof = load('wake-proof.valid.json');
  const receipt = load('handoff-receipt.valid.json');
  return {
    consumer_id: text(receipt, 'consumer'),
    checkpoint_hash: text(receipt, 'sealed_checkpoint_hash'),
    wake_stage_id: text(receipt, 'authenticated_exact_read_stage_id'),
    proof,
    receipt,
    ...over,
  };
}

function livePair(): { proof: Record<string, unknown>; receipt: Record<string, unknown> } {
  const proof = load('wake-proof.valid.json');
  const receipt = load('handoff-receipt.valid.json');
  const provenance = {
    kind: 'server_observed',
    producer_id: 'producer_p0',
    source_ref: 'server:wake',
  };
  proof.provenance = provenance;
  proof.proof_mode = 'live';
  receipt.provenance = { ...provenance, source_ref: 'server:handoff' };
  receipt.proof_mode = 'live';
  for (const key of ['relay_receipt', 'native_host_run', 'authenticated_exact_read']) {
    const stage = asRecord(proof[key], key);
    stage.evidence_source = 'server_observed';
    stage.evidence_ref = `evidence:${key}`;
    stage.observed_at = '2026-10-24T02:21:00.000Z';
  }
  return { proof, receipt };
}

test('rejects a handoff when the receipt is absent', () => {
  const decision = acceptHandoff(attempt({ receipt: undefined }));
  if (decision.ok) assert.fail('expected rejection');
  assert.deepEqual(decision.errors, ['handoff_receipt: required']);
});

test('rejects a handoff when the receipt is null', () => {
  const decision = acceptHandoff(attempt({ receipt: null }));
  if (decision.ok) assert.fail('expected rejection');
  assert.deepEqual(decision.errors, ['handoff_receipt: required']);
});

test('rejects a receipt whose seal is not a checkpoint hash', () => {
  const decision = acceptHandoff(attempt({ receipt: load('handoff-receipt.invalid-hash.json') }));
  if (decision.ok) assert.fail('expected rejection');
  assert.ok(decision.errors.some(error => error.includes('64-hex')));
});

test('rejects a receipt that does not join the wake proof stage ids', () => {
  const receipt = load('handoff-receipt.valid.json');
  receipt.relay_receipt_stage_id = 'stage_relay_other';
  const decision = acceptHandoff(attempt({ receipt }));
  if (decision.ok) assert.fail('expected rejection');
  assert.ok(decision.errors.some(error => error.includes('relay_receipt_stage_id') && error.includes('does not join the wake proof')));
});

test('rejects a receipt that does not join the wake proof message id', () => {
  const receipt = load('handoff-receipt.valid.json');
  receipt.message_id = 'msg_wake_other';
  const decision = acceptHandoff(attempt({ receipt }));
  if (decision.ok) assert.fail('expected rejection');
  assert.ok(decision.errors.some(error => error.includes('message_id') && error.includes('does not join the wake proof')));
});

test('rejects a checkpoint hash that does not match the sealed checkpoint', () => {
  const altered = `${'a'.repeat(63)}b`;
  const decision = acceptHandoff(attempt({ checkpoint_hash: altered }));
  if (decision.ok) assert.fail('expected rejection');
  assert.deepEqual(decision.errors, ['handoff_receipt.checkpoint_hash: does not match the sealed checkpoint']);
});

test('rejects a truncated checkpoint hash', () => {
  const decision = acceptHandoff(attempt({ checkpoint_hash: SEAL.slice(0, 40) }));
  if (decision.ok) assert.fail('expected rejection');
  assert.deepEqual(decision.errors, ['handoff_receipt.checkpoint_hash: does not match the sealed checkpoint']);
});

test('rejects a consumer that is not the receipt consumer', () => {
  const decision = acceptHandoff(attempt({ consumer_id: 'P4' }));
  if (decision.ok) assert.fail('expected rejection');
  assert.deepEqual(decision.errors, ['handoff_receipt.consumer_id: does not match the wake consumer']);
});

test('rejects a wake proof addressed to a different consumer than the receipt', () => {
  const proof = load('wake-proof.valid.json');
  proof.consumer = 'P2';
  const decision = acceptHandoff(attempt({ proof }));
  if (decision.ok) assert.fail('expected rejection');
  assert.deepEqual(decision.errors, ['handoff_receipt.consumer_id: does not match the wake consumer']);
});

test('rejects a wake_stage_id that is not the authenticated exact-read stage', () => {
  const proof = load('wake-proof.valid.json');
  const decision = acceptHandoff(attempt({ wake_stage_id: stageId(proof, 'relay_receipt') }));
  if (decision.ok) assert.fail('expected rejection');
  assert.deepEqual(decision.errors, ['handoff_receipt.wake_stage_id: does not join the authenticated exact-read stage']);
});

test('rejects a duplicate injection receipt id', () => {
  const first = acceptHandoff(attempt());
  if (!first.ok) assert.fail(first.errors.join('; '));
  const replay = acceptHandoff(attempt({ seen_injection_ids: [first.value.receipt.injection_receipt_id] }));
  if (replay.ok) assert.fail('expected rejection');
  assert.deepEqual(replay.errors, ['handoff_receipt.injection_receipt_id: duplicate']);
});

test('accepts a consumer-bound receipt joined to every wake stage', () => {
  const proof = load('wake-proof.valid.json');
  const receipt = load('handoff-receipt.valid.json');
  const decision = acceptHandoff(attempt({ proof, receipt }));
  if (!decision.ok) assert.fail(decision.errors.join('; '));
  assert.deepEqual(decision.value.handoff_receipt, {
    wake_stage_id: stageId(proof, 'authenticated_exact_read'),
    checkpoint_hash: text(receipt, 'sealed_checkpoint_hash'),
    consumer_id: text(receipt, 'consumer'),
  });
  assert.equal(decision.value.receipt.relay_receipt_stage_id, stageId(proof, 'relay_receipt'));
  assert.equal(decision.value.receipt.native_host_run_stage_id, stageId(proof, 'native_host_run'));
  assert.equal(decision.value.receipt.authenticated_exact_read_stage_id, stageId(proof, 'authenticated_exact_read'));
  assert.equal(decision.value.receipt.sealed_checkpoint_hash, decision.value.handoff_receipt.checkpoint_hash);
  assert.equal(decision.value.receipt.consumer, decision.value.handoff_receipt.consumer_id);
});

test('a synthetic acceptance is not a live wake proof', () => {
  const decision = acceptHandoff(attempt());
  if (!decision.ok) assert.fail(decision.errors.join('; '));
  assert.equal(decision.value.proven_live, false);
});

test('a joined server-observed live proof is proven live', () => {
  const { proof, receipt } = livePair();
  const decision = acceptHandoff(attempt({
    proof,
    receipt,
    wake_stage_id: text(receipt, 'authenticated_exact_read_stage_id'),
    checkpoint_hash: text(receipt, 'sealed_checkpoint_hash'),
    consumer_id: text(receipt, 'consumer'),
  }));
  if (!decision.ok) assert.fail(decision.errors.join('; '));
  assert.equal(decision.value.proven_live, true);
  assert.equal(decision.value.handoff_receipt.wake_stage_id, stageId(proof, 'authenticated_exact_read'));
});

test('the same attempt yields the same verdict when evaluated twice', () => {
  const input = attempt();
  assert.deepEqual(acceptHandoff(input), acceptHandoff(input));
});

test('rejects a handoff when the wake proof is absent', () => {
  const decision = acceptHandoff(attempt({ proof: undefined }));
  if (decision.ok) assert.fail('expected rejection');
  assert.ok(decision.errors.some(error => error.includes('wake_proof')));
});
