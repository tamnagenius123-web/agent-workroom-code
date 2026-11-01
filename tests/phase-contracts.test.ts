import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CASE_STATES, COUNCIL_AUTHORITY_CONFLICT, COVERAGE_LEVELS, HOLD_STATES, INTENT_STATUSES,
  MIGRATION_ALLOCATIONS, MIGRATION_REGISTRY, PHASE_CONSUMERS, RED_CASE_DESCRIPTIONS, RED_CASE_IDS,
  SOURCE_STATUSES, SPEND_CATEGORIES, VERDICTS,
  appendCorrection, canProceed, findMigrationCollisions, freshnessGrantsAuthority, gateDisposition,
  joinHandoff, proofIsProvenLive, receiptIsLiveProof, recordIsLiveProof, requireFreshForDispatch,
  stageCountsAsVerified, validateCouncilVerdict, validateDispatchAdmission, validateDispatchRequest,
  validateFreshnessCheck, validateHandoffReceipt, validateResearchTask, validateSkillCandidate,
  validateUnitCostRecord, validateVerifierReceipt, validateWakeProof, type PhaseCheck,
} from '../src/phase-contracts/index.ts';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'phase-contracts');
const validators: Record<string, (input: unknown) => PhaseCheck<unknown>> = {
  'wake-proof': validateWakeProof,
  'handoff-receipt': validateHandoffReceipt,
  'verifier-receipt': validateVerifierReceipt,
  'council-verdict': validateCouncilVerdict,
  'research-task': validateResearchTask,
  dispatch: validateDispatchRequest,
  freshness: validateFreshnessCheck,
  'skill-candidate': validateSkillCandidate,
  'unit-cost': validateUnitCostRecord,
};

const expectError: Record<string, string> = {
  'wake-proof.invalid-proven-with-claim.json': 'live',
  'wake-proof.invalid-missing-stage.json': 'authenticated_exact_read',
  'wake-proof.invalid-caller-evidence.json': 'caller_claimed',
  'handoff-receipt.invalid-hash.json': '64-hex',
  'verifier-receipt.invalid-sha-pass.json': 'HOLD',
  'verifier-receipt.invalid-missing-evidence-pass.json': 'HOLD',
  'verifier-receipt.invalid-lineage.json': 'lineage',
  'verifier-receipt.invalid-acceptor.json': 'acceptor_id',
  'verifier-receipt.invalid-hold-without-packet.json': 'FailurePacket',
  'verifier-receipt.invalid-not-run-on-mismatch.json': 'HOLD',
  'council-verdict.invalid-authority.json': 'budget',
  'council-verdict.invalid-execute.json': 'executes_immediately',
  'council-verdict.invalid-no-dissent.json': 'dissent',
  'council-verdict.invalid-correction-gap.json': 'append-only',
  'research-task.invalid-no-consumer.json': 'consumer',
  'research-task.invalid-na-no-reason.json': 'reason',
  'research-task.invalid-na-with-hypothesis.json': 'hypothesis',
  'dispatch.invalid-ids.json': 'duplicates',
  'dispatch.invalid-micros.json': 'integer',
  'dispatch.invalid-subscription-zero.json': 'never 0',
  'dispatch.invalid-release-without-evidence.json': 'evidence_ref',
  'dispatch.invalid-category.json': 'claude_api_credit',
  'freshness.invalid-stale-as-fresh.json': 'STALE',
  'freshness.invalid-merged-checks.json': 'intent_permission_check',
  'freshness.invalid-pointer-only.json': 'pointer_only',
  'freshness.invalid-not-emitted.json': 'not-emitted',
  'skill-candidate.invalid-self-promote.json': 'promoter',
  'skill-candidate.invalid-stage.json': 'stage',
  'unit-cost.invalid-zero.json': 'never 0',
};

