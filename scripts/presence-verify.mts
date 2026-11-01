// Verification bundle for the presence/activity projection unit
// (pstack create-verification-skill applied): ONE command that runs the
// targeted tests, the repo typecheck, and one fixture end-to-end through
// the real CLI, then emits evidence JSON with counts and durations.
// No full test suite, no network. Usage:
//   npx tsx scripts/presence-verify.mts [--out <evidence.json>]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

interface StepResult { cmd: string; exit: number; duration_ms: number; pass: boolean; detail: string }

function run(cmd: string, args: string[]): { exit: number; duration_ms: number; out: string } {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { exit: r.status ?? 1, duration_ms: Date.now() - t0, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

const steps: StepResult[] = [];

// 1) targeted tests only (never the full suite on the shared host)
const tests = run(process.execPath, ['--import', 'tsx', '--test', '--test-reporter=tap', 'tests/presence.test.ts']);
const summary = (label: string): number =>
  Number(new RegExp(`(?:#|ℹ) ${label} (\\d+)`).exec(tests.out)?.[1] ?? 0);
const testCount = summary('tests');
const testPass = summary('pass');
const testFail = summary('fail');
steps.push({
  cmd: 'node --import tsx --test tests/presence.test.ts',
  exit: tests.exit, duration_ms: tests.duration_ms,
  pass: tests.exit === 0 && testFail === 0 && testCount > 0,
  detail: `tests=${testCount} pass=${testPass} fail=${testFail}`,
});

// 2) typecheck
const tsc = run('npx', ['tsc', '--noEmit']);
steps.push({
  cmd: 'npx tsc --noEmit',
  exit: tsc.exit, duration_ms: tsc.duration_ms,
  pass: tsc.exit === 0,
  detail: tsc.exit === 0 ? 'typecheck green' : tsc.out.slice(-500),
});

// 3) fixture end-to-end through the real CLI, both renderings
const e2e = run('npx', ['tsx', 'scripts/presence.mts',
  '--messages', 'tests/fixtures/presence/messages-basic.json',
  '--deliveries', 'tests/fixtures/presence/deliveries-basic.jsonl',
  '--deliveries-agent', 'agent:muse', '--as-of', '2026-11-01T00:00:00.000Z']);
let e2eDetail = '';
let e2ePass = e2e.exit === 0;
try {
  const report = JSON.parse(e2e.out) as { basis?: string; not_wake_proof?: boolean; agents?: unknown[] };
  e2ePass = e2ePass && report.basis === 'activity-evidence' && report.not_wake_proof === true && Array.isArray(report.agents) && report.agents.length === 3;
  e2eDetail = `agents=${Array.isArray(report.agents) ? report.agents.length : '?'} basis=${report.basis} not_wake_proof=${report.not_wake_proof}`;
} catch {
  e2ePass = false;
  e2eDetail = 'CLI output was not JSON';
}
const e2eMd = run('npx', ['tsx', 'scripts/presence.mts',
  '--messages', 'tests/fixtures/presence/messages-basic.json', '--format', 'md',
  '--as-of', '2026-11-01T00:00:00.000Z']);
const mdPass = e2eMd.exit === 0 && e2eMd.out.includes('NOT wake proof') && e2eMd.out.includes('activity-evidence');
steps.push({
  cmd: 'tsx scripts/presence.mts (basic fixtures, json + md)',
  exit: e2e.exit, duration_ms: e2e.duration_ms + e2eMd.duration_ms,
  pass: e2ePass && mdPass,
  detail: `${e2eDetail}; markdown banner ${mdPass ? 'ok' : 'MISSING'}`,
});

const evidence = {
  unit: 'presence-projection',
  basis: 'activity-evidence',
  not_wake_proof: true,
  generated_at: new Date().toISOString(),
  ok: steps.every((s) => s.pass),
  tests: { count: testCount, pass: testPass, fail: testFail },
  total_duration_ms: steps.reduce((n, s) => n + s.duration_ms, 0),
  steps,
};
const text = JSON.stringify(evidence, null, 2);
const outIdx = process.argv.indexOf('--out');
if (outIdx >= 0 && process.argv[outIdx + 1]) writeFileSync(process.argv[outIdx + 1], text + '\n');
console.log(text);
process.exit(evidence.ok ? 0 : 1);
