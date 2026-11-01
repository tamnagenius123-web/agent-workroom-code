// V3-7 slice 1, Dots criteria 16644c4f / a8af1a47: the advisory reports a static
// tests-before-src commit order only. It never reports RED and never auto-passes
// cases it cannot decide from commit metadata.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commitsFromLog, testOrder, testOrderLogArgs } from '../scripts/ci/test-order.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const P = 'f'.repeat(40);
type Change = { status: string; paths: string[] };
const add = (p: string): Change => ({ status: 'A', paths: [p] });
const mod = (p: string): Change => ({ status: 'M', paths: [p] });
const del = (p: string): Change => ({ status: 'D', paths: [p] });
const ren = (from: string, to: string): Change => ({ status: 'R100', paths: [from, to] });
const c = (sha: string, changes: Change[], parents = [P]) => ({ sha, parents, subject: 'x', changes });

test('test-order: a commit adding a test before the code commit is tests-before-src, never a RED claim', () => {
  const r = testOrder([c(A, [add('tests/x.test.ts')]), c(B, [mod('src/x.ts'), mod('decisions.tsv')])]);
  assert.equal(r.order, 'tests-before-src');
  assert.deepEqual(r.reasons, []);
  assert.ok(!('red' in r) && !('pass' in r));
});

test('test-order: code before the first test commit is src-before-tests with its sha', () => {
  const r = testOrder([c(A, [mod('src/x.ts')]), c(B, [add('tests/x.test.ts')]), c(C, [mod('src/x.ts')])]);
  assert.equal(r.order, 'src-before-tests');
  assert.match(r.reasons.join(' '), /aaaaaaa/);
});

test('test-order: code outside src/scripts/migrations counts as code (packages/agent, root worker.js, config)', () => {
  for (const f of ['packages/agent/index.ts', 'worker.js', 'package.json', '.github/workflows/ci.yml'])
    assert.equal(testOrder([c(A, [mod(f)]), c(B, [add('tests/x.test.ts')])]).order, 'src-before-tests', f);
  assert.equal(testOrder([c(A, [mod('worker.js')])]).order, 'src-before-tests');
});

test('test-order: docs/decisions-only and tests-only ranges are no-code', () => {
  assert.equal(testOrder([c(A, [mod('docs/a.md'), mod('decisions.tsv'), mod('README.md')])]).order, 'no-code');
  assert.equal(testOrder([c(A, [add('tests/x.test.ts')])]).order, 'no-code');
  assert.equal(testOrder([]).order, 'no-code');
});

test('test-order: same commit adding the test and changing code is uncertain, even with later code commits', () => {
  assert.equal(testOrder([c(A, [add('tests/x.test.ts'), mod('src/x.ts')])]).order, 'uncertain');
  const r = testOrder([c(A, [add('tests/x.test.ts'), mod('src/x.ts')]), c(B, [mod('scripts/y.mjs')])]);
  assert.equal(r.order, 'uncertain');
  assert.match(r.reasons.join(' '), /aaaaaaa.*also changes code/);
});

test('test-order: a first test commit that only modifies existing tests is uncertain', () => {
  const r = testOrder([c(A, [mod('tests/x.test.ts')]), c(B, [mod('src/x.ts')])]);
  assert.equal(r.order, 'uncertain');
  assert.match(r.reasons.join(' '), /no new test file/);
});

test('test-order: deleting a test then changing code is uncertain', () => {
  assert.equal(testOrder([c(A, [del('tests/x.test.ts')]), c(B, [mod('src/x.ts')])]).order, 'uncertain');
});

test('test-order: renames are uncertain (test -> test, and test -> src)', () => {
  assert.equal(testOrder([c(A, [ren('tests/a.test.ts', 'tests/b.test.ts')]), c(B, [mod('src/x.ts')])]).order, 'uncertain');
  assert.equal(testOrder([c(A, [ren('tests/x.test.ts', 'src/x.ts')]), c(B, [mod('scripts/y.mjs')])]).order, 'uncertain');
});

