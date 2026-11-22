#!/usr/bin/env node
// Local git read of two stores. main stays in this codebase. Other remote
// heads are Cloudflare Artifacts backup candidates. No network, no credentials,
// no upload, and no deploy.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'cf-artifacts-vs-same-codebase/1';
export const NAMESPACE = 'workroom';
export const NAMESPACE_EXPIRY_RECORDED = '2027-10-28';
export const SOURCE_REPOSITORY = 'tamnagenius123-web/agent-workroom-code';
export const HANDOVER_REPO = 'handover-20261028';
export const HANDOVER_PREFIX = 'docs/handover/';
export const DEFAULT_MANIFEST = 'scripts/cf-artifacts-backup-manifest.json';
export const GIT_READ_COMMANDS = ['for-each-ref', 'ls-tree', 'cat-file', 'rev-parse'] as const;

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BLOB_MODE = /^(100644|100755|120000)$/;
const GITLINK_MODE = '160000';

const REF_REPO: Record<string, string> = {
  'claude-features': 'claude-branches',
};

export type LiveState = {
  uploaded: 'not-uploaded';
  downloaded: 'NOT_VERIFIED';
  hash_matched: 'NOT_VERIFIED';
  independent_reviewed: 'NOT_VERIFIED';
  consumed: 'NOT_VERIFIED';
  accepted: 'NOT_VERIFIED';
};

export type DigestEntry = { mode: string; type: 'blob' | 'commit'; path: string; payload: string };
export type LsEntry = { mode: string; type: 'blob' | 'commit'; gitSha: string; path: string };

export type ManifestItem = {
  kind: 'branch' | 'handover_doc';
  store: 'cloudflare-artifacts';
  name: string;
  source_ref: string;
  commit: string;
  content_digest: string;
  intended_repo: string;
  state: LiveState;
  tree?: string;
  git_blob?: string;
  bytes?: number;
};

export type SameCodebase = {
  store: 'cf-git-same-codebase';
  repository: typeof SOURCE_REPOSITORY;
  ref: 'refs/heads/main';
  commit: string;
  tree: string;
  content_digest: string;
  reason: 'github-canonical-main';
};

export type Manifest = {
  schema: typeof SCHEMA;
  namespace: typeof NAMESPACE;
  namespace_expiry_recorded: typeof NAMESPACE_EXPIRY_RECORDED;
  namespace_expiry_note: string;
  source_repository: typeof SOURCE_REPOSITORY;
  source_remote_name: string;
  observed_main: string;
  observation: 'local-git-refs';
  placement: {
    cf_git_same_codebase: SameCodebase;
    cloudflare_artifacts: {
      store: 'cloudflare-artifacts';
      namespace: typeof NAMESPACE;
      role: 'backup-candidate';
      live_cloudflare: 'NOT_VERIFIED';
      credential_use: 'not-performed';
      upload_performed: 'not-performed';
      repo_existence: 'NOT_VERIFIED';
    };
  };
  live_cloudflare: 'NOT_VERIFIED';
  credential_use: 'not-performed';
  upload_performed: 'not-performed';
  identity: string;
  intended_repo_rule: string;
  repo_existence: 'NOT_VERIFIED';
  state_legend: Record<string, string>;
  excluded: { name: string; reason: string }[];
  counts: { items: number; branches: number; handover_docs: number; by_repo: Record<string, number> };
  items_sha256: string;
  items: ManifestItem[];
};

type RefRow = { name: string; type: string; commit: string; tree: string; symref: string };
type HashedBlob = { digest: string; bytes: number };

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function initialState(): LiveState {
  return {
    uploaded: 'not-uploaded',
    downloaded: 'NOT_VERIFIED',
    hash_matched: 'NOT_VERIFIED',
    independent_reviewed: 'NOT_VERIFIED',
    consumed: 'NOT_VERIFIED',
    accepted: 'NOT_VERIFIED',
  };
}

export function intendedBranchRepo(name: string): string {
  if (Object.prototype.hasOwnProperty.call(REF_REPO, name)) return REF_REPO[name] ?? 'UNASSIGNED';
  const seg = String(name).split('/')[0] ?? '';
  if (!REMOTE_NAME.test(seg)) return 'UNASSIGNED';
  return `${seg}-branches`;
}

function pathCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function utf8Strict(buf: Buffer, what: string): string {
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error(`${what} is not utf-8`);
  if (text.includes('\n') || text.includes('\0')) throw new Error(`${what} is not a single line`);
  return text;
}

// Canonical content digest of a tree. Lines are sorted by UTF-8 path.
// A blob payload is the SHA-256 of the stored blob bytes. A gitlink payload
// is the recorded commit id. The digest does not include commit metadata.
export function treeContentDigest(entries: DigestEntry[]): string {
  const sorted = [...entries].sort((a, b) => pathCmp(a.path, b.path) || pathCmp(a.mode, b.mode));
  let prev: string | null = null;
  let body = '';
  for (const entry of sorted) {
    if (entry.path.length === 0 || entry.path.includes('\n') || entry.path.includes('\0')) {
      throw new Error('tree path is not representable');
    }
    if (prev === entry.path) throw new Error(`duplicate tree path: ${entry.path}`);
    prev = entry.path;
    if (entry.type === 'blob') {
      if (!BLOB_MODE.test(entry.mode) || !SHA256.test(entry.payload)) throw new Error(`bad blob entry: ${entry.path}`);
    } else if (entry.type === 'commit') {
      if (entry.mode !== GITLINK_MODE || !SHA40.test(entry.payload)) throw new Error(`bad gitlink entry: ${entry.path}`);
    } else {
      throw new Error(`bad tree entry type: ${entry.path}`);
    }
    body += `${entry.mode} ${entry.type} ${entry.payload} ${entry.path}\n`;
  }
  return sha256Hex(body);
}

export function parseLsTreeZ(buf: Buffer): LsEntry[] {
  const entries: LsEntry[] = [];
  let i = 0;
  while (i < buf.length) {
    const nul = buf.indexOf(0, i);
    const end = nul === -1 ? buf.length : nul;
    const rec = buf.subarray(i, end);
    i = nul === -1 ? buf.length : nul + 1;
    if (rec.length === 0) continue;
    const tab = rec.indexOf(0x09);
    if (tab < 0) throw new Error('ls-tree record missing tab');
    const meta = utf8Strict(rec.subarray(0, tab), 'ls-tree meta');
    const path = utf8Strict(rec.subarray(tab + 1), 'ls-tree path');
    const match = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40})$/.exec(meta);
    if (!match) throw new Error(`unexpected ls-tree record: ${meta}`);
    const mode = match[1];
    const kind = match[2];
    const gitSha = match[3];
    if (mode === undefined || kind === undefined || gitSha === undefined) throw new Error(`unexpected ls-tree record: ${meta}`);
    if (kind === 'commit' && mode !== GITLINK_MODE) throw new Error(`gitlink mode mismatch: ${path}`);
    if (kind === 'blob' && !BLOB_MODE.test(mode)) throw new Error(`blob mode mismatch: ${path}`);
    if (kind !== 'blob' && kind !== 'commit') throw new Error(`unexpected ls-tree record: ${meta}`);
    entries.push({ mode, type: kind, gitSha, path });
  }
  return entries;
}

function scrub(text: string): string {
  return text
    .replace(/x-access-token:[^@\s]+/gi, 'x-access-token:[REDACTED]')
    .replace(/https:\/\/[^@\s/]+@/g, 'https://[REDACTED]@');
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function git(repo: string, args: readonly string[], encoding: 'utf8'): string;
function git(repo: string, args: readonly string[]): Buffer;
function git(repo: string, args: readonly string[], encoding?: 'utf8'): string | Buffer {
  const command = args[0];
  if (command === undefined || !(GIT_READ_COMMANDS as readonly string[]).includes(command)) {
    throw new Error('git command is not a local read');
  }
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding,
      env: gitEnv(),
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err ? scrub(String(err.stderr ?? '')) : '';
    throw new Error(`git ${command} failed${stderr ? `: ${stderr.trim()}` : ''}`);
  }
}

