import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, runDriver, type DriverIO, type DriverJournal, type Envelope } from '../scripts/orch/driver.ts';
import { createApprovedHarnessHook, validateHarnessBytes, type HarnessAdmission, type HarnessProposal } from '../scripts/orch/harness-contract.ts';
import { nativeTaskDigest } from '../scripts/orch/native-contract.ts';

const ENDPOINT = digest('https://harness.synthetic.invalid');
const ok = (data: unknown): Envelope => ({ ok: true, data });
function fixture() {
  let journal: DriverJournal | null = null, serial = 0, starts = 0;
  let currentSubmission: Record<string, unknown> | null = null;
  const prompts: string[] = [];
  const task = { id: 'harness-task', room_id: 'room_main', goal: 'Use the verified procedure', owner_id: null,
    dependencies: [], input_versions: [], done_conditions: ['Return a checked result'], state: 'in_progress', version: 1,
    current_submission_id: null as string | null };
  const bundle = () => ({ task: structuredClone(task), lease: { task_id: task.id, holder_id: 'agent:test', lease_epoch: 1,
    expires_at_ms: Date.now() + 30000 }, server_time_ms: Date.now(), lease_active: true, submission: currentSubmission });
  const payload = { sections: {}, pin_table: [] };
  const context = { ...payload, used_chars: 0, manifest: { version: 1, room: 'room_main',
    payload_sha256: digest(JSON.stringify(payload)), payload_utf8_bytes: Buffer.byteLength(JSON.stringify(payload)) } };
  for (let i = 0; i < 5; i++) context.used_chars = JSON.stringify(context).length;
  const io: DriverIO = {
    uuid: () => `harness-${++serial}`,
    load: async () => structuredClone(journal),
    save: async value => { journal = structuredClone(value); },
    mcp: async name => {
      if (name === 'workroom_task_claim_next') return ok(bundle());
      if (name === 'workroom_context_pack') return ok(context);
      throw new Error(`unexpected MCP ${name}`);
    },
    rest: async (method, path, raw) => {
      if (path === '/api/v1/me') return ok({ principal_id: 'agent:test', room_id: 'room_main', can_post: true });
      if (path === '/v1/intent') return ok({ v: 1 });
      if (path.endsWith('/renew')) { task.version++; return ok(bundle()); }
      if (method === 'GET' && path.endsWith('/tasks/harness-task')) return ok(bundle());
      if (path.endsWith('/execution-runs')) {
        starts++;
        const body = raw as { prompt: string; run_id: string; attempt_id: string };
        prompts.push(body.prompt);
        return ok({ state: 'settled', disposition: 'PASS', artifact_id: 'harness-artifact',
          run_id: body.run_id, attempt_id: body.attempt_id, generation_id: 'synthetic-generation' });
      }
      if (path.includes('/messages/harness-artifact/history')) return ok({ message_id: 'harness-artifact', revisions: [
        { version: 1, room_id: 'room_main', actor_id: 'agent:test', text: 'checked synthetic result' },
      ] });
      if (path.endsWith('/submit')) {
        const body = raw as { artifact_message_id: string; artifact_revision: number; lease_epoch: number };
        currentSubmission = { id: 'submission-1', task_id: task.id, actor_id: 'agent:test',
          lease_epoch: body.lease_epoch, artifact_message_id: body.artifact_message_id,
          artifact_revision: body.artifact_revision, disposition: 'review' };
        task.current_submission_id = 'submission-1'; task.state = 'review';
        return ok({ submitted: currentSubmission });
      }
      throw new Error(`unexpected REST ${method} ${path}`);
    },
  };
  return { io, task, prompts, get starts() { return starts; }, get journal() { return journal; },
    set journal(value: DriverJournal | null) { journal = value; } };
}

test('driver invokes optional harness admission before any model dispatch', async () => {
  const f = fixture(); let prepared = 0;
  const io = { ...f.io, harness: { prepare: async () => { prepared++; throw new Error('admission denied'); },
    validate: async () => undefined } };
  const result = await runDriver({ execute: true, endpoint_sha256: ENDPOINT }, io);
  assert.equal(prepared, 1);
  assert.equal(f.starts, 0);
  assert.equal(result.disposition, 'HOLD');
});

function approved(f: ReturnType<typeof fixture>) {
  const admission: HarnessAdmission = { contract: 'workroom.harness-admission.v1', approval_ref: 'synthetic-owner-contract',
    principal_id: 'agent:test', task_id: f.task.id, task_spec_sha256: nativeTaskDigest(f.task), project: 'workroom',
    task_family: 'graph', bundles: [{ bundle_sha256: digest('bundle-1'), interpreter_sha256: digest('interpreter'),
      tool_catalog_sha256: digest('tools') }], models: ['approved-model'], max_tokens: 128,
    max_context_bytes: 3000, allow_shared_memory: false };
  const proposal: HarnessProposal = { bundle_sha256: digest('bundle-1'), model: 'approved-model',
    memory: { project: 'workroom', task_family: 'graph', visibility: 'project', retrieval_receipt_sha256: digest('retrieval'),
      items: [{ procedure: 'Check tool schema before use', authority: 'reference_data' }] } };
  return { admission, proposal };
}