const stableKeys = [
  'schema_version', 'proof_mode', 'consumer', 'check_id', 'event_id', 'message_id', 'attempt_id',
  'injection_receipt_id', 'sha', 'observed_sha', 'verdict', 'agenda_id', 'task_id', 'applicability',
  'run_id', 'attempt_id', 'hold_id', 'call_id', 'unit_id', 'skill_id', 'stage', 'source_status',
  'intent_status', 'intent_revision', 'permission_revision', 'incorporated_by',
];

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8')) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.ok(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('every phase-contract fixture matches its validator', () => {
  const files = readdirSync(fixtureDir).filter(name => name.endsWith('.json')).sort();
  const seenInvalid: string[] = [];
  const seenValid = new Map<string, number>();
  const seenInvalidCount = new Map<string, number>();
  for (const file of files) {
    const match = /^(.+)\.(valid|invalid)(?:-.+)?\.json$/.exec(file);
    assert.ok(match, `unexpected fixture name ${file}`);
    const contract = match[1];
    const kind = match[2];
    assert.ok(contract && (kind === 'valid' || kind === 'invalid'), file);
    const validate = validators[contract];
    if (!validate) throw new Error(`no validator for ${file}`);
    const result = validate(load(file));
    if (kind === 'valid') {
      assert.equal(result.ok, true, `${file} ${result.ok ? '' : result.errors.join(' | ')}`);
      if (result.ok) assert.deepEqual(result.value, load(file));
      seenValid.set(contract, (seenValid.get(contract) ?? 0) + 1);
    } else {
      assert.equal(result.ok, false, `${file} was accepted`);
      if (!result.ok) {
        assert.ok(result.errors.length > 0, file);
        const needle = expectError[file];
        assert.ok(needle, `missing expected error for ${file}`);
        assert.ok(result.errors.some(error => error.includes(needle)), `${file}: ${result.errors.join(' | ')}`);
      }
      seenInvalid.push(file);
      seenInvalidCount.set(contract, (seenInvalidCount.get(contract) ?? 0) + 1);
    }
  }
  for (const contract of Object.keys(validators)) {
    assert.ok((seenValid.get(contract) ?? 0) >= 1, `${contract} needs a valid fixture`);
    assert.ok((seenInvalidCount.get(contract) ?? 0) >= 1, `${contract} needs an invalid fixture`);
  }
  assert.equal(Object.keys(validators).length, 9);
  assert.deepEqual(seenInvalid.sort(), Object.keys(expectError).sort());
});

test('json roundtrip does not mutate identity, status, or proof_mode', () => {
  const files = readdirSync(fixtureDir).filter(name => name.includes('.valid') && name.endsWith('.json')).sort();
  assert.ok(files.length >= 9);
  for (const file of files) {
    const contract = /^(.+)\.valid/.exec(file)?.[1];
    assert.ok(contract);
    const validate = validators[contract];
    assert.ok(validate);
    const raw = asRecord(load(file));
    const once = validate(raw);
    assert.equal(once.ok, true, file);
    if (!once.ok) continue;
    const encoded = JSON.parse(JSON.stringify(once.value)) as unknown;
    const twice = validate(encoded);
    assert.equal(twice.ok, true, file);
    if (!twice.ok) continue;
    assert.deepEqual(twice.value, once.value);
    assert.deepEqual(once.value, raw);
    const returned = asRecord(once.value);
    for (const key of stableKeys) {
      if (key in raw) assert.deepEqual(returned[key], raw[key], `${file} ${key}`);
    }
    assert.equal(recordIsLiveProof(asRecord(returned) as never), false, file);
  }
});

test('unknown fields, unknown enums, and incomplete records are rejected', () => {
  const samples = [
    'wake-proof.valid.json', 'handoff-receipt.valid.json', 'verifier-receipt.valid.json',
    'council-verdict.valid.json', 'research-task.valid.json', 'dispatch.valid.json',
    'freshness.valid.json', 'skill-candidate.valid.json', 'unit-cost.valid.json',
  ];
  assert.equal(samples.length, 9);
  for (const file of samples) {
    const contract = /^(.+)\.valid/.exec(file)?.[1];
    assert.ok(contract);
    const validate = validators[contract];
    assert.ok(validate);
    const extra = asRecord(load(file));
    extra.not_a_field = true;
    const unknownField = validate(extra);
    assert.equal(unknownField.ok, false, file);
    if (!unknownField.ok) assert.ok(unknownField.errors.some(error => error.includes('not_a_field')));
    const badMode = asRecord(load(file));
    badMode.proof_mode = 'mock';
    const unknownEnum = validate(badMode);
    assert.equal(unknownEnum.ok, false, file);
    if (!unknownEnum.ok) assert.ok(unknownEnum.errors.some(error => error.includes('synthetic|live')));
    const incomplete = asRecord(load(file));
    delete incomplete.schema_version;
    assert.equal(validate(incomplete).ok, false, file);
  }
  const fresh = asRecord(load('freshness.valid.json'));
  fresh.intent_status = 'WITHDRAWN';
  const withdrawn = validateFreshnessCheck(fresh);
  assert.equal(withdrawn.ok, false);
  if (!withdrawn.ok) assert.ok(withdrawn.errors.some(error => error.includes('VALID|RECHECK_REQUIRED|CHANGED|DENIED')));
  const coverage = asRecord(load('freshness.valid.json'));
  const manifest = coverage.manifest;
  assert.ok(Array.isArray(manifest) && manifest[0] && typeof manifest[0] === 'object');
  (manifest[0] as Record<string, unknown>).coverage = 'complete';
  const oldCoverage = validateFreshnessCheck(coverage);
  assert.equal(oldCoverage.ok, false);
  if (!oldCoverage.ok) assert.ok(oldCoverage.errors.some(error => error.includes('body|partial|pointer_only|none')));
  const badConsumer = asRecord(load('freshness.valid.json'));
  badConsumer.consumer = 'P4-DISPATCH';
  const consumerResult = validateFreshnessCheck(badConsumer);
  assert.equal(consumerResult.ok, false);
  if (!consumerResult.ok) assert.ok(consumerResult.errors.some(error => error.includes('P0|P1|P2|P3|P4|P5|P6')));
  const badRepresentation = asRecord(load('freshness.valid.json'));
  const entries = badRepresentation.manifest;
  assert.ok(Array.isArray(entries) && entries[0] && typeof entries[0] === 'object');
  (entries[0] as Record<string, unknown>).representation = 'capsule';
  const namespaced = validateFreshnessCheck(badRepresentation);
  assert.equal(namespaced.ok, false);
  if (!namespaced.ok) assert.ok(namespaced.errors.some(error => error.includes('source-namespaced')));
});

