import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COVERAGE_LEVELS, SOURCE_STATUSES, buildContextBudget, renderContext,
  type ContextBudget, type ContextCandidate, type FreshnessManifestEntry, type TokenCounter,
} from '../src/phase-contracts/index.ts';
import * as budgetModule from '../src/phase-contracts/context-budget.ts';

const lengthCounter: TokenCounter = text => text.length;

function candidate(over: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id: 'item-1',
    source_id: 'src_msg_1',
    revision: 'rev_1',
    scope: 'room_main',
    representation: 'src_msg_1:body',
    freshness: 'FRESH',
    coverage: 'body',
    text: 'body',
    token_cost: 1,
    mandatory: false,
    correction: false,
    ...over,
  };
}

function built(items: readonly ContextCandidate[], budget: number, countTokens: TokenCounter = lengthCounter): ContextBudget {
  const result = buildContextBudget(items, budget, countTokens);
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
  if (!result.ok) throw new Error('expected a budget selection');
  return result.value;
}

function errorsOf(items: unknown, budget: unknown, countTokens: unknown): string[] {
  const result = buildContextBudget(items, budget, countTokens);
  assert.equal(result.ok, false);
  if (result.ok) return [];
  return result.errors;
}

test('the budget module does not reimplement the freshness proceed gate', () => {
  assert.equal(typeof budgetModule.buildContextBudget, 'function');
  assert.equal(Object.hasOwn(budgetModule, 'canProceed'), false);
  assert.equal(Object.hasOwn(budgetModule, 'validateFreshnessCheck'), false);
  assert.equal(Object.hasOwn(budgetModule, 'COVERAGE_LEVELS'), false);
  assert.equal(Object.hasOwn(budgetModule, 'SOURCE_STATUSES'), false);
});

test('records the freshness manifest shape and counts the final render', () => {
  const correction = candidate({
    id: 'corr-1',
    source_id: 'msg-9',
    revision: 'rev_4',
    scope: 'room_main',
    representation: 'msg-9:revised_figure',
    freshness: 'STALE',
    coverage: 'partial',
    text: 'Use the revised figure.',
    token_cost: 40,
    mandatory: true,
    correction: true,
  });
  const evidence = candidate({
    id: 'ev-1',
    source_id: 'msg-2',
    revision: 'rev_2',
    scope: 'task-7',
    representation: 'msg-2:abstract',
    freshness: 'RECHECK_REQUIRED',
    coverage: 'partial',
    text: 'Abstract of the source.',
    token_cost: 3,
    mandatory: true,
    correction: false,
  });
  const expected = renderContext([correction, evidence]);
  const seen: string[] = [];
  const manifest = built([correction, evidence], expected.length, text => {
    seen.push(text);
    return text.length;
  });
  assert.equal(manifest.rendered, expected);
  assert.equal(manifest.token_count, expected.length);
  assert.equal(manifest.budget, expected.length);
  assert.ok(seen.includes(expected));
  assert.equal(manifest.token_count, lengthCounter(manifest.rendered));
  assert.notEqual(manifest.token_count, correction.token_cost + evidence.token_cost);
  assert.equal(manifest.rendered.includes('source_id: msg-9'), true);
  assert.equal(manifest.rendered.includes('freshness: STALE'), true);
  assert.equal(manifest.rendered.includes('coverage: partial'), true);
  assert.equal(manifest.rendered.includes('role: correction'), true);
  assert.equal(manifest.rendered.includes('role: evidence'), true);
  assert.equal(manifest.rendered.includes('emitted: body'), true);
  const projected: FreshnessManifestEntry[] = manifest.entries;
  assert.deepEqual(projected.map(entry => ({
    source_id: entry.source_id,
    representation: entry.representation,
    revision: entry.revision,
    actually_emitted: entry.actually_emitted,
    freshness: entry.freshness,
    coverage: entry.coverage,
  })), [
    {
      source_id: 'msg-9', representation: 'msg-9:revised_figure', revision: 'rev_4',
      actually_emitted: true, freshness: 'STALE', coverage: 'partial',
    },
    {
      source_id: 'msg-2', representation: 'msg-2:abstract', revision: 'rev_2',
      actually_emitted: true, freshness: 'RECHECK_REQUIRED', coverage: 'partial',
    },
  ]);
  assert.ok(SOURCE_STATUSES.includes(projected[0]?.freshness ?? 'FRESH'));
  assert.ok(COVERAGE_LEVELS.includes(projected[0]?.coverage ?? 'body'));
  assert.deepEqual(manifest.entries.map(entry => ({
    id: entry.id,
    mandatory: entry.mandatory,
    correction: entry.correction,
    selected: entry.selected,
    token_cost: entry.token_cost,
  })), [
    { id: 'corr-1', mandatory: true, correction: true, selected: true, token_cost: 40 },
    { id: 'ev-1', mandatory: true, correction: false, selected: true, token_cost: 3 },
  ]);
  assert.equal(Object.hasOwn(manifest.entries[0] ?? {}, 'omission_reason'), false);
});

