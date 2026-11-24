// MCP adapters for the same authenticated REST execution/evaluation handlers.
// No second admission, identity, budget or execution authority is introduced.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { Fault, baseSchema, keySchema } from './contracts.ts';
import type { Workroom } from './domain.ts';
import {
  executionRunRoute, executionRunSchema, executionHeartbeatSchema, executionInterruptSchema, executionReconcileSchema,
} from './run-supervisor-route.ts';
import { runEvaluationRoute, runEvaluationSchema } from './run-evaluation.ts';

const room = z.literal('room_main');
const runId = z.string().min(1).max(128);
export const executionStartToolSchema = executionRunSchema.extend({ room }).strict();
export const executionHeartbeatToolSchema = executionHeartbeatSchema.extend({ room }).strict();
export const executionInterruptToolSchema = executionInterruptSchema.extend({ room }).strict();
export const executionReconcileToolSchema = executionReconcileSchema.extend({ room }).strict();
export const executionReadToolSchema = baseSchema.extend({ room, run_id: runId }).strict();
export const executionEvaluationFreezeToolSchema = executionReadToolSchema.extend({ idempotency_key: keySchema }).strict();
export const executionEvaluationRecordToolSchema = runEvaluationSchema.extend({ room, run_id: runId, idempotency_key: keySchema }).strict();

export const EXECUTION_READ_TOOLS = ['workroom_execution_status', 'workroom_execution_evaluation_read'] as const;
export const EXECUTION_WRITE_TOOLS = [
  'workroom_execution_start', 'workroom_execution_resume', 'workroom_execution_heartbeat',
  'workroom_execution_interrupt', 'workroom_execution_reconcile_cost', 'workroom_execution_evaluation_freeze', 'workroom_execution_evaluation_record',
] as const;

