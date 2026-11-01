import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEDUP_KEY_FIELDS,
  DEDUP_KEY_VERSION,
  decodeDedupKey,
  dedupCases,
  encodeDedupKey,
  measurementSpread,
  type Iw04Case,
  type Iw04DedupKey,
  type Iw04Measurement,
  type PhaseCheck,
} from '../src/phase-contracts/index.ts';

const BASE: Iw04DedupKey = {
  candidate: 'cand-a',
  parentHash: 'parent-aaa',
  taskCase: 'case-1',
  split: 'held_out',
  artifactRevision: 'rev-3',
  evaluatorEpoch: 'epoch-2',
};

function expectOk<T>(result: PhaseCheck<T>): T {
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
  return result.value;
}

function expectFail(result: PhaseCheck<unknown>, needle: string): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some(error => error.includes(needle)), result.errors.join(' | '));
}

function rec(over: Partial<Iw04Measurement> & Record<string, unknown> = {}): Iw04Measurement {
  return { ...BASE, value: 1, ...over };
}

function caseOf(cases: readonly Iw04Case[], over: Partial<Iw04DedupKey> = {}): Iw04Case {
  const id = expectOk(encodeDedupKey({ ...BASE, ...over }));
  const found = cases.find(row => row.id === id);
  assert.ok(found, `missing case ${id}`);
  return found;
}

test('the counting key is exactly the six IW-04 fields in order', () => {
  assert.deepEqual([...DEDUP_KEY_FIELDS], [
    'candidate', 'parentHash', 'taskCase', 'split', 'artifactRevision', 'evaluatorEpoch',
  ]);
  const encoded = expectOk(encodeDedupKey(BASE));
  assert.deepEqual(JSON.parse(encoded), [
    DEDUP_KEY_VERSION,
    BASE.candidate,
    BASE.parentHash,
    BASE.taskCase,
    BASE.split,
    BASE.artifactRevision,
    BASE.evaluatorEpoch,
  ]);
  assert.deepEqual(expectOk(decodeDedupKey(encoded)), BASE);
});

test('retries, judgment seeds and repeated runs under one key are one case', () => {
  const cases = expectOk(dedupCases([
    rec({ value: 4, retry: 1, judgmentSeed: 's1', runId: 'r1' }),
    rec({ value: 8, retry: 2, judgmentSeed: 's2', runId: 'r2' }),
    rec({ value: 6, retry: '3', judgmentSeed: 9, runId: 'r3' }),
  ]));
  assert.equal(cases.length, 1);
  const only = cases[0];
  assert.ok(only);
  assert.equal(only.n, 3);
  assert.deepEqual(only.key, BASE);
  assert.equal(only.id, expectOk(encodeDedupKey(BASE)));
  assert.equal(only.spread.min, 4);
  assert.equal(only.spread.max, 8);
  assert.equal(only.spread.stddev, 2);
  assert.deepEqual(only.spread, expectOk(measurementSpread([4, 8, 6])));
});

test('a different value of any key field is a new case', () => {
  const variants: Partial<Iw04DedupKey>[] = [
    { candidate: 'cand-b' },
    { parentHash: 'parent-bbb' },
    { taskCase: 'case-2' },
    { split: 'train' },
    { artifactRevision: 'rev-4' },
    { evaluatorEpoch: 'epoch-3' },
  ];
  const records = [rec({ value: 1 }), ...variants.map(over => rec({ ...over, value: 9 }))];
  const cases = expectOk(dedupCases(records));
  assert.equal(cases.length, 1 + variants.length);
  assert.equal(caseOf(cases).n, 1);
  for (const over of variants) {
    const row = caseOf(cases, over);
    assert.equal(row.n, 1);
    assert.equal(row.spread.min, 9);
    assert.equal(row.spread.max, 9);
    assert.equal(row.spread.stddev, 0);
  }
});

test('procedure, output, selector, memory bank, child revision and recipient do not split cases', () => {
  const extra = rec({
    value: 2,
    procedure: 'p1',
    output: 'o1',
    selector: 'sel',
    memoryBank: 'bank-a',
    childRevision: 'child-9',
    recipient: 'agent:muse',
    note: 'not a key field',
  });
  const cases = expectOk(dedupCases([
    rec({ value: 2 }),
    extra,
    rec({ value: 4, retry: 7 }),
  ]));
  assert.equal(cases.length, 1);
  const only = cases[0];
  assert.ok(only);
  assert.equal(only.n, 3);
  assert.deepEqual(only.key, BASE);
});

test('JSON encoding keeps neighbouring key fields from colliding', () => {
  const left = expectOk(encodeDedupKey({ ...BASE, candidate: 'a|b', parentHash: 'c' }));
  const right = expectOk(encodeDedupKey({ ...BASE, candidate: 'a', parentHash: 'b|c' }));
  assert.notEqual(left, right);
  const quoted = expectOk(encodeDedupKey({ ...BASE, taskCase: 'x","y' }));
  assert.equal(expectOk(decodeDedupKey(quoted)).taskCase, 'x","y');
  const full = 'x'.repeat(256);
  const bounded = expectOk(encodeDedupKey({ ...BASE, candidate: full }));
  assert.equal(expectOk(decodeDedupKey(bounded)).candidate, full);
});

