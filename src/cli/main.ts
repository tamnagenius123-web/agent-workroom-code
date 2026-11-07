#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { bodySchema, readSchema, operationSchema, keySchema, Fault, failure, metadata, type Envelope } from '../server/contracts.ts';
import { taskFlags,taskRequest } from './task.ts';
import { decodeResponse } from './response.ts';
import { threadCreateSchema,threadReadSchema,historySchema,reviseSchema,ackSchema,exportSchema } from '../server/g2-contracts.ts';

const controller = new AbortController();
let sentMutation = false;
let interrupted = false;
process.once('SIGINT', () => { interrupted = true; controller.abort(); process.stdin.destroy(); });

function argumentsFor(args: string[]) {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  const bool = new Set(['--stdin']);
  const known = new Set(['--room','--cursor','--limit','--file','--idempotency-key','--operation','--content-format','--timeout','--format','--thread','--reply-to','--title','--message','--expected-version','--receipt','--export-format',...Object.values(taskFlags).flat()]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    if (arg in flags || (!known.has(arg) && !bool.has(arg))) throw new Fault('INVALID_INPUT', 'Unknown or repeated CLI flag.');
    if (bool.has(arg)) flags[arg] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Fault('INVALID_INPUT', 'Flag requires a value.');
      flags[arg] = value;
    }
  }
  return { command: words.join(' '), flags };
}
async function inputText(flags: Record<string, string | true>) {
  if (Number(!!flags['--stdin']) + Number(!!flags['--file']) !== 1) throw new Fault('INVALID_INPUT', 'Use exactly one of --stdin or --file.');
  if (flags['--file']) {
    const path = String(flags['--file']);
    const info = await stat(path);
    if (!info.isFile() || info.size > 32768) throw new Fault('INVALID_INPUT', 'File must be regular UTF-8 text up to 32 KiB.');
    return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > 32768) throw new Fault('INVALID_INPUT', 'stdin exceeds 32 KiB.');
    chunks.push(bytes);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}
