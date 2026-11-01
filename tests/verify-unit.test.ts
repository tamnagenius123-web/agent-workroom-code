import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UsageError,
  decideOutcome,
  formatMs,
  parseArgs,
  parseNameOnly,
  parseSelectedTests,
  renderVerdictDraft,
  type StepResult,
} from '../scripts/verify-unit.mts';

const SHA = 'ec500767afa0db6dff60551b352261d4d58d5081';
const BASE_SHA = 'accd2748a3f160e14e1e6225e84e1f5591e67ffa';

function step(over: Partial<StepResult> = {}): StepResult {
  return {
    id: 'pin',
    label: 'pin exact head',
    command: 'git rev-parse HEAD',
    status: 'pass',
    exit: 0,
    ms: 12,
    detail: 'head matches target sha',
    ...over,
  };
}

// ---------- parseArgs ----------

test('parseArgs accepts --branch with defaults', () => {
  const a = parseArgs(['--branch', 'muse/contract-registry', '--unit', 'CONTRACT-REGISTRY']);
  assert.equal(a.branch, 'muse/contract-registry');
  assert.equal(a.sha, null);
  assert.equal(a.unit, 'CONTRACT-REGISTRY');
  assert.equal(a.base, 'origin/main');
  assert.equal(a.keepWorktree, false);
});

test('parseArgs accepts --sha and explicit options', () => {
  const a = parseArgs(['--sha', SHA, '--unit', 'U1', '--base', 'origin/main', '--out', '/tmp/out', '--pr', '128', '--tag', 'TOOLING-DEMO', '--keep-worktree']);
  assert.equal(a.sha, SHA);
  assert.equal(a.branch, null);
  assert.equal(a.outDir, '/tmp/out');
  assert.equal(a.pr, 128);
  assert.equal(a.tag, 'TOOLING-DEMO');
  assert.equal(a.keepWorktree, true);
});

test('parseArgs requires exactly one of --branch/--sha and a --unit', () => {
  assert.throws(() => parseArgs(['--unit', 'U1']), UsageError);
  assert.throws(() => parseArgs(['--branch', 'b', '--sha', SHA, '--unit', 'U1']), UsageError);
  assert.throws(() => parseArgs(['--branch', 'b']), UsageError);
  assert.throws(() => parseArgs(['--sha', 'abc123', '--unit', 'U1']), UsageError); // not a full sha
  assert.throws(() => parseArgs(['--branch', 'b', '--unit', 'U1', '--bogus']), UsageError);
});

test('parseArgs hard-refuses any full-suite request', () => {
  for (const bad of ['--all', '--full', '--suite', 'test:all']) {
    assert.throws(
      () => parseArgs(['--branch', 'b', '--unit', 'U1', bad]),
      (e: unknown) => e instanceof UsageError && /FULL_SUITE_REFUSED/.test(e.message),
      `expected FULL_SUITE_REFUSED for ${bad}`,
    );
  }
});

// ---------- output parsers (fixture diffs / fixture selector output) ----------

test('parseNameOnly trims, drops blanks and dedupes a fixture diff listing', () => {
  const fixture = ['src/contract-registry/registry.ts', '', 'tests/contract-registry.test.ts', 'src/contract-registry/registry.ts', '  decisions.tsv  ', ''].join('\n');
  assert.deepEqual(parseNameOnly(fixture), [
    'src/contract-registry/registry.ts',
    'tests/contract-registry.test.ts',
    'decisions.tsv',
  ]);
});

test('parseSelectedTests keeps only tests/*.test.ts lines from fixture selector output', () => {
  const fixture = [
    'tests/contract-registry.test.ts',
    'tests/contracts.test.ts',
    '[test-select] 7 changed file(s) -> 2/121 test file(s)',
    'src/contract-registry/registry.ts',
    'tests/contract-registry.test.ts',
    'README.md',
  ].join('\n');
  assert.deepEqual(parseSelectedTests(fixture), ['tests/contract-registry.test.ts', 'tests/contracts.test.ts']);
});

// ---------- decideOutcome ----------

test('decideOutcome is GREEN when every executed step passes, listing not-run steps', () => {
  const o = decideOutcome([step(), step({ id: 'tests', status: 'pass' }), step({ id: 'policy', status: 'not-run', exit: null, ms: null })]);
  assert.equal(o.status, 'GREEN');
  assert.deepEqual(o.notRun, ['policy']);
});

test('decideOutcome is FAIL naming the first failing executed step', () => {
  const o = decideOutcome([step(), step({ id: 'typecheck', status: 'fail', exit: 2 }), step({ id: 'tests', status: 'fail', exit: 1 })]);
  assert.equal(o.status, 'FAIL');
  assert.match(o.reason, /typecheck/);
});

test('decideOutcome is COULD_NOT_RUN on runner errors or an unproven pin', () => {
  assert.equal(decideOutcome([step({ id: 'fetch', status: 'error', exit: null })]).status, 'COULD_NOT_RUN');
  assert.equal(decideOutcome([step({ status: 'fail', exit: 1 })]).status, 'COULD_NOT_RUN'); // pin itself failed
  assert.equal(decideOutcome([]).status, 'COULD_NOT_RUN');
});

// ---------- formatting + verdict draft ----------

test('formatMs renders sub-second, seconds and minutes', () => {
  assert.equal(formatMs(null), 'n/a');
  assert.equal(formatMs(250), '0.25s');
  assert.equal(formatMs(12_300), '12.3s');
  assert.equal(formatMs(75_000), '1m15.0s');
});

test('renderVerdictDraft is evidence-only, scoped, and lists NOT_RUN steps', () => {
  const steps = [step(), step({ id: 'tests', status: 'pass', ms: 4200 }), step({ id: 'policy', status: 'not-run', exit: null, ms: null, detail: 'no PR for target' })];
  const md = renderVerdictDraft({
    unit: 'CONTRACT-REGISTRY',
    tag: 'TOOLING-DEMO',
    branch: 'muse/contract-registry',
    sha: SHA,
    base: 'origin/main',
    baseSha: BASE_SHA,
    changedFiles: ['src/contract-registry/registry.ts'],
    selectedTests: ['tests/contract-registry.test.ts'],
    steps,
    outcome: decideOutcome(steps),
    wallMs: 31_000,
    generatedAt: '2026-11-01T00:00:00.000Z',
  });
  assert.match(md, /CONTRACT-REGISTRY/);
  assert.match(md, new RegExp(SHA));
  assert.match(md, /TOOLING-DEMO/);
  assert.match(md, /evidence, not a verdict/i);
  assert.match(md, /NOT_RUN:.*policy/);
  assert.match(md, /tests\/contract-registry\.test\.ts/);
});
