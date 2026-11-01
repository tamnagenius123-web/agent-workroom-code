// agent:claude wake loop: polls unread for agent:claude and answers @claude/@클로드 mentions with
// headless Claude Code (Opus 5.5, effort medium, subagents from .claude/agents). Never logs secrets.
// Auth order: authOrder(now) = api-first before 2026-11-01 00:00 KST (promo API credit expires then),
// subscription-first from then on. CLAUDE_AUTH=api|subscription forces the primary; CLAUDE_AUTH_SWITCH_AT
// moves the cutover. A failed primary run (402/credit/rate limit/any error) falls back to the other mode once.
// Soft guard: API spend (total_cost_usd from claude JSON, ledger state/api-spend.json) stops at
// CLAUDE_API_BUDGET_USD (default 199, under the $199.99 credit); beyond it only subscription is used.
// Env: WORKROOM_GW (gw.mts client dir), CLAUDE_AGENT_DIR (state + SYSTEM.md), CLAUDE_MODEL, CLAUDE_EFFORT, CLAUDE_POLL_MS.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { unitOf } from './claude-meter.mts';

const GW = process.env.WORKROOM_GW ?? '/workspace/tools/grok-workroom';
const D = process.env.CLAUDE_AGENT_DIR ?? '/workspace/tools/claude-agent';
const REPO = process.env.CLAUDE_REPO ?? new URL('..', import.meta.url).pathname;
const WT = process.env.CLAUDE_WT ?? '/workspace/claude-wt';
const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5-5';
const EFFORT = process.env.CLAUDE_EFFORT ?? 'medium';
const SWITCH_AT = Date.parse(process.env.CLAUDE_AUTH_SWITCH_AT ?? '2026-11-01T00:00:00+09:00');
const BUDGET = Number(process.env.CLAUDE_API_BUDGET_USD ?? 199);
const LEDGER = D + '/state/api-spend.json';
const POLL = Number(process.env.CLAUDE_POLL_MS ?? 15000);
const MENTION = /@(claude|클로드)(?![\p{L}\p{N}_])/iu;
mkdirSync(D + '/state', { recursive: true });

