import assert from 'node:assert/strict';
import test from 'node:test';
import { validateResearchTask } from '../src/phase-contracts/research-task.ts';
import {
  incorporateResearchPacket,
  openResearchPacket,
} from '../src/server/research-packet.ts';

const provenance = {
  kind: 'synthetic_fixture',
  producer_id: 'producer_p3',
  source_ref: 'fixture:research-packet',
} as const;

function requiredInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    consumer: 'P4',
    provenance,
    proof_mode: 'synthetic',
    task_id: 'research_001',
    applicability: 'required',
    hypothesis: 'A named consumer raises closure rate.',
    discriminator: 'consumer present vs absent',
    edv_band: 'mid',
    frontier_class: 'dispatch',
    incorporated_by: null,
    intent_rev: 'intent_001',
    ...over,
  };
}

function notApplicableInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    consumer: 'P4',
    provenance,
    proof_mode: 'synthetic',
    task_id: 'task_det_001',
    applicability: 'not_applicable',
    reason: 'Deterministic ledger write; research is not a prerequisite.',
    incorporated_by: null,
    intent_rev: 'intent_001',
    ...over,
  };
}

test('missing consumer is rejected', () => {
  const requiredBody = requiredInput();
  delete requiredBody.consumer;
  const notApplicableBody = notApplicableInput();
  delete notApplicableBody.consumer;
  const required = openResearchPacket(requiredBody);
  const notApplicable = openResearchPacket(notApplicableBody);
  const blank = openResearchPacket(requiredInput({ consumer: '' }));
  const unitName = openResearchPacket(requiredInput({ consumer: 'P4-DISPATCH' }));
  assert.equal(required.ok, false);
  assert.equal(notApplicable.ok, false);
  assert.equal(blank.ok, false);
  assert.equal(unitName.ok, false);
  if (!required.ok) assert.ok(required.errors.some(error => error.includes('consumer')));
  if (!notApplicable.ok) assert.ok(notApplicable.errors.some(error => error.includes('consumer')));
  if (!blank.ok) assert.ok(blank.errors.some(error => error.includes('consumer')));
  if (!unitName.ok) assert.ok(unitName.errors.some(error => error.includes('consumer')));

  const forDispatch = openResearchPacket(requiredInput({ consumer: 'P4' }));
  const forCouncil = openResearchPacket(notApplicableInput({ consumer: 'P2' }));
  assert.equal(forDispatch.ok, true, forDispatch.ok ? '' : forDispatch.errors.join(' | '));
  assert.equal(forCouncil.ok, true, forCouncil.ok ? '' : forCouncil.errors.join(' | '));
  if (forDispatch.ok) assert.equal(forDispatch.value.task.consumer, 'P4');
  if (forCouncil.ok) assert.equal(forCouncil.value.task.consumer, 'P2');
});

test('not-applicable path is explicit and deterministic', () => {
  const input = notApplicableInput();
  const first = openResearchPacket(input);
  const second = openResearchPacket(input);
  assert.equal(first.ok, true, first.ok ? '' : first.errors.join(' | '));
  assert.equal(second.ok, true, second.ok ? '' : second.errors.join(' | '));
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.value, second.value);
  assert.equal(input.incorporated_by, null);
  assert.equal(first.value.intent_rev, 'intent_001');
  assert.equal(first.value.incorporated_by, null);
  assert.equal(first.value.task.incorporated_by, null);
  assert.equal(first.value.task.applicability, 'not_applicable');
  if (first.value.task.applicability === 'not_applicable') {
    assert.equal(first.value.task.reason, 'Deterministic ledger write; research is not a prerequisite.');
    assert.equal('hypothesis' in first.value.task, false);
    assert.equal('discriminator' in first.value.task, false);
    assert.equal('edv_band' in first.value.task, false);
    assert.equal('frontier_class' in first.value.task, false);
  }
  const checked = validateResearchTask(first.value.task);
  assert.equal(checked.ok, true, checked.ok ? '' : checked.errors.join(' | '));

  const withHypothesis = openResearchPacket(notApplicableInput({
    hypothesis: 'should not be here',
  }));
  assert.equal(withHypothesis.ok, false);
  if (!withHypothesis.ok) assert.ok(withHypothesis.errors.some(error => error.includes('hypothesis')));

  const droppedReason = notApplicableInput();
  delete droppedReason.reason;
  const noReason = openResearchPacket(droppedReason);
  assert.equal(noReason.ok, false);
  if (!noReason.ok) assert.ok(noReason.errors.some(error => error.includes('reason')));

  const research = openResearchPacket(requiredInput());
  assert.equal(research.ok, true, research.ok ? '' : research.errors.join(' | '));
  if (research.ok && research.value.task.applicability === 'required') {
    assert.equal(research.value.task.hypothesis, 'A named consumer raises closure rate.');
    assert.equal(research.value.task.discriminator, 'consumer present vs absent');
    assert.equal(research.value.task.edv_band, 'mid');
    assert.equal(research.value.task.frontier_class, 'dispatch');
  }
  const droppedBand = requiredInput();
  delete droppedBand.edv_band;
  const noBand = openResearchPacket(droppedBand);
  assert.equal(noBand.ok, false);
  if (!noBand.ok) assert.ok(noBand.errors.some(error => error.includes('edv_band')));
});

