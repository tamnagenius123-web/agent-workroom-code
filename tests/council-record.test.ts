import assert from 'node:assert/strict';
import test from 'node:test';
import { type PhaseCheck } from '../src/phase-contracts/check.ts';
import {
  FORBIDDEN_AUTHORITY, validateCouncilVerdict,
} from '../src/phase-contracts/council-verdict.ts';
import {
  appendCouncilCorrection, claimCouncilAuthority, councilGrantsAuthority, openAgenda, sealBlindRound,
  sealChair, sealCrossRound, setOwnerAccepted,
  type AgendaRecord, type BlindRoundRecord, type ChairInput, type CouncilRecord, type CrossRoundRecord,
  type SeatNote,
} from '../src/server/council-record.ts';

const EXECUTED = '2026-10-24T02:21:00.000Z';
const CORRECTED_AT = '2026-10-24T04:00:00.000Z';
const CORRECTED_AGAIN = '2026-10-24T05:00:00.000Z';

const provenance = {
  kind: 'synthetic_fixture' as const,
  producer_id: 'producer_p2',
  source_ref: 'fixture:council-record',
};

function must<T>(result: PhaseCheck<T>, label = 'expected ok'): T {
  assert.equal(result.ok, true, result.ok ? label : `${label}: ${result.errors.join(' | ')}`);
  if (!result.ok) throw new Error(label);
  return result.value;
}

function agenda(): AgendaRecord {
  return must(openAgenda({
    agenda_id: 'agenda_p2_001',
    consumer: 'P3',
    provenance,
    proof_mode: 'synthetic',
    owner_report_ref: 'report_owner_001',
  }));
}

function chairInput(): ChairInput {
  return {
    chair_id: 'chair_muse',
    record_ref: 'chair_record_001',
    summary: 'Advisory verdict recorded with dissent.',
    executed_at: EXECUTED,
  };
}

function sealFrom(blindNotes: readonly SeatNote[], crossNotes: readonly SeatNote[]): {
  blindNotes: readonly SeatNote[];
  cross: CrossRoundRecord;
  record: CouncilRecord;
} {
  const blind = must(sealBlindRound(agenda(), { record_ref: 'round_blind_001', notes: blindNotes }));
  const cross = must(sealCrossRound(blind, { record_ref: 'round_cross_001', notes: crossNotes }));
  const record = must(sealChair(cross, chairInput()));
  return { blindNotes: blind.notes, cross, record };
}

const blindNotes: readonly SeatNote[] = [
  { member_id: 'member_dots', stance: 'dissent', text: 'Egress proof is still missing.' },
  { member_id: 'member_muse', stance: 'unknown', text: 'Content unknown from retrievable sources.', topic: 'MASS' },
  { member_id: 'member_grok', stance: 'assent', text: 'The agenda is in scope.' },
];

const crossNotes: readonly SeatNote[] = [
  { member_id: 'member_dots', stance: 'dissent', text: 'Cross round does not replace the blind objection.' },
];

test('chair record keeps the verdict, dissent, unknowns, and executed_at', () => {
  const { record } = sealFrom(blindNotes, crossNotes);
  const checked = validateCouncilVerdict(record.verdict);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.errors.join(' | '));
  assert.equal(record.executed_at, EXECUTED);
  assert.equal('executed_at' in record.verdict, false);
  assert.equal(record.corrects, null);
  assert.equal(record.record_id, 'chair_record_001');
  assert.equal(record.verdict.executes_immediately, true);
  assert.equal(record.verdict.owner_accepted, null);
  assert.deepEqual(record.verdict.authority, []);
  assert.equal(record.verdict.proof_mode, 'synthetic');
  assert.deepEqual(record.verdict.rounds, [
    { name: 'blind_r1', record_ref: 'round_blind_001' },
    { name: 'cross_r2', record_ref: 'round_cross_001' },
  ]);
  assert.deepEqual(record.verdict.dissent.map(entry => entry.text), [
    'Egress proof is still missing.',
    'Cross round does not replace the blind objection.',
  ]);
  assert.deepEqual(record.verdict.unknowns, [
    { topic: 'MASS', note: 'Content unknown from retrievable sources.' },
  ]);
  assert.equal(record.verdict.chair.summary, 'Advisory verdict recorded with dissent.');
  const again = sealFrom(blindNotes, crossNotes);
  assert.deepEqual(again.record, record);
});