test('synthetic wake and receipt cannot validate as live', () => {
  const original = asRecord(load('wake-proof.valid.json'));
  const dropped = { ...original };
  delete dropped.proof_mode;
  assert.equal(validateWakeProof(dropped).ok, false);
  const result = validateWakeProof(original);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.proof_mode, 'synthetic');
  assert.equal(proofIsProvenLive(result.value), false);
  assert.equal(stageCountsAsVerified(result.value.relay_receipt), true);
  assert.equal(stageCountsAsVerified(result.value.native_host_run), false);
  assert.equal(stageCountsAsVerified(result.value.authenticated_exact_read), false);
  const observed = validateWakeProof(load('wake-proof.valid-proven.json'));
  assert.equal(observed.ok, true);
  if (!observed.ok) return;
  assert.equal(proofIsProvenLive(observed.value), false);
  const relabeled = validateWakeProof({ ...observed.value, proof_mode: 'live' });
  assert.equal(relabeled.ok, false);
  if (!relabeled.ok) assert.ok(relabeled.errors.some(error => error.includes('synthetic proof cannot validate as live')));
  const liveShape = validateWakeProof({
    ...observed.value,
    proof_mode: 'live',
    provenance: { ...observed.value.provenance, kind: 'server_observed' },
  });
  assert.equal(liveShape.ok, true, liveShape.ok ? '' : liveShape.errors.join(' | '));
  if (liveShape.ok) assert.equal(proofIsProvenLive(liveShape.value), true);
  const claimedLive = validateWakeProof({
    ...original,
    proof_mode: 'live',
    provenance: { ...result.value.provenance, kind: 'server_observed' },
  });
  assert.equal(claimedLive.ok, false);
  if (!claimedLive.ok) assert.ok(claimedLive.errors.some(error => error.includes('caller_claimed')));
  const pass = validateVerifierReceipt(load('verifier-receipt.valid.json'));
  const notRun = validateVerifierReceipt(load('verifier-receipt.valid-not-run.json'));
  assert.equal(pass.ok, true);
  assert.equal(notRun.ok, true);
  if (pass.ok) {
    assert.equal(receiptIsLiveProof(pass.value), false);
    const liveLabel = validateVerifierReceipt({ ...pass.value, proof_mode: 'live' });
    assert.equal(liveLabel.ok, false);
    if (!liveLabel.ok) assert.ok(liveLabel.errors.some(error => error.includes('synthetic proof cannot validate as live')));
  }
  if (notRun.ok) {
    assert.equal(gateDisposition(notRun.value), 'HOLD');
    const liveNotRun = validateVerifierReceipt({
      ...notRun.value,
      proof_mode: 'live',
      provenance: { ...notRun.value.provenance, kind: 'server_observed' },
    });
    assert.equal(liveNotRun.ok, false);
    if (!liveNotRun.ok) assert.ok(liveNotRun.errors.some(error => error.includes('NOT_RUN')));
  }
  const handoff = asRecord(load('handoff-receipt.valid.json'));
  handoff.proof_mode = 'live';
  const liveHandoff = validateHandoffReceipt(handoff);
  assert.equal(liveHandoff.ok, false);
  if (!liveHandoff.ok) assert.ok(liveHandoff.errors.some(error => error.includes('synthetic proof cannot validate as live')));
});