test('reserves mandatory corrections and evidence outside the drop competition', () => {
  const correction = candidate({
    id: 'corr', source_id: 'msg-c', revision: 'rev_3', text: 'MANDATORY-CORRECTION', token_cost: 500,
    mandatory: true, correction: true, representation: 'msg-c:body', coverage: 'body', freshness: 'FRESH',
  });
  const evidence = candidate({
    id: 'ev', source_id: 'msg-e', revision: 'rev_8', text: 'MANDATORY-EVIDENCE', token_cost: 500,
    mandatory: true, correction: false, representation: 'msg-e:body', coverage: 'body', freshness: 'STALE',
  });
  const optional = candidate({
    id: 'opt', source_id: 'msg-o', revision: 'rev_1', text: 'OPTIONAL-CHEAP', token_cost: 0,
    mandatory: false, correction: false,
  });
  const budget = renderContext([correction, evidence]).length;
  const manifest = built([optional, evidence, correction], budget, lengthCounter);
  assert.equal(manifest.token_count <= budget, true);
  assert.equal(manifest.rendered.includes('MANDATORY-CORRECTION'), true);
  assert.equal(manifest.rendered.includes('MANDATORY-EVIDENCE'), true);
  assert.equal(manifest.rendered.includes('OPTIONAL-CHEAP'), false);
  assert.deepEqual(manifest.entries.map(entry => entry.id), ['ev', 'corr', 'opt']);
  const dropped = manifest.entries[2];
  assert.ok(dropped);
  assert.equal(dropped.selected, false);
  assert.equal(dropped.actually_emitted, false);
  assert.equal(dropped.omission_reason, 'over_budget');
  assert.equal(dropped.correction, false);
  assert.equal(dropped.representation, optional.representation);
  assert.equal(dropped.freshness, optional.freshness);
  assert.equal(dropped.coverage, optional.coverage);
});

test('errors when mandatory items exceed the budget and does not truncate them', () => {
  const correction = candidate({
    id: 'corr', source_id: 'msg-c', text: 'KEEP-WHOLE-CORRECTION', mandatory: true, correction: true, token_cost: 1,
  });
  const evidence = candidate({
    id: 'ev', source_id: 'msg-e', text: 'KEEP-WHOLE-EVIDENCE', mandatory: true, token_cost: 1,
  });
  const bait = candidate({
    id: 'bait', source_id: 'msg-b', text: 'x', token_cost: 0, mandatory: false,
  });
  const seen: string[] = [];
  const budget = renderContext([correction]).length;
  assert.ok(renderContext([correction, evidence]).length > budget);
  const result = buildContextBudget([correction, evidence, bait], budget, (text: string) => {
    seen.push(text);
    return text.length;
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.errors.some(error => error.includes('MANDATORY_EXCEEDS_BUDGET')));
    assert.ok(result.errors.some(error => error.includes('not dropped or truncated')));
  }
  assert.equal(seen.length, 1);
  const only = seen[0];
  assert.ok(only);
  assert.equal(only.includes('KEEP-WHOLE-CORRECTION'), true);
  assert.equal(only.includes('KEEP-WHOLE-EVIDENCE'), true);
  assert.equal(only.includes(bait.text), false);
});

