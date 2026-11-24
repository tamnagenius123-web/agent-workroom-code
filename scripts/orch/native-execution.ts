import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rosterCapMicros } from '../../src/or-harness/client.ts';
import { acquireJournalLock } from './journal-lock.ts';
import { nativeActionSchema, nativeDigest, nativeTaskDigest, nativeUnitSchema,
  type NativeBinding, type NativeCheckResult, type NativeDriverHook, type NativeReceipt,
  type NativeTask } from './native-contract.ts';

export class NativeHold extends Error { constructor(readonly code: string) { super(code); this.name = 'NativeHold'; } }
interface Output { exit: number | null; signal: string | null; stdout: string; stderr: string }
const outputSchema = z.object({ exit: z.number().int().nullable(), signal: z.string().nullable(), stdout: z.string(), stderr: z.string() }).strict();
const journalSchema = z.object({ version: z.literal(1), binding_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  steps: z.array(z.object({ id: z.string(), state: z.enum(['started', 'done']), output: z.json().optional() }).strict()),
  receipt: z.json().optional(),
}).strict();
type Journal = z.infer<typeof journalSchema>;

/** No ambient credentials, preload options, git config, SSH agent, or npm config. */
export function nativeEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
    GIT_AUTHOR_NAME: 'Workroom native builder', GIT_AUTHOR_EMAIL: 'native@workroom.invalid',
    GIT_COMMITTER_NAME: 'Workroom native builder', GIT_COMMITTER_EMAIL: 'native@workroom.invalid' };
}
async function command(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  timeout: number, signal?: AbortSignal): Promise<Output> {
  signal?.throwIfAborted();
  return new Promise((accept, reject) => {
    if (process.platform === 'win32') { reject(new NativeHold('native_posix_required')); return; }
    const child = spawn(executable, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false;
    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      if (kind === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 16384) { overflow = true; abort(); }
    };
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    const abort = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeout);
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', (exit, killed) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      accept({ exit: overflow ? null : exit, signal: overflow ? 'OUTPUT_LIMIT' : killed,
        stdout: stdout.slice(0, 16384), stderr: stderr.slice(0, 16384) });
    });
  });
}
async function durableJSON(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function safeFile(root: string, path: string): Promise<string> {
  const target = resolve(root, path), rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new NativeHold('native_path_escape');
  let cursor = root;
  for (const [i, part] of rel.split(sep).entries()) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || (i < rel.split(sep).length - 1 && !info.isDirectory())
        || (i === rel.split(sep).length - 1 && (!info.isFile() || info.nlink !== 1))) throw new NativeHold('native_path_alias');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return target;
}
async function fileDigest(path: string): Promise<string | null> {
  try { return nativeDigest(await readFile(path)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
}
const DATA_CHECK = `const fs=require('node:fs');const [kind,path,expected]=process.argv.slice(1);const text=fs.readFileSync(path,'utf8');let ok=false;try{ok=kind==='text-equals'?text===expected:JSON.stringify(JSON.parse(text))===JSON.stringify(JSON.parse(expected));}catch{}process.stdout.write(ok?'data check passed\\n':'data check failed\\n');process.exitCode=ok?0:1;`;

export interface LocalNativeOptions { spec_path: string; approved_sha256: string; repository: string; root: string; git_path?: string }

/** A checkout and data-check adapter, not a security sandbox. No arbitrary
 * candidate code, package script, shell, push, merge, network, or verdict tool. */
export async function createLocalNativeHook(options: LocalNativeOptions): Promise<NativeDriverHook> {
  const bytes = await readFile(options.spec_path, 'utf8');
  if (nativeDigest(bytes) !== options.approved_sha256) throw new NativeHold('native_approval_digest_mismatch');
  const parsed = nativeUnitSchema.safeParse(JSON.parse(bytes));
  if (!parsed.success) throw new NativeHold('native_contract_unsupported');
  const unit = parsed.data, specHash = nativeDigest(bytes);
  const cap = rosterCapMicros({ native: { cap_usd: unit.budget.usd_max } }, 'native');
  const source = await realpath(options.repository), root = resolve(options.root), gitPath = options.git_path ?? '/usr/bin/git';
  const displacement = relative(source, root);
  if (!isAbsolute(gitPath) || !(displacement === '..' || displacement.startsWith('..' + sep))) throw new NativeHold('native_root_inside_repository');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) throw new NativeHold('native_root_alias');
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700, recursive: true });
  const env = nativeEnvironment(home);
  const git = async (cwd: string, args: string[], signal?: AbortSignal): Promise<string> => {
    const result = await command(gitPath, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false', '-c', 'protocol.allow=never', ...args], cwd, env, 30000, signal);
    if (result.exit !== 0 || result.signal) throw new NativeHold('native_git_failed');
    return result.stdout.trimEnd();
  };
  const assertBase = async () => {
    if (await git(source, ['rev-parse', '--verify', `${unit.base_sha}^{commit}`]) !== unit.base_sha) throw new NativeHold('native_base_mismatch');
  };
  const bindTask = (task: NativeTask, principal: string) => {
    if (!z.object({ kind: z.literal('builder'), lease_ms: z.number().int().positive().max(86400000) }).strict().safeParse(task.unit).success) {
      throw new NativeHold('native_builder_unit_metadata_required');
    }
    if (task.id !== unit.task_id || principal !== unit.principal_id || nativeTaskDigest(task) !== unit.task_spec_sha256
      || JSON.stringify(task.dependencies) !== JSON.stringify(unit.deps)) throw new NativeHold('native_task_binding_mismatch');
  };
  return {
    async prepare(task, principal): Promise<NativeBinding> {
      bindTask(task, principal); await assertBase();
      const inputs = [];
      for (const path of new Set([...unit.read_paths, ...unit.write_paths])) {
        const entry = await git(source, ['ls-tree', unit.base_sha, '--', path]);
        if (!entry) { inputs.push({ path, content: null, sha256: null }); continue; }
        if (!/^100(?:644|755) blob [a-f0-9]{40}\t/.test(entry) || entry.split('\n').length !== 1) throw new NativeHold('native_source_alias');
        const result = await command(gitPath, ['cat-file', 'blob', `${unit.base_sha}:${path}`], source, env, 30000);
        if (result.exit !== 0 || result.signal) throw new NativeHold('native_input_unavailable');
        inputs.push({ path, content: result.stdout, sha256: nativeDigest(result.stdout) });
      }
      const prompt = JSON.stringify({ contract: unit.contract, unit, spec_sha256: specHash, inputs,
        output_contract: { contract: 'workroom.native-actions.v1', spec_sha256: specHash,
          actions: [{ tool: 'write_file', path: '<approved write path>', before_sha256: '<input hash or null>', content: '<replacement text>' }] },
        instruction: 'Return only this strict JSON object. Commands and acceptance checks are frozen by the host. Do not emit shell commands or claim execution.' });
      return { spec_sha256: specHash, task_spec_sha256: unit.task_spec_sha256, prompt,
        model: unit.model, max_tokens: Math.min(1024, unit.budget.tokens_max), max_total_tokens: unit.budget.tokens_max,
        max_wall_ms: unit.budget.wall_s * 1000, max_micro_usd: cap };
    },
    async execute(binding, identity, modelText, guard, signal): Promise<NativeReceipt> {
      if (binding.spec_sha256 !== specHash || binding.task_spec_sha256 !== unit.task_spec_sha256
        || identity.principal_id !== unit.principal_id || identity.task_id !== unit.task_id) throw new NativeHold('native_execution_binding_mismatch');
      if (!Number.isSafeInteger(identity.actual_micro_usd) || identity.actual_micro_usd < 0 || identity.actual_micro_usd > cap) throw new NativeHold('native_actual_cost_outside_budget');
      const tokens = identity.actual_tokens;
      if (!tokens || [tokens.prompt, tokens.completion, tokens.total].some(value => !Number.isSafeInteger(value) || value < 0)
        || tokens.total !== tokens.prompt + tokens.completion || tokens.total > unit.budget.tokens_max) throw new NativeHold('native_actual_tokens_outside_budget');
      let actions: z.infer<typeof nativeActionSchema>;
      try { actions = nativeActionSchema.parse(JSON.parse(modelText)); } catch { throw new NativeHold('native_actions_invalid'); }
      if (actions.spec_sha256 !== specHash || actions.actions.length > unit.budget.max_actions
        || actions.actions.reduce((sum, action) => sum + Buffer.byteLength(action.content), 0) > unit.budget.max_write_bytes
        || actions.actions.some(action => !unit.write_paths.includes(action.path))) throw new NativeHold('native_actions_outside_contract');
      const runPath = join(root, nativeDigest(identity.run_id)), checkout = join(runPath, 'checkout');
      await mkdir(runPath, { recursive: true, mode: 0o700 });
      if (await realpath(runPath) !== runPath) throw new NativeHold('native_run_path_alias');
      const lock = await acquireJournalLock(join(runPath, 'journal.lock'), 5000, env);
      const abort = AbortSignal.any([signal, lock.signal, AbortSignal.timeout(unit.budget.wall_s * 1000)]);
      const journalPath = join(runPath, 'journal.json'), branch = `native/${nativeDigest(identity.run_id).slice(0, 24)}`;
      const bindingHash = nativeDigest(JSON.stringify({ binding, identity, model_sha256: nativeDigest(modelText) }));
      let journal: Journal;
      try {
        try { journal = journalSchema.parse(JSON.parse(await readFile(journalPath, 'utf8'))); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new NativeHold('native_journal_invalid');
          journal = { version: 1, binding_sha256: bindingHash, steps: [] }; await durableJSON(journalPath, journal); }
        if (journal.binding_sha256 !== bindingHash) throw new NativeHold('native_journal_binding_mismatch');
        if (journal.steps.some(step => step.state === 'started')) throw new NativeHold('native_effect_outcome_unknown');
        const step = async (id: string, effect: () => Promise<unknown>): Promise<unknown> => {
          abort.throwIfAborted(); await guard(); abort.throwIfAborted();
          const done = journal.steps.find(row => row.id === id);
          if (done) return structuredClone(done.output);
          const row: Journal['steps'][number] = { id, state: 'started' };
          journal.steps.push(row); await durableJSON(journalPath, journal);
          const output = await effect();
          row.state = 'done'; row.output = z.json().parse(output); await durableJSON(journalPath, journal);
          return output;
        };
        await step('checkout', async () => {
          await assertBase(); await mkdir(checkout, { mode: 0o700 });
          // Fresh local repo: never inherit source config/hooks/filters or run
          // upload-pack (its source-local packObjectsHook is executable). Copy
          // only immutable object bytes, rejecting alternates and aliases.
          await git(checkout, ['init', '--quiet', '--template=', '--initial-branch', branch], abort);
          const common = await git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'], abort);
          const objects = join(common, 'objects'); let copied = 0;
          await cp(objects, join(checkout, '.git', 'objects'), { recursive: true, filter: async path => {
            abort.throwIfAborted(); const info = await lstat(path);
            if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())
              || relative(objects, path) === join('info', 'alternates')) throw new NativeHold('native_object_store_unsupported');
            copied += info.isFile() ? info.size : 0;
            if (copied > 128 * 1024 * 1024) throw new NativeHold('native_object_store_exceeds_bound');
            return true;
          } });
          await git(checkout, ['checkout', '--quiet', '--no-recurse-submodules', '-B', branch, unit.base_sha], abort);
          return { head: await git(checkout, ['rev-parse', 'HEAD'], abort) };
        });
        for (const [index, action] of actions.actions.entries()) await step(`write:${index}`, async () => {
          const target = await safeFile(checkout, action.path);
          if (await fileDigest(target) !== action.before_sha256) throw new NativeHold('native_write_preimage_mismatch');
          await mkdir(dirname(target), { recursive: true });
          await safeFile(checkout, action.path);
          const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
          try { await file.writeFile(action.content); await file.sync(); } finally { await file.close(); }
          return { path: action.path, sha256: nativeDigest(action.content) };
        });
        const committed = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/), tree: z.string().regex(/^[a-f0-9]{40}$/),
          changed: z.array(z.string()) }).strict().parse(await step('commit', async () => {
          for (const path of unit.write_paths) await safeFile(checkout, path);
          await git(checkout, ['add', '--', ...unit.write_paths], abort);
          const changed = (await git(checkout, ['diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv'], abort)).split('\0').filter(Boolean);
          if (!changed.length || changed.some(path => !unit.write_paths.includes(path))) throw new NativeHold('native_diff_outside_contract');
          await git(checkout, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', `Native unit ${unit.id}; run ${identity.run_id}`], abort);
          return { head: await git(checkout, ['rev-parse', 'HEAD'], abort), tree: await git(checkout, ['rev-parse', 'HEAD^{tree}'], abort), changed };
        }));
        const assertFrozen = async () => {
          if (await git(checkout, ['rev-parse', 'HEAD'], abort) !== committed.head
            || await git(checkout, ['rev-parse', 'HEAD^{tree}'], abort) !== committed.tree
            || await git(checkout, ['status', '--porcelain=v1', '--untracked-files=all'], abort) !== '') throw new NativeHold('native_checked_tree_changed');
          for (const path of new Set([...unit.read_paths, ...unit.write_paths])) await safeFile(checkout, path);
        };
        await assertFrozen();
        const checks: NativeCheckResult[] = [];
        for (const check of unit.acceptance) {
          const raw = await step(`check:${check.id}`, async () => {
            await assertFrozen();
            let result: Output;
            if (check.cmd[0] === 'git') result = await command(gitPath, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
              'diff', '--no-ext-diff', '--no-textconv', '--check', unit.base_sha, committed.head, '--'], checkout, env, check.timeout_ms, abort);
            else if (check.cmd[0] === 'node') result = await command(process.execPath,
              ['--check', await safeFile(checkout, check.cmd[2])], checkout, env, check.timeout_ms, abort);
            else result = await command(process.execPath, ['--input-type=commonjs', '-e', DATA_CHECK,
              check.cmd[1], await safeFile(checkout, check.cmd[2]), check.cmd[3]], checkout, env, check.timeout_ms, abort);
            await assertFrozen();
            return result;
          });
          const output = outputSchema.parse(raw);
          checks.push({ ...output, id: check.id, cmd: check.cmd, expect: check.expect, scope: check.scope,
            log_sha256: nativeDigest(JSON.stringify(output)), status: output.exit === 0 && output.signal === null ? 'PASS' : 'FAIL',
            head_sha: committed.head, tree_sha: committed.tree });
        }
        await guard(); abort.throwIfAborted(); await assertFrozen();
        if (checks.length !== unit.acceptance.length || checks.some((check, i) => check.id !== unit.acceptance[i]!.id)) throw new NativeHold('native_check_census_mismatch');
        const receipt: NativeReceipt = { contract: 'workroom.native-receipt.v1',
          status: checks.every(check => check.status === 'PASS') ? 'LOCAL_CHECKS_PASSED' : 'LOCAL_CHECKS_FAILED',
          unit_id: unit.id, run_id: identity.run_id, principal_id: identity.principal_id, task_id: identity.task_id,
          lease_epoch: identity.lease_epoch, intent_revision: identity.intent_revision, spec_sha256: specHash,
          task_spec_sha256: unit.task_spec_sha256, base_sha: unit.base_sha, branch, head_sha: committed.head,
          tree_sha: committed.tree, model_artifact_id: identity.model_artifact_id, checks, changed_files: committed.changed,
          transcript_sha256: nativeDigest(JSON.stringify(journal.steps)), transcript_ref: `${nativeDigest(identity.run_id)}/journal.json`,
          push: 'NOT_RUN', independent_verdict: 'NOT_RUN', execution_boundary: 'trusted_data_checks_only',
          actual_micro_usd: identity.actual_micro_usd, actual_tokens: tokens, budget_check: 'estimate_admitted_and_actual_observed' };
        journal.receipt = z.json().parse(receipt); await durableJSON(journalPath, journal);
        return receipt;
      } finally { await lock.release(); }
    },
  };
}