test('test-order: any merge commit in range is uncertain, including a range whose only change is a merge', () => {
  const r = testOrder([c(A, [add('tests/x.test.ts')]), c(B, [mod('src/x.ts')]), c(C, [], [P, A])]);
  assert.equal(r.order, 'uncertain');
  assert.match(r.reasons.join(' '), /merge commit ccccccc/);
  assert.equal(testOrder([c(C, [], [P, A])]).order, 'uncertain');
});

test('test-order: shallow history, or an empty log with a non-empty diff, is uncertain', () => {
  const ok = [c(A, [add('tests/x.test.ts')]), c(B, [mod('src/x.ts')])];
  assert.equal(testOrder(ok, { shallow: true }).order, 'uncertain');
  assert.equal(testOrder([], { diffFiles: 3 }).order, 'uncertain');
  assert.equal(testOrder([], { diffFiles: 0 }).order, 'no-code');
});

test('test-order: a test file under src/ is a test, not code', () => {
  assert.equal(testOrder([c(A, [add('src/server/x.test.ts')]), c(B, [mod('src/server/x.ts')])]).order, 'tests-before-src');
});

// Dots afe091c8: code-first plus shallow or merge history must not read as a decided order.
test('test-order: code-first with shallow history, a merge, or a test rename is uncertain and keeps the code-first reason', () => {
  const codeFirst = [c(A, [mod('src/x.ts')]), c(B, [add('tests/x.test.ts')])];
  for (const r of [
    testOrder(codeFirst, { shallow: true }),
    testOrder([...codeFirst, c(C, [], [P, A])]),
    testOrder([c(A, [mod('src/x.ts')]), c(B, [ren('tests/a.test.ts', 'tests/b.test.ts')])]),
  ]) {
    assert.equal(r.order, 'uncertain');
    assert.match(r.reasons[0] ?? '', /code commit aaaaaaa/);
    assert.ok(r.reasons.length >= 2);
  }
  assert.equal(testOrder(codeFirst).order, 'src-before-tests');
});

// Dots afe091c8: path rule. Source files are code wherever they live; test support under tests/ is a test
// path, but only a test source file counts as "a new test".
test('test-order: a source file under docs/ is code; docs prose stays non-code', () => {
  for (const f of ['docs/app.js', 'docs/tool.mjs', 'docs/x.ts', 'docs/run.sh', 'docs/q.sql', 'docs/a.py'])
    assert.equal(testOrder([c(A, [mod(f)]), c(B, [add('tests/x.test.ts')])]).order, 'src-before-tests', f);
  for (const f of ['docs/a.md', 'docs/data.json', 'docs/img.svg', 'docs/notes.txt'])
    assert.equal(testOrder([c(A, [mod(f)])]).order, 'no-code', f);
});

test('test-order: a fixture under tests/ is not code, but adding only a fixture is not a new test', () => {
  assert.equal(testOrder([c(A, [add('tests/x.test.ts'), add('tests/fixtures/sample.json')]), c(B, [mod('src/x.ts')])]).order, 'tests-before-src');
  const r = testOrder([c(A, [add('tests/fixtures/sample.json')]), c(B, [mod('src/x.ts')])]);
  assert.equal(r.order, 'uncertain');
  assert.match(r.reasons.join(' '), /no new test file/);
});

test('commitsFromLog reads sha, parents, subject and per-file status; renames keep both paths', () => {
  const log = `\0${A}\t${P}\tred: x\n\nA\ttests/x.test.ts\n\0${B}\t${A}\tgreen: x\n\nM\tsrc/x.ts\nR100\tsrc/old.ts\tsrc/new.ts\n\0${C}\t${P} ${B}\tMerge x\n`;
  assert.deepEqual(commitsFromLog(log), [
    { sha: A, parents: [P], subject: 'red: x', changes: [add('tests/x.test.ts')] },
    { sha: B, parents: [A], subject: 'green: x', changes: [mod('src/x.ts'), ren('src/old.ts', 'src/new.ts')] },
    { sha: C, parents: [P, B], subject: 'Merge x', changes: [] },
  ]);
  assert.deepEqual(commitsFromLog('M\tsrc/x.ts\n'), []);
  assert.deepEqual(commitsFromLog(''), []);
});

