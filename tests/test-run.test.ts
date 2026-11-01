import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runTests } from '../scripts/test-run.mjs';

// Regression (Muse HOLD on 2010200): a runner child killed by a signal exits with code null; it must count as failure.
test('scheduler treats a signal-killed runner (exit code null) as failure', async () => {
  const code = await runTests(['tests/fixtures/runner/kills-parent-runner.ts']);
  assert.equal(code, 1);
});
