import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLASSIFICATION_FIELDS,
  COLLAPSED_ALIASES,
  CORPUS_LEVELS,
  LIFECYCLE_FIELDS,
  MEMORY_TIERS,
  REVIEW_SUPPORTS,
  SKILL_STAGES,
  STRUCTURAL_GRADES,
  classificationOf,
  lifecycleOf,
  validateIw01Status,
  type Iw01StatusIssue,
  type Iw01StatusRecord,
  type Iw01StatusValidation,
  type SkillStage,
} from '../src/phase-contracts/index.ts';

function valid(over: Partial<Iw01StatusRecord> = {}): Iw01StatusRecord {
  return {
    reviewSupport: 'none',
    structuralGrade: 'ungraded',
    corpusLevel: 'L0',
    memoryTier: 0,
    promotionStage: 'candidate',
    kept: false,
    applied: false,
    effect: false,
    ...over,
  };
}

function accepted(input: unknown): Iw01StatusRecord {
  const result = validateIw01Status(input);
  if (!result.ok) assert.fail(`expected ok, got ${result.issues.map(issue => `${issue.code}:${issue.field}`).join(',')}`);
  return result.record;
}

function rejected(input: unknown): readonly Iw01StatusIssue[] {
  const result: Iw01StatusValidation = validateIw01Status(input);
  if (result.ok) assert.fail('expected validation issues');
  return result.issues;
}

function fail(input: unknown, field: string, code: string): void {
  const issues = rejected(input);
  assert.ok(
    issues.some(issue => issue.field === field && issue.code === code),
    `${code}:${field} in ${issues.map(issue => `${issue.code}:${issue.field}`).join(',')}`,
  );
}

test('a complete record keeps the five classification fields and the three lifecycle states', () => {
  const record = accepted(valid({
    reviewSupport: 'supported',
    structuralGrade: 'C',
    corpusLevel: 'L1',
    memoryTier: 2,
    promotionStage: 'shadow',
    kept: true,
    applied: false,
    effect: false,
  }));
  assert.deepEqual(record, {
    reviewSupport: 'supported',
    structuralGrade: 'C',
    corpusLevel: 'L1',
    memoryTier: 2,
    promotionStage: 'shadow',
    kept: true,
    applied: false,
    effect: false,
  });
  assert.deepEqual(Object.keys(record), [...CLASSIFICATION_FIELDS, ...LIFECYCLE_FIELDS]);
});

test('each classification field accepts every closed value without changing the others', () => {
  for (const reviewSupport of REVIEW_SUPPORTS) {
    const record = accepted(valid({ reviewSupport }));
    assert.equal(record.reviewSupport, reviewSupport);
    assert.equal(record.structuralGrade, 'ungraded');
    assert.equal(record.memoryTier, 0);
  }
  for (const structuralGrade of STRUCTURAL_GRADES) {
    const record = accepted(valid({ structuralGrade }));
    assert.equal(record.structuralGrade, structuralGrade);
    assert.equal(record.reviewSupport, 'none');
  }
  for (const corpusLevel of CORPUS_LEVELS) {
    const record = accepted(valid({ corpusLevel }));
    assert.equal(record.corpusLevel, corpusLevel);
    assert.equal(record.memoryTier, 0);
  }
  for (const memoryTier of MEMORY_TIERS) {
    const record = accepted(valid({ memoryTier }));
    assert.equal(record.memoryTier, memoryTier);
    assert.equal(record.corpusLevel, 'L0');
  }
  for (const promotionStage of SKILL_STAGES) {
    const record = accepted(valid({ promotionStage }));
    const stage: SkillStage = record.promotionStage;
    assert.equal(stage, promotionStage);
    assert.equal(record.reviewSupport, 'none');
  }
});

test('review support, structural grade, corpus level, memory tier and promotion stage stay independent', () => {
  const axes = classificationOf(accepted(valid({
    reviewSupport: 'blocked',
    structuralGrade: 'S',
    corpusLevel: 'L0',
    memoryTier: 3,
    promotionStage: 'independent_review',
  })));
  assert.equal(axes.reviewSupport, 'blocked');
  assert.equal(axes.structuralGrade, 'S');
  assert.equal(axes.corpusLevel, 'L0');
  assert.equal(axes.memoryTier, 3);
  assert.equal(axes.promotionStage, 'independent_review');
  assert.deepEqual(Object.keys(axes), [...CLASSIFICATION_FIELDS]);
});

test('kept, applied and effect are distinct; every explicit combination is stored as given', () => {
  for (const kept of [false, true]) {
    for (const applied of [false, true]) {
      for (const effect of [false, true]) {
        const record = accepted(valid({ kept, applied, effect }));
        assert.deepEqual(lifecycleOf(record), { kept, applied, effect });
      }
    }
  }
});

test('kept true does not set applied or effect', () => {
  const record = accepted(valid({ kept: true, applied: false, effect: false }));
  assert.equal(record.kept, true);
  assert.equal(record.applied, false);
  assert.equal(record.effect, false);
  assert.deepEqual(lifecycleOf(record), { kept: true, applied: false, effect: false });
});