test('incorporation requires incorporated_by {msg_id, intent_rev}', () => {
  const opened = openResearchPacket(requiredInput());
  assert.equal(opened.ok, true, opened.ok ? '' : opened.errors.join(' | '));
  if (!opened.ok) return;
  const packet = opened.value;
  assert.equal(packet.task.incorporated_by, null);
  assert.equal(packet.incorporated_by, null);

  const missing = incorporateResearchPacket(packet, null);
  const omitted = incorporateResearchPacket(packet, undefined);
  const empty = incorporateResearchPacket(packet, {});
  const msgOnly = incorporateResearchPacket(packet, { msg_id: 'msg_001' });
  const revOnly = incorporateResearchPacket(packet, { intent_rev: 'intent_001' });
  assert.equal(missing.ok, false);
  assert.equal(omitted.ok, false);
  assert.equal(empty.ok, false);
  assert.equal(msgOnly.ok, false);
  assert.equal(revOnly.ok, false);
  if (!missing.ok) assert.ok(missing.errors.some(error => error.includes('incorporated_by')));
  if (!msgOnly.ok) assert.ok(msgOnly.errors.some(error => error.includes('intent_rev')));
  if (!revOnly.ok) assert.ok(revOnly.errors.some(error => error.includes('msg_id')));
  assert.equal(packet.task.incorporated_by, null);
  assert.equal(packet.incorporated_by, null);

  const stale = incorporateResearchPacket(packet, { msg_id: 'msg_001', intent_rev: 'intent_999' });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.ok(stale.errors.some(error => error.includes('intent_rev')));
  assert.equal(packet.task.incorporated_by, null);

  const extra = incorporateResearchPacket(packet, { msg_id: 'msg_001', intent_rev: 'intent_001', note: 'x' });
  assert.equal(extra.ok, false);

  const preloaded = openResearchPacket(requiredInput({ incorporated_by: 'msg_001' }));
  assert.equal(preloaded.ok, false);
  if (!preloaded.ok) assert.ok(preloaded.errors.some(error => error.includes('incorporated_by')));

  const noIntent = requiredInput();
  delete noIntent.intent_rev;
  const unbound = openResearchPacket(noIntent);
  assert.equal(unbound.ok, false);
  if (!unbound.ok) assert.ok(unbound.errors.some(error => error.includes('intent_rev')));

  const once = incorporateResearchPacket(packet, { msg_id: 'msg_001', intent_rev: 'intent_001' });
  assert.equal(once.ok, true, once.ok ? '' : once.errors.join(' | '));
  if (!once.ok) return;
  assert.deepEqual(once.value.incorporated_by, { msg_id: 'msg_001', intent_rev: 'intent_001' });
  assert.equal(once.value.task.incorporated_by, 'msg_001');
  assert.equal(once.value.intent_rev, 'intent_001');
  assert.equal(packet.task.incorporated_by, null);
  if (once.value.task.applicability === 'required') {
    assert.equal(once.value.task.hypothesis, 'A named consumer raises closure rate.');
    assert.equal(once.value.task.edv_band, 'mid');
  }
  const stored = validateResearchTask(once.value.task);
  assert.equal(stored.ok, true, stored.ok ? '' : stored.errors.join(' | '));
  if (stored.ok) assert.equal(stored.value.incorporated_by, 'msg_001');

  const twice = incorporateResearchPacket(once.value, { msg_id: 'msg_001', intent_rev: 'intent_001' });
  assert.equal(twice.ok, true, twice.ok ? '' : twice.errors.join(' | '));
  if (twice.ok) assert.deepEqual(twice.value, once.value);

  const replaced = incorporateResearchPacket(once.value, { msg_id: 'msg_002', intent_rev: 'intent_001' });
  assert.equal(replaced.ok, false);
  if (!replaced.ok) assert.ok(replaced.errors.some(error => error.includes('incorporated_by')));
  assert.equal(once.value.task.incorporated_by, 'msg_001');

  const cleared = incorporateResearchPacket(once.value, null);
  assert.equal(cleared.ok, false);
  assert.equal(once.value.task.incorporated_by, 'msg_001');

  const na = openResearchPacket(notApplicableInput());
  assert.equal(na.ok, true, na.ok ? '' : na.errors.join(' | '));
  if (!na.ok) return;
  const naMissing = incorporateResearchPacket(na.value, null);
  assert.equal(naMissing.ok, false);
  const naOnce = incorporateResearchPacket(na.value, { msg_id: 'msg_na_001', intent_rev: 'intent_001' });
  assert.equal(naOnce.ok, true, naOnce.ok ? '' : naOnce.errors.join(' | '));
  if (naOnce.ok) {
    assert.deepEqual(naOnce.value.incorporated_by, { msg_id: 'msg_na_001', intent_rev: 'intent_001' });
    assert.equal(naOnce.value.task.incorporated_by, 'msg_na_001');
    assert.equal(naOnce.value.task.applicability, 'not_applicable');
  }
});
