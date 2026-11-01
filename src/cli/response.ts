import { z } from 'zod';
import { ROOM, VERSION, keySchema, textSchema, type Envelope } from '../server/contracts.ts';

const metaSchema = z.object({
  request_id: z.string().min(1), schema_version: z.literal(VERSION), server_time: z.iso.datetime(),
}).passthrough();
const operationMeta = metaSchema.extend({ idempotency_key: keySchema, replayed: z.boolean() });
const messageSchema = z.object({
  id: z.string().min(1), room_id: z.literal(ROOM), actor_id: z.string().min(1),
  text: textSchema, format: z.enum(['text', 'markdown']), created_at: z.iso.datetime(),
}).passthrough();
const storedSchema = z.object({ message: messageSchema,
  operation: z.object({ type: z.literal('message.post'), idempotency_key: keySchema }).passthrough(),
}).passthrough();
const threadSchema=z.object({id:z.string().min(1),room_id:z.literal(ROOM),creator_id:z.string().min(1),title:z.string().min(1),created_at:z.iso.datetime()}).passthrough();
const operationInfo=z.object({type:z.enum(['message.post','thread.create','message.revise','inbox.ack','task.create','task.claim','task.renew','task.submit','task.cancel','task.approve','task.request_changes']),idempotency_key:keySchema}).passthrough();
const threadStored=z.object({thread:threadSchema,operation:operationInfo.extend({type:z.literal('thread.create')})}).passthrough();
const revisedStored=z.object({message:messageSchema.extend({version:z.number().int().min(2)}),operation:operationInfo.extend({type:z.literal('message.revise')})}).passthrough();
const ackStored=z.object({ack:z.object({receipt:z.uuid(),through_seq:z.number().int().nonnegative(),execution_accepted:z.literal(false),processing_complete:z.literal(false)}).passthrough(),operation:operationInfo.extend({type:z.literal('inbox.ack')})}).passthrough();
const taskSchema=z.object({id:z.string().min(1),room_id:z.literal(ROOM),creator_id:z.string(),owner_id:z.string().nullable(),goal:textSchema,dependencies:z.array(z.string()).max(20),input_versions:z.array(z.object({message_id:z.string(),revision:z.number().int().positive()})).max(20),done_conditions:z.array(textSchema).min(1).max(20),state:z.enum(['open','in_progress','blocked','review','done','canceled']),version:z.number().int().positive(),current_submission_id:z.string().nullable(),cancel_reason:z.string().nullable(),created_at_ms:z.number().int().positive(),updated_at_ms:z.number().int().positive(),stop_confirmation:z.literal('unavailable_no_runner')}).passthrough();
const submissionSchema=z.object({id:z.string(),task_id:z.string(),actor_id:z.string(),lease_epoch:z.number().int().positive(),artifact_message_id:z.string(),artifact_revision:z.number().int().positive(),disposition:z.enum(['review','blocked']),reason:z.string().nullable(),submitted_at_ms:z.number().int().positive()}).passthrough();
const taskBundle=z.object({task:taskSchema,lease:z.object({task_id:z.string(),holder_id:z.string().nullable(),lease_epoch:z.number().int().nonnegative(),expires_at_ms:z.number().int().nonnegative()}).passthrough(),submission:submissionSchema.nullable(),server_time_ms:z.number().int().positive(),lease_active:z.boolean()}).passthrough();
const taskOperations=['task.create','task.claim','task.renew','task.submit','task.cancel','task.approve','task.request_changes'] as const;
const taskStored=taskBundle.extend({operation:operationInfo.extend({type:z.enum(taskOperations)})});
const dataSchemas: Record<string, z.ZodType> = {
  capabilities: z.object({ schema_version: z.literal(VERSION), room_id: z.literal(ROOM),
    mode: z.literal('synthetic-local'), operations: z.array(z.string()), agents_connected: z.boolean(),
    hosted_auth_verified: z.boolean(), limits: z.object({ text_bytes: z.number().int().positive(),
      page_default: z.number().int().positive(), page_max: z.number().int().positive(),
      posts_per_minute: z.number().int().positive() }).passthrough(),
  }).passthrough(),
  whoami: z.object({ principal_id: z.string().min(1), synthetic: z.boolean(), room_id: z.literal(ROOM), can_post: z.boolean() }).passthrough(),
  'room read': z.object({ messages: z.array(messageSchema).max(100) }).passthrough(),
  'message post': storedSchema, 'operation get':z.union([storedSchema,threadStored,revisedStored,ackStored,taskStored]),
  'thread create':threadStored,
  'thread read':z.object({thread:threadSchema,messages:z.array(messageSchema).max(100)}).passthrough(),
  'message revise':revisedStored,
  'message history':z.object({message_id:z.string(),revisions:z.array(z.object({message_id:z.string(),version:z.number().int().min(1),text:textSchema,format:z.enum(['text','markdown']),editor_id:z.string(),created_at:z.iso.datetime()}).passthrough()).max(100)}).passthrough(),
  'inbox pull':z.object({events:z.array(z.object({seq:z.number().int().positive(),event_id:z.string(),kind:z.enum(['thread.created','message.posted','message.revised']),text:z.string().nullable(),version:z.number().int().nullable()}).passthrough()).max(100),receipt:z.uuid().nullable(),execution_accepted:z.literal(false),processing_complete:z.literal(false)}).passthrough(),
  'inbox ack':ackStored,
  'room export':z.object({schema_version:z.literal(VERSION),records:z.array(z.object({source_message_id:z.string(),source_revision:z.number().int().min(1),source_thread_id:z.string().nullable(),text:textSchema,format:z.enum(['text','markdown'])}).passthrough()).max(20),text:z.string(),format:z.enum(['text','markdown']),range:z.object({room:z.literal(ROOM),max_message_seq:z.number().int().nonnegative(),revision_event_watermark:z.number().int().nonnegative(),include:z.literal('all_revisions')}).passthrough()}).passthrough(),
};
dataSchemas['task get']=taskBundle;
for(const operation of taskOperations)dataSchemas[operation.replace('.',' ')]=taskBundle.extend({operation:operationInfo.extend({type:z.literal(operation)})});
const errorSchema = z.object({ ok: z.literal(false), meta: metaSchema, error: z.object({
  code: z.string().min(1), message: z.string(), retryable: z.boolean(),
  outcome: z.enum(['not_applied', 'applied', 'history_only', 'unknown']),
}).passthrough() }).passthrough();