test('spread is min, max and sample stddev; a lone measurement has stddev 0', () => {
  assert.deepEqual(expectOk(measurementSpread([7])), { min: 7, max: 7, stddev: 0 });
  assert.deepEqual(expectOk(measurementSpread([1, 2, 3])), { min: 1, max: 3, stddev: 1 });
  const spread = expectOk(measurementSpread([2, 4, 4, 4, 5, 5, 7, 9]));
  assert.equal(spread.min, 2);
  assert.equal(spread.max, 9);
  assert.equal(spread.stddev, Math.sqrt(32 / 7));
  const two = expectOk(measurementSpread([1, 3]));
  assert.equal(two.min, 1);
  assert.equal(two.max, 3);
  assert.equal(two.stddev, Math.sqrt(2));
  const floats = expectOk(measurementSpread([1.5, 2.5]));
  assert.equal(floats.min, 1.5);
  assert.equal(floats.max, 2.5);
  assert.equal(floats.stddev, Math.sqrt(0.5));
  const signed = expectOk(measurementSpread([-2, 0, 2]));
  assert.equal(signed.min, -2);
  assert.equal(signed.max, 2);
  assert.equal(signed.stddev, 2);
});

test('empty input is zero cases; grouping order is the encoded key, not input order', () => {
  assert.deepEqual(expectOk(dedupCases([])), []);
  const later = rec({ candidate: 'cand-z', value: 1 });
  const earlier = rec({ candidate: 'cand-m', value: 2 });
  const ids = expectOk(dedupCases([later, earlier])).map(row => row.id);
  assert.deepEqual(ids, [expectOk(encodeDedupKey(earlier)), expectOk(encodeDedupKey(later))].sort());
});

test('case count is distinct keys, never retry count', () => {
  const cases = expectOk(dedupCases([
    rec({ value: 1, retry: 1 }),
    rec({ value: 2, retry: 2 }),
    rec({ candidate: 'other', value: 3, retry: 1 }),
    rec({ candidate: 'other', value: 4, retry: 2 }),
    rec({ candidate: 'other', value: 5, retry: 3 }),
  ]));
  assert.equal(cases.length, 2);
  assert.equal(caseOf(cases).n, 2);
  assert.equal(caseOf(cases, { candidate: 'other' }).n, 3);
});

test('blank, ill-formed or oversized key fields are rejected', () => {
  for (const field of DEDUP_KEY_FIELDS) {
    expectFail(encodeDedupKey({ ...BASE, [field]: '' }), field);
    expectFail(encodeDedupKey({ ...BASE, [field]: '  ' }), 'non-empty');
    expectFail(encodeDedupKey({ ...BASE, [field]: 'x\0y' }), field);
    expectFail(encodeDedupKey({ ...BASE, [field]: '\uD800' }), 'well-formed');
    expectFail(encodeDedupKey({ ...BASE, [field]: 'x'.repeat(257) }), '256');
    expectFail(encodeDedupKey({ ...BASE, [field]: 1 as unknown as string }), field);
    expectFail(dedupCases([rec({ [field]: '' })]), field);
  }
  const missing = encodeDedupKey({});
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.errors.length, DEDUP_KEY_FIELDS.length);
    for (const field of DEDUP_KEY_FIELDS) assert.ok(missing.errors.some(error => error.includes(field)));
  }
  const both = encodeDedupKey({ ...BASE, candidate: '', parentHash: '   ' });
  assert.equal(both.ok, false);
  if (!both.ok) {
    assert.ok(both.errors.some(error => error.includes('candidate')));
    assert.ok(both.errors.some(error => error.includes('parentHash')));
  }
});