test('testOrderLogArgs: full shas only, oldest first, merges kept, parents printed, no diff drivers', () => {
  const args = testOrderLogArgs(A, B);
  assert.equal(args.at(-1), `${A}..${B}`);
  for (const f of ['--reverse', '--no-ext-diff', '--no-textconv', '--name-status']) assert.ok(args.includes(f), f);
  assert.ok(!args.includes('--no-merges'));
  assert.ok(args.some((a) => a.startsWith('--format=') && a.includes('%P')));
  assert.throws(() => testOrderLogArgs('main', B));
  assert.throws(() => testOrderLogArgs(A, 'feature'));
  assert.equal(testOrderLogArgs(A).at(-1), `${A}..HEAD`);
});

const checkScript = fileURLToPath(new URL('../scripts/ci/check.mjs', import.meta.url));
const gitBin = dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());

// Throwaway repo: a base commit, then each step as a commit. A step is a list of files to
// write ('-path' deletes), or { merge: files } for a side branch off base merged with --no-ff.
type Step = string[] | { merge: string[] };
function runCheck(steps: Step[]) {
  const dir = mkdtempSync(join(tmpdir(), 'test-order-'));
  const env = { PATH: `${gitBin}:/usr/bin:/bin`, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim();
  const write = (files: string[], i: number) => {
    for (const f of files) {
      if (f.startsWith('-')) { unlinkSync(join(dir, f.slice(1))); continue; }
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), `step ${i}\n`);
    }
    git('add', '-A');
  };
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), 'base\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    steps.forEach((s, i) => {
      if (Array.isArray(s)) {
        write(s, i);
        git('commit', '-q', '-m', `step ${i}`);
        return;
      }
      git('checkout', '-q', '-b', `side${i}`, base);
      write(s.merge, i);
      git('commit', '-q', '-m', `side ${i}`);
      git('checkout', '-q', 'main');
      git('merge', '-q', '--no-ff', '-m', `merge ${i}`, `side${i}`);
    });
    const head = git('rev-parse', 'HEAD');
    return spawnSync(process.execPath, [checkScript, base, head], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...env, PR_BODY: 'Tier: D\n\n## Blast radius\nfixture\n', HEAD_SHA: head },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LINE = /tests-before-src static order \(advisory, V3-7\)/;

test('check.mjs: code before test prints src-before-tests, says it is not RED evidence, exit code unchanged', () => {
  const r = runCheck([['src/x.ts', 'decisions.tsv'], ['tests/x.test.ts']]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, LINE);
  assert.match(r.stdout, /src-before-tests/);
  assert.match(r.stdout, /not RED evidence/);
  assert.doesNotMatch(r.stdout, /red-first/);
});

test('check.mjs: test commit then code commit prints tests-before-src with the not-RED note, no PASS wording', () => {
  const r = runCheck([['tests/x.test.ts'], ['src/x.ts', 'decisions.tsv']]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /: tests-before-src/);
  assert.match(r.stdout, /not RED evidence/);
  assert.doesNotMatch(r.stdout, /tests-before-src[^\n]*\bPASS\b/);
});

test('check.mjs: Dots a8af1a47 counterexamples are not tests-before-src', () => {
  // decisions.tsv rides along where src/ changes so the existing policy rule passes and the
  // exit code reflects only the advisory.
  const cases: [string, Step[]][] = [
    ['test+fix in one commit, then unrelated scripts', [['tests/x.test.ts', 'src/x.ts', 'decisions.tsv'], ['scripts/y.mjs']]],
    ['test deleted, then src', [['tests/x.test.ts'], ['-tests/x.test.ts'], ['src/x.ts', 'decisions.tsv']]],
    ['packages/agent before test', [['packages/agent/a.ts'], ['tests/x.test.ts']]],
    ['root worker.js only', [['worker.js']]],
    ['src only inside a merge', [['tests/x.test.ts'], { merge: ['src/x.ts', 'decisions.tsv'] }]],
  ];
  for (const [name, steps] of cases) {
    const r = runCheck(steps);
    assert.equal(r.status, 0, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, LINE, name);
    assert.match(r.stdout, /: (uncertain|src-before-tests)/, name);
  }
});
