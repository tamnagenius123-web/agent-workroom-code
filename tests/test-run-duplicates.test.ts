import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function runDuplicateFixture(sequence: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'workroom-runner-duplicates-'));
  try {
    mkdirSync(join(cwd, 'scripts', 'ci'), { recursive: true });
    mkdirSync(join(cwd, 'tests'));
    mkdirSync(join(cwd, 'tmp'));
    copyFileSync(join(root, 'scripts', 'test-run.mjs'), join(cwd, 'scripts', 'test-run.mjs'));
    copyFileSync(join(root, 'scripts', 'ci', 'run-files.mjs'), join(cwd, 'scripts', 'ci', 'run-files.mjs'));
    symlinkSync(realpathSync(join(root, 'node_modules')), join(cwd, 'node_modules'), 'dir');
    writeFileSync(join(cwd, 'sequence.json'), JSON.stringify(sequence));
    writeFileSync(join(cwd, 'tests', 'repeated.test.ts'), `
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
const attempt = existsSync('attempt.txt') ? Number(readFileSync('attempt.txt', 'utf8')) + 1 : 1;
writeFileSync('attempt.txt', String(attempt));
const sequence = JSON.parse(readFileSync('sequence.json', 'utf8'));
test('synthetic attempt ' + attempt, () => assert.equal(sequence[attempt - 1], 'pass'));
`);
    const env = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TZ: 'UTC', LC_ALL: 'C', TMPDIR: join(cwd, 'tmp'),
      TSX_DISABLE_CACHE: '1', TEST_CONCURRENCY: '1', TEST_FILE_TIMEOUT_MS: '5000',
    };
    const files = sequence.map(() => 'tests/repeated.test.ts').join(',');
    const result = spawnSync(process.execPath,
      ['scripts/ci/run-files.mjs', '--files', files],
      { cwd, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    return {
      sequence, status: result.status, signal: result.signal,
      stdout: result.stdout, stderr: result.stderr,
      attempts: existsSync(join(cwd, 'attempt.txt')) ? Number(readFileSync(join(cwd, 'attempt.txt'), 'utf8')) : 0,
      timingCache: existsSync(join(cwd, '.cache', 'test-timings.json')),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const [name, sequence, expectedStatus] of [
  ['failure then success stays failed', ['fail', 'pass'], 1],
  ['success then failure stays failed', ['pass', 'fail'], 1],
  ['two successes stay successful without deduplication', ['pass', 'pass'], 0],
] as const) {
  test(`duplicate explicit file: ${name}`, (t) => {
    const result = runDuplicateFixture([...sequence]);
    t.diagnostic('OBSERVATION ' + JSON.stringify(result));
    assert.equal(result.attempts, 2, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.timingCache, true);
    assert.equal(result.status, expectedStatus, result.stderr);
  });
}
