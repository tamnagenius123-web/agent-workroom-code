import { z } from 'zod';
import { baseSchema, Fault, postSchema, VERSION } from './contracts.ts';
import { taskSchemas, type TaskAction, type TaskCreate } from './task-contracts.ts';
import type { Workroom } from './domain.ts';
import type { Plan, Row } from './mutations.ts';

// E3: POST /api/v1/batch runs up to 50 post/task ops as one D1 batch. Every op keeps its own idempotency key,
// guard and result; a per-op assertion raises inside the batch when that op did not apply, so the batch is all-or-nothing.
export const MAX_OPS = 50;
const OPS = ['message.post', 'task.create', 'task.claim', 'task.renew', 'task.submit', 'task.cancel', 'task.approve'] as const;
type Op = typeof OPS[number];
// The envelope schema checks only the body and the ops array; each entry is parsed in parseOp so every entry-level
// fault (malformed entry, malformed or unknown op, schema mismatch) names its index instead of a generic schema 400.
const batchSchema = baseSchema.extend({ ops: z.array(z.unknown()).min(1).max(MAX_OPS) }).strict();
const ABORT = /batch_abort:(\d+)/;

type Planned = Plan<{ data: unknown; meta: object }>;
// Every entry-level 400 names the entry's index, its op (the raw value, or null when absent) and a cause code, as BATCH_ABORTED does.
function invalid(index: number, op: unknown, code: string, message: string): Fault {
  return new Fault('INVALID_INPUT', `Op ${index} (${JSON.stringify(op)}): ${message}`, 400, 'not_applied', false, { index, op, cause: { code, message } });
}
function parseOp(entry: unknown, index: number) {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw invalid(index, null, 'MALFORMED_ENTRY', 'entry must be an object.');
  const { op = null, ...fields } = entry as Record<string, unknown>;
  if (typeof op !== 'string') throw invalid(index, op, 'MALFORMED_OP', 'op must be a string.');
  if (!(OPS as readonly string[]).includes(op)) throw invalid(index, op, 'UNKNOWN_OPERATION', `unknown op; expected one of ${OPS.join(', ')}.`);
  return parseKnown(op as Op, fields, index);
}
function parseKnown(op: Op, fields: Record<string, unknown>, index: number) {
  const input = { ...fields, schema_version: VERSION };
  try {
    if (op === 'message.post') return { op, input: postSchema.parse(input) };
    if (op === 'task.create') return { op, input: taskSchemas.create.parse(input) as TaskCreate };
    const action = op.slice(5) as 'claim' | 'renew' | 'submit' | 'cancel' | 'approve';
    return { op, action, input: taskSchemas[action].parse(input) as TaskAction };
  } catch (e) {
    if (e instanceof z.ZodError) throw invalid(index, op, 'SCHEMA_MISMATCH', 'does not match its schema.');
    throw e;
  }
}
function aborted(index: number, op: Op, cause: unknown): Fault {
  const f = cause instanceof Fault ? cause : new Fault('TEMPORARY_FAILURE', 'Op result is uncertain.', 503, 'unknown', true);
  return new Fault('BATCH_ABORTED', `Op ${index} (${op}) failed; no op in this batch was applied.`, f.status, 'not_applied', f.retryable,
    { ...f.details, index, op, cause: { code: f.code, message: f.message, ...f.details } });
}

export async function batchRoute(service: Workroom, request: Request, url: URL, readJSON: () => Promise<unknown>) {
  if (url.pathname !== '/api/v1/batch') return null;
  if (request.method !== 'POST') throw new Fault('UNSUPPORTED', 'Method unsupported.', 405);
  if (url.search) throw new Fault('INVALID_INPUT', 'No query parameters for batch.');
  const body = batchSchema.parse(await readJSON());
  const parsed = body.ops.map(parseOp);
  const keys = new Set<string>(), tasks = new Set<string>();
  parsed.forEach((p, index) => {
    const key = p.op + ' ' + p.input.idempotency_key;
    if (keys.has(key)) throw invalid(index, p.op, 'DUPLICATE_KEY', 'an op type and idempotency key may appear once per batch.');
    keys.add(key);
    // Task actions plan against the task as read before the batch, so a second action on the same task could never apply.
    if ('task_id' in p.input) {
      if (tasks.has(p.input.task_id)) throw invalid(index, p.op, 'DUPLICATE_TASK', 'a task may be acted on once per batch.');
      tasks.add(p.input.task_id);
    }
  });
  for (const room of new Set(parsed.map(p => p.input.room))) await service.authorize(room, true);
  const plans: Planned[] = [];
  for (const [index, p] of parsed.entries()) {
    try {
      plans.push(p.op === 'message.post' ? await service.planPost(p.input as z.infer<typeof postSchema>)
        : p.op === 'task.create' ? await service.tasks.planCreate(p.input as TaskCreate)
        : await service.tasks.planAction(p.action!, p.input as TaskAction));
    } catch (e) { throw aborted(index, p.op, e); }
  }
  const db = service.database, statements = [], readbacks: number[] = [];
  for (const [index, plan] of plans.entries()) {
    statements.push(...plan.statements);
    readbacks.push(statements.length - 1);
    statements.push(db.prepare(`SELECT json_extract('{}',CASE WHEN ${plan.applied.sql} THEN '$' ELSE 'batch_abort:'||? END)`).bind(...plan.applied.args, index));
  }
  let output;
  try { output = await db.batch<Row>(statements); }
  catch (e) {
    const match = ABORT.exec(String((e as Error)?.message));
    if (!match) throw e;
    // The batch rolled back, so storage is as it was before; rerun the op's own read-back to name the precise fault.
    const index = Number(match[1]), plan = plans[index]!, op = parsed[index]!.op;
    try { await plan.finish((await plan.statements.at(-1)!.all<Row>()).results[0]); }
    catch (cause) { throw aborted(index, op, cause); }
    throw aborted(index, op, undefined);
  }
  const results = [];
  for (const [index, plan] of plans.entries()) results.push(await plan.finish(output[readbacks[index]!]?.results[0]));
  return { data: { results }, meta: { count: results.length } };
}
