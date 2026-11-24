import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
export const nativePath = z.string().min(1).max(240).refine(value =>
  value.split('/').every(part => /^[A-Za-z0-9_@+.-]+$/.test(part)
    && part !== '.' && part !== '..' && !/^\.git(?:$|[^a-z])/i.test(part)
    && !/^(?:node_modules|\.env(?:\..*)?|\.ssh|\.npmrc|\.netrc)$/i.test(part)), 'unsafe native path');

// Only these data-only commands are implemented. An unsupported acceptance
// command is a HOLD, never replaced by a weaker check or counted as skipped.
const check = z.object({ id, cmd: z.union([
  z.tuple([z.literal('node'), z.literal('--check'), nativePath]),
  z.tuple([z.literal('git'), z.literal('diff'), z.literal('--check')]),
  z.tuple([z.literal('workroom'), z.literal('text-equals'), nativePath, z.string().max(32768)]),
  z.tuple([z.literal('workroom'), z.literal('json-equals'), nativePath, z.string().max(32768)]),
]), expect: z.literal('exit0'), scope: z.enum(['touched', 'full']), timeout_ms: positive.max(30000) }).strict();

/** Host-supplied approval material. Model output and retrieved documents cannot
 * create or widen this contract; the host must separately pin its exact bytes. */
export const nativeUnitSchema = z.object({
  contract: z.literal('workroom.native-unit.v1'), id, title: z.string().min(1).max(500),
  lane: id, spec_md: z.string().min(1).max(16000), lineage: z.array(id).min(1).max(20),
  deps: z.array(id).max(20), verifier: id, principal_id: id, task_id: id,
  model: z.string().min(1).max(128),
  task_spec_sha256: sha, base_sha: sha40, approval_ref: z.string().min(1).max(500),
  read_paths: z.array(nativePath).max(20), write_paths: z.array(nativePath).min(1).max(20),
  acceptance: z.array(check).min(1).max(20),
  budget: z.object({ usd_max: z.number().finite().nonnegative().max(20),
    tokens_max: positive.max(1000000), wall_s: positive.max(600), max_actions: positive.max(20),
    max_write_bytes: positive.max(65536) }).strict(),
}).strict().superRefine((value, ctx) => {
  for (const [name, values] of [['read_paths', value.read_paths], ['write_paths', value.write_paths],
    ['deps', value.deps], ['acceptance', value.acceptance.map(item => item.id)]] as const) {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', path: [name], message: 'duplicate native member' });
  }
  if (value.principal_id === value.verifier) ctx.addIssue({ code: 'custom', path: ['verifier'], message: 'author cannot be verifier' });
  for (const item of value.acceptance) {
    if (item.cmd[0] !== 'git' && !new Set([...value.read_paths, ...value.write_paths]).has(item.cmd[2])) {
      ctx.addIssue({ code: 'custom', path: ['acceptance'], message: 'check path outside approved inputs' });
    }
    if (item.cmd[1] === 'json-equals') {
      try { JSON.parse(item.cmd[3]); } catch { ctx.addIssue({ code: 'custom', path: ['acceptance'], message: 'invalid frozen JSON expectation' }); }
    }
  }
});
export type NativeUnit = z.infer<typeof nativeUnitSchema>;
export interface NativeTask { id: string; goal: string; owner_id: string | null; dependencies: string[];
  input_versions: { message_id: string; revision: number }[]; done_conditions: string[]; unit?: unknown }
export function nativeDigest(bytes: string | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function nativeTaskDigest(task: NativeTask): string {
  return nativeDigest(JSON.stringify({ id: task.id, goal: task.goal, owner_id: task.owner_id,
    dependencies: task.dependencies, input_versions: task.input_versions, done_conditions: task.done_conditions,
    ...(task.unit === undefined ? {} : { unit: task.unit }) }));
}
export const nativeActionSchema = z.object({ contract: z.literal('workroom.native-actions.v1'), spec_sha256: sha,
  actions: z.array(z.object({ tool: z.literal('write_file'), path: nativePath,
    before_sha256: sha.nullable(), content: z.string().max(65536) }).strict()).min(1).max(20),
}).strict();
export interface NativeBinding { spec_sha256: string; task_spec_sha256: string; prompt: string;
  model: string; max_tokens: number; max_total_tokens: number; max_wall_ms: number; max_micro_usd: number }
export interface NativeTokenCensus { prompt: number; completion: number; total: number }
export interface NativeIdentity { run_id: string; principal_id: string; task_id: string; lease_epoch: number;
  intent_revision: number; cancel_generation: number; model_artifact_id: string; actual_micro_usd: number; actual_tokens: NativeTokenCensus }
export interface NativeCheckResult { id: string; cmd: string[]; expect: 'exit0'; scope: 'touched' | 'full';
  exit: number | null; signal: string | null; stdout: string; stderr: string; log_sha256: string;
  status: 'PASS' | 'FAIL'; head_sha: string; tree_sha: string }
export interface NativeReceipt {
  contract: 'workroom.native-receipt.v1'; status: 'LOCAL_CHECKS_PASSED' | 'LOCAL_CHECKS_FAILED';
  unit_id: string; run_id: string; principal_id: string; task_id: string; lease_epoch: number; intent_revision: number;
  spec_sha256: string; task_spec_sha256: string; base_sha: string; branch: string; head_sha: string; tree_sha: string;
  model_artifact_id: string; checks: NativeCheckResult[]; changed_files: string[]; transcript_sha256: string; transcript_ref: string;
  actual_micro_usd: number; budget_check: 'estimate_admitted_and_actual_observed';
  actual_tokens: NativeTokenCensus;
  push: 'NOT_RUN'; independent_verdict: 'NOT_RUN'; execution_boundary: 'trusted_data_checks_only';
}
export interface NativeDriverHook {
  prepare(task: NativeTask, principal: string): Promise<NativeBinding>;
  execute(binding: NativeBinding, identity: NativeIdentity, modelText: string,
    guard: () => Promise<void>, signal: AbortSignal): Promise<NativeReceipt>;
}
