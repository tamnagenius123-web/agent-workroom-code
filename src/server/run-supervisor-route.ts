// Authenticated G1/G2 execution-run routes. None of these paths match
// /tasks/:id/claim, so worker.ts does not schedule shadowClaim.
import { z } from 'zod';
import { Fault } from './contracts.ts';
import type { Workroom } from './domain.ts';
import { budgetCapUsdMicros, type DispatchEnv } from './dispatch-wire.ts';
import { reconcileRunCost } from './execution-cost.ts';
import { nativeSubmitSchema, submitNative } from './native-submission.ts';
import {
  getRunStatus, heartbeatRun, interruptRun,
  EXECUTION_MAX_PROMPT_CHARS, LIVE_MAX_TOKENS, LIVE_MODEL,
  resumeRun, superviseRun, type RunReport,
} from './run-supervisor.ts';

const ROOM = 'room_main';
const BODY_IDENTITY = ['room', 'idempotency_key', 'principal_id', 'actor_id', 'principal', 'api_key'];

export const executionRunSchema = z.object({
  schema_version: z.literal('1'),
  task_id: z.string().min(1).max(128),
  run_id: z.string().min(1).max(128),
  attempt_id: z.string().min(1).max(128),
  lease_epoch: z.number().int().min(0),
  intent_revision: z.number().int().min(0),
  cancel_generation: z.number().int().min(0).default(0),
  prompt: z.string().min(1).max(EXECUTION_MAX_PROMPT_CHARS),
  max_tokens: z.number().int().min(1).max(LIVE_MAX_TOKENS).default(LIVE_MAX_TOKENS),
  project: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/).default('g1'),
  model: z.string().min(1).max(128).default(LIVE_MODEL),
}).strict();

export const executionInterruptSchema = z.object({
  schema_version: z.literal('1'),
  task_id: z.string().min(1).max(128),
  run_id: z.string().min(1).max(128).optional(),
  reason: z.string().min(1).max(256).default('owner_interrupt'),
}).strict();

export const executionHeartbeatSchema = z.object({
  schema_version: z.literal('1'),
  task_id: z.string().min(1).max(128),
  run_id: z.string().min(1).max(128),
  attempt_id: z.string().min(1).max(128),
  lease_epoch: z.number().int().min(0),
  intent_revision: z.number().int().min(0),
  cancel_generation: z.number().int().min(0).default(0),
  execution_generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();

export const executionReconcileSchema = z.object({
  schema_version: z.literal('1'),
  run_id: z.string().min(1).max(128),
}).strict();

function configuredKey(env: object): string | null {
  const key = (env as { OPENROUTER_API_KEY?: unknown }).OPENROUTER_API_KEY;
  if (typeof key !== 'string' || key.length === 0 || key.trim() !== key) return null;
  if (/[\r\n\0]/.test(key)) return null;
  return key;
}

function rejectIdentityBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body) || BODY_IDENTITY.some(key => key in body)) {
    throw new Fault('INVALID_INPUT', 'Identity and path fields cannot be supplied in the body.');
  }
  return body as Record<string, unknown>;
}

function runPayload(
  input: z.infer<typeof executionRunSchema>,
  report: RunReport,
) {
  return {
    data: {
      state: report.state,
      failure: report.failure,
      disposition: report.disposition,
      run_id: input.run_id,
      attempt_id: input.attempt_id,
      task_id: input.task_id,
      generation_id: report.generation_id,
      reservation_id: report.reservation_id,
      artifact_id: report.artifact_id,
      receipt_id: report.receipt_id,
      fetches: report.fetches,
      trace: report.trace,
      ...(report.blocking_run_id ? { blocking_run_id: report.blocking_run_id } : {}),
      check_kind: 'execution_self_check',
      task_approved: false,
    },
    meta: {},
  };
}

