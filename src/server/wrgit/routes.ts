import { z } from 'zod';
import { Fault } from '../contracts.ts';
import type { Env } from '../db.ts';
import type { WrgitClaim } from '../tasks.ts';
import type { ArtifactsBinding } from './artifacts-binding.ts';
import { mergeTask, submitWorkspace } from './merge.ts';
import { ensureWorkspace, openWorkspace, pendingHeldTask, pendingMarkerStatement, prepareWrgit, readWorkspace } from './workspaces.ts';

const workspaceBody = z.object({ task_id: z.string().min(1).max(128) }).strict();
const itemPath = /^\/git\/workspaces\/([^/]+)$/;

export function wrgitClaim(env: Env, artifacts: ArtifactsBinding | undefined): WrgitClaim | undefined {
  if (env.WRGIT_ENABLED !== '1') return undefined;
  return {
    enabled: true,
    prepare: () => prepareWrgit(artifacts),
    ensureWorkspace: async (taskId, agentId) => { await ensureWorkspace(env, artifacts, taskId, agentId); },
    pendingHeld: async (taskId, agentId) => (await pendingHeldTask(env, agentId, taskId)) !== null,
    pendingTask: (agentId) => pendingHeldTask(env, agentId),
    pendingMarker: (fresh, args, taskId, agentId) => pendingMarkerStatement(env.DB, fresh, args, taskId, agentId),
  };
}

export async function wrgitRoute(env: Env, artifacts: ArtifactsBinding | undefined, request: Request, url: URL, principal: string, readJSON: () => Promise<unknown>): Promise<{ data: unknown; meta: object } | null> {
  const item = itemPath.exec(url.pathname);
  const collection = url.pathname === '/git/workspaces';
  if (!item && !collection) return null;
  if (env.WRGIT_ENABLED !== '1') return null;
  if (url.search) throw new Fault('INVALID_INPUT', 'Query parameters are unsupported.');
  if (!artifacts) throw new Fault('UNAVAILABLE', 'Artifacts binding is not configured.', 503, 'unknown', true);
  if (collection && request.method === 'POST') {
    const body = workspaceBody.parse(await readJSON());
    return { data: await openWorkspace(env, artifacts, body.task_id, principal), meta: {} };
  }
  if (item && request.method === 'GET') return { data: await readWorkspace(env, artifacts, decodeURIComponent(item[1]!)), meta: {} };
  throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
}

const submitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
}).strict();
const mergeSchema = z.object({
  task_id: z.string().min(1).max(128),
  receipt_id: z.string().min(1).max(128),
}).strict();

const SUBMIT = /^\/git\/workspaces\/([^/]+)\/submit$/;

export async function gitRoute(
  request: Request,
  url: URL,
  env: Env,
  artifacts: ArtifactsBinding | undefined,
  principal: string,
  readJSON: () => Promise<unknown>,
): Promise<{ data: unknown; meta: Record<string, never> } | null> {
  const submit = SUBMIT.exec(url.pathname);
  const isMerge = url.pathname === '/git/merge';
  if (!submit && !isMerge) return null;
  if (env.WRGIT_ENABLED !== '1') return null;
  if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  if (url.search) throw new Fault('INVALID_INPUT', 'Query parameters are unsupported.');
  if (!artifacts) throw new Fault('UNAVAILABLE', 'Artifacts binding is not configured.', 503);
  const body = await readJSON();
  if (submit) {
    let workspaceId = submit[1] ?? '';
    try { workspaceId = decodeURIComponent(workspaceId); }
    catch { throw new Fault('INVALID_INPUT', 'Workspace id is not valid.'); }
    const input = submitSchema.parse(body);
    return { data: await submitWorkspace(env.DB, artifacts, principal, workspaceId, input.sha), meta: {} };
  }
  const input = mergeSchema.parse(body);
  return { data: await mergeTask(env.DB, artifacts, principal, input.task_id, input.receipt_id), meta: {} };
}