// Unexpected responses are transport uncertainty, never evidence of success.
export function decodeResponse(value: unknown, command: string, httpOK: boolean, expectedKey?: string,expectedOperation?:string): Envelope {
  const data = dataSchemas[command];
  if (!data) throw new Error('Unsupported response command');
  const meta = (['message post','operation get','thread create','message revise','inbox ack'].includes(command)||(command.startsWith('task ')&&command!=='task get')) ? operationMeta
    : ['room read','thread read','message history','inbox pull','room export'].includes(command) ? metaSchema.extend({ next_cursor: z.string().nullable(), has_more: z.boolean() }) : metaSchema;
  const success = z.object({ ok: z.literal(true), data, meta }).passthrough();
  const result = z.discriminatedUnion('ok', [success, errorSchema]).parse(value) as Envelope;
  if (result.ok !== httpOK) throw new Error('HTTP/body status mismatch');
  if (result.ok && expectedKey) {
    const stored = z.object({operation:operationInfo}).passthrough().parse(result.data);
    if (result.meta.idempotency_key !== expectedKey || stored.operation.idempotency_key !== expectedKey)
      throw new Error('Operation key mismatch');
    if(expectedOperation && stored.operation.type!==expectedOperation) throw new Error('Operation action mismatch');
  }
  return result;
}
