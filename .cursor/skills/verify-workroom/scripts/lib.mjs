import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

export const ROOT = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
export const SKILL = ROOT + '/.cursor/skills/verify-workroom';
export const EVIDENCE = SKILL + '/evidence/pinned-discovery';
export const STATE = '/tmp/verify-workroom/current.json';
export const PINNED_ORIGIN = 'https://agent-workroom-main.tamnagenius123.workers.dev';
export const PINNED_RESOURCE = PINNED_ORIGIN + '/mcp';
export const PINNED_REDIRECT = PINNED_ORIGIN + '/oauth/internal/grok-callback';
export const PINNED_HOST = 'agent-workroom-main.tamnagenius123.workers.dev';
export const WRANGLER = 'wrangler@4.152.0';

export function cleanEnv() {
  const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_API_KEY;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  return env;
}

export function assertLocal(args) {
  const bad = args.filter((a) => a === '--remote' || a.startsWith('--remote=') || a === '-r');
  if (bad.length) throw new Error('refusing remote wrangler flag');
  if (!args.includes('--local')) throw new Error('wrangler invocation is missing --local');
}

export function wrangler(args, opts = {}) {
  assertLocal(args);
  return execFileSync('npx', ['--yes', WRANGLER, ...args], {
    encoding: 'utf8', cwd: opts.cwd ?? ROOT, env: cleanEnv(), maxBuffer: 10 * 1024 * 1024,
    stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

export function parseWranglerJson(text) {
  const start = text.indexOf('[');
  if (start < 0) throw new Error('wrangler did not return JSON');
  return JSON.parse(text.slice(start));
}

export function readState() {
  if (!existsSync(STATE)) return null;
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

export function writeState(state) {
  mkdirSync('/tmp/verify-workroom', { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function pinnedFromWrangler() {
  const text = readFileSync(ROOT + '/wrangler.jsonc', 'utf8');
  const m = text.match(/"WORKROOM_RESOURCE":\s*"([^"]+)"/);
  if (!m) throw new Error('WORKROOM_RESOURCE missing from wrangler.jsonc');
  return m[1];
}

export function d1Name() {
  const text = readFileSync(ROOT + '/wrangler.jsonc', 'utf8');
  const m = text.match(/"database_name":\s*"([^"]+)"/);
  if (!m) throw new Error('database_name missing from wrangler.jsonc');
  return m[1];
}

export function redact(text) {
  return String(text)
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/\bwra_[A-Za-z0-9_-]+/g, 'wra_***')
    .replace(/\bwrr_[A-Za-z0-9_-]+/g, 'wrr_***')
    .replace(/\bwrc_[A-Za-z0-9_-]+/g, 'wrc_***')
    .replace(/("code"\s*:\s*")[^"]+"/g, '$1***"')
    .replace(/(code=)[^&"\s]+/g, '$1***')
    .replace(/WORKROOM_TOKEN_PEPPER=\S+/g, 'WORKROOM_TOKEN_PEPPER=***')
    .replace(/OWNER_PASSWORD_HASH=\S+/g, 'OWNER_PASSWORD_HASH=***');
}

export function curl(args) {
  const out = execFileSync('curl', ['-sk', '--resolve', `${PINNED_HOST}:443:127.0.0.1`, '--max-time', '20', '-w', '\n%{http_code}', ...args], {
    encoding: 'utf8', env: cleanEnv(),
  });
  const nl = out.lastIndexOf('\n');
  const body = nl < 0 ? out : out.slice(0, nl);
  const status = Number(nl < 0 ? '0' : out.slice(nl + 1).trim());
  let json = null;
  try { json = JSON.parse(body); } catch { json = null; }
  return { status, body, json };
}

export function spawnWrangler(args, logPath) {
  assertLocal(args);
  const fd = openSync(logPath, 'a');
  const child = spawn('npx', ['--yes', WRANGLER, ...args], {
    cwd: '/tmp/verify-workroom/run', detached: true, env: cleanEnv(), stdio: ['ignore', fd, fd],
  });
  child.unref();
  return child.pid;
}

export function workerdBins() {
  const roots = [ROOT + '/node_modules', homedir() + '/.npm/_npx'];
  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const out = execFileSync('find', [root, '-path', '*/@cloudflare/workerd-linux-64/bin/workerd', '-type', 'f'], { encoding: 'utf8' });
    for (const line of out.split('\n').map((s) => s.trim()).filter(Boolean)) found.push(line);
  }
  return found;
}
