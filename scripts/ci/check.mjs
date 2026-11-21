#!/usr/bin/env node
// Policy job entry. Run this copy from the base ref (gate/scripts/ci/check.mjs) with the PR
// checkout as cwd. It diffs that tree and reads SQL bytes. It does not import PR code.
// PR_BODY is set by the workflow. GitHub reviews are not read: the Tier L PASS lives in the workroom (t1035u).
// It also fails when head adds migrations/NNNN_*.sql whose number is already on the base
// tree or claimed in migrations/REGISTRY.md for a different file. ci.yml runs the same
// check via scripts/ci/mig-num-lint.mjs.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, appendFileSync } from 'node:fs';
import { migrationErrorsAt } from './mig-num-lint.mjs';
import { policyErrors, TIER_L_NOTE, classifyTier, pathsFromNameStatus, diffNameStatusArgs } from './policy.mjs';
import { commitsFromLog, testOrder, testOrderLogArgs } from './test-order.mjs';

const base = process.argv[2];
const head = process.argv[3] || process.env.HEAD_SHA || 'HEAD';
if (!base) {
  console.error('usage: node scripts/ci/check.mjs <base-sha> [head-sha]');
  process.exit(1);
}

const gitEnv = { ...process.env };
delete gitEnv.GIT_EXTERNAL_DIFF;
let nameStatus;
try {
  nameStatus = execFileSync('git', diffNameStatusArgs(base, head), { encoding: 'utf8', env: gitEnv });
} catch (e) {
  console.error(`git diff failed closed: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
const files = pathsFromNameStatus(nameStatus);

function inRepo(f) {
  return f.length > 0 && !f.startsWith('/') && !f.split('/').includes('..');
}

function failClosed(message) {
  console.error(message);
  process.exit(1);
}

// lstat each path component. Do not follow a symlink into another file's bytes.
// A missing path is a deletion and is not read. Anything else fails closed.
function sqlPathKind(f) {
  const parts = f.split('/');
  let acc = '';
  for (let i = 0; i < parts.length; i++) {
    acc = i === 0 ? parts[i] : `${acc}/${parts[i]}`;
    let st;
    try {
      st = lstatSync(acc);
    } catch (e) {
      if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') return 'missing';
      failClosed(`sql path not readable; failing closed: ${f}`);
    }
    if (st.isSymbolicLink()) return 'symlink';
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory()) return 'other';
  }
  return 'file';
}

function sqlContents(files) {
  const contents = {};
  for (const f of files) {
    if (!f.endsWith('.sql') || !inRepo(f)) continue;
    const kind = sqlPathKind(f);
    if (kind === 'missing') continue;
    if (kind !== 'file') failClosed(`sql path is not a regular file; failing closed: ${f}`);
    contents[f] = readFileSync(f, 'utf8');
  }
  return contents;
}

const contents = sqlContents(files);

// Absent registry: this tree is not a workroom checkout (the policy spawn tests). A present
// registry that is not a regular file fails closed and is not read.
function headMigrationErrors(baseRev, headRev) {
  return migrationErrorsAt(baseRev, headRev, {
    lstat: lstatSync,
    readFile: (path, encoding) => readFileSync(path, encoding),
    execGit: (args) => execFileSync('git', args, { encoding: 'utf8', env: gitEnv }),
    fail: failClosed,
  });
}

const { tier, reasons } = classifyTier(files, contents);
const errs = policyErrors({
  files,
  body: process.env.PR_BODY ?? '',
  contents,
});
errs.push(...headMigrationErrors(base, head));
// Advisory (roadmap V3-7): printed, never added to errs. Commit order only, not RED evidence.
let order;
try {
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8', env: gitEnv }).trim() === 'true';
  order = testOrder(commitsFromLog(execFileSync('git', testOrderLogArgs(base, head), { encoding: 'utf8', env: gitEnv })), { shallow, diffFiles: files.length });
} catch (e) {
  order = { order: 'uncertain', reasons: [`commit order not read: ${e instanceof Error ? e.message.split('\n')[0] : e}`] };
}
const advisories = order.order === 'no-code' ? '' : `- ${order.order === 'tests-before-src' ? 'ℹ️' : '⚠️'} tests-before-src static order (advisory, V3-7): ${order.order}${order.reasons.map((r) => `\n  - ${r}`).join('')}\n  - commit order is not RED evidence; RED needs a reproducible failing run at the test commit`;
const summary = `### CI-GATE policy\n- required tier: **${tier}**${reasons.map((r) => `\n  - ${r}`).join('')}${tier === 'L' ? `\n- ℹ️ ${TIER_L_NOTE}` : ''}\n${errs.length ? errs.map((e) => `- ❌ ${e}`).join('\n') : '- ✅ policy checks pass'}\n${advisories ? `${advisories}\n` : ''}`;
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tier=${tier}\n`);
process.exit(errs.length ? 1 : 0);
