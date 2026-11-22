// Authenticated G1 execution-run route. The path is not a task claim, so
// worker.ts does not schedule shadowClaim and does not start a second model call.
import { z } from 'zod';
import { Fault } from './contracts.ts';
import type { Workroom } from './domain.ts';
import { DEFAULT_BUDGET_CAP_USD_MICROS } from './dispatch-wire.ts';
import {
  LIVE_MAX_PROMPT_CHARS, LIVE_MAX_TOKENS, LIVE_MODEL, superviseRun,
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
  prompt: z.string().min(1).max(LIVE_MAX_PROMPT_CHARS),
  max_tokens: z.number().int().min(1).max(LIVE_MAX_TOKENS).default(LIVE_MAX_TOKENS),
  project: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/).default('g1'),
  model: z.literal(LIVE_MODEL).default(LIVE_MODEL),
}).strict();

function configuredKey(env: object): string | null {
  const key = (env as { OPENROUTER_API_KEY?: unknown }).OPENROUTER_API_KEY;
  if (typeof key !== 'string' || key.length === 0 || key.trim() !== key) return null;
  if (/[\r\n\0]/.test(key)) return null;
  return key;
}

export async function executionRunRoute(
  service: Workroom,
  env: object,
  request: Request,
  url: URL,
  readJSON: () => Promise<unknown>,
) {
  const match = /^\/api\/v1\/rooms\/([^/]+)\/execution-runs$/.exec(url.pathname);
  if (!match) return null;
  if (url.search) throw new Fault('INVALID_INPUT', 'No query parameters.');
  let room: string;
  try { room = decodeURIComponent(match[1] ?? ''); } catch { throw new Fault('INVALID_INPUT', 'Room path is not valid.'); }
  if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  if (room !== ROOM) throw new Fault('INVALID_INPUT', 'G1 execution runs are bound to room_main.');
  await service.authorize(room, true);
  const apiKey = configuredKey(env);
  if (!apiKey) throw new Fault('DISPATCH_NOT_CONFIGURED', 'OpenRouter dispatch is not configured.', 503);
  const body = await readJSON();
  if (!body || typeof body !== 'object' || Array.isArray(body) || BODY_IDENTITY.some(key => key in body)) {
    throw new Fault('INVALID_INPUT', 'Identity and path fields cannot be supplied in the body.');
  }
  const input = executionRunSchema.parse({ schema_version: '1', ...body });
  const report = await superviseRun(service.database, {
    project: input.project, task_id: input.task_id, run_id: input.run_id, attempt_id: input.attempt_id,
    principal: service.principal, lease_epoch: input.lease_epoch, intent_revision: input.intent_revision,
    cancel_generation: input.cancel_generation, model: input.model, prompt: input.prompt,
    max_tokens: input.max_tokens, api_key: apiKey, cap_micro_usd: DEFAULT_BUDGET_CAP_USD_MICROS,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
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
    },
    meta: {},
  };
}
