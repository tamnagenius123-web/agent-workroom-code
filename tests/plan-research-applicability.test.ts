import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPLICABILITY,
  EDV_BANDS,
  FRONTIER_CLASSES,
  checkResearchApplicability,
  type ResearchApplicability,
} from '../src/server/plan/research-applicability.ts';

function requiredInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicability: 'required',
    consumer: 'agent:muse',
    hypothesis: 'A named consumer raises closure rate.',
    discriminator: 'consumer present vs absent',
    edvBand: 'HIGH',
    frontierClass: 'ONE_DISCRIMINATOR_AWAY',
    ...over,
  };
}

function notApplicableInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applicability: 'not_applicable',
    reason: 'Deterministic ledger write; research is not a prerequisite.',
    ...over,
  };
}

function drop(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...input };
  delete copy[key];
  return copy;
}

function fail(input: unknown): string[] {
  const result = checkResearchApplicability(input);
  if (result.ok) assert.fail('expected rejection');
  return result.errors;
}

function pass(input: unknown): ResearchApplicability {
  const result = checkResearchApplicability(input);
  if (!result.ok) assert.fail(result.errors.join(' | '));
  return result.value;
}

test('exported enums match the transplanted EDV claim schema', () => {
  assert.deepEqual([...APPLICABILITY], ['required', 'not_applicable']);
  assert.deepEqual([...EDV_BANDS], ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']);
  assert.deepEqual([...FRONTIER_CLASSES], [
    'CONSUME_FIRST',
    'READY_TO_ADJUDICATE',
    'ONE_DISCRIMINATOR_AWAY',
    'CONTRADICTORY',
    'EVIDENCE_POOR',
    'ACTIVE_SEARCH',
    'HUMAN_GATE',
    'BLOCKED',
  ]);
});

test('required research names a consumer and carries validated EDV fields', () => {
  const first = checkResearchApplicability(requiredInput());
  const second = checkResearchApplicability(requiredInput());
  assert.equal(first.ok, true, first.ok ? '' : first.errors.join(' | '));
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  assert.deepEqual(first.value, second.value);
  assert.deepEqual(first.value, {
    applicability: 'required',
    consumer: 'agent:muse',
    hypothesis: 'A named consumer raises closure rate.',
    discriminator: 'consumer present vs absent',
    edvBand: 'HIGH',
    frontierClass: 'ONE_DISCRIMINATOR_AWAY',
  });
});

test('deterministic tasks take an explicit not_applicable path with a reason', () => {
  const value = pass(notApplicableInput());
  assert.equal(value.applicability, 'not_applicable');
  if (value.applicability === 'not_applicable') {
    assert.equal(value.reason, 'Deterministic ledger write; research is not a prerequisite.');
    assert.equal('consumer' in value, false);
    assert.equal('hypothesis' in value, false);
    assert.equal('discriminator' in value, false);
    assert.equal('edvBand' in value, false);
    assert.equal('frontierClass' in value, false);
  }

  const noReason = fail(drop(notApplicableInput(), 'reason'));
  assert.ok(noReason.some(error => error.includes('reason')));

  const blank = fail(notApplicableInput({ reason: '   ' }));
  assert.ok(blank.some(error => error.includes('reason')));

  const withHypothesis = fail(notApplicableInput({ hypothesis: 'should not be here' }));
  assert.ok(withHypothesis.some(error => error.includes('hypothesis')));
});

test('dispatched actions require a named consumer (C5)', () => {
  const missing = fail(drop(requiredInput(), 'consumer'));
  assert.ok(missing.some(error => error.includes('consumer')));

  const blank = fail(requiredInput({ consumer: '' }));
  assert.ok(blank.some(error => error.includes('consumer')));

  const spaced = fail(requiredInput({ consumer: 'muse team' }));
  assert.ok(spaced.some(error => error.includes('consumer')));

  const value = pass(requiredInput({ consumer: 'agent:grok' }));
  if (value.applicability === 'required') assert.equal(value.consumer, 'agent:grok');
});

test('EDV fields hypothesis, discriminator, edvBand, and frontierClass are validated', () => {
  for (const key of ['hypothesis', 'discriminator', 'edvBand', 'frontierClass'] as const) {
    const errors = fail(drop(requiredInput(), key));
    assert.ok(errors.some(error => error.includes(key)), key);
  }

  const badBand = fail(requiredInput({ edvBand: 'mid' }));
  assert.ok(badBand.some(error => error.includes('edvBand')));

  const unknownBand = fail(requiredInput({ edvBand: 'UNKNOWN' }));
  assert.ok(unknownBand.some(error => error.includes('edvBand')));

  const badClass = fail(requiredInput({ frontierClass: 'dispatch' }));
  assert.ok(badClass.some(error => error.includes('frontierClass')));

  const unassessed = fail(requiredInput({ frontierClass: 'UNASSESSED' }));
  assert.ok(unassessed.some(error => error.includes('frontierClass')));

  const snake = fail(requiredInput({ edv_band: 'HIGH', frontier_class: 'ACTIVE_SEARCH' }));
  assert.ok(snake.some(error => error.includes('edv_band') || error.includes('frontier_class')));

  for (const edvBand of EDV_BANDS) {
    const value = pass(requiredInput({ edvBand }));
    if (value.applicability === 'required') assert.equal(value.edvBand, edvBand);
  }
  for (const frontierClass of FRONTIER_CLASSES) {
    const value = pass(requiredInput({ frontierClass }));
    if (value.applicability === 'required') assert.equal(value.frontierClass, frontierClass);
  }
});

test('any reward or selector field derived from R(t) is rejected', () => {
  const reward = fail(requiredInput({ reward: 12 }));
  assert.ok(reward.some(error => error.includes('reward') && error.includes('R(t)')));

  const selector = fail(requiredInput({ selector: 'next-task' }));
  assert.ok(selector.some(error => error.includes('selector') && error.includes('R(t)')));

  const rt = fail(notApplicableInput({ 'R(t)': 50 }));
  assert.ok(rt.some(error => error.includes('R(t)')));

  const nested = fail(requiredInput({
    scoring: { rt_reward: 1, selectorFromRt: 'pick' },
  }));
  assert.ok(nested.some(error => error.includes('rt_reward')));
  assert.ok(nested.some(error => error.includes('selectorFromRt')));

  const both = fail(requiredInput({ reward: 1, selector: 'r' }));
  assert.equal(both.filter(error => error.includes('R(t)')).length >= 2, true);
});

test('rejects non-objects, unknown applicability, and hostile text', () => {
  assert.ok(fail(null).some(error => error.includes('object')));
  assert.ok(fail([]).some(error => error.includes('object')));
  assert.ok(fail('required').some(error => error.includes('object')));

  const missing = fail({});
  assert.ok(missing.some(error => error.includes('applicability')));

  const other = fail(requiredInput({ applicability: 'optional' }));
  assert.ok(other.some(error => error.includes('applicability')));

  const nul = fail(requiredInput({ hypothesis: 'ok\0hidden' }));
  assert.ok(nul.some(error => error.includes('hypothesis')));
});
