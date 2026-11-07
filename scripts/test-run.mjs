// Parallel test scheduler. One child process per test file, pool = os.availableParallelism().
// Files that cannot share the machine declare lock keys in tests/test-exclusive.json; they wait in a
// ready queue and dispatch the instant a slot AND their locks are free. Longest-first using cached timings.
// dist/ build overlaps with tests that do not need it.
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const TIMINGS = '.cache/test-timings.json';
export async function runTests(list, { needsBuild = () => false } = {}) {
  const slots = Number(process.env.TEST_CONCURRENCY) || availableParallelism();
  // Preserve the existing auto fallback, but reject unusable effective sizes
  // before reading scheduling metadata or starting builds/tests.
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error('TEST_CONCURRENCY must resolve to a positive integer');
  }
  const excl = existsSync('tests/test-exclusive.json') ? JSON.parse(readFileSync('tests/test-exclusive.json', 'utf8')).files ?? {} : {};
  const past = existsSync(TIMINGS) ? JSON.parse(readFileSync(TIMINGS, 'utf8')) : {};
  const locksOf = (f) => excl[f]?.locks ?? [];
  const held = new Set();
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT; // each child is a top-level runner, even when runTests runs under node --test
  let built = !list.some(needsBuild), building = null;
  const queue = [...list].sort((a, b) => (past[b] ?? 1e9) - (past[a] ?? 1e9));
  const results = new Map(); let running = 0; const t0 = Date.now();
  const ensureBuild = () => building ??= new Promise((res, rej) => {
    const b = spawn(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
    b.on('exit', (c) => c !== 0 ? rej(new Error('build failed ' + c)) : (built = true, res()));
  });
  if (!built) { console.error('[test-run] building dist/ in parallel with build-free tests'); running++; }
  return new Promise((resolve) => {
    if (!built) ensureBuild().then(() => { running--; pump(); }, (e) => { console.error(e.message); process.exit(1); });
    function pump() {
      for (let i = 0; i < queue.length && running < slots;) {
        const f = queue[i];
        if ((needsBuild(f) && !built) || locksOf(f).some((k) => held.has(k))) { i++; continue; }
        queue.splice(i, 1); start(f);
      }
      if (!queue.length && !running) finish();
    }
    function start(f) {
      running++; locksOf(f).forEach((k) => held.add(k));
      const s = Date.now(); let out = '';
      const c = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-force-exit', '--test-reporter=tap', f], { env: childEnv });
      const perFile = Number(process.env.TEST_FILE_TIMEOUT_MS) || 0; // CI sets this; a hung file is killed and fails
      const killer = perFile ? setTimeout(() => c.kill('SIGKILL'), perFile) : null;
      c.stdout.on('data', (d) => out += d); c.stderr.on('data', (d) => out += d);
      c.on('exit', (code, signal) => {
        if (killer) clearTimeout(killer);
        const ms = Date.now() - s;
        const previous = results.get(f);
        // Repeated explicit paths still run; a later success must not erase a failed attempt.
        results.set(f, { code: previous && previous.code !== 0 ? previous.code : code, ms });
        if (signal) out += `\n[test-run] runner killed by ${signal}\n`; past[f] = ms;
        const tests = /# tests (\d+)/.exec(out)?.[1] ?? '?';
        console.error(`${code !== 0 ? 'FAIL' : 'ok  '} ${f}  ${tests} tests  ${(ms / 1000).toFixed(1)}s`);
        if (code !== 0) process.stderr.write(out);
        running--; locksOf(f).forEach((k) => held.delete(k)); pump();
      });
    }
    function finish() {
      mkdirSync('.cache', { recursive: true }); writeFileSync(TIMINGS, JSON.stringify(past, null, 1));
      const failed = [...results].filter(([, r]) => r.code !== 0); // null = killed by signal: failure
      console.error(`[test-run] ${results.size} file(s), ${slots} slots, wall ${((Date.now() - t0) / 1000).toFixed(1)}s, ${failed.length} failed`);
      resolve(failed.length ? 1 : 0);
    }
    pump();
  });
}
