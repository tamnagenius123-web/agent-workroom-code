import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { duplicateMigrationNumbers, classifyTier, policyErrors } from '../scripts/ci/policy.mjs';

const HEAD = '0123456789abcdef0123456789abcdef01234567';
const VERIFIED = '\n## Verification\nnode --test tests/ci-policy.test.ts — exit 0, 0 failed\n';
const tierL = {
  files: ['src/server/auth.ts', 'decisions.tsv'],
  body: 'Tier: L\nAuthor: agent:grok\n\n## Blast radius\nauthority boundary\n',
};
const verifyGap = (errs: string[]) => errs.some((e) => /Verification/.test(e));

test('migration numbers: duplicates are reported', () => {
  assert.deepEqual(duplicateMigrationNumbers(['0052_a.sql', '0053_b.sql', '0053_c.sql', 'REGISTRY.md']), { '0053': ['0053_b.sql', '0053_c.sql'] });
  assert.deepEqual(duplicateMigrationNumbers(['0052_a.sql', '0053_b.sql']), {});
});

test('repo migrations/ has unique numbers', async () => {
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(duplicateMigrationNumbers(readdirSync('migrations')), {});
});

test('tier: path rules force L', () => {
  assert.equal(classifyTier(['docs/x.md', 'src/server/fold.ts']).tier, 'D');
  for (const f of ['src/server/auth.ts', 'src/oauth/x.ts', 'wrangler.jsonc', '.github/workflows/ci.yml', 'scripts/ci/policy.mjs', 'docs/verification-policy.md', 'src/server/notify.ts', 'scripts/claude-runner.mts'])
    assert.equal(classifyTier([f]).tier, 'L', f);
});

test('tier: destructive migration forces L, additive does not', () => {
  assert.equal(classifyTier(['migrations/0054_x.sql'], { 'migrations/0054_x.sql': 'CREATE TABLE t(a);' }).tier, 'D');
  assert.equal(classifyTier(['migrations/0054_x.sql'], { 'migrations/0054_x.sql': 'DELETE FROM t;' }).tier, 'L');
  assert.equal(classifyTier(['migrations/0054_x.sql'], { 'migrations/0054_x.sql': 'ALTER TABLE t DROP COLUMN a;' }).tier, 'L');
});

test('policy: src change needs decisions.tsv + blast radius; claimed D on L path fails', () => {
  const body = 'Tier: D\n\n## Blast radius\nonly fold.ts';
  assert.deepEqual(policyErrors({ files: ['docs/a.md'], body: 'Tier: D' }), []);
  assert.match(policyErrors({ files: ['src/a.ts'], body }).join(), /decisions\.tsv/);
  assert.match(policyErrors({ files: ['src/a.ts', 'decisions.tsv'], body: 'Tier: D' }).join(), /Blast radius/);
  assert.deepEqual(policyErrors({ files: ['src/a.ts', 'decisions.tsv'], body }), []);
  assert.match(policyErrors({ files: ['src/server/auth.ts', 'decisions.tsv'], body }).join(), /Tier L/);
  assert.match(policyErrors({ files: ['docs/a.md'], body: 'no tier' }).join(), /Tier:/);
});

function workflowSteps(yml: string): string[] {
  return yml.split(/\n {6}- /).slice(1);
}

function runScriptBodies(yml: string): string[] {
  const lines = yml.split('\n');
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\s*)run:\s*(.*)$/.exec(lines[i] ?? '');
    if (!header) continue;
    const indent = (header[1] ?? '').length;
    const inline = header[2] ?? '';
    if (inline === '|' || inline === '|-' || inline === '>' || inline === '>-') {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j] ?? '';
        if (line.trim() === '') {
          body.push(line);
          continue;
        }
        const width = /^\s*/.exec(line)?.[0].length ?? 0;
        if (width <= indent) break;
        body.push(line);
      }
      i = j - 1;
      bodies.push(body.join('\n'));
    } else if (inline !== '') {
      bodies.push(inline);
    }
  }
  return bodies;
}

test('ci.yml stays on pull_request and does not host the policy job', () => {
  const yml = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.doesNotMatch(yml, /pull_request_target/);
  assert.match(yml, /^on:\n(?:[^\n]*\n)*? {2}pull_request:\s*$/m);
  assert.match(yml, /push:\n {4}branches:\s*\[main\]/);
  // This repo's required check is the job named pr.
  assert.match(yml, /^ {2}pr:\s*$/m);
  assert.doesNotMatch(yml, /^ {2}policy:\s*$/m);
});