test('sealed rounds stay immutable when later inputs change', () => {
  const notes: SeatNote[] = [
    { member_id: 'member_dots', stance: 'dissent', text: 'Egress proof is still missing.' },
  ];
  const opened = agenda();
  const blind = must(sealBlindRound(opened, { record_ref: 'round_blind_001', notes }));
  notes[0]!.text = 'rewritten after the blind seal';
  notes.push({ member_id: 'member_muse', stance: 'dissent', text: 'added after the blind seal' });
  assert.equal(blind.notes.length, 1);
  assert.equal(blind.notes[0]!.text, 'Egress proof is still missing.');

  const resealed = must(sealBlindRound(opened, { record_ref: 'round_blind_002', notes: [] }));
  assert.equal(blind.record_ref, 'round_blind_001');
  assert.equal(blind.notes.length, 1);
  assert.equal(resealed.notes.length, 0);

  const cross = must(sealCrossRound(blind, { record_ref: 'round_cross_001', notes: [] }));
  const record = must(sealChair(cross, chairInput()));
  assert.deepEqual(record.verdict.dissent, [
    { member_id: 'member_dots', text: 'Egress proof is still missing.' },
  ]);
  const snapshot = JSON.stringify(record);
  assert.throws(() => {
    record.verdict.dissent[0]!.text = 'mutated in place';
  }, TypeError);
  assert.equal(JSON.stringify(record), snapshot);

  const skipped = sealCrossRound({ stage: 'agenda' } as unknown as BlindRoundRecord, {
    record_ref: 'round_cross_001', notes: [],
  });
  assert.equal(skipped.ok, false);
  if (!skipped.ok) assert.match(skipped.errors.join(' | '), /blind_r1/);

  const missingTopic = sealBlindRound(opened, {
    record_ref: 'round_blind_003',
    notes: [{ member_id: 'member_muse', stance: 'unknown', text: 'No topic given.' }],
  });
  assert.equal(missingTopic.ok, false);
  if (!missingTopic.ok) assert.match(missingTopic.errors.join(' | '), /topic/);
  assert.equal(blind.notes.length, 1);
});

test('corrections append with a link to the prior record', () => {
  const { record } = sealFrom(blindNotes, crossNotes);
  const before = JSON.stringify(record);
  const first = must(appendCouncilCorrection(record, {
    correction_id: 'corr_001',
    text: 'Record the dissent in the owner report.',
    at: CORRECTED_AT,
  }));
  assert.equal(JSON.stringify(record), before);
  assert.equal(first.corrects, record.record_id);
  assert.equal(first.record_id, 'corr_001');
  assert.equal(first.executed_at, record.executed_at);
  assert.equal(first.verdict.owner_accepted, null);
  assert.deepEqual(first.verdict.dissent, record.verdict.dissent);
  assert.deepEqual(first.verdict.unknowns, record.verdict.unknowns);
  assert.equal(first.verdict.chair.summary, record.verdict.chair.summary);
  assert.deepEqual(first.verdict.corrections, [
    { correction_id: 'corr_001', seq: 1, text: 'Record the dissent in the owner report.', at: CORRECTED_AT },
  ]);

  const replay = must(appendCouncilCorrection(first, {
    correction_id: 'corr_001',
    text: 'Record the dissent in the owner report.',
    at: CORRECTED_AT,
  }));
  assert.equal(replay.verdict.corrections.length, 1);
  assert.equal(replay.record_id, first.record_id);
  assert.equal(replay.corrects, first.corrects);

  const clash = appendCouncilCorrection(first, {
    correction_id: 'corr_001',
    text: 'A reused id must not rewrite the linked correction.',
    at: CORRECTED_AGAIN,
  });
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.match(clash.errors.join(' | '), /duplicate correction_id/);
  assert.equal(first.verdict.corrections[0]!.text, 'Record the dissent in the owner report.');

  const second = must(appendCouncilCorrection(first, {
    correction_id: 'corr_002',
    text: 'The first correction still stands.',
    at: CORRECTED_AGAIN,
  }));
  assert.equal(second.corrects, 'corr_001');
  assert.equal(second.record_id, 'corr_002');
  assert.equal(second.verdict.corrections.length, 2);
  assert.equal(second.verdict.corrections[0]!.seq, 1);
  assert.equal(second.verdict.corrections[1]!.seq, 2);
  assert.equal(second.verdict.corrections[0]!.text, 'Record the dissent in the owner report.');
  assert.equal(first.verdict.corrections.length, 1);
  assert.equal(record.verdict.corrections.length, 0);
});