type Hints = { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
type ResultFn = (call: () => Promise<unknown>, wrapped?: boolean) => Promise<{
  content: { type: 'text'; text: string }[]; structuredContent: object; isError: boolean;
}>;

export function registerExecutionTools(server: McpServer, service: Workroom, env: object, result: ResultFn, hints: Hints): void {
  const readHints = { ...hints, readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const writeHints = { ...hints, readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true };
  const providerHints = { ...writeHints, openWorldHint: true };

  async function execute(method: 'GET' | 'POST', selectedRoom: string, tail: string, body?: unknown) {
    const url = new URL(`https://workroom.invalid/api/v1/rooms/${encodeURIComponent(selectedRoom)}/execution-runs${tail ? '/' + encodeURIComponent(tail) : ''}`);
    const value = await executionRunRoute(service, env, new Request(url, { method }), url, async () => body);
    if (!value) throw new Fault('NOT_FOUND', 'Execution handler not found.', 404);
    return value;
  }
  async function evaluate(method: 'GET' | 'POST', selectedRoom: string, selectedRun: string, manifest: boolean, key?: string, body?: unknown) {
    const url = new URL(`https://workroom.invalid/api/v1/rooms/${encodeURIComponent(selectedRoom)}/execution-runs/${encodeURIComponent(selectedRun)}/evaluation${manifest ? '/manifest' : ''}`);
    const request = new Request(url, { method, ...(key ? { headers: { 'idempotency-key': key } } : {}) });
    const value = await runEvaluationRoute(service, request, url, async () => body);
    if (!value) throw new Fault('NOT_FOUND', 'Evaluation handler not found.', 404);
    return value;
  }

  server.registerTool('workroom_execution_start', {
    description: 'Start one bounded, task-lease-fenced execution using the authenticated principal and the configured OpenRouter account. May incur provider cost after durable reservation. run_id/attempt_id and the complete immutable envelope identify the attempt; a replay cannot blindly resend an ambiguous provider effect. Does not approve the task.',
    inputSchema: executionStartToolSchema, annotations: providerHints,
  }, ({ room: selectedRoom, ...body }) => result(() => execute('POST', selectedRoom, '', body), true));
  server.registerTool('workroom_execution_resume', {
    description: 'Resume the exact stored execution envelope. May contact the configured provider to reconcile cost or continue an unstarted attempt. An ambiguous prior provider send remains UNKNOWN and is never automatically sent again. Does not approve the task.',
    inputSchema: executionStartToolSchema, annotations: providerHints,
  }, ({ room: selectedRoom, ...body }) => result(() => execute('POST', selectedRoom, 'resume', body), true));
  server.registerTool('workroom_execution_status', {
    description: 'Read durable execution state, checkpoints and execution checks for a run. Execution self-check PASS is not independent task acceptance. Read independent evidence with workroom_execution_evaluation_read.',
    inputSchema: executionReadToolSchema, annotations: readHints,
  }, input => result(() => execute('GET', input.room, input.run_id), true));
  server.registerTool('workroom_execution_reconcile_cost', {
    description: 'Read back and settle the original known provider generation for a run owned by the authenticated principal, including canceled or expired executions. Never reserves or sends a chat request. Unknown generation stays UNKNOWN; cost settlement never restores stale task authority or approves an artifact.',
    inputSchema: executionReconcileToolSchema, annotations: providerHints,
  }, ({ room: selectedRoom, ...body }) => result(() => execute('POST', selectedRoom, 'reconcile', body), true));
  server.registerTool('workroom_execution_heartbeat', {
    description: 'Renew the current execution lease only when the authenticated holder, exact run envelope, current epoch, intent and cancellation generation still agree. No provider call.',
    inputSchema: executionHeartbeatToolSchema, annotations: { ...writeHints, idempotentHint: false },
  }, ({ room: selectedRoom, ...body }) => result(() => execute('POST', selectedRoom, 'heartbeat', body), true));
  server.registerTool('workroom_execution_interrupt', {
    description: 'Interrupt a task or its matching execution as the authenticated task creator or owner. Advances the durable cancellation generation, fencing later effects; completed external costs remain reconciliable. No provider call.',
    inputSchema: executionInterruptToolSchema, annotations: { ...writeHints, destructiveHint: true, idempotentHint: false },
  }, ({ room: selectedRoom, ...body }) => result(() => execute('POST', selectedRoom, 'interrupt', body), true));
  server.registerTool('workroom_execution_evaluation_freeze', {
    description: 'Freeze host-derived done conditions and the current run/spec/artifact/cost digests before independent reviewer evidence is submitted. The authenticated reviewer must differ from the run author. Returns HOLD until complete evidence is recorded; caller cannot choose the expected shard census.',
    inputSchema: executionEvaluationFreezeToolSchema, annotations: writeHints,
  }, input => result(() => evaluate('POST', input.room, input.run_id, true, input.idempotency_key, { schema_version: input.schema_version }), true));
  server.registerTool('workroom_execution_evaluation_record', {
    description: 'Persist authenticated non-author evidence against a previously frozen evaluation manifest. Requires the exact nonempty expected shard set, nonzero unique cases, exit code zero, PASS cases and matching lowercase SHA-256 evidence digests. Missing, UNKNOWN, FAIL, stale or mismatched evidence remains HOLD. Reports historical receipt and current_disposition separately; no command execution or task approval.',
    inputSchema: executionEvaluationRecordToolSchema, annotations: writeHints,
  }, ({ room: selectedRoom, run_id: selectedRun, idempotency_key: key, ...body }) => result(() => evaluate('POST', selectedRoom, selectedRun, false, key, body), true));
  server.registerTool('workroom_execution_evaluation_read', {
    description: 'Read current independent evaluation disposition and preserved receipt history. Revalidates source/artifact/epoch/intent/cancellation/reviewer authority and retains failed evidence. This is evidence admission, not automatic proof of natural-language requirements or live provider proof.',
    inputSchema: executionReadToolSchema, annotations: readHints,
  }, input => result(() => evaluate('GET', input.room, input.run_id, false), true));
}