test('does not drop one mandatory item so another mandatory item can fit', () => {
  const first = candidate({ id: 'm1', source_id: 's1', text: 'FIRST-MANDATORY-LONG', mandatory: true, token_cost: 1 });
  const second = candidate({ id: 'm2', source_id: 's2', text: 'SECOND', mandatory: true, token_cost: 1 });
  const alone = renderContext([first]).length;
  assert.ok(renderContext([second]).length <= alone);
  assert.ok(renderContext([first, second]).length > alone);
  const errors = errorsOf([first, second], alone, lengthCounter);
  assert.ok(errors.some(error => error.includes('MANDATORY_EXCEEDS_BUDGET')));
  assert.ok(errors.some(error => error.includes('not dropped or truncated')));
});

test('omits an optional item whole and still accepts a later item that fits', () => {
  const mandatory = candidate({ id: 'm', source_id: 'sm', text: 'PINNED', mandatory: true, correction: true });
  const tooBig = candidate({
    id: 'big', source_id: 'sb', text: 'ZZZ-UNIQUE-TAIL-THAT-MUST-NOT-BE-SLICED', token_cost: 1,
  });
  const fits = candidate({
    id: 'fit', source_id: 'sf', text: 'small', token_cost: 99,
    representation: 'sf:partial', coverage: 'partial',
  });
  const alsoBig = candidate({ id: 'late', source_id: 'sl', text: 'ALSO-TOO-LONG-FOR-THE-REMAINING-BUDGET', token_cost: 1 });
  const budget = renderContext([mandatory, fits]).length;
  assert.ok(renderContext([mandatory, tooBig]).length > budget);
  assert.ok(renderContext([mandatory, fits, alsoBig]).length > budget);
  const seen: string[] = [];
  const manifest = built([tooBig, mandatory, fits, alsoBig], budget, text => {
    seen.push(text);
    return text.length;
  });
  assert.equal(manifest.rendered, renderContext([mandatory, fits]));
  assert.equal(manifest.token_count, budget);
  assert.equal(manifest.token_count, lengthCounter(manifest.rendered));
  assert.equal(manifest.rendered.includes('ZZZ-UNIQUE-TAIL-THAT-MUST-NOT-BE-SLICED'), false);
  assert.equal(manifest.rendered.includes('ZZZ-UNIQUE'), false);
  assert.equal(manifest.rendered.includes('small'), true);
  assert.equal(manifest.rendered.includes('PINNED'), true);
  for (const sample of seen) {
    if (sample.includes('ZZZ')) assert.equal(sample.includes('ZZZ-UNIQUE-TAIL-THAT-MUST-NOT-BE-SLICED'), true);
  }
  assert.deepEqual(manifest.entries.map(entry => [entry.id, entry.selected, entry.omission_reason]), [
    ['m', true, undefined],
    ['fit', true, undefined],
    ['big', false, 'over_budget'],
    ['late', false, 'over_budget'],
  ]);
  const kept = manifest.entries[1];
  assert.ok(kept);
  assert.equal(kept.actually_emitted, true);
  assert.equal(kept.coverage, 'partial');
  assert.equal(kept.representation, 'sf:partial');
});

test('budgets with the injected counter of the full render, ignoring declared token costs', () => {
  const countTokens: TokenCounter = text => {
    const bodies = [...text.matchAll(/«(\d+)»/g)].reduce((sum, match) => sum + Number(match[1] ?? 0), 0);
    const blocks = text.length === 0 ? 0 : text.split('\n---\n').length;
    return bodies + blocks;
  };
  const mandatory = candidate({
    id: 'm', source_id: 'sm', mandatory: true, correction: true, text: '«3»', token_cost: 100,
  });
  const optional = candidate({ id: 'o', source_id: 'so', text: '«5»', token_cost: 1 });
  const tight = built([mandatory, optional], 9, countTokens);
  assert.equal(tight.token_count, 4);
  assert.equal(tight.rendered.includes('«3»'), true);
  assert.equal(tight.rendered.includes('«5»'), false);
  assert.equal(tight.entries.find(entry => entry.id === 'o')?.omission_reason, 'over_budget');
  const roomy = built([mandatory, optional], 10, countTokens);
  assert.equal(roomy.token_count, 10);
  assert.equal(roomy.entries.every(entry => entry.selected), true);
  assert.notEqual(roomy.token_count, mandatory.token_cost + optional.token_cost);
});