test('applied and effect cannot be inferred from kept when those fields are omitted', () => {
  const issues = rejected({
    reviewSupport: 'supported',
    structuralGrade: 'A',
    corpusLevel: 'L2',
    memoryTier: 3,
    promotionStage: 'promoted',
    kept: true,
  });
  const applied = issues.find(issue => issue.field === 'applied');
  const effect = issues.find(issue => issue.field === 'effect');
  assert.equal(applied?.code, 'missing_field');
  assert.equal(effect?.code, 'missing_field');
  assert.match(applied?.message ?? '', /cannot be inferred from kept/);
  assert.match(effect?.message ?? '', /cannot be inferred from kept/);
  assert.equal(issues.some(issue => issue.field === 'kept'), false);
});

test('omitting only applied still refuses inference from kept', () => {
  const rec: Record<string, unknown> = { ...valid({ kept: true, effect: false }) };
  delete rec.applied;
  const issues = rejected(rec);
  assert.equal(issues.some(issue => issue.field === 'applied' && issue.code === 'missing_field'), true);
  assert.match(issues.find(issue => issue.field === 'applied')?.message ?? '', /cannot be inferred from kept/);
});

test('applied true with kept false is valid; effect true with kept false is valid', () => {
  assert.deepEqual(lifecycleOf(accepted(valid({ kept: false, applied: true, effect: false }))), {
    kept: false, applied: true, effect: false,
  });
  assert.deepEqual(lifecycleOf(accepted(valid({ kept: false, applied: false, effect: true }))), {
    kept: false, applied: false, effect: true,
  });
});

test('each required field is refused when missing', () => {
  for (const field of [...CLASSIFICATION_FIELDS, ...LIFECYCLE_FIELDS]) {
    const rec: Record<string, unknown> = { ...valid() };
    delete rec[field];
    fail(rec, field, 'missing_field');
  }
});

test('invalid values on each field are refused', () => {
  fail(valid({ reviewSupport: 'approved' as never }), 'reviewSupport', 'invalid_value');
  fail(valid({ reviewSupport: 'A' as never }), 'reviewSupport', 'invalid_value');
  fail(valid({ structuralGrade: 'UNGRADED' as never }), 'structuralGrade', 'invalid_value');
  fail(valid({ structuralGrade: 'blocked' as never }), 'structuralGrade', 'invalid_value');
  fail(valid({ corpusLevel: 'L3' as never }), 'corpusLevel', 'invalid_value');
  fail(valid({ corpusLevel: 0 as never }), 'corpusLevel', 'invalid_value');
  fail(valid({ memoryTier: 4 as never }), 'memoryTier', 'invalid_value');
  fail(valid({ memoryTier: 1.5 as never }), 'memoryTier', 'invalid_value');
  fail(valid({ memoryTier: 'L1' as never }), 'memoryTier', 'invalid_value');
  fail(valid({ promotionStage: 'independent review' as never }), 'promotionStage', 'invalid_value');
  fail(valid({ promotionStage: 'supported' as never }), 'promotionStage', 'invalid_value');
  fail(valid({ kept: 1 as never }), 'kept', 'invalid_value');
  fail(valid({ applied: 'true' as never }), 'applied', 'invalid_value');
  fail(valid({ effect: 0 as never }), 'effect', 'invalid_value');
});

test('collapsed aliases that would mix axes or infer lifecycle are refused', () => {
  for (const alias of COLLAPSED_ALIASES) {
    fail({ ...valid(), [alias]: 'kept' }, alias, 'collapsed_field');
  }
  const issues = rejected({ status: 'kept', grade: 'A', level: 2 });
  assert.equal(issues.some(issue => issue.code === 'collapsed_field' && issue.field === 'status'), true);
  assert.equal(issues.some(issue => issue.code === 'collapsed_field' && issue.field === 'grade'), true);
  assert.equal(issues.some(issue => issue.code === 'collapsed_field' && issue.field === 'level'), true);
  assert.equal(issues.some(issue => issue.field === 'reviewSupport' && issue.code === 'missing_field'), true);
  assert.equal(issues.some(issue => issue.field === 'applied' && issue.code === 'missing_field'), true);
});

test('unknown fields are refused', () => {
  fail({ ...valid(), letter: 'A' }, 'letter', 'unknown_field');
  fail({ ...valid(), review_support: 'none' }, 'review_support', 'unknown_field');
});

test('non-objects are refused', () => {
  for (const input of [null, undefined, true, 0, 'kept', [valid()]]) {
    const issues = rejected(input);
    assert.equal(issues[0]?.code, 'not_object');
  }
});

test('JSON round-trip preserves separate fields and does not promote kept to applied', () => {
  const source = valid({ kept: true, applied: false, effect: false, memoryTier: 3, corpusLevel: 'L2' });
  const record = accepted(JSON.parse(JSON.stringify(source)) as unknown);
  assert.deepEqual(record, source);
  assert.equal(record.applied, false);
  assert.equal(record.effect, false);
});