test('a correction cannot reuse the record_id it corrects (no self-reference)', () => {
  const { record } = sealFrom(blindNotes, crossNotes);
  const before = JSON.stringify(record);
  const self = appendCouncilCorrection(record, {
    correction_id: record.record_id,
    text: 'A correction must not point at itself.',
    at: CORRECTED_AT,
  });
  assert.equal(self.ok, false);
  if (!self.ok) assert.match(self.errors.join(' | '), /self-reference/);
  assert.equal(JSON.stringify(record), before);
});

test('the record grants no release, security, or budget authority', () => {
  const { cross, record } = sealFrom(blindNotes, crossNotes);
  assert.deepEqual(record.verdict.authority, []);
  assert.equal(record.verdict.executes_immediately, true);
  assert.equal(record.verdict.owner_accepted, null);

  for (const claim of FORBIDDEN_AUTHORITY) {
    assert.equal(councilGrantsAuthority(record, claim), false);
    const refused = claimCouncilAuthority(record, claim);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.match(refused.errors.join(' | '), new RegExp(`${claim} is a forbidden authority`));
  }
  assert.deepEqual(record.verdict.authority, []);
  const other = claimCouncilAuthority(record, 'promotion');
  assert.equal(other.ok, false);
  if (!other.ok) assert.match(other.errors.join(' | '), /council authority stays empty/);
  assert.equal(councilGrantsAuthority(record, 'promotion'), false);

  const accepted = must(setOwnerAccepted(record, true));
  assert.equal(accepted.verdict.owner_accepted, true);
  assert.equal(accepted.executed_at, record.executed_at);
  assert.equal(accepted.record_id, record.record_id);
  assert.equal(accepted.corrects, record.corrects);
  assert.equal(record.verdict.owner_accepted, null);
  assert.equal(accepted.verdict.executes_immediately, true);
  assert.deepEqual(accepted.verdict.authority, []);
  for (const claim of FORBIDDEN_AUTHORITY) {
    assert.equal(councilGrantsAuthority(accepted, claim), false);
    assert.equal(claimCouncilAuthority(accepted, claim).ok, false);
  }

  const declined = must(setOwnerAccepted(record, false));
  assert.equal(declined.verdict.owner_accepted, false);
  assert.equal(declined.verdict.executes_immediately, true);
  assert.deepEqual(declined.verdict.authority, []);
  assert.equal(councilGrantsAuthority(declined, 'security'), false);

  const sneaky: ChairInput & { authority?: readonly string[] } = { ...chairInput(), authority: ['budget'] };
  const denied = sealChair(cross, sneaky);
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.match(denied.errors.join(' | '), /budget is a forbidden authority/);

  const smuggled = structuredClone(record);
  (smuggled.verdict as { authority: string[] }).authority = ['release', 'security', 'budget'];
  for (const claim of FORBIDDEN_AUTHORITY) assert.equal(councilGrantsAuthority(smuggled, claim), false);
});
