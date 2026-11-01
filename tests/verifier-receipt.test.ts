import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gateDisposition, receiptIsLiveProof, RED_CASE_IDS, validateVerifierReceipt, type RedCaseId } from '../src/phase-contracts/verifier-receipt.ts';
import {
  GATE_VERSION, SEPARATE_GATES, evaluateVerifierReceipt,
  type CaseRun, type ReceiptEvaluation, type ReceiptObservation,
} from '../src/server/verifier-receipt.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const DIGEST = 'a'.repeat(64);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function logOf(id: RedCaseId): string {
  return `log ${id} retained`;
}

function passingRuns(): CaseRun[] {
  return RED_CASE_IDS.map(case_id => {
    const evidence = logOf(case_id);
    return { case_id, evidence, evidence_sha256: sha256(evidence) };
  });
}

function base(over: Partial<ReceiptObservation> = {}): ReceiptObservation {
  return {
    consumer: 'P2',
    producer_id: 'agent_author',
    acceptor_id: 'agent_acceptor',
    next_maker: 'agent_author',
    author_lineage: { method: 'author.impl', dependencies: ['pkg-a', 'pkg-b'] },
    verifier_lineage: { method: 'verifier.impl', dependencies: ['pkg-a', 'pkg-b'] },
    sha: SHA,
    observed_sha: SHA,
    claimed_gate_version: GATE_VERSION,
    task_id: 'task_p1',
    attempt_id: 'attempt_1',
    artifact_digest: DIGEST,
    verifier_id: 'agent_acceptor',
    lease: { epoch: 'lease_1', stale: false },
    capability_label_as_authority: false,
    approval_events: ['accept'],
    observation_ok: true,
    runs: passingRuns(),
    ...over,
  };
}

function sealed(result: ReceiptEvaluation, report: 'RETAINED' | 'UNKNOWN' = 'RETAINED') {
  assert.equal(result.disposition, 'HOLD');
  assert.ok(result.receipt);
  const checked = validateVerifierReceipt(result.receipt);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.errors.join(' | '));
  if (result.failure_packet) assert.equal(result.failure_packet.next_maker, 'agent_author');
  assert.equal(result.observation_report, report);
  assert.deepEqual(result.separate_gates, SEPARATE_GATES);
  return result.receipt;
}

test('RC1 SHA change is HOLD', () => {
  const result = evaluateVerifierReceipt(base({ observed_sha: OTHER_SHA }));
  const receipt = sealed(result);
  assert.equal(receipt.verdict, 'HOLD');
  assert.equal(receipt.sha, SHA);
  assert.equal(receipt.observed_sha, OTHER_SHA);
  assert.equal(receipt.sha.length, 40);
  assert.equal(gateDisposition(receipt), 'HOLD');
  assert.equal(receipt.cases.every(row => row.state === 'passed'), true);
  assert.deepEqual(result.failure_packet?.failed_cases, [...RED_CASE_IDS]);
  assert.ok(result.failure_packet?.evidence.includes('RC1 sha changed'));
  assert.ok(result.reasons.includes('sha_changed'));
  const short = evaluateVerifierReceipt(base({ sha: 'abc', observed_sha: 'abc' }));
  assert.equal(short.disposition, 'HOLD');
  assert.equal(short.receipt, null);
  assert.ok(short.reasons.includes('sha'));
});

test('RC2 stale lease is HOLD', () => {
  for (const lease of [{ epoch: 'lease_1', stale: true }, null] as const) {
    const result = evaluateVerifierReceipt(base({ lease }));
    const receipt = sealed(result);
    assert.equal(receipt.verdict, 'HOLD');
    assert.equal(receipt.cases.find(row => row.case_id === 'RC2')?.state, 'missing');
    assert.equal(receipt.cases.find(row => row.case_id === 'RC2')?.evidence, null);
    assert.equal(receipt.cases.filter(row => row.state === 'passed').length, 7);
    assert.deepEqual(result.failure_packet?.failed_cases, ['RC2']);
    assert.ok(result.failure_packet?.evidence.includes('RC2 stale lease'));
    assert.ok(result.reasons.includes('stale_lease'));
  }
});

