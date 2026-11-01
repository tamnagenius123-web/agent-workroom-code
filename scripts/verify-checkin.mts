#!/usr/bin/env tsx
// verify-checkin — one-command verification bundle for the check-in
// projection unit (pstack create-verification-skill applied).
//
//   tsx scripts/verify-checkin.mts [--out evidence.json]
//
// Runs, in order: tsc --noEmit, the unit's targeted tests, and a fixture
// end-to-end pass through the real CLI for every fixture snapshot. Emits
// an evidence JSON (stdout, or --out) with per-step exit codes, test
// counts and durations, so a non-author verifier needs this one command
// plus spot-checks. Targeted tests only — never the full suite.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outArg = (() => {
  const i = argv.indexOf('--out');
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : null;
})();

interface Step {
  name: string;
  cmd: string;
  exitCode: number;
  durationMs: number;
  detail?: string;
}

function run(name: string, args: string[]): Step & { stdout: string } {
  const started = Date.now();
  const res = spawnSync('npx', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return {
    name,
    cmd: `npx ${args.join(' ')}`,
    exitCode: res.status ?? 1,
    durationMs: Date.now() - started,
    stdout: `${res.stdout ?? ''}${res.stderr ?? ''}`,
  };
}

const steps: Step[] = [];

const tsc = run('typecheck', ['tsc', '--noEmit']);
steps.push({ name: tsc.name, cmd: tsc.cmd, exitCode: tsc.exitCode, durationMs: tsc.durationMs });

const tests = run('targeted-tests', ['tsx', '--test', 'tests/checkin.test.ts']);
const passMatch = /ℹ pass (\d+)/.exec(tests.stdout);
const failMatch = /ℹ fail (\d+)/.exec(tests.stdout);
steps.push({
  name: tests.name,
  cmd: tests.cmd,
  exitCode: tests.exitCode,
  durationMs: tests.durationMs,
  detail: `pass ${passMatch?.[1] ?? '?'} / fail ${failMatch?.[1] ?? '?'}`,
});

const fixtureDir = join(root, 'tests', 'fixtures', 'checkin');
const fixtureNames = (await readdir(fixtureDir)).filter((f) => f.endsWith('.json')).sort();
const evidenceDir = await mkdtemp(join(tmpdir(), 'checkin-verify-'));
const fixtures: { fixture: string; exitCode: number; durationMs: number; status?: string; awaiting?: number }[] = [];
for (const name of fixtureNames) {
  const outJson = join(evidenceDir, name.replace(/\.json$/, '.brief.json'));
  const step = run(`e2e:${name}`, [
    'tsx',
    'scripts/checkin.mts',
    join('tests', 'fixtures', 'checkin', name),
    '--actor',
    'agent:muse',
    '--now',
    '2026-11-01T01:35:00.000Z',
    '--out',
    outJson,
  ]);
  let status: string | undefined;
  let awaiting: number | undefined;
  if (step.exitCode === 0) {
    try {
      const brief = JSON.parse(readFileSync(outJson, 'utf8')) as {
        header: { status: string };
        summary: { awaitingReviews: number };
      };
      status = brief.header.status;
      awaiting = brief.summary.awaitingReviews;
    } catch {
      status = '(brief unreadable)';
    }
  }
  fixtures.push({ fixture: name, exitCode: step.exitCode, durationMs: step.durationMs, status, awaiting });
  steps.push({ name: step.name, cmd: step.cmd, exitCode: step.exitCode, durationMs: step.durationMs });
}

const ok = steps.every((s) => s.exitCode === 0);
const evidence = {
  unit: 'checkin-projection',
  generatedAt: new Date().toISOString(),
  ok,
  steps,
  fixtures,
  totals: {
    steps: steps.length,
    failedSteps: steps.filter((s) => s.exitCode !== 0).length,
    testsPass: passMatch ? Number(passMatch[1]) : null,
    testsFail: failMatch ? Number(failMatch[1]) : null,
    durationMs: steps.reduce((acc, s) => acc + s.durationMs, 0),
  },
};
const text = JSON.stringify(evidence, null, 2);
if (outArg) await writeFile(outArg, `${text}\n`, 'utf8');
console.log(text);
process.exit(ok ? 0 : 1);
