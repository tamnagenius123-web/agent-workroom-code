#!/usr/bin/env node
// Dynamic test selection: changed files -> reverse dependency graph -> affected tests.
// Usage: node scripts/test-select.mjs [--base <ref>] [--files a,b] [--list] [--smoke] [--all]
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize, relative } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const flag = (k) => args.includes(k);
const overrides = JSON.parse(readFileSync('tests/test-deps.json', 'utf8'));

const SRC_EXT = /\.(ts|mts|mjs|js)$/;
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(relative(ROOT, p));
  }
  return out;
}
const codeFiles = ['src', 'tests', 'scripts'].flatMap((d) => walk(d)).filter((f) => SRC_EXT.test(f));
const tests = codeFiles.filter((f) => /^tests\/[^/]+\.test\.ts$/.test(f)).sort();

function resolveImport(from, spec) {
  if (!spec.startsWith('.')) return { pkg: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] };
  const base = normalize(join(dirname(from), spec));
  for (const c of [base, base + '.ts', base + '.mjs', join(base, 'index.ts')]) if (existsSync(c) && statSync(c).isFile()) return { file: c };
  return {};
}

// edges: file -> set of dependencies (files or "pkg:<name>")
const deps = new Map();
const migrations = walk('migrations').filter((f) => f.endsWith('.sql'));
for (const f of codeFiles) {
  const src = readFileSync(f, 'utf8');
  const d = new Set();
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)) {
    const spec = m[1] || m[2] || m[3];
    if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue; // erased at runtime; tsc covers it
    if (spec.startsWith('node:')) continue;
    const r = resolveImport(f, spec);
    if (r.file) d.add(r.file); else if (r.pkg) d.add('pkg:' + r.pkg);
  }
  // Non-import runtime links: string literals naming repo paths.
  if (f !== 'scripts/build.mjs') for (const m of src.matchAll(/['"`]((?:dist|migrations|handoff|contracts|tests\/fixtures)\/?[A-Za-z0-9_./-]*)['"`]/g)) {
    const p = m[1].replace(/\/$/, '');
    if (p.startsWith('dist/')) { const e = overrides.dist[p]; if (e) { d.add(e); d.add('scripts/build.mjs'); } }
    else if (p === 'migrations' || p === 'migrations/') migrations.forEach((x) => d.add(x));
    else if (existsSync(p) && statSync(p).isFile()) d.add(p);
  }
  deps.set(f, d);
}

// Explicit non-import dependencies are data, never executable inputs. Keep
// missing targets: deleting a runtime script must still select its consumers.
const runtime = overrides.runtime === undefined ? {} : overrides.runtime;
if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('invalid runtime dependency mapping');
const repoPath = (p) => typeof p === 'string' && p.length > 0 && !p.includes('\\') && !/[\u0000-\u001f\u007f]/.test(p)
  && !p.split('/').some((part) => !part || part === '.' || part === '..');
const runtimeTargets = new Set();
for (const [owner, targets] of Object.entries(runtime)) {
  if (!repoPath(owner) || !deps.has(owner)) throw new Error(`invalid runtime dependency owner: ${owner}`);
  if (!Array.isArray(targets) || targets.some((p) => !repoPath(p))) throw new Error(`invalid runtime dependency targets: ${owner}`);
  for (const target of targets) { deps.get(owner).add(target); runtimeTargets.add(target); }
}

const reaches = new Map();
function closure(f) {
  if (reaches.has(f)) return reaches.get(f);
  // Cache only a completed root traversal. Partially cached DFS results can
  // lose dependencies for another consumer when imports contain a cycle.
  const out = new Set(); const pending = [f];
  while (pending.length) {
    const next = pending.pop();
    if (out.has(next)) continue;
    out.add(next);
    for (const d of deps.get(next) || []) if (!out.has(d)) pending.push(d);
  }
  reaches.set(f, out);
  return out;
}
const testReach = new Map(tests.map((t) => [t, closure(t)]));
const needsBuild = (t) => [...testReach.get(t)].includes('scripts/build.mjs');

function changedFiles() {
  if (opt('--files')) return opt('--files').split(',').filter(Boolean);
  const base = opt('--base') || process.env.TEST_BASE || 'origin/main';
  const mb = execFileSync('git', ['merge-base', base, 'HEAD'], { encoding: 'utf8' }).trim();
  const committed = execFileSync('git', ['diff', '--name-only', mb], { encoding: 'utf8' });
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' });
  return [...new Set((committed + untracked).split('\n').filter(Boolean))];
}

function select(changed) {
  const picked = new Map(); // test -> reason
  const add = (t, why) => { if (!picked.has(t)) picked.set(t, why); };
  const wide = overrides.wide || [];
  for (const c of changed) {
    // Shared surfaces first (D5-cl (1) + council B-H5): a change to the harness,
    // the runner/selector itself, migrations, contracts, the dependency manifests,
    // the workflows or the scoped tsconfigs can invalidate any test's assumptions,
    // so it forces the full set instead of trusting the import graph.
    if (wide.some((p) => c === p || c.startsWith(p))) {
      console.error(`[test-select] WIDE ${c} (shared surface) -> full set`);
      tests.forEach((t) => add(t, c + ' (shared surface: wide set forced)'));
      continue;
    }
    // A declared runtime dependency is stronger evidence than an ordinary
    // ignore rule (for example, a JSON runtime fixture under docs/).
    if (runtimeTargets.has(c)) for (const [t, r] of testReach) if (r.has(c)) add(t, c);
    if (overrides.ignore.some((p) => c === p || c.startsWith(p))) continue;
    if (overrides.everything.includes(c)) { tests.forEach((t) => add(t, c + ' (toolchain: affects every test)')); continue; }
    for (const [t, r] of testReach) if (r.has(c)) add(t, c);
  }
  return picked;
}

const smoke = overrides.smoke;
let picked;
if (flag('--all')) picked = new Map(tests.map((t) => [t, 'manual full run']));
else if (flag('--smoke')) picked = new Map(smoke.map((t) => [t, 'smoke']));
else {
  const changed = changedFiles();
  picked = select(changed);
  console.error(`[test-select] ${changed.length} changed file(s) -> ${picked.size}/${tests.length} test file(s)`);
  if (picked.size === 0) { console.error('[test-select] no test reaches the diff; running smoke'); picked = new Map(smoke.map((t) => [t, 'smoke fallback'])); }
}
const list = [...picked.keys()].sort();
for (const t of list) console.error(`  ${t}  <- ${picked.get(t)}`);
if (flag('--list')) { console.log(list.join('\n')); process.exit(0); }

const { runTests } = await import('./test-run.mjs');
process.exit(await runTests(list, { needsBuild }));
