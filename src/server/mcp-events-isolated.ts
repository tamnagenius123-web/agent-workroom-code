import { createApp, type AppOptions, type Authenticate } from './app.ts';
import type { Env } from './db.ts';
import { McpEvents, type IsolatedEventsBindings } from './mcp-events.ts';

/** Entry factory for a separate synthetic database, authenticated connection and guarded egress. */
export function isolatedMcpEvents(
  authenticate: Authenticate, bindings: (env: Env) => IsolatedEventsBindings,
  options: Omit<AppOptions, 'isolatedEvents'> = {},
) {
  const events = (env: Env) => new McpEvents(env.DB, bindings(env));
  const app = createApp(authenticate, { ...options, ui: false, isolatedEvents: events });
  return {
    fetch: app.fetch,
    scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
      ctx.waitUntil(events(env).sweep().catch(() => { throw new Error('MCP Events sweep failed.'); }));
    },
  };
}
