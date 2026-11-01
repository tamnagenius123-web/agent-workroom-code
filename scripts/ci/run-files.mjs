#!/usr/bin/env node
// Run an explicit list of test files through the shared parallel runner.
// Used by the sharded full-suite jobs on main push: scripts/ci/plan-shards.mjs
// decides the lists, this wrapper only executes one of them.
// Usage: node scripts/ci/run-files.mjs --files a.test.ts,b.test.ts [--build]
// Without --build the caller must have built dist/ already (CI runs npm run build
// first). With --build the runner builds dist/ lazily, like test-select does.
import { runTests } from '../test-run.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--files');
const list = i >= 0 && args[i + 1] ? args[i + 1].split(',').filter(Boolean) : [];
if (!list.length) { console.error('[run-files] no --files given'); process.exit(2); }
const build = args.includes('--build');
console.error(`[run-files] ${list.length} file(s)${build ? ' (lazy dist build on)' : ''}`);
process.exit(await runTests(list, { needsBuild: () => build }));