test('RC3 evidence tampering is HOLD', () => {
  const runs = passingRuns().map(run => run.case_id === 'RC3' ? { ...run, evidence_sha256: 'b'.repeat(64) } : run);
  const result = evaluateVerifierReceipt(base({ runs }));
  const receipt = sealed(result);
  assert.equal(receipt.verdict, 'HOLD');
  assert.equal(receipt.cases.find(row => row.case_id === 'RC3')?.state, 'missing');
  assert.equal(receipt.cases.find(row => row.case_id === 'RC3')?.evidence, null);
  assert.equal(receipt.cases.filter(row => row.state === 'passed').length, 7);
  assert.deepEqual(result.failure_packet?.failed_cases, ['RC3']);
  assert.ok(result.failure_packet?.evidence.includes('RC3 evidence tampered'));
  assert.ok(result.reasons.includes('evidence_tampered'));
});

test('RC4 partial census is HOLD', () => {
  const skipped = evaluateVerifierReceipt(base({ runs: passingRuns().filter(run => run.case_id !== 'RC4') }));
  const skippedReceipt = sealed(skipped);
  assert.equal(skippedReceipt.verdict, 'HOLD');
  assert.equal(skippedReceipt.cases.find(row => row.case_id === 'RC4')?.state, 'not_run');
  assert.equal(skippedReceipt.cases.filter(row => row.state === 'passed').length, 7);
  assert.deepEqual(skipped.failure_packet?.failed_cases, ['RC4']);
  assert.ok(skipped.failure_packet?.evidence.includes('RC4 partial census'));
  assert.ok(skipped.reasons.includes('partial_census'));
  const blankRuns = passingRuns().map(run => run.case_id === 'RC4' ? { ...run, evidence: '', evidence_sha256: sha256('') } : run);
  const blank = evaluateVerifierReceipt(base({ runs: blankRuns }));
  const blankReceipt = sealed(blank);
  assert.equal(blankReceipt.cases.find(row => row.case_id === 'RC4')?.state, 'missing');
  assert.deepEqual(blank.failure_packet?.failed_cases, ['RC4']);
  assert.ok(blank.failure_packet?.evidence.includes('RC4 partial census'));
});

test('RC5 same-lineage review is HOLD', () => {
  const same = evaluateVerifierReceipt(base({
    author_lineage: { method: 'shared.impl', dependencies: ['pkg-b', 'pkg-a'] },
    verifier_lineage: { method: 'shared.impl', dependencies: ['pkg-a', 'pkg-b'] },
  }));
  assert.equal(same.disposition, 'HOLD');
  assert.equal(same.receipt, null);
  assert.ok(same.reasons.includes('same_lineage'));
  assert.deepEqual(same.failure_packet?.failed_cases, ['RC5']);
  assert.ok(same.failure_packet?.evidence.includes('RC5 same lineage'));
  assert.equal(same.failure_packet?.next_maker, 'agent_author');
  const self = evaluateVerifierReceipt(base({ acceptor_id: 'agent_author' }));
  assert.equal(self.disposition, 'HOLD');
  assert.equal(self.receipt, null);
  assert.ok(self.reasons.includes('acceptor_is_producer'));
  assert.ok(self.failure_packet?.evidence.includes('RC5 acceptor is producer'));
  assert.equal(self.failure_packet?.next_maker, 'agent_author');
});

test('RC6 capability-label authority is HOLD', () => {
  const result = evaluateVerifierReceipt(base({ capability_label_as_authority: true }));
  const receipt = sealed(result);
  assert.equal(receipt.verdict, 'HOLD');
  assert.equal(receipt.cases.find(row => row.case_id === 'RC6')?.state, 'missing');
  assert.equal(receipt.cases.find(row => row.case_id === 'RC6')?.evidence, null);
  assert.equal(receipt.cases.filter(row => row.state === 'passed').length, 7);
  assert.deepEqual(result.failure_packet?.failed_cases, ['RC6']);
  assert.ok(result.failure_packet?.evidence.includes('RC6 capability label is not authority'));
  assert.ok(result.reasons.includes('capability_label'));
});

test('RC7 revoke/accept race is HOLD', () => {
  const result = evaluateVerifierReceipt(base({ approval_events: ['accept', 'revoke'] }));
  const receipt = sealed(result);
  assert.equal(receipt.verdict, 'HOLD');
  assert.equal(receipt.cases.find(row => row.case_id === 'RC7')?.state, 'missing');
  assert.equal(receipt.cases.find(row => row.case_id === 'RC7')?.evidence, null);
  assert.equal(receipt.cases.filter(row => row.state === 'passed').length, 7);
  assert.deepEqual(result.failure_packet?.failed_cases, ['RC7']);
  assert.ok(result.failure_packet?.evidence.includes('RC7 revoke/accept race'));
  assert.ok(result.reasons.includes('revoke_accept_race'));
  const missing = evaluateVerifierReceipt(base({ approval_events: [] }));
  assert.equal(missing.disposition, 'HOLD');
  assert.equal(missing.receipt?.cases.find(row => row.case_id === 'RC7')?.state, 'missing');
  assert.ok(missing.failure_packet?.evidence.includes('RC7 approval missing'));
});

