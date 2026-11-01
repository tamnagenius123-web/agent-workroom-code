#!/usr/bin/env node
// Plan full-suite shards for the main-push CI workflow (D5-cl (3)).
// Reads .cache/test-timings.json (restored by actions/cache in the plan job).
// When recorded times cover at least half the test files, files are bin-packed
// by time (longest first) into 2-4 shards targeting about TARGET_S each.
// Otherwise the plan falls back to a count-balanced split and says so in the
// log: the chosen mode and its reason are part of the run evidence.
// Output: matrix JSON on stdout, plus `matrix=<json>` appended to
// $GITHUB_OUTPUT when that file is set.
import { readdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';

const MAX_SHARDS = 4;
const MIN_SHARDS = 2;
const TARGET_S = 300;
const FALLBACK_SHARDS = 3;

const tests = readdirSync('tests')
  .filter((f) => /^[^/]+\.test\.ts$/.test(f))
  .sort()
  .map((f) => 'tests/' + f);

let timings = {};
let mode = 'count-fallback';
let why = 'no timings file';
if (existsSync('.cache/test-timings.json')) {
  try { timings = JSON.parse(readFileSync('.cache/test-timings.json', 'utf8')); } catch { /* unreadable counts as missing */ }
  const covered = tests.filter((t) => typeof timings[t] === 'number').length;
  if (tests.length && covered / tests.length >= 0.5) {
    mode = 'timings';
    why = `timings cover ${covered}/${tests.length} files`;
  } else {
    why = `timings stale (cover ${covered}/${tests.length} files, under 50%)`;
  }
}

let shards;
if (mode === 'timings') {
  const known = tests.map((t) => timings[t]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] || 5000;
  const weight = (t) => timings[t] ?? median;
  const totalMs = tests.reduce((s, t) => s + weight(t), 0);
  const n = Math.min(MAX_SHARDS, Math.max(MIN_SHARDS, Math.ceil(totalMs / 1000 / TARGET_S)));
  shards = Array.from({ length: n }, () => ({ files: [], estMs: 0 }));
  for (const t of [...tests].sort((a, b) => weight(b) - weight(a))) {
    shards.sort((a, b) => a.estMs - b.estMs);
    shards[0].files.push(t);
    shards[0].estMs += weight(t);
  }
  console.error(`[plan-shards] mode=timings (${why}); total est ${(totalMs / 1000).toFixed(0)}s over ${n} shard(s)`);
} else {
  const n = tests.length > 20 ? FALLBACK_SHARDS : 1;
  shards = Array.from({ length: n }, () => ({ files: [], estMs: 0 }));
  tests.forEach((t, i) => { shards[i % n].files.push(t); });
  console.error(`[plan-shards] mode=count-fallback (${why}); ${tests.length} files over ${n} shard(s)`);
}
shards.forEach((s, i) => console.error(`[plan-shards] shard ${i + 1}: ${s.files.length} files, est ${(s.estMs / 1000).toFixed(0)}s`));

const matrix = { include: shards.map((s, i) => ({ shard: i + 1, files: s.files.join(','), est_s: Math.round(s.estMs / 1000) })) };
const json = JSON.stringify(matrix);
console.log(json);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${json}\n`);
