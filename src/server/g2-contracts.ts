import { z } from 'zod';
import { baseSchema, readSchema, textSchema, keySchema } from './contracts.ts';

export const idSchema = z.string().min(1).max(128);
export const threadCreateSchema = baseSchema.extend({ room: idSchema, title: z.string().trim().min(1)
  .refine(s=>new TextEncoder().encode(s).length<=256 && s.isWellFormed() && !s.includes('\0'),'Invalid title'), idempotency_key:keySchema }).strict();
export const threadReadSchema = readSchema.extend({ thread_id:idSchema }).strict();
export const historySchema = readSchema.extend({ message_id:idSchema }).strict();
export const reviseSchema = baseSchema.extend({ room:idSchema,message_id:idSchema,expected_version:z.number().int().min(1).max(2147483646),
  text:textSchema,format:z.enum(['text','markdown']).default('text'),idempotency_key:keySchema }).strict();
export const ackSchema = baseSchema.extend({ room:idSchema,receipt:z.uuid(),idempotency_key:keySchema }).strict();
export const exportSchema = readSchema.extend({ thread_id:idSchema.optional(),format:z.enum(['text','markdown']).default('text'),limit:z.number().int().min(1).max(20).default(10) }).strict();
export type ThreadCreate = z.infer<typeof threadCreateSchema>;
export type ThreadRead = z.infer<typeof threadReadSchema>;
export type HistoryRead = z.infer<typeof historySchema>;
export type Revise = z.infer<typeof reviseSchema>;
export type Ack = z.infer<typeof ackSchema>;
export type ExportRead = z.infer<typeof exportSchema>;
export interface Thread { id:string;room_id:string;creator_id:string;title:string;created_at:string }
export interface Revision { message_seq:number;message_id:string;room_id:string;actor_id:string;editor_id:string;version:number;text:string;format:string;created_at:string;thread_id:string|null;reply_to_message_id:string|null }
