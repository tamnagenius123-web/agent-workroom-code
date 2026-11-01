import type { ArtifactsBinding, ArtifactsCommit, ArtifactsRepoInfo } from './artifacts-binding.ts';

// The real ARTIFACTS binding (workers-types 5.20261028.1, interfaces Artifacts and ArtifactsRepo).
// Only the members WR-GIT calls are listed. The namespace creates, imports, gets, and deletes repos.
// Everything else lives on the disposable handle returned by get(name).
// The native API has no fast-forward or ref update, so this adapter does not provide
// MergeArtifacts and /git/merge fails closed with 503 (merge.ts writer()).

interface NativeCreateRepoResult { name: string; remote: string; defaultBranch: string; token: string }
interface NativeRepoInfo { name: string; defaultBranch: string; source: string | null; remote: string }
interface NativeCommit { hash: string; message: string; author: { name: string }; authoredAt: number }

export interface NativeArtifactsRepo extends Disposable {
  info(): Promise<NativeRepoInfo>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<NativeCommit[]>;
  fork(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<NativeCreateRepoResult>;
  createToken(scope?: 'write' | 'read', ttl?: number): Promise<{ plaintext: string; scope: 'read' | 'write'; expiresAt: string }>;
  readFile(args: { ref: string; path: string }): Promise<Blob | null>;
}

export interface NativeArtifacts {
  create(name: string, opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string }): Promise<NativeCreateRepoResult>;
  get(name: string): Promise<NativeArtifactsRepo>;
  import(params: { source: { url: string; branch?: string; depth?: number }; target: { name: string; opts?: { description?: string; readOnly?: boolean } } }): Promise<NativeCreateRepoResult>;
  delete(name: string): Promise<boolean>;
}

// Callers match on message === 'NOT_FOUND'. The native message can carry request detail, so only the code is kept.
function normalized(error: unknown): Error {
  const code = (error as { code?: unknown } | null)?.code;
  return new Error(typeof code === 'string' ? code : 'INTERNAL_ERROR');
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { throw normalized(error); }
}

function ref(result: NativeCreateRepoResult) {
  return { name: result.name, remote: result.remote, defaultBranch: result.defaultBranch, token: result.token };
}

export function nativeArtifacts(ns: NativeArtifacts): ArtifactsBinding {
  const withRepo = <T>(name: string, run: (repo: NativeArtifactsRepo) => Promise<T>) => guard(async () => {
    const repo = await ns.get(name);
    try { return await run(repo); }
    finally { repo[Symbol.dispose]?.(); }
  });
  return {
    create: (name, opts) => guard(async () => ref(await ns.create(name, { readOnly: opts?.readOnly, description: opts?.description, setDefaultBranch: opts?.defaultBranch }))),
    import: params => guard(async () => ref(await ns.import({ source: { url: params.url, branch: params.branch, depth: params.depth }, target: { name: params.name } }))),
    delete: name => guard(() => ns.delete(name)),
    get: name => withRepo(name, async (repo): Promise<ArtifactsRepoInfo> => {
      const info = await repo.info();
      const head = (await repo.log({ limit: 1 }))[0]?.hash ?? null;
      return { name: info.name, remote: info.remote, defaultBranch: info.defaultBranch, headSha: head, sourceUrl: info.source };
    }),
    fork: (source, name, opts) => withRepo(source, async repo => ref(await repo.fork(name, opts))),
    issueToken: (name, scope = 'write', ttl) => withRepo(name, async repo => {
      const issued = await repo.createToken(scope, ttl);
      return { token: issued.plaintext, scope: issued.scope, expiresAt: Date.parse(issued.expiresAt) };
    }),
    readFile: (name, at, path) => withRepo(name, async repo => {
      const blob = await repo.readFile({ ref: at, path });
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    }),
    log: (name, opts) => withRepo(name, async repo => (await repo.log(opts)).map((commit): ArtifactsCommit => ({
      hash: commit.hash, message: commit.message, authorName: commit.author.name, authoredAt: commit.authoredAt,
    }))),
  };
}