export async function executionRunRoute(
  service: Workroom,
  env: object,
  request: Request,
  url: URL,
  readJSON: () => Promise<unknown>,
) {
  const match = /^\/api\/v1\/rooms\/([^/]+)\/execution-runs(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) return null;
  if (url.search) throw new Fault('INVALID_INPUT', 'No query parameters.');
  let room: string;
  try { room = decodeURIComponent(match[1] ?? ''); } catch { throw new Fault('INVALID_INPUT', 'Room path is not valid.'); }
  if (room !== ROOM) throw new Fault('INVALID_INPUT', 'G1/G2 execution runs are bound to room_main.');
  let tail: string | undefined;
  try { tail = match[2] ? decodeURIComponent(match[2]) : undefined; } catch { throw new Fault('INVALID_INPUT', 'Execution run path is not valid.'); }

  if (tail === 'native-submit') {
    if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
    // Native publication consumes a settled run and never calls the provider.
    // Its strict schema owns the exact retry key; identity comes from service.
    return submitNative(service, nativeSubmitSchema.parse(await readJSON()));
  }

  if (tail === 'reconcile') {
    if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
    await service.authorize(room, true);
    const apiKey = configuredKey(env);
    if (!apiKey) throw new Fault('DISPATCH_NOT_CONFIGURED', 'OpenRouter dispatch is not configured.', 503);
    const input = executionReconcileSchema.parse({ schema_version: '1', ...rejectIdentityBody(await readJSON()) });
    const data = await reconcileRunCost(service.database, { run_id: input.run_id, principal: service.principal,
      api_key: apiKey, cap_micro_usd: budgetCapUsdMicros(env as DispatchEnv),
      fetch: (target, init) => globalThis.fetch(target, init) });
    return { data, meta: {} };
  }

  if (!tail || tail === 'resume') {
    if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
    await service.authorize(room, true);
    const apiKey = configuredKey(env);
    if (!apiKey) throw new Fault('DISPATCH_NOT_CONFIGURED', 'OpenRouter dispatch is not configured.', 503);
    const body = rejectIdentityBody(await readJSON());
    const input = executionRunSchema.parse({ schema_version: '1', ...body });
    const runInput = {
      project: input.project, task_id: input.task_id, run_id: input.run_id, attempt_id: input.attempt_id,
      principal: service.principal, lease_epoch: input.lease_epoch, intent_revision: input.intent_revision,
      cancel_generation: input.cancel_generation, model: input.model, prompt: input.prompt,
      max_tokens: input.max_tokens, api_key: apiKey, cap_micro_usd: budgetCapUsdMicros(env as DispatchEnv),
      fetch: (target: string | URL | Request, init?: RequestInit) => globalThis.fetch(target, init),
    };
    const report = tail === 'resume'
      ? await resumeRun(service.database, runInput)
      : await superviseRun(service.database, runInput);
    return runPayload(input, report);
  }

  if (tail === 'interrupt') {
    if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
    await service.authorize(room, true);
    const body = rejectIdentityBody(await readJSON());
    const input = executionInterruptSchema.parse({ schema_version: '1', ...body });
    const result = await interruptRun(service.database, {
      task_id: input.task_id,
      run_id: input.run_id ?? null,
      principal: service.principal,
      reason: input.reason,
    });
    if (!result.ok) {
      if (result.failure === 'forbidden') throw new Fault('FORBIDDEN', 'Only the task creator or an owner can interrupt this task.', 403);
      if (result.failure === 'task_mismatch') throw new Fault('INVALID_INPUT', 'Run does not belong to task.');
      throw new Fault('NOT_FOUND', 'Task or execution run not found.', 404);
    }
    return { data: result, meta: {} };
  }

  if (tail === 'heartbeat') {
    if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
    await service.authorize(room, true);
    const body = rejectIdentityBody(await readJSON());
    const input = executionHeartbeatSchema.parse({ schema_version: '1', ...body });
    const result = await heartbeatRun(service.database, {
      task_id: input.task_id,
      run_id: input.run_id,
      attempt_id: input.attempt_id,
      principal: service.principal,
      lease_epoch: input.lease_epoch,
      intent_revision: input.intent_revision,
      cancel_generation: input.cancel_generation,
      execution_generation: input.execution_generation,
    });
    return { data: result, meta: {} };
  }

  if (request.method !== 'GET') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  await service.authorize(room, false);
  const view = await getRunStatus(service.database, tail);
  if (!view) throw new Fault('NOT_FOUND', 'Execution run not found.', 404);
  return { data: view, meta: {} };
}