const exits: Record<string, number> = {
  INVALID_INPUT: 2, BODY_TOO_LARGE: 2, UNAUTHENTICATED: 3, FORBIDDEN: 3, NOT_FOUND: 4,
  IDEMPOTENCY_CONFLICT: 5, RATE_LIMITED: 6, TEMPORARY_FAILURE: 7, AUTH_NOT_CONFIGURED: 8, UNSUPPORTED: 8,
  VERSION_CONFLICT:5,ACK_OUT_OF_ORDER:5,INVALID_RELATION:2,TASK_CONFLICT:5,LEASE_CONFLICT:5,DEPENDENCY_CONFLICT:5,
};
async function main(): Promise<Envelope> {
  const { command, flags } = argumentsFor(process.argv.slice(2));
  const allowed: Record<string, string[]> = {
    ...taskFlags,
    capabilities: [], whoami: [], 'room read': ['--room','--cursor','--limit'],
    'message post': ['--room','--stdin','--file','--idempotency-key','--content-format','--thread','--reply-to'],
    'operation get': ['--operation','--idempotency-key'],
    'thread create':['--room','--title','--idempotency-key'],
    'thread read':['--room','--thread','--cursor','--limit'],
    'message revise':['--room','--message','--expected-version','--stdin','--file','--content-format','--idempotency-key'],
    'message history':['--room','--message','--cursor','--limit'],
    'inbox pull':['--room','--cursor','--limit'],
    'inbox ack':['--room','--receipt','--idempotency-key'],
    'room export':['--room','--thread','--export-format','--cursor','--limit'],
  };
  if (!allowed[command]) throw new Fault('UNSUPPORTED', 'Unsupported command.', 400);
  if (Object.keys(flags).some(k => ![...allowed[command]!, '--timeout','--format'].includes(k))) throw new Fault('INVALID_INPUT', 'Flag does not apply to this command.');
  if (flags['--format'] && flags['--format'] !== 'json') throw new Fault('UNSUPPORTED', 'Only JSON output is supported in G1.');
  const mutation = ['message post','thread create','message revise','inbox ack'].includes(command)||(command.startsWith('task ')&&command!=='task get');
  const seconds = flags['--timeout'] ? Number(flags['--timeout']) : mutation ? 15 : 10;
  if (!Number.isFinite(seconds) || seconds < 0.01 || seconds > 60) throw new Fault('INVALID_INPUT', '--timeout must be >0 and <=60 seconds.');
  let path = '';
  let body: string | undefined;
  let key: string | undefined;
  if (command === 'capabilities') path = '/capabilities';
  if (command === 'whoami') path = '/me';
  if (command === 'room read') {
    const input = readSchema.parse({ schema_version: '1', room: flags['--room'], cursor: flags['--cursor'],
      limit: flags['--limit'] === undefined ? 50 : Number(flags['--limit']) });
    path = `/rooms/${encodeURIComponent(input.room)}/messages?limit=${input.limit}` + (input.cursor ? `&cursor=${encodeURIComponent(input.cursor)}` : '');
  }
  if (command==='message post') {
    const room = z.string().min(1).max(128).parse(flags['--room']);
    key = keySchema.parse(flags['--idempotency-key']);
    const input = bodySchema.parse({ schema_version: '1', text: await inputText(flags), format: flags['--content-format'] ?? 'text',thread_id:flags['--thread'],reply_to_message_id:flags['--reply-to'] });
    body = JSON.stringify(input);
    path = `/rooms/${encodeURIComponent(room)}/messages`;
  }
  if (command === 'operation get') {
    const input = operationSchema.parse({ schema_version: '1', operation: flags['--operation'], idempotency_key: flags['--idempotency-key'] });
    path = `/operations/${input.operation}/${input.idempotency_key}`;
  }
  const page={schema_version:'1',room:flags['--room'],cursor:flags['--cursor'],limit:flags['--limit']===undefined?undefined:Number(flags['--limit'])};
  const query=(cursor:string|undefined,limit:number)=>`?limit=${limit}`+(cursor?'&cursor='+encodeURIComponent(cursor):'');
  if(command==='thread create') {
    const input=threadCreateSchema.parse({schema_version:'1',room:flags['--room'],title:flags['--title'],idempotency_key:flags['--idempotency-key']});
    key=input.idempotency_key;path=`/rooms/${encodeURIComponent(input.room)}/threads`;body=JSON.stringify({schema_version:'1',title:input.title});
  }
  if(command==='thread read') {
    const input=threadReadSchema.parse({...page,thread_id:flags['--thread']});
    path=`/rooms/${encodeURIComponent(input.room)}/threads/${encodeURIComponent(input.thread_id)}`+query(input.cursor,input.limit);
  }
  if(command==='message revise') {
    const input=reviseSchema.parse({schema_version:'1',room:flags['--room'],message_id:flags['--message'],expected_version:Number(flags['--expected-version']),text:await inputText(flags),format:flags['--content-format']??'text',idempotency_key:flags['--idempotency-key']});
    key=input.idempotency_key;path=`/rooms/${encodeURIComponent(input.room)}/messages/${encodeURIComponent(input.message_id)}/revisions`;
    body=JSON.stringify({schema_version:'1',expected_version:input.expected_version,text:input.text,format:input.format});
  }
  if(command==='message history') {
    const input=historySchema.parse({...page,message_id:flags['--message']});
    path=`/rooms/${encodeURIComponent(input.room)}/messages/${encodeURIComponent(input.message_id)}/history`+query(input.cursor,input.limit);
  }
  if(command==='inbox pull') {
    const input=readSchema.parse(page);path=`/rooms/${encodeURIComponent(input.room)}/inbox`+query(input.cursor,input.limit);
  }
  if(command==='inbox ack') {
    const input=ackSchema.parse({schema_version:'1',room:flags['--room'],receipt:flags['--receipt'],idempotency_key:flags['--idempotency-key']});
    key=input.idempotency_key;path=`/rooms/${encodeURIComponent(input.room)}/inbox/ack`;body=JSON.stringify({schema_version:'1',receipt:input.receipt});
  }
  if(command==='room export') {
    const input=exportSchema.parse({...page,thread_id:flags['--thread'],format:flags['--export-format']??'text'});
    path=`/rooms/${encodeURIComponent(input.room)}/export`+query(input.cursor,input.limit)+'&format='+input.format+(input.thread_id?'&thread_id='+encodeURIComponent(input.thread_id):'');
  }
  if(command.startsWith('task ')){const request=await taskRequest(command,flags,()=>inputText(flags));path=request.path;body=request.body;key=request.key;}
  let base: URL;
  try { base = new URL(process.env.WORKROOM_URL ?? 'http://127.0.0.1:8787'); }
  catch { throw new Fault('INVALID_INPUT', 'Invalid WORKROOM_URL.'); }
  if (base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) throw new Fault('INVALID_INPUT', 'Use an origin without credentials, path, query or fragment.');
  if (base.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(base.hostname)) throw new Fault('UNSUPPORTED', 'Hosted client authentication is not configured; use synthetic loopback only.');
  const token = process.env.WORKROOM_LOCAL_TOKEN;
  if (!token) throw new Fault('UNAUTHENTICATED', 'Set WORKROOM_LOCAL_TOKEN to a synthetic fixture token.', 401);
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  try {
    if (interrupted) throw new Error('Interrupted before sending');
    sentMutation = mutation;
    const response = await fetch(new URL('/api/v1' + path, base), { method: mutation ? 'POST' : 'GET',
      redirect: 'error', signal: controller.signal, body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } });
    const result: unknown = await response.json();
    return decodeResponse(result, command, response.ok,
      mutation || command === 'operation get' ? String(flags['--idempotency-key']) : undefined,
      command==='operation get'?String(flags['--operation']):undefined,
      command.startsWith('task ')&&command!=='task create'?String(flags['--task']):undefined);
  } catch {
    throw new Fault('TEMPORARY_FAILURE', mutation ? 'Outcome unknown. Requery or retry identical content with the same key.' : 'Read did not complete.',
      503, mutation ? 'unknown' : 'not_applied', true);
  } finally { clearTimeout(timer); }
}
let output: Envelope;
try { output = await main(); }
catch (e) {
  if (e instanceof z.ZodError || e instanceof TypeError || (e instanceof Error && 'code' in e && ['ENOENT','EACCES','EISDIR'].includes(String(e.code))))
    output = failure(new Fault('INVALID_INPUT', 'Invalid arguments or UTF-8 text input.'), metadata()).body;
  else output = failure(e instanceof Fault ? e : new Fault('INTERNAL_ERROR', 'Client could not complete the request.', 500,
    sentMutation ? 'unknown' : 'not_applied'), metadata()).body;
}
if (interrupted) output = failure(new Fault('INTERRUPTED', 'Interrupted. Check the original key if a mutation was sent.', 499,
  sentMutation ? 'unknown' : 'not_applied'), metadata()).body;
process.stdout.write(JSON.stringify(output) + '\n');
if (!output.ok) process.stderr.write(output.error.code + ': ' + output.error.message + '\n');
process.exitCode = interrupted ? 130 : output.ok ? 0 : exits[output.error.code] ?? 1;
