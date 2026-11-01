import { retain } from './retention.ts';
import { deliver, wakeAuthFrom } from './notify.ts';
import { expireFiles } from './files.ts';
import { createApp } from './app.ts';
import { intentOwnerRoutes } from './intent.ts';
import type { Env } from './db.ts';
import { Workroom } from './domain.ts';
import { ROOM, postSchema } from './contracts.ts';
import { telegramWebhook, type TelegramEnv } from './telegram.ts';
import { g5Authenticate, g5Capabilities, g5Routes, wwwAuthenticate, type G5Env } from '../auth/g5.ts';

// Production: G5 hosted OAuth through the G4 authority. Missing configuration => 503 AUTH_NOT_CONFIGURED.
// Owner intent writes run before G5. An agent bearer token never reaches them.
const app = createApp((request, env) => g5Authenticate(request, env as G5Env), {
  ui: false, connection: (env, identity) => g5Capabilities(env as G5Env, identity),
  pre: async (request, env) => (await telegramWebhook(request, env as TelegramEnv, {
    postAsOwner: async (text, key) => { await new Workroom(env.DB, 'user:minsung', undefined, wakeAuthFrom(env)).post(postSchema.parse({ schema_version: '1', room: ROOM, text, format: 'markdown', idempotency_key: key })); },
    fetch: (url, init) => fetch(url, init),
  })) ?? (await intentOwnerRoutes(request, env as G5Env)) ?? g5Routes(request, env as G5Env),
  legacy: env => (env as G5Env).MCP_COMPAT === '1',
});
interface Ctx { waitUntil(p: Promise<unknown>): void }
export default { async scheduled(_e: unknown, env: Env, ctx: Ctx) { ctx.waitUntil(deliver(env.DB, undefined, wakeAuthFrom(env))); ctx.waitUntil(expireFiles(env.DB, env.FILES ?? null, Date.now()).catch(() => undefined)); if (new Date().getUTCMinutes() === 7) ctx.waitUntil(retain(env.DB, Date.now(), (env as { RETENTION_MODE?: string }).RETENTION_MODE === 'delete' ? 'delete' : 'dry_run')); },
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const response = await app.fetch(request, env, ctx);
  if (response.status !== 401) return response;
  const challenge = wwwAuthenticate(env as G5Env);
  if (!challenge) return response;
  const out = new Response(response.body, response);
  out.headers.set('WWW-Authenticate', challenge);
  return out;
} };
