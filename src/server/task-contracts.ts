import { z } from 'zod';
import { baseSchema,keySchema,textSchema } from './contracts.ts';
import { idSchema } from './g2-contracts.ts';
const revision=z.number().int().min(1).max(2147483646);
export const BUILDER_UNIT_LEASE_MS = 40 * 60 * 1000;
export const MAX_UNIT_LEASE_MS = 24 * 60 * 60 * 1000;
/** Explicit opt-in unit policy. Ordinary and historical tasks retain their
 * existing short lease; a renewal cannot change this immutable specification. */
export const taskUnitSchema=z.object({kind:z.literal('builder'),
  lease_ms:z.number().int().positive().max(MAX_UNIT_LEASE_MS).default(BUILDER_UNIT_LEASE_MS)}).strict();
export const taskSpecSchema=z.object({goal:textSchema,owner:idSchema.nullable().default(null),dependencies:z.array(idSchema).max(20).default([]),
  input_versions:z.array(z.object({message_id:idSchema,revision}).strict()).max(20).default([]),done_conditions:z.array(textSchema).min(1).max(20),unit:taskUnitSchema.optional()}).strict()
  .refine(s=>new Set(s.dependencies).size===s.dependencies.length,'Duplicate dependencies')
  .refine(s=>new Set(s.input_versions.map(v=>JSON.stringify([v.message_id,v.revision]))).size===s.input_versions.length,'Duplicate inputs');
// Old task snapshots can predate done-condition admission. Reading them does
// not make an empty condition set eligible for independent evaluation.
export const storedTaskSpecSchema=z.object({...taskSpecSchema.shape,done_conditions:z.array(textSchema).max(20).default([])}).strict()
  .refine(s=>new Set(s.dependencies).size===s.dependencies.length,'Duplicate dependencies')
  .refine(s=>new Set(s.input_versions.map(v=>JSON.stringify([v.message_id,v.revision]))).size===s.input_versions.length,'Duplicate inputs');
const base=baseSchema.extend({room:idSchema}),keyed=base.extend({idempotency_key:keySchema});
export const taskCreateSchema=keyed.extend(taskSpecSchema.shape).strict()
  .refine(s=>new Set(s.dependencies).size===s.dependencies.length,'Duplicate dependencies')
  .refine(s=>new Set(s.input_versions.map(v=>JSON.stringify([v.message_id,v.revision]))).size===s.input_versions.length,'Duplicate inputs');
export const taskGetSchema=base.extend({task_id:idSchema}).strict();
export const myQueueSchema=base.strict();
const expected=keyed.extend({task_id:idSchema,expected_version:revision}).strict();
export const taskClaimSchema=expected.extend({lease_epoch:z.number().int().min(0).max(2147483646)}).strict();
export const taskClaimNextSchema=keyed.strict();
export const taskRenewSchema=expected.extend({lease_epoch:revision}).strict();
export const taskExecutionSchema=z.object({run_id:idSchema,attempt_id:idSchema,
  intent_revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cancel_generation:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export const taskSubmitSchema=taskRenewSchema.extend({artifact_message_id:idSchema,artifact_revision:revision,disposition:z.enum(['review','blocked']).default('review'),reason:textSchema.optional(),execution:taskExecutionSchema.optional()}).strict()
  .refine(s=>s.disposition!=='blocked'||s.reason!==undefined,'Blocked requires reason');
export const taskCancelSchema=expected.extend({reason:textSchema}).strict();
export const taskApproveSchema=expected.extend({submission_id:idSchema,artifact_message_id:idSchema,artifact_revision:revision}).strict();
export const taskRequestChangesSchema=taskApproveSchema.extend({reason:textSchema}).strict();
export type TaskCreate=z.infer<typeof taskCreateSchema>;
export type TaskClaimNext=z.infer<typeof taskClaimNextSchema>;
export type TaskGet=z.infer<typeof taskGetSchema>;
export type TaskAction=z.infer<typeof taskClaimSchema>|z.infer<typeof taskRenewSchema>|z.infer<typeof taskSubmitSchema>|z.infer<typeof taskCancelSchema>|z.infer<typeof taskApproveSchema>|z.infer<typeof taskRequestChangesSchema>;
export const taskActions=['create','claim','renew','submit','cancel','approve','request_changes'] as const;
export const taskSchemas={create:taskCreateSchema,get:taskGetSchema,claim:taskClaimSchema,renew:taskRenewSchema,submit:taskSubmitSchema,cancel:taskCancelSchema,approve:taskApproveSchema,request_changes:taskRequestChangesSchema};
