import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const key = 'synthetic-task-target-001';
const meta = { request_id: 'synthetic-task-target', schema_version: '1', server_time: '2026-11-07T00:00:00.000Z' };
function reply(id: string, operation?: string) {
  return { ok: true, data: {
    task: { id, room_id: 'room_main', creator_id: 'synthetic:alpha', owner_id: null, goal: 'synthetic task',
      dependencies: [], input_versions: [], done_conditions: ['verified'], state: 'in_progress', version: 2,
      current_submission_id: null, cancel_reason: null, created_at_ms: 1000, updated_at_ms: 2000,
      stop_confirmation: 'unavailable_no_runner' },
    lease: { task_id: id, holder_id: 'synthetic:alpha', lease_epoch: 1, expires_at_ms: 32000 },
    submission: null, server_time_ms: 2000, lease_active: true,
    ...(operation ? { operation: { type: operation, idempotency_key: key } } : {}),
  }, meta: { ...meta, ...(operation ? { idempotency_key: key, replayed: false } : {}) } };
}

async function probe(args: string[], responseBody: unknown, status = 200, input = '') {
  const requests: { method: string | undefined; url: string | undefined; key: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', bytes => { body += String(bytes); });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, key: request.headers['idempotency-key'] as string | undefined, body });
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const child = spawn(process.execPath, ['dist/workroom.mjs', ...args], {
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: 'UTC',
      WORKROOM_URL: `http://127.0.0.1:${address.port}`, WORKROOM_LOCAL_TOKEN: 'local-alpha-fixture' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10_000);
  child.stdin.end(input);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(timedOut, false, 'CLI exceeded the local test deadline');
    assert.equal(stdout.trim().split('\n').length, 1, 'CLI must emit exactly one JSON envelope');
    return { code, body: JSON.parse(stdout) as { ok: boolean; error?: { code: string; outcome: string }; data?: { task?: { id: string } } }, requests, stdout, stderr };
  } finally {
    clearTimeout(timer); child.kill(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
const get = ['task', 'get', '--room', 'room_main', '--task', 'requested-task'];
const claim = ['task', 'claim', '--room', 'room_main', '--task', 'requested-task', '--expected-version', '1', '--lease-epoch', '0', '--idempotency-key', key];

test('CLI task get rejects another task despite a valid response envelope', async t => {
  const result = await probe(get, reply('different-task')); t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 7); assert.equal(result.body.error?.outcome, 'not_applied');
  assert.equal(result.body.error?.code, 'TEMPORARY_FAILURE');
  assert.deepEqual(result.requests, [{ method: 'GET', url: '/api/v1/rooms/room_main/tasks/requested-task', key: undefined, body: '' }]);
});
test('CLI task claim rejects another task even with matching action and idempotency key', async t => {
  const result = await probe(claim, reply('different-task', 'task.claim')); t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 7); assert.equal(result.body.error?.outcome, 'unknown');
  assert.equal(result.body.error?.code, 'TEMPORARY_FAILURE');
  assert.equal(result.requests.length, 1); assert.equal(result.requests[0]?.url, '/api/v1/rooms/room_main/tasks/requested-task/claim');
  assert.equal(result.requests[0]?.key, key); assert.equal(result.requests[0]?.method, 'POST');
  assert.deepEqual(JSON.parse(result.requests[0]!.body), { schema_version: '1', expected_version: 1, lease_epoch: 0 });
});
test('CLI accepts a task get response for the requested task', async () => {
  const result = await probe(get, reply('requested-task'));
  assert.equal(result.code, 0); assert.equal(result.body.data?.task?.id, 'requested-task'); assert.equal(result.requests.length, 1);
});
test('CLI accepts a task claim response for the requested task and key', async () => {
  const result = await probe(claim, reply('requested-task', 'task.claim'));
  assert.equal(result.code, 0); assert.equal(result.body.data?.task?.id, 'requested-task'); assert.equal(result.requests.length, 1);
});
test('CLI task creation accepts a server-generated task identifier', async () => {
  const result = await probe(['task', 'create', '--room', 'room_main', '--stdin', '--idempotency-key', key], reply('server-generated-task', 'task.create'), 200,
    JSON.stringify({ goal: 'synthetic task', done_conditions: ['verified'] }));
  assert.equal(result.code, 0); assert.equal(result.body.data?.task?.id, 'server-generated-task'); assert.equal(result.requests.length, 1);
});
test('CLI operation recovery keeps key and action binding without inventing a task target', async () => {
  const result = await probe(['operation', 'get', '--operation', 'task.claim', '--idempotency-key', key], reply('original-task', 'task.claim'));
  assert.equal(result.code, 0); assert.equal(result.body.data?.task?.id, 'original-task'); assert.equal(result.requests.length, 1);
});
test('CLI task errors retain server classification without requiring task data', async () => {
  const result = await probe(get, { ok: false, meta, error: { code: 'NOT_FOUND', message: 'Synthetic missing task', retryable: false, outcome: 'not_applied' } }, 404);
  assert.equal(result.code, 4); assert.equal(result.body.error?.code, 'NOT_FOUND'); assert.equal(result.requests.length, 1);
});

const submit = ['task', 'submit', '--room', 'room_main', '--task', 'requested-task', '--expected-version', '1', '--lease-epoch', '1', '--artifact-message', 'synthetic-artifact', '--artifact-revision', '1', '--idempotency-key', key];
function submittedReply(submissionTask: string) {
  const result = reply('requested-task', 'task.submit');
  return { ...result, data: { ...result.data,
    task: { ...result.data.task, state: 'review', current_submission_id: 'synthetic-submission' },
    lease: { ...result.data.lease, expires_at_ms: 0 }, lease_active: false,
    submission: { id: 'synthetic-submission', task_id: submissionTask, actor_id: 'synthetic:alpha', lease_epoch: 1,
      artifact_message_id: 'synthetic-artifact', artifact_revision: 1, disposition: 'review', reason: null, submitted_at_ms: 2000 },
  } };
}
test('CLI relationship rejects a foreign lease within the requested task GET', async t => {
  const body = reply('requested-task'); body.data.lease.task_id = 'different-task';
  const result = await probe(get, body); t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 7); assert.equal(result.body.error?.outcome, 'not_applied'); assert.equal(result.requests.length, 1);
});
test('CLI relationship rejects a foreign submission within the requested task submit', async t => {
  const result = await probe(submit, submittedReply('different-task')); t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 7); assert.equal(result.body.error?.outcome, 'unknown'); assert.equal(result.requests.length, 1);
});
test('CLI relationship accepts a same-task non-null submission', async () => {
  const result = await probe(submit, submittedReply('requested-task'));
  assert.equal(result.code, 0); assert.equal(result.body.data?.task?.id, 'requested-task'); assert.equal(result.requests.length, 1);
});
test('CLI relationship validates task-create bundle without predicting the server-generated ID', async () => {
  const body = reply('server-generated-task', 'task.create'); body.data.lease.task_id = 'different-task';
  const result = await probe(['task', 'create', '--room', 'room_main', '--stdin', '--idempotency-key', key], body, 200,
    JSON.stringify({ goal: 'synthetic task', done_conditions: ['verified'] }));
  assert.equal(result.code, 7); assert.equal(result.body.error?.outcome, 'unknown'); assert.equal(result.requests.length, 1);
});
test('CLI relationship validates stored task bundles in operation recovery', async () => {
  const body = reply('original-task', 'task.claim'); body.data.lease.task_id = 'different-task';
  const result = await probe(['operation', 'get', '--operation', 'task.claim', '--idempotency-key', key], body);
  assert.equal(result.code, 7); assert.equal(result.body.error?.outcome, 'not_applied'); assert.equal(result.requests.length, 1);
});
