import { z } from 'zod';

export const ROOM = 'room_main';
export const VERSION = '1';
const utf8 = new TextEncoder();
export const keySchema = z.string().regex(/^[A-Za-z0-9_.-]{8,128}$/);
export const baseSchema = z.object({ schema_version: z.literal(VERSION) }).strict();
export const unreadSchema = baseSchema.extend({
  room: z.string().min(1).max(128), limit: z.number().int().min(1).max(100).default(50), peek: z.boolean().default(false), mentions_only: z.boolean().default(false),
}).strict();
export const memorySearchSchema = baseSchema.extend({ room: z.string().min(1).max(128), query: z.string().min(1).max(256), limit: z.number().int().min(1).max(50).default(10), before: z.string().datetime().optional() }).strict();
const kindEnum = z.enum(['decision','fact','skill']);
export const memoryProposeSchema = baseSchema.extend({ room: z.string().min(1).max(128), kind: kindEnum, tier: z.number().int().min(0).max(3), title: z.string().min(1).max(200), body: z.string().min(1).max(8192), source_message_id: z.string().min(1).max(128), valid_from: z.string().datetime({ offset: true }), valid_until: z.string().datetime({ offset: true }).optional() }).strict();
export const memorySupersedeSchema = baseSchema.extend({ room: z.string().min(1).max(128), old_id: z.string().min(1).max(128), new_id: z.string().min(1).max(128) }).strict();
export const memoryPromoteSchema = baseSchema.extend({ room: z.string().min(1).max(128), from_id: z.string().min(1).max(128), title: z.string().min(1).max(200), body: z.string().min(1).max(8192) }).strict();
export const memoryReviewSchema = baseSchema.extend({ room: z.string().min(1).max(128), target: z.enum(['item','edge']), id: z.string().min(1).max(128), verdict: z.enum(['approve','reject']), reason: z.string().min(1).max(2000), content_digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const reviewPrepareSchema = baseSchema.extend({ room: z.string().min(1).max(128), target: z.enum(['item','edge']), id: z.string().min(1).max(128) }).strict();
export const memoryViewSchema = baseSchema.extend({ room: z.string().min(1).max(128), kinds: z.array(kindEnum).max(3).optional(), at: z.string().datetime({ offset: true }).optional(), include_pending: z.boolean().default(false) }).strict();
const roomField = z.string().min(1).max(128);
const idField = z.string().min(1).max(128);
export const foldProposeSchema = baseSchema.extend({ room: roomField, id: idField.optional(), summary: z.string().min(1).max(4000), valid_from: z.string().datetime({ offset: true }), message_ids: z.array(idField).min(1).max(200).optional(), child_fold_ids: z.array(idField).min(1).max(200).optional(), supersedes: idField.optional() }).strict();
export const foldReviewSchema = baseSchema.extend({ room: roomField, target: z.enum(['fold','edge']), id: idField, verdict: z.enum(['approve','reject']), reason: z.string().min(1).max(2000), content_digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const foldViewSchema = baseSchema.extend({ room: roomField, at: z.string().datetime({ offset: true }).optional(), include_pending: z.boolean().default(false) }).strict();
export const contextPackSchema = baseSchema.extend({ room: z.string().min(1).max(128), task: z.string().min(1).max(1000), budget_chars: z.number().int().min(500).max(20000).default(6000), at: z.string().datetime({ offset: true }).optional(), folds: z.boolean().default(false) }).strict();
export const briefGetSchema = baseSchema.extend({ room: z.string().min(1).max(128), at: z.string().datetime({ offset: true }).optional(), max_chars: z.number().int().min(1000).max(8000).default(4000), task: z.string().max(2000).optional(), kind: z.enum(['handoff','question','decision']).optional() }).strict();
export const memoryRecallSchema = baseSchema.extend({ room: z.string().min(1).max(128), kind: z.enum(['handoff','question','decision']), text: z.string().max(2000) }).strict();
export const skillGradeSchema = baseSchema.extend({ room: z.string().min(1).max(128), id: z.string().min(1).max(128) }).strict();
export const skillEndorseSchema = baseSchema.extend({ room: z.string().min(1).max(128), id: z.string().min(1).max(128), reason: z.string().min(1).max(2000), content_digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const componentEnum = z.enum(['system_prompt','guardrails','memory','tool_guidance','subagents','skills','scripts','plugins']);
export const experienceProposeSchema = baseSchema.extend({ room: z.string().min(1).max(128), component: componentEnum, change: z.string().min(1).max(4000), prediction: z.string().min(1).max(2000), source_message_id: z.string().min(1).max(128) }).strict();
export const experienceObserveSchema = baseSchema.extend({ room: z.string().min(1).max(128), id: z.string().min(1).max(128), outcome: z.string().min(1).max(4000), outcome_message_id: z.string().min(1).max(128) }).strict();
export const experienceVerdictSchema = baseSchema.extend({ room: z.string().min(1).max(128), id: z.string().min(1).max(128), verdict: z.enum(['keep','revert']), reason: z.string().min(1).max(2000), content_digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const experienceViewSchema = baseSchema.extend({ room: z.string().min(1).max(128), states: z.array(z.enum(['proposed','observed','kept','reverted'])).max(4).optional(), component: componentEnum.optional(), limit: z.number().int().min(1).max(200).default(50) }).strict();
export const latencySchema = baseSchema.extend({ room: z.string().min(1).max(128), hours: z.number().int().min(1).max(720).default(168) }).strict();
export const mentionsSchema = baseSchema.extend({ room: z.string().min(1).max(128), limit: z.number().int().min(1).max(100).default(20) }).strict();
export const webhookSetSchema = baseSchema.extend({ url: z.string().min(1).max(2048), all_messages: z.boolean().default(false), rotate_secret: z.boolean().default(false) }).strict();
const wakeId = z.string().min(1).max(128);
const wakeAgent = z.string().min(1).max(128);
const wakeTime = z.string().datetime({ offset: true });
export const wakeRelaySchema = z.object({
  delivery_id: wakeId, event_id: wakeId, message_id: wakeId, agent: wakeAgent,
  received_at: wakeTime, signature_verified: z.boolean(), source: z.enum(['webhook', 'relay', 'poll']),
}).strict();
export const wakeHostSchema = z.object({
  run_id: wakeId, delivery_id: wakeId, event_id: wakeId, agent: wakeAgent,
  started_at: wakeTime, cause: z.enum(['delivery', 'schedule', 'manual']),
}).strict();
export const wakeReadSchema = z.object({
  run_id: wakeId, message_id: wakeId, agent: wakeAgent, read_at: wakeTime,
  principal_authenticated: z.boolean(), outcome_ref: z.string().min(1).max(256).nullable(),
}).strict();
export const wakeReportSchema = baseSchema.extend({
  room: z.string().min(1).max(128), idempotency_key: keySchema, message_id: wakeId,
  stage: z.enum(['relay_receipt', 'host_run', 'read_outcome']),
  relay_receipt: wakeRelaySchema.optional(), host_run: wakeHostSchema.optional(), read_outcome: wakeReadSchema.optional(),
}).strict().refine(value => {
  const names = ['relay_receipt', 'host_run', 'read_outcome'] as const;
  const present = names.filter(name => value[name] !== undefined);
  return present.length === 1 && present[0] === value.stage;
}, 'Provide only the payload named by stage.');
export const wakeProofSchema = baseSchema.extend({
  room: z.string().min(1).max(128), message_id: wakeId, agent: wakeAgent,
}).strict();
export type WakeReportInput = z.infer<typeof wakeReportSchema>;
export type WakeProofQuery = z.infer<typeof wakeProofSchema>;
export const readSchema = baseSchema.extend({
  room: z.string().min(1).max(128), cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const textSchema = z.string().min(1).refine(s => s.trim().length > 0, 'Text is blank')
  .refine(s => utf8.encode(s).length <= 32768, 'Text exceeds 32 KiB')
  .refine(s => !s.includes('\0') && s.isWellFormed(), 'Invalid Unicode text');
export const bodySchema = baseSchema.extend({
  text: textSchema, format: z.enum(['text', 'markdown']).default('text'),
  thread_id: z.string().min(1).max(128).optional(), reply_to_message_id: z.string().min(1).max(128).optional(),
}).strict();
export const postSchema = bodySchema.extend({
  room: z.string().min(1).max(128), idempotency_key: keySchema,
}).strict();
export const operationSchema = baseSchema.extend({
  operation: z.enum(['message.post','thread.create','message.revise','inbox.ack','task.create','task.claim','task.renew','task.submit','task.cancel','task.approve','task.request_changes']), idempotency_key: keySchema,
}).strict();
export type Post = z.infer<typeof postSchema>;
export type Read = z.infer<typeof readSchema>;
export interface Message { id: string; room_id: string; actor_id: string; text: string; format: string; created_at: string }
export interface Stored { message: Message; operation: { type: 'message.post'; idempotency_key: string } }
export interface Meta { request_id: string; schema_version: string; server_time: string; [key: string]: unknown }
export type Outcome = 'not_applied' | 'applied' | 'history_only' | 'unknown';
export interface Failure { ok: false; error: { code: string; message: string; retryable: boolean; outcome: Outcome; [key: string]: unknown }; meta: Meta }
export interface Success { ok: true; data: unknown; meta: Meta }
export type Envelope = Success | Failure;
export class Fault extends Error {
  constructor(public code: string, message: string, public status = 400,
    public outcome: Outcome = 'not_applied', public retryable = false,
    public details: Record<string, unknown> = {}) { super(message); }
}
export function metadata(): Meta {
  return { request_id: crypto.randomUUID(), schema_version: VERSION, server_time: new Date().toISOString() };
}
export { unitCostRecordSchema, unitCostSummarySchema, agentDispatchSchema } from './dispatch-wire.ts';
export function failure(e: unknown, meta: Meta): { body: Failure; status: number } {
  const f = e instanceof Fault ? e : e instanceof z.ZodError
    ? new Fault('INVALID_INPUT', 'Input does not match the G1 schema.')
    : new Fault('TEMPORARY_FAILURE', 'Storage or transport result is uncertain. Requery or retry the same key.', 503, 'unknown', true);
  return { status: f.status, body: { ok: false, error: {
    code: f.code, message: f.message, retryable: f.retryable, outcome: f.outcome, ...f.details,
  }, meta } };
}
