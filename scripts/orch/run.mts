#!/usr/bin/env node
// Run with: node --import tsx scripts/orch/run.mts --help
// Importing this file does not contact the service. --execute is mandatory.
import { open, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { digest, runDriver, type DriverOptions, type Envelope, type RequestOptions } from './driver.ts';
import { acquireJournalLock } from './journal-lock.ts';

interface Cli { execute: boolean; help: boolean; journal: string; maxTasks: number; runtime: number; heartbeat: number; context: number }
function parse(args: string[]): Cli {
  const out: Cli = { execute: false, help: false, journal: '.cache/orch/worker.json', maxTasks: 1, runtime: 180_000, heartbeat: 8000, context: 4000 };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--execute') { out.execute = true; continue; }
    if (name === '--help') { out.help = true; continue; }
    const value = args[++i];
    if (value === undefined) throw new Error('invalid_arguments');
    if (name === '--journal') out.journal = value;
    else if (name === '--max-tasks') out.maxTasks = Number(value);
    else if (name === '--max-runtime-ms') out.runtime = Number(value);
    else if (name === '--heartbeat-ms') out.heartbeat = Number(value);
    else if (name === '--context-budget-chars') out.context = Number(value);
    else throw new Error('invalid_arguments');
  }
  return out;
}
async function readJSON(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('response_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<number> {
  let cli: Cli;
  try { cli = parse(args); } catch { process.stderr.write('invalid_arguments\n'); return 2; }
  if (cli.help) {
    process.stdout.write('Usage: node --import tsx scripts/orch/run.mts [--execute] [--journal PATH] [--max-tasks 1..20] [--max-runtime-ms 1..600000] [--heartbeat-ms 1..10000] [--context-budget-chars 500..8000]\nRequired only with --execute: WORKROOM_URL and WORKROOM_TOKEN_FILE. The token file is read only at execution time; the service holds the provider key. Linux/POSIX flock is required. The default is an offline plan. Use a separate journal per worker; preserve it on restart. No task approval or deployment is performed.\n');
    return 0;
  }
  const options: DriverOptions = { execute: cli.execute, endpoint_sha256: '0'.repeat(64),
    max_tasks: cli.maxTasks, max_runtime_ms: cli.runtime, heartbeat_ms: cli.heartbeat, context_budget_chars: cli.context };
  if (!cli.execute) {
    try {
      const summary = await runDriver(options, { rest: async () => { throw new Error('offline'); },
        mcp: async () => { throw new Error('offline'); }, load: async () => null, save: async () => { throw new Error('offline'); } });
      process.stdout.write(JSON.stringify(summary) + '\n'); return 0;
    } catch { process.stderr.write('invalid_driver_bound\n'); return 2; }
  }
  let origin: URL, token: string;
  try {
    origin = new URL(env.WORKROOM_URL ?? '');
    if (!env.WORKROOM_TOKEN_FILE) throw new Error('missing_token_file');
    token = (await readFile(env.WORKROOM_TOKEN_FILE, 'utf8')).trim();
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if ((origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))
      || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
      || !token || token.length > 32768 || /[\r\n\0]/.test(token)) throw new Error('invalid_config');
  } catch { process.stderr.write('invalid_service_configuration\n'); return 2; }
  options.endpoint_sha256 = digest(origin.origin);
  const journalPath = resolve(cli.journal), lockPath = journalPath + '.lock';
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  let lock: Awaited<ReturnType<typeof acquireJournalLock>>;
  try { lock = await acquireJournalLock(lockPath); }
  catch { process.stderr.write('journal_locked_or_unavailable\n'); return 2; }
  let queue = Promise.resolve();
  try {
    const rest = async (method: 'GET' | 'POST', path: string, body?: unknown, requestOptions: RequestOptions = {}): Promise<Envelope> => {
      // Paths come only from driver code; never follow service redirects with credentials.
      const target = new URL(path, origin);
      if (target.origin !== origin.origin) throw new Error('origin_mismatch');
      const execution = method === 'POST' && /\/execution-runs(?:\/resume)?$/.test(target.pathname);
      const signal = AbortSignal.any([lock.signal, AbortSignal.timeout(execution ? 180_000 : 10_000), ...(requestOptions.signal ? [requestOptions.signal] : [])]);
      const response = await fetch(target, { method, redirect: 'error', signal,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(requestOptions.key ? { 'Idempotency-Key': requestOptions.key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await readJSON(response) as Envelope;
      if (!result || typeof result.ok !== 'boolean' || (!response.ok && result.ok)) throw new Error('invalid_service_response');
      return result;
    };
    const summary = await runDriver(options, {
      rest,
      mcp: async (name, input, requestOptions = {}) => {
        const signal = AbortSignal.any([lock.signal, AbortSignal.timeout(10_000), ...(requestOptions.signal ? [requestOptions.signal] : [])]);
        const response = await fetch(new URL('/mcp', origin), { method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/call', 'Mcp-Name': name },
          body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: input,
            _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
        const rpc = await readJSON(response) as { result?: { structuredContent?: Envelope }; error?: unknown } & Envelope;
        if (rpc.ok === false) return rpc;
        if (!response.ok || !rpc.result?.structuredContent) return { ok: false, error: { code: 'mcp_response_unavailable' } };
        return rpc.result.structuredContent;
      },
      load: async () => {
        lock.signal.throwIfAborted();
        try { return JSON.parse(await readFile(journalPath, 'utf8')); }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
      },
      save: journal => {
        const bytes = JSON.stringify(journal, null, 2) + '\n';
        queue = queue.then(async () => {
          lock.signal.throwIfAborted();
          const temporary = journalPath + `.${randomUUID()}.tmp`;
          const file = await open(temporary, 'wx', 0o600);
          try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
          lock.signal.throwIfAborted();
          await rename(temporary, journalPath);
          const directory = await open(dirname(journalPath), 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        });
        return queue;
      },
    });
    process.stdout.write(JSON.stringify(summary).replaceAll(token, '[redacted]').replaceAll(origin.origin, '[service]') + '\n');
    return summary.disposition === 'HOLD' ? 2 : 0;
  } catch { process.stderr.write('driver_unavailable\n'); return 2; }
  finally { await lock.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