test('policy.yml is pull_request_target and does not execute PR-head code', () => {
  const yml = readFileSync('.github/workflows/policy.yml', 'utf8');
  assert.match(yml, /pull_request_target:/);
  assert.match(yml, /types:\s*\[opened,\s*synchronize,\s*reopened,\s*edited,\s*ready_for_review\]/);
  assert.doesNotMatch(yml, /pull_request_review/);
  assert.doesNotMatch(yml, /^ {2}pull_request:\s*$/m);
  assert.match(yml, /group:\s*policy-\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/);
  assert.doesNotMatch(yml, /github\.ref/);
  const steps = workflowSteps(yml);
  const pr = steps.find((s) => /\bpath:\s*pr\s*(?:#.*)?$/m.test(s));
  const gate = steps.find((s) => /\bpath:\s*gate\s*(?:#.*)?$/m.test(s));
  assert.equal(pr !== undefined, true);
  assert.match(pr ?? '', /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/);
  // This repo fetches depth 1, then deepens until the merge-base is reachable.
  assert.match(pr ?? '', /fetch-depth:\s*1/);
  assert.match(pr ?? '', /persist-credentials:\s*false/);
  assert.match(yml, /PR_NUMBER:\s*\$\{\{\s*github\.event\.pull_request\.number\s*\}\}/);
  assert.match(yml, /BASE_REF:\s*\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\}\}/);
  assert.match(yml, /refs\/pull\/\$\{PR_NUMBER\}\/head/);
  assert.match(yml, /refs\/heads\/\$\{BASE_REF\}/);
  const runBodies = runScriptBodies(yml);
  assert.equal(runBodies.length >= 1, true);
  for (const body of runBodies) assert.doesNotMatch(body, /\$\{\{\s*github\.event\.pull_request\./);
  assert.equal(gate !== undefined, true);
  assert.match(gate ?? '', /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/);
  assert.match(gate ?? '', /persist-credentials:\s*false/);
  const checkouts = yml.match(/uses:\s*actions\/checkout@v4/g) ?? [];
  const persisted = yml.match(/persist-credentials:\s*false/g) ?? [];
  assert.equal(checkouts.length, persisted.length);
  assert.equal(persisted.length >= 2, true);
  assert.doesNotMatch(yml, /persist-credentials:\s*true/);
  const permBlocks = yml.match(/permissions:\n(?:[ \t]+[a-z-]+:[ \t]*\S+[ \t]*\n)+/g) ?? [];
  assert.equal(permBlocks.length >= 1, true);
  for (const block of permBlocks) {
    const keys = [...block.matchAll(/^[ \t]+([a-z-]+):/gm)].map((m) => m[1]).sort();
    assert.deepEqual(keys, ['contents', 'pull-requests']);
    assert.match(block, /contents:\s*read/);
    assert.match(block, /pull-requests:\s*read/);
  }
  assert.doesNotMatch(yml, /\b(?:npm|npx|tsx)\b/);
  assert.doesNotMatch(yml, /node\s+scripts\/ci\/check\.mjs/);
  assert.doesNotMatch(yml, /(?:node|bash|sh|npx|npm|tsx)\s+["']?(?:\.\/|\.\.\/)?pr\//);
  assert.doesNotMatch(yml, /\$GITHUB_WORKSPACE\/pr\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|sh|ts|mts)/);
  const nodeScripts = [...yml.matchAll(/node\s+"\$GITHUB_WORKSPACE\/[^"]+"/g)].map((m) => m[0]);
  assert.deepEqual(nodeScripts, ['node "$GITHUB_WORKSPACE/gate/scripts/ci/check.mjs"']);
  // t1035u: one shared GitHub account by design; the gate never reads GitHub reviews.
  assert.doesNotMatch(yml, /pulls\/.+\/reviews/);
  assert.doesNotMatch(yml, /secrets\./);
  assert.doesNotMatch(yml, /GH_TOKEN|github\.token/);
});

test('check.mjs diffs with the pure name-status helper and does not use name-only', () => {
  const src = readFileSync('scripts/ci/check.mjs', 'utf8');
  assert.match(src, /diffNameStatusArgs/);
  assert.match(src, /pathsFromNameStatus/);
  assert.doesNotMatch(src, /PR_REVIEWS_FILE/);
  assert.match(src, /lstatSync/);
  assert.doesNotMatch(src, /existsSync/);
  assert.doesNotMatch(src, /--name-only/);
});

const checkScript = fileURLToPath(new URL('../scripts/ci/check.mjs', import.meta.url));

function runSqlCheck(nameStatus: string, prepare: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-sql-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const git = join(bin, 'git');
  writeFileSync(git, '#!/bin/sh\nprintf \'%s\\n\' "$CHECK_NAME_STATUS"\n');
  chmodSync(git, 0o755);
  prepare(dir);
  const head = 'b'.repeat(40);
  const result = spawnSync(process.execPath, [checkScript, 'a'.repeat(40), head], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: bin,
      PR_BODY: 'Tier: D\n',
      PR_AUTHOR: 'octocat',
      HEAD_SHA: head,
      CHECK_NAME_STATUS: nameStatus,
    },
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test('a changed .sql symlink fails closed and is not followed', () => {
  const result = runSqlCheck('A\tdocs/note.sql', (dir) => {
    mkdirSync(join(dir, 'docs'));
    const secret = join(dir, 'secret.sql');
    writeFileSync(secret, 'DELETE FROM t; SECRET_MARKER\n');
    symlinkSync(secret, join(dir, 'docs', 'note.sql'));
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}`, /not a regular file/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /SECRET_MARKER/);
});

test('a changed .sql path that is not a regular file fails closed', () => {
  const result = runSqlCheck('A\tdocs/note.sql', (dir) => {
    mkdirSync(join(dir, 'docs', 'note.sql'), { recursive: true });
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}`, /not a regular file/);
});

test('a regular changed .sql file is read and a missing one is skipped', () => {
  const present = runSqlCheck('A\tdocs/note.sql', (dir) => {
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'note.sql'), 'SELECT 1;\n');
  });
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /policy checks pass/);
  const missing = runSqlCheck('D\tdocs/gone.sql', () => {});
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /policy checks pass/);
});

test('Tier L rules cover mcp, policy, worker, domain, and dispatch-wire', () => {
  const missed = [
    'src/server/mcp.ts',
    'src/server/policy.ts',
    'src/server/worker.ts',
    'src/worker.ts',
    'src/server/domain.ts',
    'src/server/dispatch-wire.ts',
  ].filter((f) => classifyTier([f]).tier !== 'L');
  assert.deepEqual(missed, []);
});

test('rename and copy name-status classifies the old path and the new path', async () => {
  const { pathsFromNameStatus } = await import('../scripts/ci/policy.mjs');
  assert.deepEqual(pathsFromNameStatus('M\tsrc/server/fold.ts\n'), ['src/server/fold.ts']);
  assert.deepEqual(pathsFromNameStatus('A\tdocs/a.md\nD\tsrc/old.ts\n'), ['docs/a.md', 'src/old.ts']);
  assert.equal(classifyTier(['src/server/fold.ts']).tier, 'D');
  const renamed = pathsFromNameStatus('R100\tsrc/server/auth.ts\tsrc/server/fold.ts\n');
  assert.deepEqual(renamed, ['src/server/auth.ts', 'src/server/fold.ts']);
  assert.equal(classifyTier(renamed).tier, 'L');
  const copied = pathsFromNameStatus('C80\tsrc/server/dispatch-wire.ts\tdocs/copy.md\n');
  assert.deepEqual(copied, ['src/server/dispatch-wire.ts', 'docs/copy.md']);
  assert.equal(classifyTier(copied).tier, 'L');
  assert.deepEqual(pathsFromNameStatus('R\tsrc/server/domain.ts\tsrc/server/fold.ts\n'), ['src/server/domain.ts', 'src/server/fold.ts']);
  assert.deepEqual(
    pathsFromNameStatus('R100\t"src/server/mcp.ts"\t"docs/my copy.md"\n'),
    ['src/server/mcp.ts', 'docs/my copy.md'],
  );
});

test('name-status diff asks git for both sides with -M', async () => {
  const { diffNameStatusArgs } = await import('../scripts/ci/policy.mjs');
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  const args = diffNameStatusArgs(base, head);
  const joined = args.join(' ');
  const spec = `${base}...${head}`;
  assert.equal(joined.includes('--name-status'), true);
  assert.equal(joined.includes('-M'), true);
  assert.equal(joined.includes('-C'), true);
  assert.equal(joined.includes('--find-copies-harder'), true);
  assert.equal(joined.includes('--no-ext-diff'), true);
  assert.equal(joined.includes(spec), true);
});

test('policy.mjs, check.mjs and policy.yml never read /pulls/*/reviews (shared GitHub account)', async () => {
  for (const f of ['scripts/ci/policy.mjs', 'scripts/ci/check.mjs', '.github/workflows/policy.yml']) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /pulls\/[^\s'"]*\/reviews/);
    assert.doesNotMatch(src, /PR_REVIEWS_FILE|reviewDecision|author_association/);
  }
  const mod = await import('../scripts/ci/policy.mjs');
  assert.equal('nonAuthorPassErrors' in mod, false);
  assert.equal('workroomPassErrors' in mod, false);
});

test('Tier L: a Verification section that names a command and result clears the gate', () => {
  assert.deepEqual(policyErrors({ ...tierL, body: tierL.body + VERIFIED }), []);
  assert.deepEqual(policyErrors({ ...tierL, body: tierL.body + '\n## Verification\nEvidence: https://github.com/tamnagenius123-web/agent-workroom/pull/1#issuecomment-1\n' }), []);
});

test('Tier L: missing, empty, or placeholder Verification fails, and a Workroom-PASS line does not clear it', () => {
  assert.equal(verifyGap(policyErrors(tierL)), true);
  assert.equal(verifyGap(policyErrors({ ...tierL, body: tierL.body + '\n## Verification\n\n' })), true);
  assert.equal(verifyGap(policyErrors({ ...tierL, body: tierL.body + '\n## Verification\nTODO\n' })), true);
  assert.equal(verifyGap(policyErrors({ ...tierL, body: tierL.body + '\n## Verification\npending\n' })), true);
  assert.equal(verifyGap(policyErrors({ ...tierL, body: tierL.body + '\n## Verification\nn/a\n' })), true);
  assert.equal(verifyGap(policyErrors({ ...tierL, body: tierL.body + `\n## Verification\nWorkroom-PASS: ${HEAD} agent:muse msg:3baf6a14\n` })), true);
  assert.equal(verifyGap(policyErrors({ ...tierL, body: `Tier: L\nWorkroom-PASS: ${HEAD} agent:muse msg:3baf6a14\n` })), true);
});

test('forbidden paths stay Tier L: wrangler.jsonc still forces the tier', () => {
  assert.match(policyErrors({ files: ['wrangler.jsonc'], body: 'Tier: D\n' }).join('\n'), /path rules force Tier L/);
  assert.match(policyErrors({ files: ['wrangler.jsonc'], body: `Tier: D\n${VERIFIED}` }).join('\n'), /path rules force Tier L/);
  assert.equal(verifyGap(policyErrors({ files: ['wrangler.jsonc'], body: 'Tier: L\n' })), true);
  assert.deepEqual(policyErrors({ files: ['wrangler.jsonc'], body: `Tier: L\n${VERIFIED}` }), []);
  const destructive = policyErrors({
    files: ['migrations/0099_drop.sql', 'decisions.tsv'],
    contents: { 'migrations/0099_drop.sql': 'DROP TABLE t;' },
    body: 'Tier: D\n\n## Blast radius\ndrops t\n',
  });
  assert.match(destructive.join('\n'), /path rules force Tier L/);
  assert.equal(verifyGap(destructive), true);
});

test('Tier D passes with decisions.tsv and blast radius', () => {
  const body = 'Tier: D\n\n## Blast radius\nonly fold.ts\n';
  assert.deepEqual(policyErrors({ files: ['src/server/fold.ts', 'decisions.tsv'], body }), []);
});

test('declared Tier L is accepted on a D path; claimed D on an L path still fails', () => {
  const files = ['docs/a.md'];
  assert.equal(classifyTier(files).tier, 'D');
  assert.equal(verifyGap(policyErrors({ files, body: 'Tier: L\n' })), true);
  assert.deepEqual(policyErrors({ files, body: `Tier: L\n${VERIFIED}` }), []);
  const weaker = 'Tier: D\n\n## Blast radius\nauthority boundary\n';
  assert.match(policyErrors({ files: ['src/server/auth.ts', 'decisions.tsv'], body: weaker }).join('\n'), /path rules force Tier L/);
});

test('stale-phrases lint: flags retired gate wording, allowlists OWNER_RULINGS.md, repo is clean', async () => {
  const { staleHits } = await import('../scripts/ci/stale-phrases.mjs');
  const read = (f: string) => (f.endsWith('bad.md') || f === 'docs/OWNER_RULINGS.md' ? 'needs an APPROVED review and per-agent GitHub accounts' : 'fine');
  assert.equal(staleHits(['docs/bad.md'], read).length, 2);
  assert.deepEqual(staleHits(['docs/OWNER_RULINGS.md'], read), []);
  const r = spawnSync('node', ['scripts/ci/stale-phrases.mjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync('.github/workflows/ci.yml', 'utf8'), /node scripts\/ci\/stale-phrases\.mjs/);
});