interface Msg { id: string; actor_id: string; created_at: string; text?: string; thread_id?: string }
const redact = (s: string): string => s.replace(/Bearer\s+\S+/g, 'Bearer ***').replace(/sk-ant-[\w-]+/g, '***');
const log = (o: Record<string, unknown>): void => appendFileSync(D + '/state/wake.log', JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');
interface GwResult { ok?: boolean; error?: { code?: string }; meta?: { has_more?: boolean }; data?: { messages?: Msg[]; id?: string; message?: { id?: string } } }
const gw = (...a: string[]): GwResult => JSON.parse(execFileSync('npx', ['tsx', 'gw.mts', '--as', 'agent:claude', ...a], { cwd: GW, encoding: 'utf8', timeout: 60000 }));

export function claudeArgs(prompt: string, system: string): string[] {
  return ['-p', prompt, '--model', MODEL, '--effort', EFFORT, '--append-system-prompt', system, '--output-format', 'json', '--max-turns', process.env.CLAUDE_MAX_TURNS ?? '80', '--add-dir', WT,
    '--allowedTools', `Task,Read,Grep,Glob,Edit(${WT}/**),Write(${WT}/**),MultiEdit(${WT}/**),Bash(npx tsx ${GW}/gw.mts --as agent:claude latest:*),Bash(git:*),Bash(npm test:*),Bash(npm ci:*),Bash(npm install:*),Bash(npx vitest:*),Bash(npx tsc:*),Bash(ls:*),Bash(cat:*),Bash(mkdir -p ${WT}/*),Bash(cd ${WT}/*)`,
    '--disallowedTools', 'Bash(git push origin main:*),Bash(git push origin HEAD:main:*),Bash(git push -f:*),Bash(git push --force:*),Bash(npx wrangler:*),Bash(wrangler:*),Bash(git merge:*),Bash(env:*),Bash(printenv:*)'];
}
export function authEnv(mode: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (mode === 'api') { if (!env.ANTHROPIC_API_KEY) throw new Error('CLAUDE_AUTH=api needs ANTHROPIC_API_KEY'); return env; }
  const rest = { ...env }; delete rest.ANTHROPIC_API_KEY; delete rest.ANTHROPIC_AUTH_TOKEN; return rest;
}
export function authOrder(now: number, env: NodeJS.ProcessEnv, spentUsd: number, switchAt = SWITCH_AT, budget = BUDGET): string[] {
  const forced = env.CLAUDE_AUTH;
  let order = forced === 'api' ? ['api', 'subscription'] : forced === 'subscription' ? ['subscription', 'api'] : now < switchAt ? ['api', 'subscription'] : ['subscription', 'api'];
  if (!env.ANTHROPIC_API_KEY || spentUsd >= budget) order = order.filter(m => m !== 'api');
  if (env.CLAUDE_AUTH_FALLBACK === '0') order = order.slice(0, 1);
  return order;
}
export const readSpend = (f = LEDGER): number => { try { return Number(JSON.parse(readFileSync(f, 'utf8')).usd) || 0; } catch { return 0; } };
interface Run { out: string; auth: string; usage?: Record<string, number | undefined>; cost?: number }
function runClaude(prompt: string, system: string): Run {
  const go = (mode: string): Run => {
    const raw = execFileSync('claude', claudeArgs(prompt, system), { cwd: REPO, encoding: 'utf8', timeout: 900000, env: authEnv(mode, process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    const j = JSON.parse(raw) as { result?: string; is_error?: boolean; total_cost_usd?: number; usage?: Record<string, number> };
    if (mode === 'api' && j.total_cost_usd) writeFileSync(LEDGER, JSON.stringify({ usd: readSpend() + j.total_cost_usd, updated: new Date().toISOString() }));
    if (j.is_error) throw new Error('claude error: ' + String(j.result).slice(0, 200));
    const u = j.usage ?? {};
    return { out: (j.result ?? '').trim(), auth: mode, cost: j.total_cost_usd, usage: { input: u.input_tokens, output: u.output_tokens, cache_read: u.cache_read_input_tokens, cache_write: u.cache_creation_input_tokens } };
  };
  const order = authOrder(Date.now(), process.env, readSpend());
  if (!order.length) throw new Error('no auth mode available');
  let err: unknown;
  for (const mode of order) {
    try { return go(mode); } catch (e) { err = e; log({ ev: 'auth_fallback', from: mode, err: redact(String((e as Error).message)).slice(0, 200) }); }
  }
  throw err;
}
async function handle(m: Msg, system: string): Promise<void> {
  const t0 = Date.now(); log({ ev: 'wake', id: m.id, from: m.actor_id, lag_ms: t0 - Date.parse(m.created_at) });
  let out = '', auth = 'none', usage: Run['usage'], cost: number | undefined;
  try { ({ out, auth, usage, cost } = runClaude(`Message ${m.id} from ${m.actor_id} at ${m.created_at}:\n\n${m.text ?? ''}\n\nReply as agent:claude.`, system)); }
  catch (e) { out = `[Claude] I was woken by ${m.id} but my run failed (${redact(String((e as Error).message)).slice(0, 120)}). Will retry on next mention.`; }
  if (!out) out = '[Claude] (empty response)';
  const f = D + '/state/reply.json';
  writeFileSync(f, JSON.stringify({ room: 'room_main', format: 'markdown', text: `[Claude] re ${m.id} (@${m.actor_id.slice(6)})\n\n` + out.slice(0, 15000), ...(m.thread_id ? { thread_id: m.thread_id, reply_to_message_id: m.id } : {}), idempotency_key: 'claude-reply-' + m.id }));
  const r = gw('call', 'workroom_message_post', f);
  log({ ev: 'replied', id: m.id, unit: unitOf(m.text), auth, usage, cost_usd: cost, api_spent_usd: readSpend(), model: MODEL, effort: EFFORT, reply: r?.data?.message?.id ?? r?.data?.id ?? null, ok: r?.ok, err: r?.error?.code, handle_ms: Date.now() - t0, total_ms: Date.now() - Date.parse(m.created_at) });
}
export async function loop(): Promise<never> {
  const system = readFileSync(D + '/SYSTEM.md', 'utf8');
  for (;;) {
    try {
      let more = true;
      while (more) {
        const r = gw('unread');
        const ms = (r.data?.messages ?? []).filter(m => m.actor_id !== 'agent:claude' && MENTION.test(m.text ?? ''));
        for (const m of ms) await handle(m, system);
        more = !!r.meta?.has_more;
      }
    } catch (e) { log({ ev: 'poll_error', err: redact(String((e as Error).message)).slice(0, 300) }); }
    writeFileSync(D + '/state/heartbeat', new Date().toISOString());
    await new Promise(res => setTimeout(res, POLL));
  }
}
if (process.argv[1]?.endsWith('claude-runner.mts')) await loop();
