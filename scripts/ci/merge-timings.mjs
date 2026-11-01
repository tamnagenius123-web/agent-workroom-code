#!/usr/bin/env node
// Merge per-shard test-timings artifacts into one .cache/test-timings.json.
// Usage: node scripts/ci/merge-timings.mjs <dir-with-artifact-subdirs> [out]
// Each shard job uploads its own .cache/test-timings.json (only its files).
// For a file measured by several shards the median wins, so one contention-
// inflated measurement cannot poison the balance plan (council B-H3).
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const root = process.argv[2];
const out = process.argv[3] || '.cache/test-timings.json';
if (!root) { console.error('[merge-timings] usage: merge-timings.mjs <dir> [out]'); process.exit(2); }

const byFile = new Map();
const subs = existsSync(root) ? readdirSync(root) : [];
if (!subs.length) console.error(`[merge-timings] no shard artifacts under ${root} (test shards did not run?)`);
for (const sub of subs) {
  const p = join(root, sub, 'test-timings.json');
  if (!existsSync(p)) continue;
  let map;
  try { map = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
  for (const [f, ms] of Object.entries(map)) {
    if (typeof ms !== 'number') continue;
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(ms);
  }
}
const merged = {};
for (const [f, vals] of byFile) {
  vals.sort((a, b) => a - b);
  merged[f] = vals[Math.floor(vals.length / 2)];
}
if (!Object.keys(merged).length) {
  console.error('[merge-timings] nothing to merge; leaving any existing timings file untouched');
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(merged, null, 1));
}
console.error(`[merge-timings] ${Object.keys(merged).length} file(s) -> ${out}`);
