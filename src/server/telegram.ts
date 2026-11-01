// BOUNDARY CONTRACT — mirrors src/server/telegram.ts in the gate MCP repo (agent-workroom-gate-mcp).
//
// This repo (the public codebase) was split from the gate repo; the Telegram bridge (inbound
// webhook and outbound owner notifications) lives on the gate side, where the bot secrets are
// held. This repo has no bot token configured. The entry points fail closed: telegramNotify
// reports the module's own unconfigured error instead of sending anything, and telegramWebhook
// answers 503 TELEGRAM_NOT_CONFIGURED on its own path (null elsewhere) rather than ever
// acknowledging an update as processed here. Phase 2 replaces this seam with calls to the
// gate MCP server, which owns the real implementation.
export interface TelegramEnv { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_WEBHOOK_SECRET?: string; TELEGRAM_OWNER_CHAT_ID?: string }
export interface TelegramDeps {
  postAsOwner(text: string, idempotencyKey: string): Promise<void>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

// The bridge is unconfigured in this repo: the webhook route answers with the
// module's own TELEGRAM_NOT_CONFIGURED state for its own path and null for
// every other path (worker.ts chains it as a pre-auth route). No update is
// ever acknowledged as processed here.
export async function telegramWebhook(_request: Request, _env: TelegramEnv, _deps: TelegramDeps): Promise<Response | null> {
  void _env; void _deps;
  if (new URL(_request.url).pathname !== '/telegram/webhook') return null;
  return new Response(JSON.stringify({ ok: false, error: 'TELEGRAM_NOT_CONFIGURED' }), { status: 503, headers: { 'content-type': 'application/json' } });
}

// No bot token is configured in this repo, so notification truthfully reports unconfigured
// (the real module's own error code for that state) and sends nothing.
export async function telegramNotify(_text: string, _env: TelegramEnv, _deps: Pick<TelegramDeps, 'fetch'>): Promise<{ ok: boolean; error?: string }> {
  void _text; void _env; void _deps;
  return { ok: false, error: 'TELEGRAM_NOT_CONFIGURED' };
}
