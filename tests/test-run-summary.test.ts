import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function runSummaryFixture(outcome: 'pass' | 'fail') {
  const evidence = process.env.WORKROOM_TAP_SUMMARY_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const cwd = mkdtempSync(join(evidence ?? tmpdir(), `workroom-tap-${outcome}-`));
  try {
    mkdirSync(join(cwd, 'scripts', 'ci'), { recursive: true });
    mkdirSync(join(cwd, 'tests'));
    mkdirSync(join(cwd, 'fixtures'));
    mkdirSync(join(cwd, 'tmp'));
    copyFileSync(join(root, 'scripts', 'test-run.mjs'), join(cwd, 'scripts', 'test-run.mjs'));
    copyFileSync(join(root, 'scripts', 'ci', 'run-files.mjs'), join(cwd, 'scripts', 'ci', 'run-files.mjs'));
    symlinkSync(realpathSync(join(root, 'node_modules')), join(cwd, 'node_modules'), 'dir');
    writeFileSync(join(cwd, 'fixtures', 'nested.mjs'), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('one actual nested case', () => assert.equal(1,1));
`);
    writeFileSync(join(cwd, 'tests', 'summary.test.ts'), `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
test('diagnostic quotes actual nested TAP', (t) => {
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const nested = spawnSync(process.execPath, ['--test','--test-reporter=tap','fixtures/nested.mjs'], {env,encoding:'utf8',timeout:5000});
  assert.equal(nested.error,undefined);
  assert.equal(nested.status,0);
  assert.match(nested.stdout,/^# tests 1$/m);
  writeFileSync('nested.stdout.log',nested.stdout);
  t.diagnostic('OBSERVATION '+JSON.stringify({stdout:nested.stdout,stderr:nested.stderr,status:nested.status}));
});
test('second outer case controls actual exit', () => {
  assert.equal(readFileSync('outcome.txt','utf8'),'pass','intentional synthetic outer failure');
});
`);
    writeFileSync(join(cwd, 'outcome.txt'), outcome);
    const paths = ['scripts/test-run.mjs', 'scripts/ci/run-files.mjs', 'fixtures/nested.mjs', 'tests/summary.test.ts', 'outcome.txt'];
    const before = Object.fromEntries(paths.map(path => [path, digest(join(cwd, path))]));
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TZ: 'UTC', LC_ALL: 'C',
      TMPDIR: join(cwd, 'tmp'), TSX_DISABLE_CACHE: '1', TEST_CONCURRENCY: '1', TEST_FILE_TIMEOUT_MS: '10000',
    };
    const argv = ['scripts/ci/run-files.mjs', '--files', 'tests/summary.test.ts'];
    const result = spawnSync(process.execPath, argv, { cwd, env, encoding: 'utf8', timeout: 20_000 });
    const after = Object.fromEntries(paths.map(path => [path, digest(join(cwd, path))]));
    const observation = {
      outcome, cwd, argv, env, status: result.status, signal: result.signal,
      error: result.error?.message ?? null, stdout: result.stdout, stderr: result.stderr,
      nestedTap: existsSync(join(cwd, 'nested.stdout.log')) ? readFileSync(join(cwd, 'nested.stdout.log'), 'utf8') : null,
      fixtureBefore: before, fixtureAfter: after,
      reportedTests: /^(?:ok  |FAIL) tests\/summary\.test\.ts  (\d+|\?) tests /m.exec(result.stderr)?.[1] ?? null,
    };
    if (evidence) writeFileSync(join(evidence, `${outcome}.json`), JSON.stringify(observation, null, 2)+'\n');
    return observation;
  } finally {
    if (!evidence) rmSync(cwd, { recursive: true, force: true });
  }
}

for (const outcome of ['pass', 'fail'] as const) {
  test(`runner reports outer count without changing ${outcome} result`, () => {
    const result = runSummaryFixture(outcome);
    assert.equal(result.error, null);
    assert.equal(result.signal, null);
    assert.deepEqual(result.fixtureAfter, result.fixtureBefore);
    assert.match(result.nestedTap ?? '', /^# tests 1$/m);
    assert.equal(result.status, outcome === 'pass' ? 0 : 1, result.stderr);
    assert.match(result.stderr, new RegExp(`1 file\\(s\\), 1 slots, wall .*${outcome === 'pass' ? 0 : 1} failed`));
    if (outcome === 'fail') {
      assert.match(result.stderr, /intentional synthetic outer failure/);
      assert.match(result.stderr, /^# tests 2$/m);
      assert.match(result.stderr, /^# pass 1$/m);
      assert.match(result.stderr, /^# fail 1$/m);
      assert.match(result.stderr, /# OBSERVATION .*# tests 1/);
    }
    assert.equal(result.reportedTests, '2', 'nested diagnostic count must not replace the outer footer');
  });
}