test('RC8 observation failure is UNKNOWN and HOLD', () => {
  const result = evaluateVerifierReceipt(base({ observation_ok: false }));
  const receipt = sealed(result, 'UNKNOWN');
  assert.equal(receipt.verdict, 'HOLD');
  assert.equal(receipt.cases.every(row => row.state === 'missing' && row.evidence === null), true);
  assert.deepEqual(result.failure_packet?.failed_cases, [...RED_CASE_IDS]);
  assert.ok(result.failure_packet?.evidence.includes('RC8 observation UNKNOWN'));
  assert.ok(result.reasons.includes('observation_unknown'));
  assert.equal(result.reasons.includes('not_run'), false);
});

test('NOT_RUN at a matching sha is disposition HOLD', () => {
  const runs = RED_CASE_IDS.map(case_id => ({ case_id, evidence: null, evidence_sha256: null }));
  const result = evaluateVerifierReceipt(base({ runs }));
  const receipt = sealed(result);
  assert.equal(receipt.verdict, 'NOT_RUN');
  assert.equal(receipt.failure_packet, null);
  assert.equal(result.failure_packet, null);
  assert.equal(gateDisposition(receipt), 'HOLD');
  assert.equal(receipt.sha, receipt.observed_sha);
  assert.equal(receipt.cases.every(row => row.state === 'not_run' && row.evidence === null), true);
  assert.ok(result.reasons.includes('not_run'));
  assert.equal(result.reasons.includes('partial_census'), false);
});

test('PASS binds the full sha, gate version, per-case evidence, and lineage', () => {
  const input = base();
  const result = evaluateVerifierReceipt(input);
  assert.deepEqual(evaluateVerifierReceipt(input), result);
  assert.equal(result.disposition, 'PASS');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.failure_packet, null);
  assert.equal(result.observation_report, 'RETAINED');
  assert.deepEqual(result.separate_gates, ['trusted_auth', 'atomic_approval']);
  assert.ok(result.receipt);
  const checked = validateVerifierReceipt(result.receipt);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.errors.join(' | '));
  const receipt = result.receipt;
  assert.equal(receipt.verdict, 'PASS');
  assert.equal(receipt.failure_packet, null);
  assert.equal(gateDisposition(receipt), 'PASS');
  assert.equal(receiptIsLiveProof(receipt), false);
  assert.equal(receipt.proof_mode, 'synthetic');
  assert.equal(receipt.sha, SHA);
  assert.equal(receipt.observed_sha, SHA);
  assert.equal(receipt.sha.length, 40);
  assert.equal(receipt.gate_version, GATE_VERSION);
  assert.equal(receipt.producer_id === receipt.acceptor_id, false);
  assert.equal(receipt.acceptor_id, 'agent_acceptor');
  assert.equal(receipt.provenance.source_ref, `digest.${DIGEST}`);
  assert.deepEqual(receipt.f2, { id: 'F2', description: 'TBD' });
  assert.deepEqual(receipt.cases.map(row => row.case_id), [...RED_CASE_IDS]);
  for (const row of receipt.cases) {
    assert.equal(row.state, 'passed');
    assert.ok(row.evidence?.includes(logOf(row.case_id)));
    assert.ok(row.evidence?.includes('task=task_p1'));
    assert.ok(row.evidence?.includes('attempt=attempt_1'));
    assert.ok(row.evidence?.includes(`sha=${SHA}`));
    assert.ok(row.evidence?.includes(`digest=${DIGEST}`));
    assert.ok(row.evidence?.includes('verifier=agent_acceptor'));
    assert.ok(row.evidence?.includes(`gate=${GATE_VERSION}`));
  }
  const wrongGate = evaluateVerifierReceipt(base({ claimed_gate_version: 'p0.9' }));
  assert.equal(wrongGate.disposition, 'HOLD');
  assert.ok(wrongGate.reasons.includes('gate_unbound'));
  assert.equal(wrongGate.receipt?.verdict, 'HOLD');
  assert.equal(wrongGate.receipt?.gate_version, GATE_VERSION);
});
