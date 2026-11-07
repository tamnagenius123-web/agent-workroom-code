import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const selector = process.env.TEST_SELECTOR_UNDER_TEST ?? fileURLToPath(new URL('../scripts/test-select.mjs', import.meta.url));
const checkedInManifest = JSON.parse(readFileSync(new URL('./test-deps.json', import.meta.url), 'utf8'));
const deploymentTest = 'tests/deploy-pinned.test.ts';
const otherTest = 'tests/other.test.ts';
const smokeTest = 'tests/smoke.test.ts';
const wrapper = 'scripts/deploy-pinned.sh';

function select(changed: string[], options: {
  runtime?: unknown;
  omitRuntime?: boolean;
  omitWrapper?: boolean;
  files?: Record<string, string>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workroom-selector-runtime-'));
  try {
    const manifest: Record<string, unknown> = {
      dist: {}, everything: [], wide: ['scripts/test-select.mjs', 'tests/test-deps.json'],
      ignore: ['docs/'], smoke: [smokeTest],
    };
    if (!options.omitRuntime) manifest.runtime = 'runtime' in options ? options.runtime : { [deploymentTest]: [wrapper] };
    const files = {
      [deploymentTest]: "// A fixture whose runtime shell dependency is declared in the manifest.\n",
      [otherTest]: "import '../src/other.ts';\n",
      [smokeTest]: '// A synthetic smoke test.\n',
      'src/other.ts': 'export const value = 1;\n',
      ...(!options.omitWrapper ? { [wrapper]: '#!/bin/sh\ntouch SHOULD_NOT_RUN\nexit 99\n' } : {}),
      ...options.files,
      'tests/test-deps.json': JSON.stringify(manifest),
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const result = spawnSync(process.execPath, [selector, '--files', changed.join(','), '--list'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { PATH: '/usr/bin:/bin', HOME: root, LC_ALL: 'C' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(existsSync(join(root, 'SHOULD_NOT_RUN')), false);
    return { status: result.status, stderr: result.stderr, selected: result.stdout.trim().split('\n').filter(Boolean) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('checked-in manifest declares shell dependency and treats manifest edits as a shared surface', () => {
  assert.deepEqual(checkedInManifest.runtime[deploymentTest], [wrapper]);
  assert.ok(checkedInManifest.wide.includes('tests/test-deps.json'));
  assert.ok(!checkedInManifest.ignore.includes('tests/test-deps.json'));
});

test('shell-only change selects its deployment regression without executing the shell', () => {
  const result = select([wrapper]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.selected, [deploymentTest]);
});

test('deleted shell dependency still selects its regression', () => {
  const result = select([wrapper], { omitWrapper: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.selected, [deploymentTest]);
});

test('changed test still selects itself and duplicate runtime links do not duplicate tests', () => {
  const result = select([deploymentTest, wrapper], { runtime: { [deploymentTest]: [wrapper, wrapper] } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.selected, [deploymentTest]);
});

test('unrelated documentation retains the existing smoke fallback', () => {
  const result = select(['docs/readme.md']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.selected, [smokeTest]);
});

test('runtime manifest edit selects every fixture test', () => {
  const result = select(['tests/test-deps.json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.selected, [deploymentTest, otherTest, smokeTest]);
});

test('declared runtime edges participate in transitive import reachability', () => {
  const result = select([wrapper], {
    runtime: { 'scripts/helper.mjs': [wrapper] },
    files: { [deploymentTest]: "import '../scripts/helper.mjs';\n", 'scripts/helper.mjs': 'export const helper = true;\n' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.selected, [deploymentTest]);
});

test('absent runtime configuration preserves existing import selection', () => {
  const result = select(['src/other.ts'], { omitRuntime: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.selected, [otherTest]);
});

for (const owner of ['src/a.ts', 'src/b.ts']) {
  test(`runtime reachability is complete across an import cycle owned by ${owner}`, () => {
    const result = select([wrapper], {
      runtime: { [owner]: [wrapper] },
      files: {
        [deploymentTest]: "import '../src/a.ts';\n", [otherTest]: "import '../src/b.ts';\n",
        'src/a.ts': "import './b.ts';\n", 'src/b.ts': "import './a.ts';\n",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.selected, [deploymentTest, otherTest]);
  });
}

test('explicit runtime dependencies override the ordinary documentation ignore rule', () => {
  const result = select(['docs/runtime.json'], { runtime: { [deploymentTest]: ['docs/runtime.json'] } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.selected, [deploymentTest]);
});

for (const runtime of [null, false, [], { [deploymentTest]: wrapper }, { [deploymentTest]: [null] }]) {
  test(`invalid runtime mapping fails closed: ${JSON.stringify(runtime)}`, () => {
    const result = select([wrapper], { runtime });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid runtime dependency/);
    assert.deepEqual(result.selected, []);
  });
}

for (const path of ['../outside.sh', '/tmp/outside.sh', 'scripts/../outside.sh', 'scripts\\outside.sh', 'scripts//outside.sh', 'scripts/./outside.sh']) {
  test(`non-canonical runtime dependency is rejected: ${path}`, () => {
    const result = select([wrapper], { runtime: { [deploymentTest]: [path] } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid runtime dependency/);
  });
}

test('unknown owner is rejected rather than silently losing coverage', () => {
  const result = select([wrapper], { runtime: { 'tests/typo.test.ts': [wrapper] } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid runtime dependency owner/);
});