test('handoff joins wake stage ids and rejects a different proof', () => {
  const joined = joinHandoff(load('wake-proof.valid.json'), load('handoff-receipt.valid.json'));
  assert.equal(joined.ok, true, joined.ok ? '' : joined.errors.join(' | '));
  const mismatched = joinHandoff(load('wake-proof.valid-proven.json'), load('handoff-receipt.valid.json'));
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.ok(mismatched.errors.some(error => error.includes('does not join')));
});

test('verifier NOT_RUN does not pass the gate and red-case text stays TBD', () => {
  assert.equal(RED_CASE_IDS.length, 8);
  for (const id of RED_CASE_IDS) assert.equal(RED_CASE_DESCRIPTIONS[id], 'TBD');
  const pass = validateVerifierReceipt(load('verifier-receipt.valid.json'));
  const notRun = validateVerifierReceipt(load('verifier-receipt.valid-not-run.json'));
  assert.equal(pass.ok, true);
  assert.equal(notRun.ok, true);
  if (pass.ok) assert.equal(gateDisposition(pass.value), 'PASS');
  if (notRun.ok) assert.equal(gateDisposition(notRun.value), 'HOLD');
});

test('council keeps dissent and unknowns, and corrections only append', () => {
  assert.equal(COUNCIL_AUTHORITY_CONFLICT, 'unresolved');
  const parsed = validateCouncilVerdict(load('council-verdict.valid.json'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.dissent.length, 1);
  assert.equal(parsed.value.unknowns.length, 1);
  assert.equal(parsed.value.owner_accepted, null);
  assert.equal(parsed.value.executes_immediately, true);
  assert.equal(parsed.value.authority.length, 0);
  const declined = validateCouncilVerdict({ ...parsed.value, owner_accepted: false });
  assert.equal(declined.ok, true);
  if (declined.ok) {
    assert.equal(declined.value.owner_accepted, false);
    assert.equal(declined.value.executes_immediately, true);
    assert.equal(declined.value.authority.length, 0);
  }
  const before = parsed.value.corrections.length;
  const once = appendCorrection(parsed.value, {
    correction_id: 'corr_001', seq: 1, text: 'Record the dissent in the owner report.', at: '2026-10-24T04:00:00.000Z',
  });
  assert.equal(once.ok, true, once.ok ? '' : once.errors.join(' | '));
  assert.equal(parsed.value.corrections.length, before);
  if (!once.ok) return;
  assert.equal(once.value.corrections.length, 1);
  assert.deepEqual(once.value.dissent, parsed.value.dissent);
  assert.deepEqual(once.value.unknowns, parsed.value.unknowns);
  const again = appendCorrection(once.value, {
    correction_id: 'corr_001', seq: 2, text: 'Reuse of an id is not an append.', at: '2026-10-24T05:00:00.000Z',
  });
  assert.equal(again.ok, false);
});

test('research packets name a consumer and leave incorporated_by null until consumed', () => {
  const required = validateResearchTask(load('research-task.valid.json'));
  const notApplicable = validateResearchTask(load('research-task.valid-not-applicable.json'));
  const consumed = validateResearchTask(load('research-task.valid-incorporated.json'));
  assert.equal(required.ok, true);
  assert.equal(notApplicable.ok, true);
  assert.equal(consumed.ok, true);
  if (required.ok) {
    assert.equal(required.value.consumer, 'P4');
    assert.equal(required.value.incorporated_by, null);
  }
  if (notApplicable.ok && notApplicable.value.applicability === 'not_applicable') {
    assert.equal(notApplicable.value.consumer, 'P4');
    assert.ok(notApplicable.value.reason.length > 0);
  }
  if (consumed.ok) assert.equal(consumed.value.incorporated_by, 'record_incorp_001');
});

test('dispatch refuses a non-FRESH check and never stores unknown subscription usage as 0', () => {
  const request = validateDispatchRequest(load('dispatch.valid.json'));
  const subscription = validateDispatchRequest(load('dispatch.valid-subscription.json'));
  assert.equal(request.ok, true);
  assert.equal(subscription.ok, true);
  if (request.ok) assert.equal(request.value.unit_cost.subscription_usage, 'UNKNOWN');
  if (subscription.ok) {
    assert.equal(subscription.value.unit_cost.subscription_usage, 12);
    assert.equal(subscription.value.unit_cost.usd_micros, null);
    assert.equal(subscription.value.hold.category, 'subscription');
  }
  const fresh = validateFreshnessCheck(load('freshness.valid.json'));
  assert.equal(fresh.ok, true);
  if (fresh.ok) {
    assert.equal(canProceed(fresh.value), true);
    assert.equal(freshnessGrantsAuthority(fresh.value), false);
    assert.equal(canProceed(fresh.value, {
      action_digest: fresh.value.action_digest,
      context_digest: 'c'.repeat(64),
      intent_revision: fresh.value.intent_revision,
      permission_revision: fresh.value.permission_revision,
      manifest: fresh.value.manifest.map(entry => ({ source_id: entry.source_id, revision: entry.revision })),
    }), false);
  }
  assert.equal(requireFreshForDispatch(load('freshness.valid.json')).ok, true);
  const stale = requireFreshForDispatch(load('freshness.valid-stale.json'));
  const recheck = requireFreshForDispatch(load('freshness.valid-recheck.json'));
  const changed = requireFreshForDispatch(load('freshness.valid-changed-permission.json'));
  assert.equal(stale.ok, false);
  assert.equal(recheck.ok, false);
  assert.equal(changed.ok, false);
  if (!stale.ok) assert.ok(stale.errors.some(error => error.includes('FRESH')));
  if (!recheck.ok) assert.ok(recheck.errors.some(error => error.includes('RECHECK_REQUIRED')));
  if (!changed.ok) assert.ok(changed.errors.some(error => error.includes('CHANGED')));
  const admitted = validateDispatchAdmission(load('dispatch.valid.json'), load('freshness.valid.json'));
  const refused = validateDispatchAdmission(load('dispatch.valid.json'), load('freshness.valid-recheck.json'));
  const refusedPermission = validateDispatchAdmission(load('dispatch.valid.json'), load('freshness.valid-changed-permission.json'));
  assert.equal(admitted.ok, true);
  assert.equal(refused.ok, false);
  assert.equal(refusedPermission.ok, false);
});

test('P1 census and P4 states come from their contracts', () => {
  assert.deepEqual([...RED_CASE_IDS], ['RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'RC6', 'RC7', 'RC8']);
  assert.deepEqual([...CASE_STATES], ['passed', 'missing', 'not_run']);
  assert.deepEqual([...VERDICTS], ['PASS', 'HOLD', 'NOT_RUN']);
  assert.deepEqual([...HOLD_STATES], ['held', 'settled', 'released_with_evidence', 'escalated']);
  assert.deepEqual([...SPEND_CATEGORIES], ['subscription', 'openrouter', 'claude_api_credit']);
  assert.deepEqual([...SOURCE_STATUSES], ['FRESH', 'RECHECK_REQUIRED', 'STALE']);
  assert.deepEqual([...INTENT_STATUSES], ['VALID', 'RECHECK_REQUIRED', 'CHANGED', 'DENIED']);
  assert.deepEqual([...COVERAGE_LEVELS], ['body', 'partial', 'pointer_only', 'none']);
  assert.deepEqual([...PHASE_CONSUMERS], ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
});

test('migration registry allocations do not collide and stay above 0025', () => {
  assert.deepEqual(findMigrationCollisions(MIGRATION_ALLOCATIONS), []);
  const numbers = MIGRATION_ALLOCATIONS.map(row => row.number);
  const units = MIGRATION_ALLOCATIONS.map(row => row.unit);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.equal(new Set(units).size, units.length);
  assert.equal(numbers.length, Object.keys(MIGRATION_REGISTRY).length);
  for (const row of MIGRATION_ALLOCATIONS) assert.ok(Number(row.number) > 25, row.number);
  const collisions = findMigrationCollisions([
    { number: '0026', unit: 'same' },
    { number: '0026', unit: 'same' },
    { number: '0025', unit: 'other' },
    { number: '0010', unit: 'legacy' },
  ]);
  assert.ok(collisions.some(error => error.includes('duplicate number 0026')));
  assert.ok(collisions.some(error => error.includes('duplicate unit same')));
  assert.ok(collisions.some(error => error.includes('0025')));
  assert.ok(collisions.some(error => error.includes('0010')));
  assert.equal(MIGRATION_REGISTRY['0026'].status, 'reserved');
  assert.equal(MIGRATION_REGISTRY['0033'].unit.includes('P6'), true);
});
