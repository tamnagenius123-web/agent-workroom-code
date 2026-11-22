import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  GIT_READ_COMMANDS,
  HANDOVER_REPO,
  SOURCE_REPOSITORY,
  buildManifest,
  initialState,
  intendedBranchRepo,
  parseLsTreeZ,
  serializeManifest,
  sha256Hex,
  treeContentDigest,
} from '../scripts/cf-artifacts-backup-manifest.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../scripts/cf-artifacts-backup-manifest.ts', import.meta.url));

const gitEnv = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  GIT_AUTHOR_NAME: 'manifest-test',
  GIT_AUTHOR_EMAIL: 'manifest-test@example.com',
  GIT_COMMITTER_NAME: 'manifest-test',
  GIT_COMMITTER_EMAIL: 'manifest-test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(repo: string, args: string[], input?: Buffer | string): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: gitEnv,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function record(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.ok(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected array');
  return value;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkTs(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('tree content digest is a canonical SHA-256 and ignores entry order', () => {
  const payload = sha256Hex(Buffer.from('hello\n'));
  const line = `100644 blob ${payload} a.txt\n`;
  const expect = sha256Hex(line);
  const entry = { mode: '100644', type: 'blob' as const, path: 'a.txt', payload };
  assert.equal(treeContentDigest([entry]), expect);
  const other = { mode: '100755', type: 'blob' as const, path: 'a.txt', payload };
  const second = { mode: '100644', type: 'blob' as const, path: 'b.txt', payload };
  assert.equal(treeContentDigest([second, entry]), treeContentDigest([entry, second]));
  assert.notEqual(treeContentDigest([entry]), treeContentDigest([other]));
  assert.equal(treeContentDigest([]), createHash('sha256').update('').digest('hex'));
  const link = { mode: '160000', type: 'commit' as const, path: 'vendor', payload: 'a'.repeat(40) };
  assert.equal(treeContentDigest([link]), sha256Hex(`160000 commit ${'a'.repeat(40)} vendor\n`));
  assert.throws(() => treeContentDigest([entry, entry]), /duplicate tree path/);
});

test('ls-tree parser keeps blob bytes identity and gitlinks', () => {
  const sha = 'a'.repeat(40);
  const buf = Buffer.from(`100644 blob ${sha}\tdocs/handover/note.md\0`);
  assert.deepEqual(parseLsTreeZ(buf), [{ mode: '100644', type: 'blob', gitSha: sha, path: 'docs/handover/note.md' }]);
  const link = `160000 commit ${sha}\tvendor/lib\0`;
  assert.equal(parseLsTreeZ(Buffer.from(link))[0]?.type, 'commit');
  assert.throws(() => parseLsTreeZ(Buffer.from(`100644 tree ${sha}\tbad\0`)), /unexpected ls-tree/);
});

test('intended repos follow the agent-branches rule', () => {
  assert.equal(intendedBranchRepo('grok/ORCH-A1'), 'grok-branches');
  assert.equal(intendedBranchRepo('dots/handover-20261028'), 'dots-branches');
  assert.equal(intendedBranchRepo('claude-features'), 'claude-branches');
  assert.equal(intendedBranchRepo('muse/roadmap'), 'muse-branches');
  assert.equal(intendedBranchRepo('.hidden'), 'UNASSIGNED');
  assert.equal(HANDOVER_REPO, 'handover-20261028');
  assert.deepEqual([...GIT_READ_COMMANDS], ['for-each-ref', 'ls-tree', 'cat-file', 'rev-parse']);
});

test('fixture digests split main from Artifacts candidates and ignore commit messages', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'cf-manifest-'));
  try {
    git(repo, ['init', '-b', 'main']);
    mkdirSync(join(repo, 'docs/handover'), { recursive: true });
    writeFileSync(join(repo, 'docs/handover/note.md'), 'alpha\n');
    writeFileSync(join(repo, 'README.bin'), Buffer.from([0, 1, 2, 255]));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'one']);
    const commitA = git(repo, ['rev-parse', 'HEAD']);
    const treeA = git(repo, ['rev-parse', 'HEAD^{tree}']);
    git(repo, ['update-ref', 'refs/remotes/origin/main', commitA]);
    git(repo, ['commit', '--allow-empty', '-m', 'two']);
    const commitB = git(repo, ['rev-parse', 'HEAD']);
    assert.notEqual(commitA, commitB);
    assert.equal(git(repo, ['rev-parse', 'HEAD^{tree}']), treeA);
    git(repo, ['update-ref', 'refs/remotes/origin/grok/one', commitA]);
    git(repo, ['update-ref', 'refs/remotes/origin/grok/two', commitB]);
    writeFileSync(join(repo, 'README.bin'), Buffer.from([9]));
    git(repo, ['add', 'README.bin']);
    git(repo, ['commit', '-m', 'three']);
    const commitC = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/grok/three', commitC]);
    git(repo, ['update-ref', 'refs/remotes/origin/claude-features', commitA]);
    git(repo, ['checkout', '-B', 'handover-work', commitA]);
    writeFileSync(join(repo, 'docs/handover/extra.md'), 'beta\n');
    git(repo, ['add', 'docs/handover/extra.md']);
    git(repo, ['commit', '-m', 'handover']);
    const commitH = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['update-ref', 'refs/remotes/origin/dots/handover-20261028', commitH]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
    const blob = git(repo, ['hash-object', '-w', '--stdin'], 'not-a-branch\n');
    git(repo, ['update-ref', 'refs/remotes/origin/blob-ref', blob]);

    const first = await buildManifest(repo);
    const second = await buildManifest(repo);
    assert.equal(serializeManifest(first), serializeManifest(second));
    const doc = record(first);
    assert.equal(doc.schema, 'cf-artifacts-vs-same-codebase/1');
    assert.equal(doc.source_repository, SOURCE_REPOSITORY);
    assert.equal(doc.live_cloudflare, 'NOT_VERIFIED');
    assert.equal(doc.credential_use, 'not-performed');
    assert.equal(doc.upload_performed, 'not-performed');
    assert.equal(doc.repo_existence, 'NOT_VERIFIED');
    assert.equal(doc.observed_main, commitA);
    const placement = record(doc.placement);
    const same = record(placement.cf_git_same_codebase);
    const artifacts = record(placement.cloudflare_artifacts);
    assert.equal(same.store, 'cf-git-same-codebase');
    assert.equal(same.repository, SOURCE_REPOSITORY);
    assert.equal(same.ref, 'refs/heads/main');
    assert.equal(same.commit, commitA);
    assert.equal(same.tree, treeA);
    assert.equal(same.reason, 'github-canonical-main');
    assert.equal(artifacts.store, 'cloudflare-artifacts');
    assert.equal(artifacts.namespace, 'workroom');
    assert.equal(artifacts.live_cloudflare, 'NOT_VERIFIED');
    assert.equal(artifacts.upload_performed, 'not-performed');
    const items = asArray(doc.items);
    const states = initialState();
    const branches = items.filter((item) => record(item).kind === 'branch').map(record);
    const docs = items.filter((item) => record(item).kind === 'handover_doc').map(record);
    assert.deepEqual(branches.map((item) => item.name).sort(), [
      'claude-features',
      'dots/handover-20261028',
      'grok/one',
      'grok/three',
      'grok/two',
    ]);
    assert.equal(branches.some((item) => item.name === 'main' || item.name === 'HEAD' || item.name === 'blob-ref'), false);
    const one = branches.find((item) => item.name === 'grok/one');
    const two = branches.find((item) => item.name === 'grok/two');
    const three = branches.find((item) => item.name === 'grok/three');
    if (!one || !two || !three) throw new Error('missing branch items');
    assert.equal(one.commit, commitA);
    assert.equal(two.commit, commitB);
    assert.equal(one.content_digest, two.content_digest);
    assert.equal(one.content_digest, same.content_digest);
    assert.notEqual(one.content_digest, three.content_digest);
    assert.match(String(one.content_digest), /^[0-9a-f]{64}$/);
    assert.equal(one.store, 'cloudflare-artifacts');
    assert.equal(branches.find((item) => item.name === 'claude-features')?.intended_repo, 'claude-branches');
    assert.equal(one.intended_repo, 'grok-branches');
    assert.equal(branches.find((item) => item.name === 'dots/handover-20261028')?.intended_repo, 'dots-branches');
    for (const item of [...branches, ...docs]) assert.deepEqual(item.state, states);
    const note = docs.filter((item) => item.name === 'docs/handover/note.md');
    assert.equal(note.length, 2);
    assert.equal(note[0]?.content_digest, note[1]?.content_digest);
    assert.notEqual(note[0]?.commit, note[1]?.commit);
    assert.equal(note[0]?.intended_repo, 'handover-20261028');
    assert.equal(sha256Hex('alpha\n'), note[0]?.content_digest);
    const extra = docs.find((item) => item.name === 'docs/handover/extra.md');
    assert.equal(extra?.content_digest, sha256Hex('beta\n'));
    assert.equal(extra?.bytes, Buffer.byteLength('beta\n'));
    assert.equal(extra?.commit, commitH);
    const counts = record(doc.counts);
    assert.equal(counts.items, items.length);
    assert.equal(counts.branches, 5);
    assert.equal(counts.handover_docs, 3);
    assert.equal(doc.items_sha256, sha256Hex(JSON.stringify(items)));
    const excluded = asArray(doc.excluded).map(record);
    assert.deepEqual(excluded.map((row) => row.name).sort(), ['HEAD', 'blob-ref', 'main']);
    assert.equal(excluded.find((row) => row.name === 'main')?.reason, 'github-canonical-main');

    const cli = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--repo', repo, '--stdout'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    const again = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--repo', repo, '--stdout'], { encoding: 'utf8' });
    assert.equal(again.stdout, cli.stdout);
    assert.equal(cli.stdout, serializeManifest(first));
    const refused = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--repo', repo, '--upload'], { encoding: 'utf8' });
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, '');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('generator source does not name a Cloudflare call or a credential', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  for (const banned of ['api.cloudflare.com', 'wrangler', 'CLOUDFLARE_API_TOKEN', 'ARTIFACTS_TOKEN', 'git fetch', 'git push', 'ls-remote']) {
    assert.equal(src.includes(banned), false, banned);
  }
});

test('product source does not reference the inventory and WRGIT stays off', () => {
  for (const file of walkTs(join(ROOT, 'src'))) {
    assert.equal(readFileSync(file, 'utf8').includes('cf-artifacts-backup-manifest'), false, file);
  }
  const wrangler = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  assert.match(wrangler, /"WRGIT_ENABLED": "0"/);
});