test('non-finite values and malformed records are rejected', () => {
  expectFail(dedupCases([rec({ value: Number.NaN })]), 'finite');
  expectFail(dedupCases([rec({ value: Number.POSITIVE_INFINITY })]), 'finite');
  expectFail(dedupCases([rec({ value: '1' as unknown as number })]), 'finite');
  expectFail(dedupCases([null]), 'expected an object');
  expectFail(dedupCases([[]]), 'expected an object');
  expectFail(dedupCases({}), 'expected an array');
  expectFail(measurementSpread([]), 'non-empty');
  expectFail(measurementSpread(null), 'non-empty');
  const many = measurementSpread([1, Number.NaN, Number.POSITIVE_INFINITY]);
  assert.equal(many.ok, false);
  if (!many.ok) {
    assert.equal(many.errors.length, 2);
    assert.ok(many.errors.every(error => error.includes('finite')));
  }
  expectFail(decodeDedupKey('not-json'), 'JSON');
  expectFail(decodeDedupKey(1), 'expected a string');
  expectFail(decodeDedupKey(JSON.stringify(['other.v1', ...DEDUP_KEY_FIELDS.map(field => BASE[field])])), DEDUP_KEY_VERSION);
  const lone = [DEDUP_KEY_VERSION, '\uD800', ...DEDUP_KEY_FIELDS.slice(1).map(field => BASE[field])];
  expectFail(decodeDedupKey(JSON.stringify(lone)), 'well-formed');
  expectFail(encodeDedupKey(null), 'expected an object');
  expectFail(encodeDedupKey([]), 'expected an object');
  const mixed = dedupCases([
    rec({ value: Number.NaN }),
    rec({ candidate: '', value: 1 }),
  ]);
  assert.equal(mixed.ok, false);
  if (!mixed.ok) {
    assert.ok(mixed.errors.some(error => error.includes('finite')));
    assert.ok(mixed.errors.some(error => error.includes('candidate')));
  }
});

function assertSpreadJson(spread: { min: number; max: number; stddev: number }): void {
  const parsed: unknown = JSON.parse(JSON.stringify(spread));
  assert.ok(parsed !== null && typeof parsed === 'object');
  const record = parsed as { min: unknown; max: unknown; stddev: unknown };
  for (const field of ['min', 'max', 'stddev'] as const) {
    const value = record[field];
    assert.notEqual(value, null, field);
    assert.ok(typeof value === 'number' && Number.isFinite(value), field);
  }
}

test('huge equal samples have stddev 0 and stay finite through JSON', () => {
  const same = expectOk(measurementSpread([1e308, 1e308]));
  assert.equal(same.min, 1e308);
  assert.equal(same.max, 1e308);
  assert.equal(same.stddev, 0);
  assertSpreadJson(same);

  const atLimit = expectOk(measurementSpread([Number.MAX_VALUE, Number.MAX_VALUE]));
  assert.equal(atLimit.stddev, 0);
  assertSpreadJson(atLimit);

  const tiny = expectOk(measurementSpread([1e-200, -1e-200]));
  assert.equal(tiny.min, -1e-200);
  assert.equal(tiny.max, 1e-200);
  assert.equal(tiny.stddev, Math.SQRT2 * 1e-200);
  assertSpreadJson(tiny);

  const grouped = expectOk(dedupCases([
    rec({ value: 1e308 }),
    rec({ value: 1e308 }),
  ]));
  const only = grouped[0];
  assert.ok(only);
  assert.equal(only.n, 2);
  assert.equal(only.spread.stddev, 0);
  assertSpreadJson(only.spread);
});

test('opposite huge samples are a finite deviation or a controlled reject', () => {
  const opposite = measurementSpread([1e308, -1e308]);
  if (opposite.ok) {
    assert.equal(opposite.value.min, -1e308);
    assert.equal(opposite.value.max, 1e308);
    assert.equal(opposite.value.stddev, Math.SQRT2 * 1e308);
    assert.ok(Number.isFinite(opposite.value.min));
    assert.ok(Number.isFinite(opposite.value.max));
    assert.ok(Number.isFinite(opposite.value.stddev));
    assertSpreadJson(opposite.value);
  } else {
    assert.ok(opposite.errors.some(error => error.includes('spread')));
    assert.ok(opposite.errors.some(error => error.includes('finite')));
  }

  const unrealizable = measurementSpread([Number.MAX_VALUE, -Number.MAX_VALUE]);
  assert.equal(unrealizable.ok, false);
  if (!unrealizable.ok) {
    assert.ok(unrealizable.errors.some(error => error.includes('spread')));
    assert.ok(unrealizable.errors.some(error => error.includes('finite')));
  }
  const grouped = dedupCases([
    rec({ value: Number.MAX_VALUE }),
    rec({ value: -Number.MAX_VALUE }),
  ]);
  assert.equal(grouped.ok, false);
  if (!grouped.ok) assert.ok(grouped.errors.some(error => error.includes('finite')));
});

test('tiny two-point spreads stay within 1e-12 of abs(x)/sqrt(2)', () => {
  for (const x of [3e-162, 4e-162, 5e-162]) {
    const expected = Math.abs(x) / Math.sqrt(2);
    const spread = expectOk(measurementSpread([0, x]));
    const spreadError = Math.abs(spread.stddev - expected) / expected;
    assert.ok(spreadError < 1e-12, `measurementSpread([0, ${x}]) relative error ${spreadError}`);
    const cases = expectOk(dedupCases([rec({ value: 0 }), rec({ value: x })]));
    assert.equal(cases.length, 1);
    const only = cases[0];
    assert.ok(only);
    const groupedError = Math.abs(only.spread.stddev - expected) / expected;
    assert.ok(groupedError < 1e-12, `dedupCases([0, ${x}]) relative error ${groupedError}`);
  }
});
