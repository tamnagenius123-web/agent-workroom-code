import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalNativeHook, NativeHold, nativeEnvironment } from '../scripts/orch/native-execution.ts';
import { nativeDigest, nativeTaskDigest, type NativeIdentity, type NativeUnit } from '../scripts/orch/native-contract.ts';

const ORIGINAL = 'export const answer = 1;\n', CHANGED = 'export const answer = 42;\n';
const task = { id: 'native-task', goal: 'Set the literal answer to 42', owner_id: null,
  dependencies: [], input_versions: [], done_conditions: ['The file matches the frozen expected bytes'], unit: { kind: 'builder', lease_ms: 2400000 } };
async function fixture(change?: (unit: NativeUnit) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'workroom-native-')), source = join(dir, 'source'), root = join(dir, 'runs');
  await mkdir(source); await mkdir(root);
  const env = nativeEnvironment(dir);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
    ...args], { cwd: source, encoding: 'utf8', env }).trim();
  git('init', '--quiet', '--template=');
  await writeFile(join(source, 'candidate.mjs'), ORIGINAL);
  git('add', '--', 'candidate.mjs'); git('commit', '--quiet', '-m', 'fixture base');
  const unit: NativeUnit = { contract: 'workroom.native-unit.v1', id: 'NATIVE-SYNTHETIC', title: 'Data check fixture', lane: 'test',
    spec_md: 'Only replace candidate.mjs. Never run candidate code.', lineage: ['INFERRED'], deps: [], verifier: 'synthetic:reviewer',
    principal_id: 'synthetic:builder', task_id: task.id, model: 'z-ai/glm-5.3-flash', task_spec_sha256: nativeTaskDigest(task),
    base_sha: git('rev-parse', 'HEAD'), approval_ref: 'synthetic fixture explicit contract', read_paths: ['candidate.mjs'], write_paths: ['candidate.mjs'],
    acceptance: [{ id: 'syntax', cmd: ['node', '--check', 'candidate.mjs'], expect: 'exit0', scope: 'touched', timeout_ms: 5000 },
      { id: 'expected-bytes', cmd: ['workroom', 'text-equals', 'candidate.mjs', CHANGED], expect: 'exit0', scope: 'full', timeout_ms: 5000 }],
    budget: { usd_max: 1, tokens_max: 1024, wall_s: 60, max_actions: 2, max_write_bytes: 4096 } };
  change?.(unit);
  const specPath = join(dir, 'unit.json');
  const configure = async () => {
    const bytes = JSON.stringify(unit); await writeFile(specPath, bytes);
    return createLocalNativeHook({ spec_path: specPath, approved_sha256: nativeDigest(bytes), repository: source, root });
  };
  const identity: NativeIdentity = { run_id: 'native-fixture-run', principal_id: unit.principal_id, task_id: task.id,
    lease_epoch: 7, intent_revision: 3, cancel_generation: 2, model_artifact_id: 'model-artifact', actual_micro_usd: 12,
    actual_tokens: { prompt: 10, completion: 20, total: 30 } };
  const actions = (specHash: string, content = CHANGED, path = 'candidate.mjs') => JSON.stringify({ contract: 'workroom.native-actions.v1',
    spec_sha256: specHash, actions: [{ tool: 'write_file', path, before_sha256: nativeDigest(ORIGINAL), content }] });
  return { dir, source, root, unit, git, identity, actions, configure, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const signal = () => new AbortController().signal;

test('a descendant named ..cache is rejected before native root creation', async () => {
  const f = await fixture();
  try {
    await f.configure();
    const forbidden = join(f.source, '..cache');
    const result = await createLocalNativeHook({ spec_path: join(f.dir, 'unit.json'),
      approved_sha256: nativeDigest(JSON.stringify(f.unit)), repository: f.source, root: forbidden })
      .then(() => ({ error: null }), (error: unknown) => ({ error }));
    const created = await lstat(forbidden).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    assert.deepEqual({ accepted: result.error === null, created }, { accepted: false, created: false });
    assert.ok(result.error instanceof NativeHold);
    assert.equal(result.error.code, 'native_root_inside_repository');
  } finally { await f.cleanup(); }
});

test('an existing symlink ancestor is rejected before creating a source child directory', async () => {
  const f = await fixture();
  try {
    await f.configure();
    const alias = join(f.dir, 'outside-looking-root');
    await symlink(f.source, alias, 'dir');
    const error = await createLocalNativeHook({ spec_path: join(f.dir, 'unit.json'),
      approved_sha256: nativeDigest(JSON.stringify(f.unit)), repository: f.source, root: join(alias, 'native-child') })
      .then(() => null, (error: unknown) => error);
    const created = await lstat(join(f.source, 'native-child')).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    assert.deepEqual({ alias_hold: error instanceof NativeHold && error.code === 'native_root_alias', created },
      { alias_hold: true, created: false });
  } finally { await f.cleanup(); }
});

test('a dangling symlink ancestor receives an alias hold without creating its missing target', async () => {
  const f = await fixture();
  try {
    await f.configure();
    const alias = join(f.dir, 'dangling-root'), missing = join(f.source, 'missing-target');
    await symlink(missing, alias, 'dir');
    await assert.rejects(createLocalNativeHook({ spec_path: join(f.dir, 'unit.json'),
      approved_sha256: nativeDigest(JSON.stringify(f.unit)), repository: f.source, root: join(alias, 'native-child') }),
      (error: unknown) => error instanceof NativeHold && error.code === 'native_root_alias');
    await assert.rejects(lstat(missing), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('native data tools produce real exact-head checks and an isolated local branch; replay performs no new write or commit', async () => {
  const f = await fixture();
  try {
    const hook = await f.configure(), binding = await hook.prepare(task, f.unit.principal_id);
    let guards = 0;
    const receipt = await hook.execute(binding, f.identity, f.actions(binding.spec_sha256), async () => { guards++; }, signal());
    assert.equal(receipt.status, 'LOCAL_CHECKS_PASSED'); assert.equal(receipt.checks.length, 2);
    assert.ok(receipt.checks.every(check => check.status === 'PASS' && check.exit === 0 && check.head_sha === receipt.head_sha));
    assert.notEqual(receipt.head_sha, f.unit.base_sha); assert.equal(receipt.push, 'NOT_RUN'); assert.equal(receipt.independent_verdict, 'NOT_RUN');
    assert.equal(await readFile(join(f.source, 'candidate.mjs'), 'utf8'), ORIGINAL);
    const checkout = join(f.root, nativeDigest(f.identity.run_id), 'checkout');
    assert.equal(execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim(), receipt.head_sha);
    assert.equal(receipt.checks[1]!.stdout, 'data check passed\n'); assert.ok(guards >= 6);
    const replay = await hook.execute(binding, f.identity, f.actions(binding.spec_sha256), async () => undefined, signal());
    assert.deepEqual(replay, receipt);
  } finally { await f.cleanup(); }
});

test('a failed frozen check remains FAIL and independent checks still receive an exact-head result', async () => {
  const f = await fixture(unit => { unit.acceptance[1]!.cmd = ['workroom', 'text-equals', 'candidate.mjs', 'const = ;\n']; });
  try {
    const hook = await f.configure(), binding = await hook.prepare(task, f.unit.principal_id);
    const result = await hook.execute(binding, f.identity, f.actions(binding.spec_sha256, 'const = ;\n'), async () => undefined, signal());
    assert.equal(result.status, 'LOCAL_CHECKS_FAILED'); assert.deepEqual(result.checks.map(check => check.status), ['FAIL', 'PASS']);
    assert.ok(result.checks[0]!.stderr.includes('SyntaxError'));
  } finally { await f.cleanup(); }
});

test('candidate executable content is parsed as data and never run', async () => {
  const f = await fixture();
  try {
    const marker = join(f.dir, 'must-not-exist');
    const text = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');\n`;
    f.unit.acceptance[1]!.cmd = ['workroom', 'text-equals', 'candidate.mjs', text];
    const hook = await f.configure(), binding = await hook.prepare(task, f.unit.principal_id);
    const result = await hook.execute(binding, f.identity, f.actions(binding.spec_sha256, text), async () => undefined, signal());
    assert.equal(result.status, 'LOCAL_CHECKS_PASSED');
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('host environment and source git hooks, attributes and upload-pack config cannot become native commands', async () => {
  const f = await fixture();
  try {
    const marker = join(f.dir, 'hook-fired'), script = join(f.dir, 'trap.sh');
    await writeFile(script, `#!/bin/sh\nprintf unsafe > ${marker}\n`, { mode: 0o755 });
    await writeFile(join(f.source, '.gitattributes'), 'candidate.mjs filter=unsafe\n');
    f.git('add', '--', '.gitattributes'); f.git('commit', '--quiet', '-m', 'attribute fixture');
    f.unit.base_sha = f.git('rev-parse', 'HEAD');
    f.git('config', 'core.hooksPath', f.dir); f.git('config', 'filter.unsafe.clean', script);
    f.git('config', 'filter.unsafe.smudge', script); f.git('config', 'uploadpack.packObjectsHook', script);
    const environment = nativeEnvironment(f.dir);
    assert.equal(environment.OPENROUTER_API_KEY, undefined); assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.SSH_AUTH_SOCK, undefined); assert.equal(environment.NODE_PATH, undefined);
    const hook = await f.configure(), binding = await hook.prepare(task, f.unit.principal_id);
    const result = await hook.execute(binding, f.identity, f.actions(binding.spec_sha256), async () => undefined, signal());
    assert.equal(result.status, 'LOCAL_CHECKS_PASSED'); await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('unsupported required command and symlink source fail closed without substituting syntax-only success', async () => {
  const f = await fixture();
  try {
    f.unit.acceptance[0]!.cmd = ['node', 'candidate.mjs'] as unknown as NativeUnit['acceptance'][number]['cmd'];
    await assert.rejects(f.configure(), /native_contract_unsupported/);
    f.unit.acceptance[0]!.cmd = ['node', '--check', 'candidate.mjs'];
    await rm(join(f.source, 'candidate.mjs')); await symlink(join(f.dir, 'outside'), join(f.source, 'candidate.mjs'));
    f.git('add', '--', 'candidate.mjs'); f.git('commit', '--quiet', '-m', 'symlink fixture'); f.unit.base_sha = f.git('rev-parse', 'HEAD');
    const hook = await f.configure(); await assert.rejects(hook.prepare(task, f.unit.principal_id), /native_source_alias/);
  } finally { await f.cleanup(); }
});

test('unapproved paths and stale authority stop before a candidate write', async () => {
  const f = await fixture();
  try {
    const hook = await f.configure(), binding = await hook.prepare(task, f.unit.principal_id);
    for (const path of ['../outside', '.git/config', 'other.mjs', '.env']) {
      await assert.rejects(hook.execute(binding, f.identity, f.actions(binding.spec_sha256, CHANGED, path), async () => undefined, signal()), /native_actions/);
    }
    let count = 0;
    await assert.rejects(hook.execute(binding, f.identity, f.actions(binding.spec_sha256), async () => {
      if (++count === 2) throw new NativeHold('current_authority_revoked');
    }, signal()), /current_authority_revoked/);
    assert.equal(await readFile(join(f.root, nativeDigest(f.identity.run_id), 'checkout', 'candidate.mjs'), 'utf8'), ORIGINAL);
  } finally { await f.cleanup(); }
});

test('ambiguous step journal and writes after checked head prevent replay success', async () => {
  const f = await fixture();
  try {
    const hook = await f.configure(), binding = await hook.prepare(task, f.unit.principal_id), text = f.actions(binding.spec_sha256);
    await hook.execute(binding, f.identity, text, async () => undefined, signal());
    const run = join(f.root, nativeDigest(f.identity.run_id)), journalPath = join(run, 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.steps.at(-1).state = 'started'; await writeFile(journalPath, JSON.stringify(journal));
    await assert.rejects(hook.execute(binding, f.identity, text, async () => undefined, signal()), /native_effect_outcome_unknown/);
    journal.steps.at(-1).state = 'done'; await writeFile(journalPath, JSON.stringify(journal));
    await writeFile(join(run, 'checkout', 'candidate.mjs'), 'changed after check\n');
    await assert.rejects(hook.execute(binding, f.identity, text, async () => undefined, signal()), /native_checked_tree_changed/);
  } finally { await f.cleanup(); }
});

test('actual cost outside the immutable unit budget prevents checkout creation', async () => {
  const f = await fixture();
  try {
    const hook = await f.configure(), binding = await hook.prepare(task, f.unit.principal_id);
    await assert.rejects(hook.execute(binding, { ...f.identity, actual_micro_usd: 1000001 }, f.actions(binding.spec_sha256), async () => undefined, signal()), /native_actual_cost_outside_budget/);
    await assert.rejects(hook.execute(binding, { ...f.identity, actual_tokens: { prompt: 1000, completion: 25, total: 1025 } },
      f.actions(binding.spec_sha256), async () => undefined, signal()), /native_actual_tokens_outside_budget/);
    await assert.rejects(hook.execute(binding, { ...f.identity, actual_tokens: { prompt: 1, completion: 2, total: 4 } },
      f.actions(binding.spec_sha256), async () => undefined, signal()), /native_actual_tokens_outside_budget/);
    await assert.rejects(readFile(join(f.root, nativeDigest(f.identity.run_id), 'journal.json')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('native tasks require immutable builder-unit lease metadata instead of inheriting the legacy task TTL', async () => {
  const f = await fixture();
  try {
    const hook = await f.configure();
    await assert.rejects(hook.prepare({ ...task, unit: undefined }, f.unit.principal_id), /native_builder_unit_metadata_required/);
  } finally { await f.cleanup(); }
});

test('source replacement refs cannot substitute bytes behind the approved base SHA', async () => {
  const f = await fixture();
  try {
    const originalBlob = f.git('rev-parse', `${f.unit.base_sha}:candidate.mjs`);
    const other = join(f.dir, 'replacement.mjs'); await writeFile(other, CHANGED);
    const replacement = f.git('hash-object', '-w', '--', other);
    f.git('replace', originalBlob, replacement);
    const hook = await f.configure(), binding = await hook.prepare(task, f.unit.principal_id);
    const prompt = JSON.parse(binding.prompt);
    assert.equal(prompt.inputs[0].content, ORIGINAL);
    assert.equal(prompt.inputs[0].sha256, nativeDigest(ORIGINAL));
  } finally { await f.cleanup(); }
});

test('a missing promisor blob holds locally without invoking a remote helper', async () => {
  const f = await fixture();
  try {
    const blob = f.git('rev-parse', `${f.unit.base_sha}:candidate.mjs`);
    await rm(join(f.source, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    const marker = join(f.dir, 'remote-helper-fired'), helper = join(f.dir, 'remote-helper.sh');
    await writeFile(helper, `#!/bin/sh\nprintf invoked > ${marker}\nexit 1\n`, { mode: 0o755 });
    f.git('config', 'core.repositoryformatversion', '1'); f.git('config', 'extensions.partialClone', 'lazy');
    f.git('config', 'remote.lazy.promisor', 'true'); f.git('config', 'remote.lazy.url', `ext::${helper}`);
    f.git('config', 'protocol.ext.allow', 'always');
    const hook = await f.configure();
    await assert.rejects(hook.prepare(task, f.unit.principal_id), /native_input_unavailable/);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});