test('keeps a mandatory item whose declared cost exceeds the budget when the render fits', () => {
  const item = candidate({ mandatory: true, token_cost: 10_000, text: 'short' });
  const budget = renderContext([item]).length;
  assert.ok(item.token_cost > budget);
  const manifest = built([item], budget, lengthCounter);
  assert.equal(manifest.entries[0]?.actually_emitted, true);
  assert.equal(manifest.token_count, budget);
  assert.equal(manifest.rendered.includes('short'), true);
});

test('records a selected pointer as not actually emitted', () => {
  const pointer = candidate({
    id: 'ptr', source_id: 'msg-p', revision: 'rev_6', scope: 'room_main', representation: 'msg-p:pointer',
    freshness: 'FRESH', coverage: 'pointer_only', text: '', token_cost: 2, mandatory: true, correction: false,
  });
  const body = candidate({
    id: 'body', source_id: 'msg-b', text: 'VISIBLE-BODY', mandatory: false, token_cost: 1,
  });
  const budget = renderContext([pointer, body]).length;
  const manifest = built([pointer, body], budget, lengthCounter);
  const pointerEntry = manifest.entries[0];
  const bodyEntry = manifest.entries[1];
  assert.ok(pointerEntry && bodyEntry);
  assert.equal(pointerEntry.selected, true);
  assert.equal(pointerEntry.actually_emitted, false);
  assert.equal(pointerEntry.coverage, 'pointer_only');
  assert.equal(pointerEntry.omission_reason, undefined);
  assert.equal(bodyEntry.actually_emitted, true);
  assert.equal(manifest.rendered.includes('emitted: pointer'), true);
  assert.equal(manifest.rendered.includes('VISIBLE-BODY'), true);
  assert.equal(manifest.rendered.includes('source_id: msg-p'), true);
  const asManifest: FreshnessManifestEntry = pointerEntry;
  assert.equal(asManifest.actually_emitted, false);
  assert.equal(asManifest.freshness, 'FRESH');
});

test('coverage none is recorded and is not body exposure', () => {
  const none = candidate({
    id: 'none', source_id: 'msg-n', coverage: 'none', text: '', mandatory: true, freshness: 'STALE',
    representation: 'msg-n:absent',
  });
  const manifest = built([none], renderContext([none]).length, lengthCounter);
  const entry = manifest.entries[0];
  assert.ok(entry);
  assert.equal(entry.selected, true);
  assert.equal(entry.actually_emitted, false);
  assert.equal(entry.coverage, 'none');
  assert.equal(entry.freshness, 'STALE');
  assert.equal(manifest.rendered.includes('coverage: none'), true);
  assert.equal(manifest.rendered.includes('emitted: none'), true);
  assert.equal(manifest.rendered.includes('emitted: pointer'), false);
  assert.equal(manifest.rendered.includes('emitted: body'), false);
});

test('drops an optional pointer that does not fit and still refuses to drop a mandatory pointer', () => {
  const pointer = candidate({
    id: 'ptr', source_id: 'msg-p', coverage: 'pointer_only', text: '', mandatory: true, token_cost: 1,
    representation: 'msg-p:pointer',
  });
  const extra = candidate({
    id: 'extra', source_id: 'msg-x', coverage: 'pointer_only', text: '', mandatory: false, token_cost: 0,
    representation: 'msg-x:pointer',
  });
  const exact = renderContext([pointer]).length;
  const manifest = built([pointer, extra], exact, lengthCounter);
  assert.deepEqual(manifest.entries.map(entry => entry.id), ['ptr', 'extra']);
  assert.equal(manifest.entries[1]?.omission_reason, 'over_budget');
  assert.equal(manifest.entries[1]?.actually_emitted, false);
  assert.equal(manifest.rendered.includes('source_id: msg-p'), true);
  assert.equal(manifest.rendered.includes('source_id: msg-x'), false);
  const errors = errorsOf([pointer], exact - 1, lengthCounter);
  assert.ok(errors.some(error => error.includes('MANDATORY_EXCEEDS_BUDGET')));
});

