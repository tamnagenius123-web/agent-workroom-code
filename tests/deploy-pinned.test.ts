import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only the public deployment wrapper is executed. npm/npx are local shims;
// no real build, Wrangler, D1, deployment, credentials, or network calls run.
const wrapper = fileURLToPath(new URL('../scripts/deploy-pinned.sh', import.meta.url));
const config = '{ "name": "agent-workroom-main" }\n';
const build = ['npm', 'run', 'build'];
const snapshot = ['npx', '--yes', 'wrangler@4.152.0', 'd1', 'time-travel', 'info', 'agent-workroom-test'];
const migrate = ['npx', '--yes', 'wrangler@4.152.0', 'd1', 'migrations', 'apply', 'agent-workroom-test', '--remote'];
const deploy = ['npx', '--yes', 'wrangler@4.152.0', 'deploy'];
type Stage = 'build' | 'snapshot' | 'migrate' | 'deploy';
const exitCodes: Record<Stage, number> = { build: 17, snapshot: 18, migrate: 19, deploy: 20 };

const shim = `#!/bin/bash
set -euo pipefail
printf '%s\\0' "\${0##*/}" "$@" >> "$COMMAND_LOG"
printf '\\n' >> "$COMMAND_LOG"
case "\${0##*/}:$*" in
  'npm:run build') phase=build; code=17 ;;
  'npx:--yes wrangler@4.152.0 d1 time-travel info agent-workroom-test') phase=snapshot; code=18 ;;
  'npx:--yes wrangler@4.152.0 d1 migrations apply agent-workroom-test --remote') phase=migrate; code=19 ;;
  'npx:--yes wrangler@4.152.0 deploy'*) phase=deploy; code=20 ;;
  *) exit 97 ;;
esac
if [[ "\${FAIL_AT:-}" == "$phase" ]]; then exit "$code"; fi
`;

function run(options: { failAt?: Stage; args?: string[]; configuration?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-order-test-'));
  try {
    const bin = join(root, 'bin'); mkdirSync(bin);
    const home = join(root, 'home'); mkdirSync(home);
    const log = join(root, 'commands.log');
    for (const name of ['npm', 'npx']) writeFileSync(join(bin, name), shim, { mode: 0o755 });
    // The wrapper uses grep for its existing config guards. Everything else
    // available in PATH is a shim, so a real package manager cannot be reached.
    symlinkSync('/usr/bin/grep', join(bin, 'grep'));
    const configuration = options.configuration === undefined ? config : options.configuration;
    if (configuration !== null) writeFileSync(join(root, 'wrangler.jsonc'), configuration);
    const result = spawnSync('/bin/bash', [wrapper, ...(options.args ?? [])], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      // Deliberately do not inherit process.env, including auth/config hooks.
      env: { PATH: bin, HOME: home, TMPDIR: root, LC_ALL: 'C', COMMAND_LOG: log, FAIL_AT: options.failAt ?? '' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    const calls = existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.split('\0').slice(0, -1))
      : [];
    return { status: result.status, stderr: result.stderr, calls };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('build precedes every D1 command and deploy follows migrations', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [build, snapshot, migrate, deploy]);
});

test('build failure runs no D1 or deployment command and preserves its exit status', () => {
  const result = run({ failAt: 'build' });
  assert.equal(result.status, exitCodes.build);
  assert.deepEqual(result.calls, [build]);
});

test('time-travel failure still stops migrations and deployment', () => {
  const result = run({ failAt: 'snapshot' });
  assert.equal(result.status, exitCodes.snapshot);
  assert.deepEqual(result.calls, [build, snapshot]);
});

test('migration failure never reaches deployment', () => {
  const result = run({ failAt: 'migrate' });
  assert.equal(result.status, exitCodes.migrate);
  assert.deepEqual(result.calls, [build, snapshot, migrate]);
});

test('deployment failure is returned after the successful prerequisites', () => {
  const result = run({ failAt: 'deploy' });
  assert.equal(result.status, exitCodes.deploy);
  assert.deepEqual(result.calls, [build, snapshot, migrate, deploy]);
});

for (const args of [['--env', 'fixture'], ['--env=fixture'], ['-e', 'fixture']]) {
  test(`existing environment guard refuses ${args[0]} before any command`, () => {
    const result = run({ args });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /REFUSED: --env is forbidden/);
    assert.deepEqual(result.calls, []);
  });
}

test('wrong worker name refuses before build or D1 commands', () => {
  const result = run({ configuration: '{ "name": "synthetic-other-worker" }\n' });
  assert.equal(result.status, 65);
  assert.deepEqual(result.calls, []);
});

test('an env section refuses before build or D1 commands', () => {
  const result = run({ configuration: '{ "name": "agent-workroom-main", "env": {} }\n' });
  assert.equal(result.status, 66);
  assert.deepEqual(result.calls, []);
});

test('missing config refuses before build or D1 commands', () => {
  const result = run({ configuration: null });
  assert.equal(result.status, 65);
  assert.deepEqual(result.calls, []);
});

test('deployment arguments retain their exact boundaries and reach deploy only', () => {
  const args = ['--dry-run', '--outdir', 'synthetic output'];
  const result = run({ args });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, [build, snapshot, migrate, [...deploy, ...args]]);
});
