// Subset of the Cloudflare Artifacts Workers binding used by WR-GIT.
// The live `workroom` namespace is not bound yet: the API token has no Artifacts permission.
// Names match the calls this worker will make. create/import/get/delete are namespace methods.
// fork, issueToken (binding createToken), readFile, and log are repo methods, flattened here
// so callers do not depend on the disposable RPC handle. A memory fake stands in for tests.

export const ARTIFACTS_OPS = ['create', 'import', 'fork', 'get', 'delete', 'issueToken', 'readFile', 'log'] as const;

export interface ArtifactsCreateOptions {
  description?: string;
  readOnly?: boolean;
  defaultBranch?: string;
}

export interface ArtifactsImportParams {
  url: string;
  name: string;
  branch?: string;
  depth?: number;
}

export interface ArtifactsForkOptions {
  description?: string;
  readOnly?: boolean;
  defaultBranchOnly?: boolean;
}

export interface ArtifactsRepoRef {
  name: string;
  remote: string;
  defaultBranch: string;
  token: string;
}

export interface ArtifactsRepoInfo {
  name: string;
  remote: string;
  defaultBranch: string;
  headSha: string | null;
  sourceUrl: string | null;
}

export interface ArtifactsToken {
  token: string;
  scope: 'read' | 'write';
  expiresAt: number;
}

export interface ArtifactsCommit {
  hash: string;
  message: string;
  authorName: string;
  authoredAt: number;
}

export interface ArtifactsLogOptions {
  ref?: string;
  limit?: number;
  offset?: number;
}

export interface ArtifactsBinding {
  create(name: string, opts?: ArtifactsCreateOptions): Promise<ArtifactsRepoRef>;
  import(params: ArtifactsImportParams): Promise<ArtifactsRepoRef>;
  fork(source: string, name: string, opts?: ArtifactsForkOptions): Promise<ArtifactsRepoRef>;
  get(name: string): Promise<ArtifactsRepoInfo>;
  delete(name: string): Promise<boolean>;
  issueToken(repo: string, scope?: 'read' | 'write', ttlSeconds?: number): Promise<ArtifactsToken>;
  readFile(repo: string, ref: string, path: string): Promise<Uint8Array | null>;
  log(repo: string, opts?: ArtifactsLogOptions): Promise<ArtifactsCommit[]>;
}

export function assertArtifactsBinding(value: unknown): ArtifactsBinding {
  if (value === null || typeof value !== 'object') throw new Error('ArtifactsBinding is missing.');
  const record = value as Record<string, unknown>;
  for (const op of ARTIFACTS_OPS) {
    if (typeof record[op] !== 'function') throw new Error(`ArtifactsBinding.${op} is missing.`);
  }
  return value as ArtifactsBinding;
}