test('an optional correction competes and can be omitted', () => {
  const pinned = candidate({ id: 'pin', source_id: 'sp', text: 'PIN', mandatory: true, correction: false });
  const note = candidate({
    id: 'note', source_id: 'sn', text: 'OPTIONAL-CORRECTION-NOTE', mandatory: false, correction: true, token_cost: 1,
  });
  const budget = renderContext([pinned]).length;
  const manifest = built([pinned, note], budget, lengthCounter);
  const entry = manifest.entries[1];
  assert.ok(entry);
  assert.equal(entry.correction, true);
  assert.equal(entry.mandatory, false);
  assert.equal(entry.selected, false);
  assert.equal(entry.actually_emitted, false);
  assert.equal(entry.omission_reason, 'over_budget');
  assert.equal(manifest.rendered.includes('OPTIONAL-CORRECTION-NOTE'), false);
});

test('empty input under a zero budget renders nothing', () => {
  const seen: string[] = [];
  const result = buildContextBudget([], 0, (text: string) => {
    seen.push(text);
    return 0;
  });
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
  if (!result.ok) return;
  assert.deepEqual(result.value, { budget: 0, token_count: 0, rendered: '', entries: [] });
  assert.deepEqual(seen, ['']);
});

test('does not mutate the input list', () => {
  const items = [
    candidate({ id: 'm', mandatory: true, text: 'keep' }),
    candidate({ id: 'o', text: 'drop-me-please', token_cost: 4 }),
  ];
  const before = JSON.stringify(items);
  const pinned = items[0];
  assert.ok(pinned);
  const budget = renderContext([pinned]).length;
  buildContextBudget(items, budget, lengthCounter);
  assert.equal(JSON.stringify(items), before);
});

test('rejects invalid input before counting tokens', () => {
  let calls = 0;
  const countTokens: TokenCounter = () => {
    calls += 1;
    return 0;
  };
  const expectReject = (items: unknown, budget: unknown, counter: unknown, message: RegExp): void => {
    const errors = errorsOf(items, budget, counter);
    assert.ok(errors.some(error => message.test(error)), errors.join(' | '));
  };
  expectReject([candidate({ id: '' })], 10, countTokens, /id/);
  expectReject([candidate({ representation: '' })], 10, countTokens, /representation/);
  expectReject([candidate(), candidate()], 10, countTokens, /duplicate item id/);
  expectReject([candidate({ coverage: 'pointer_only', text: 'body' })], 10, countTokens, /coverage pointer_only requires empty text/);
  expectReject([candidate({ coverage: 'none', text: 'body' })], 10, countTokens, /coverage none requires empty text/);
  expectReject([candidate({ coverage: 'body', text: '' })], 10, countTokens, /coverage body requires text/);
  expectReject([candidate({ coverage: 'partial', text: '' })], 10, countTokens, /coverage partial requires text/);
  expectReject([candidate()], -1, countTokens, /budget/);
  expectReject([candidate()], 1.5, countTokens, /budget/);
  expectReject([candidate()], '10', countTokens, /budget/);
  expectReject('nope', 10, countTokens, /items/);
  expectReject([candidate()], 10, 'nope', /count_tokens/);
  expectReject([{ ...candidate(), coverage: 'full' }], 10, countTokens, new RegExp(COVERAGE_LEVELS.join('|')));
  expectReject([{ ...candidate(), freshness: 'fresh' }], 10, countTokens, new RegExp(SOURCE_STATUSES.join('|')));
  expectReject([{ ...candidate(), revision: 4 }], 10, countTokens, /revision/);
  expectReject([{ ...candidate(), tokenCost: 1, actuallyEmitted: true }], 10, countTokens, /unknown field/);
  const { source_id: droppedSource, ...rest } = candidate();
  assert.equal(typeof droppedSource, 'string');
  expectReject([{ ...rest, source: 'msg-9' }], 10, countTokens, /source_id/);
  assert.equal(calls, 0);

  const fractional = errorsOf([candidate({ mandatory: true })], 10, () => 1.5);
  assert.ok(fractional.some(error => error.includes('integer')));
  const negative = errorsOf([candidate({ mandatory: true })], 10, () => -1);
  assert.ok(negative.some(error => error.includes('integer')));
  let steps = 0;
  const midLoop = buildContextBudget(
    [candidate({ id: 'm', mandatory: true, text: 'PIN' }), candidate({ id: 'o', text: 'OPT' })],
    10_000,
    () => {
      steps += 1;
      return steps === 1 ? 1 : 1.5;
    },
  );
  assert.equal(midLoop.ok, false);
  assert.equal(steps, 2);
});
