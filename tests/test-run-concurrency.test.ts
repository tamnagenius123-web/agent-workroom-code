import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function runFixture(value: string | undefined) {
  const cwd = mkdtempSync(join(tmpdir(), 'workroom-runner-slots-'));
  try {
    mkdirSync(join(cwd, 'scripts', 'ci'), { recursive: true });
    mkdirSync(join(cwd, 'tests'));
    mkdirSync(join(cwd, 'tmp'));
    copyFileSync(join(root, 'scripts', 'test-run.mjs'), join(cwd, 'scripts', 'test-run.mjs'));
    copyFileSync(join(root, 'scripts', 'ci', 'run-files.mjs'), join(cwd, 'scripts', 'ci', 'run-files.mjs'));
    symlinkSync(realpathSync(join(root, 'node_modules')), join(cwd, 'node_modules'), 'dir');
    writeFileSync(join(cwd, 'tests', 'synthetic.test.ts'), `
import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('synthetic child executes', () => appendFileSync('child-marker.txt', 'one\\n'));
`);
    const env: NodeJS.ProcessEnv = {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      TZ: 'UTC', LC_ALL: 'C', TMPDIR: join(cwd, 'tmp'),
      TSX_DISABLE_CACHE: '1', TEST_FILE_TIMEOUT_MS: '5000',
    };
    if (value !== undefined) env.TEST_CONCURRENCY = value;
    const result = spawnSync(process.execPath,
      ['scripts/ci/run-files.mjs', '--files', 'tests/synthetic.test.ts'],
      { cwd, env, encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.error, undefined, result.error?.message);
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      marker: existsSync(join(cwd, 'child-marker.txt')) ? readFileSync(join(cwd, 'child-marker.txt'), 'utf8') : '',
      timingCache: existsSync(join(cwd, '.cache', 'test-timings.json')),
    };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const value of ['-1', '1.5', 'Infinity']) {
  test(`runner rejects effective non-positive/non-integer slots: ${value}`, () => {
    const result = runFixture(value);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.signal, null);
    assert.match(result.stderr, /TEST_CONCURRENCY must resolve to a positive integer/);
    assert.equal(result.marker, '');
    assert.equal(result.timingCache, false);
  });
}

for (const [name, value] of [
  ['current CI four', '4'], ['zero auto fallback', '0'],
  ['unset auto fallback', undefined], ['empty auto fallback', ''],
  ['legacy NaN auto fallback', 'not-a-number'],
] as const) {
  test(`runner preserves ${name}`, () => {
    const result = runFixture(value);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
    assert.equal(result.marker, 'one\n');
    assert.equal(result.timingCache, true);
    assert.match(result.stderr, /1 file\(s\).*0 failed/);
  });
}