test('actual runDriver pins approved model, bundle and memory before existing dispatch and submission', async () => {
  const f = fixture(), a = approved(f);
  const harness = createApprovedHarnessHook(async () => a.admission, async () => a.proposal);
  const result = await runDriver({ execute: true, endpoint_sha256: ENDPOINT }, { ...f.io, harness });
  assert.equal(result.disposition, 'AWAITING_REVIEW');
  assert.equal(f.starts, 1);
  const saved = f.journal!.attempts[0]!;
  assert.equal(saved.envelope?.model, 'approved-model');
  assert.equal(saved.envelope?.project, 'workroom');
  assert.equal(saved.envelope?.max_tokens, 128);
  assert.ok(f.prompts[0]!.includes('Check tool schema before use'));
  assert.equal(validateHarnessBytes(saved.harness_binding).bundle_sha256, digest('bundle-1'));
  assert.equal(saved.harness_binding?.retrieval_receipt_sha256, digest('retrieval'));
});

for (const kind of ['model', 'bundle', 'project', 'family', 'shared', 'bytes'] as const) {
  test(`harness rejects ${kind} outside host admission before dispatch`, async () => {
    const f = fixture(), a = approved(f);
    if (kind === 'model') a.proposal.model = 'unapproved-model';
    if (kind === 'bundle') a.proposal.bundle_sha256 = digest('unapproved-bundle');
    if (kind === 'project') a.proposal.memory.project = 'other-project';
    if (kind === 'family') a.proposal.memory.task_family = 'other-family';
    if (kind === 'shared') a.proposal.memory.visibility = 'shared';
    if (kind === 'bytes') a.proposal.memory.items = ['한'.repeat(1500)];
    const harness = createApprovedHarnessHook(async () => a.admission, async () => a.proposal);
    const result = await runDriver({ execute: true, endpoint_sha256: ENDPOINT }, { ...f.io, harness });
    assert.equal(result.disposition, 'HOLD');
    assert.equal(f.starts, 0);
  });
}

test('saved run keeps its exact memory and bundle after backpressure; selector is not rerun', async () => {
  const f = fixture(), a = approved(f); let selected = 0, first = true;
  const harness = createApprovedHarnessHook(async () => a.admission, async () => { selected++; return a.proposal; });
  const io: DriverIO = { ...f.io, harness, rest: async (method, path, body, options) => {
    if (first && path.endsWith('/execution-runs')) {
      first = false;
      return ok({ state: 'busy', failure: 'capacity:test', fetches: 0, reservation_id: null });
    }
    return f.io.rest(method, path, body, options);
  } };
  const held = await runDriver({ execute: true, endpoint_sha256: ENDPOINT }, io);
  assert.equal(held.reason, 'execution_backpressure');
  const pinned = structuredClone(f.journal!.attempts[0]!.harness_binding);
  a.proposal.memory.items = ['a newly retrieved procedure that must wait for another run'];
  a.proposal.bundle_sha256 = digest('a new champion');
  const result = await runDriver({ execute: true, endpoint_sha256: ENDPOINT }, io);
  assert.equal(result.disposition, 'AWAITING_REVIEW');
  assert.equal(selected, 1);
  assert.deepEqual(f.journal!.attempts[0]!.harness_binding, pinned);
  assert.ok(!f.prompts[0]!.includes('newly retrieved'));
});

test('changed admission and tampered memory fail closed on a saved pin', async () => {
  const f = fixture(), a = approved(f);
  const harness = createApprovedHarnessHook(async () => a.admission, async () => a.proposal);
  const binding = await harness.prepare(f.task, 'agent:test');
  assert.throws(() => validateHarnessBytes({ ...binding, context_json: binding.context_json + ' ' }), /harness_digest_mismatch/);
  a.admission.models = ['different-model'];
  await assert.rejects(harness.validate(binding, f.task, 'agent:test'), /harness_admission_changed/);
});

test('binding cannot be applied to a changed task specification or another principal', async () => {
  const f = fixture(), a = approved(f);
  const harness = createApprovedHarnessHook(async () => a.admission, async () => a.proposal);
  await assert.rejects(harness.prepare(f.task, 'agent:other'), /harness_task_binding_mismatch/);
  f.task.goal = 'Changed goal';
  await assert.rejects(harness.prepare(f.task, 'agent:test'), /harness_task_binding_mismatch/);
});

test('explicit driver billing project cannot differ from the admitted project', async () => {
  const f = fixture(), a = approved(f);
  const harness = createApprovedHarnessHook(async () => a.admission, async () => a.proposal);
  const result = await runDriver({ execute: true, endpoint_sha256: ENDPOINT, project: 'other-project' }, { ...f.io, harness });
  assert.equal(result.reason, 'harness_project_mismatch');
  assert.equal(f.starts, 0);
});

test('native and harness model contracts must agree', async () => {
  const f = fixture(), a = approved(f);
  const harness = createApprovedHarnessHook(async () => a.admission, async () => a.proposal);
  const result = await runDriver({ execute: true, endpoint_sha256: ENDPOINT }, { ...f.io, harness, native: {
    prepare: async () => ({ spec_sha256: digest('native'), task_spec_sha256: nativeTaskDigest(f.task), prompt: 'frozen',
      model: 'different-model', max_tokens: 128, max_total_tokens: 10000, max_wall_ms: 60000, max_micro_usd: 1000000 }),
    execute: async () => { throw new Error('must not execute'); },
  } });
  assert.equal(result.reason, 'harness_native_model_mismatch');
  assert.equal(f.starts, 0);
});

test('noncooperative harness selection cannot outlive the driver deadline', async () => {
  const f = fixture(), a = approved(f);
  const harness = createApprovedHarnessHook(async () => a.admission, async () => new Promise(() => undefined));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('WATCHDOG_EXCEEDED')), 250); });
  try {
    const result = await Promise.race([runDriver({ execute: true, endpoint_sha256: ENDPOINT, max_runtime_ms: 15 }, { ...f.io, harness }), watchdog]);
    assert.equal(result.reason, 'runtime_bound');
    assert.equal(f.starts, 0);
  } finally { clearTimeout(timer); }
});