function hashBlobs(repo: string, shas: string[]): Promise<Map<string, HashedBlob>> {
  const unique = [...new Set(shas)].sort();
  for (const sha of unique) if (!SHA40.test(sha)) throw new Error('refusing to hash a non-object id');
  if (unique.length === 0) return Promise.resolve(new Map());
  return new Promise((resolveHashes, reject) => {
    const child = spawn('git', ['-C', repo, 'cat-file', '--batch'], { env: gitEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const found = new Map<string, HashedBlob>();
    let stderr = '';
    let buf = Buffer.alloc(0);
    let pending: { sha: string; size: number; hash: Hash } | null = null;
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      child.kill();
      reject(error);
    };
    const consume = () => {
      try {
        while (!failed) {
          if (!pending) {
            const nl = buf.indexOf(0x0a);
            if (nl < 0) return;
            const line = utf8Strict(buf.subarray(0, nl), 'cat-file header');
            buf = buf.subarray(nl + 1);
            if (line.endsWith(' missing')) {
              fail(new Error('git object missing'));
              return;
            }
            const header = /^([0-9a-f]{40}) blob (\d+)$/.exec(line);
            const sha = header?.[1];
            const sizeText = header?.[2];
            if (!header || sha === undefined || sizeText === undefined) {
              fail(new Error('unexpected cat-file header'));
              return;
            }
            pending = { sha, size: Number(sizeText), hash: createHash('sha256') };
          }
          if (buf.length < pending.size + 1) return;
          const current = pending;
          current.hash.update(buf.subarray(0, current.size));
          if (buf[current.size] !== 0x0a) {
            fail(new Error('cat-file record missing newline'));
            return;
          }
          found.set(current.sha, { digest: current.hash.digest('hex'), bytes: current.size });
          buf = buf.subarray(current.size + 1);
          pending = null;
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error('cat-file parse failed'));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      consume();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', fail);
    child.on('close', (code) => {
      if (failed) return;
      if (code !== 0) {
        reject(new Error(`git cat-file failed${stderr ? `: ${scrub(stderr).trim()}` : ''}`));
        return;
      }
      consume();
      if (pending || buf.length !== 0) {
        reject(new Error('truncated cat-file stream'));
        return;
      }
      if (found.size !== unique.length) {
        reject(new Error('cat-file result count mismatch'));
        return;
      }
      resolveHashes(found);
    });
    let index = 0;
    const writeMore = () => {
      while (index < unique.length) {
        const sha = unique[index];
        index += 1;
        if (sha === undefined) continue;
        const ok = child.stdin.write(`${sha}\n`);
        if (!ok) {
          child.stdin.once('drain', writeMore);
          return;
        }
      }
      child.stdin.end();
    };
    writeMore();
  });
}

function listRefs(repo: string, remote: string): RefRow[] {
  if (!REMOTE_NAME.test(remote)) throw new Error('remote name rejected');
  const prefix = `refs/remotes/${remote}/`;
  const raw = git(repo, ['for-each-ref', '--format=%(refname)%09%(objecttype)%09%(objectname)%09%(tree)%09%(symref)', prefix], 'utf8');
  const refs: RefRow[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error('short for-each-ref record');
    const refname = fields[0];
    const objecttype = fields[1];
    const objectname = fields[2];
    const tree = fields[3];
    const symref = fields[4];
    if (refname === undefined || objecttype === undefined || objectname === undefined || tree === undefined || symref === undefined) {
      throw new Error('short for-each-ref record');
    }
    if (!refname.startsWith(prefix)) throw new Error('ref outside the remote namespace');
    refs.push({ name: refname.slice(prefix.length), type: objecttype, commit: objectname, tree, symref });
  }
  return refs;
}

function compareItems(a: ManifestItem, b: ManifestItem): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const byName = pathCmp(a.name, b.name);
  if (byName !== 0) return byName;
  if (a.commit !== b.commit) return a.commit < b.commit ? -1 : 1;
  return pathCmp(a.source_ref, b.source_ref);
}

function countsOf(items: ManifestItem[]): Manifest['counts'] {
  const byRepo: Record<string, number> = {};
  let branches = 0;
  let handoverDocs = 0;
  for (const item of items) {
    if (item.kind === 'branch') branches += 1;
    else if (item.kind === 'handover_doc') handoverDocs += 1;
    byRepo[item.intended_repo] = (byRepo[item.intended_repo] ?? 0) + 1;
  }
  const by_repo: Record<string, number> = {};
  for (const key of Object.keys(byRepo).sort(pathCmp)) {
    const count = byRepo[key];
    if (count !== undefined) by_repo[key] = count;
  }
  return { items: items.length, branches, handover_docs: handoverDocs, by_repo };
}

export function serializeManifest(doc: Manifest): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function digestEntries(entries: LsEntry[], hashed: Map<string, HashedBlob>): DigestEntry[] {
  return entries.map((entry) => {
    if (entry.type === 'blob') {
      const hashedBlob = hashed.get(entry.gitSha);
      if (!hashedBlob) throw new Error('missing blob digest');
      return { mode: entry.mode, type: 'blob' as const, path: entry.path, payload: hashedBlob.digest };
    }
    if (entry.type !== 'commit') throw new Error(`unexpected tree entry: ${entry.path}`);
    return { mode: entry.mode, type: 'commit' as const, path: entry.path, payload: entry.gitSha };
  });
}

export async function buildManifest(repo: string, { remote = 'origin' }: { remote?: string } = {}): Promise<Manifest> {
  const root = resolve(repo);
  const refs = listRefs(root, remote);
  const main = refs.find((row) => row.name === 'main' && row.symref === '' && row.type === 'commit');
  if (!main || !SHA40.test(main.commit) || !SHA40.test(main.tree)) throw new Error('origin main commit is missing');
  const excluded: { name: string; reason: string }[] = [];
  const branches: RefRow[] = [];
  for (const ref of refs) {
    if (ref.name === 'HEAD' || ref.symref !== '') {
      excluded.push({ name: ref.name, reason: 'symbolic-ref' });
      continue;
    }
    if (ref.name === 'main') {
      excluded.push({ name: 'main', reason: 'github-canonical-main' });
      continue;
    }
    if (ref.type !== 'commit' || !SHA40.test(ref.commit) || !SHA40.test(ref.tree)) {
      excluded.push({ name: ref.name, reason: 'not-a-commit' });
      continue;
    }
    branches.push(ref);
  }
  excluded.sort((a, b) => pathCmp(a.name, b.name) || pathCmp(a.reason, b.reason));

  const trees = new Map<string, LsEntry[]>();
  const treeOf = (sha: string): LsEntry[] => {
    const cached = trees.get(sha);
    if (cached) return cached;
    const parsed = parseLsTreeZ(git(root, ['ls-tree', '-r', '-z', sha]));
    trees.set(sha, parsed);
    return parsed;
  };
  const handoverRefs = [main, ...branches.filter((row) => row.name.includes('handover'))];
  const blobShas: string[] = [];
  for (const ref of [main, ...branches]) {
    for (const entry of treeOf(ref.tree)) if (entry.type === 'blob') blobShas.push(entry.gitSha);
  }
  const handoverSources: { ref: RefRow; entry: LsEntry }[] = [];
  for (const ref of handoverRefs) {
    for (const entry of treeOf(ref.tree)) {
      if (!entry.path.startsWith(HANDOVER_PREFIX)) continue;
      if (entry.type !== 'blob') throw new Error(`handover path is not a blob: ${entry.path}`);
      handoverSources.push({ ref, entry });
    }
  }
  const hashed = await hashBlobs(root, blobShas);
  const items: ManifestItem[] = [];
  for (const ref of branches) {
    items.push({
      kind: 'branch',
      store: 'cloudflare-artifacts',
      name: ref.name,
      source_ref: `refs/heads/${ref.name}`,
      commit: ref.commit,
      tree: ref.tree,
      content_digest: treeContentDigest(digestEntries(treeOf(ref.tree), hashed)),
      intended_repo: intendedBranchRepo(ref.name),
      state: initialState(),
    });
  }
  for (const source of handoverSources) {
    const hashedBlob = hashed.get(source.entry.gitSha);
    if (!hashedBlob) throw new Error('missing handover blob digest');
    items.push({
      kind: 'handover_doc',
      store: 'cloudflare-artifacts',
      name: source.entry.path,
      source_ref: `refs/heads/${source.ref.name}`,
      commit: source.ref.commit,
      git_blob: source.entry.gitSha,
      bytes: hashedBlob.bytes,
      content_digest: hashedBlob.digest,
      intended_repo: HANDOVER_REPO,
      state: initialState(),
    });
  }
  items.sort(compareItems);
  const counts = countsOf(items);
  const sameCodebase: SameCodebase = {
    store: 'cf-git-same-codebase',
    repository: SOURCE_REPOSITORY,
    ref: 'refs/heads/main',
    commit: main.commit,
    tree: main.tree,
    content_digest: treeContentDigest(digestEntries(treeOf(main.tree), hashed)),
    reason: 'github-canonical-main',
  };
  return {
    schema: SCHEMA,
    namespace: NAMESPACE,
    namespace_expiry_recorded: NAMESPACE_EXPIRY_RECORDED,
    namespace_expiry_note: 'Date recorded by INF-2. Live expiry is NOT_VERIFIED.',
    source_repository: SOURCE_REPOSITORY,
    source_remote_name: remote,
    observed_main: main.commit,
    observation: 'local-git-refs',
    placement: {
      cf_git_same_codebase: sameCodebase,
      cloudflare_artifacts: {
        store: 'cloudflare-artifacts',
        namespace: NAMESPACE,
        role: 'backup-candidate',
        live_cloudflare: 'NOT_VERIFIED',
        credential_use: 'not-performed',
        upload_performed: 'not-performed',
        repo_existence: 'NOT_VERIFIED',
      },
    },
    live_cloudflare: 'NOT_VERIFIED',
    credential_use: 'not-performed',
    upload_performed: 'not-performed',
    identity: 'main is the CF+git same-codebase tree: the GitHub repository this Worker is built from. It is not an Artifacts item. A branch name is a locator. Identity is the commit SHA plus content_digest. content_digest is SHA-256 of canonical tree lines for a branch or for main, or SHA-256 of stored blob bytes for a handover document. A new commit that keeps the same tree keeps the same content_digest. This document is a local git read. It is not a live Cloudflare observation.',
    intended_repo_rule: 'Branch items use <first-segment>-branches. The unsuffixed ref claude-features maps to claude-branches. Blobs under docs/handover/ on main, and on any remote ref whose name contains "handover", are handover documents for handover-20261028. A handover ref is also a branch item for its agent repo. Intended repo names are not a claim that the Artifacts repo exists. main is excluded from Artifacts items and recorded as cf-git-same-codebase.',
    repo_existence: 'NOT_VERIFIED',
    state_legend: {
      uploaded: 'not-uploaded means this inventory records no upload. It is not a live proof that Cloudflare lacks the object.',
      downloaded: 'NOT_VERIFIED',
      hash_matched: 'NOT_VERIFIED',
      independent_reviewed: 'NOT_VERIFIED until a non-producer readback matches content_digest. A pusher readback does not set this.',
      consumed: 'NOT_VERIFIED',
      accepted: 'NOT_VERIFIED',
    },
    excluded,
    counts,
    items_sha256: sha256Hex(JSON.stringify(items)),
    items,
  };
}

type CliOpts = { repo: string | null; out: string | null; check: boolean; stdout: boolean; remote: string };

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { repo: null, out: null, check: false, stdout: false, remote: 'origin' };
  const need = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--stdout') opts.stdout = true;
    else if (arg === '--repo') {
      opts.repo = need(arg, i);
      i += 1;
    } else if (arg === '--out') {
      opts.out = need(arg, i);
      i += 1;
    } else if (arg === '--remote') {
      opts.remote = need(arg, i);
      i += 1;
    } else throw new Error(`unknown argument: ${arg ?? ''}`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const repo = resolve(opts.repo ?? git(process.cwd(), ['rev-parse', '--show-toplevel'], 'utf8').trim());
  const outPath = resolve(repo, opts.out ?? DEFAULT_MANIFEST);
  const doc = await buildManifest(repo, { remote: opts.remote });
  const text = serializeManifest(doc);
  if (opts.stdout) process.stdout.write(text);
  if (opts.check) {
    const current = readFileSync(outPath, 'utf8');
    if (current !== text) {
      process.stderr.write(`manifest drift: ${outPath}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`manifest matches ${outPath} (${doc.counts.items} items)\n`);
  }
  if (!opts.stdout && !opts.check) {
    writeFileSync(outPath, text);
    process.stderr.write(`wrote ${outPath} (${doc.counts.items} items)\n`);
  }
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  void main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${scrub(message)}\n`);
    process.exitCode = 1;
  });
}
