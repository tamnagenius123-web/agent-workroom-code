import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const id = 'synthetic-current-task';
const key = 'synthetic-current-submission-001';
function submission() { return { id: 'synthetic-current-submission', task_id: id, actor_id: 'synthetic:alpha', lease_epoch: 1, artifact_message_id: 'synthetic-artifact', artifact_revision: 1, disposition: 'review', reason: null, submitted_at_ms: 2000 }; }
function reply(operation?: string) {
  return { ok: true, data: {
    task: { id, room_id: 'room_main', creator_id: 'synthetic:alpha', owner_id: null, goal: 'Synthetic task', dependencies: [], input_versions: [], done_conditions: ['verified'], state: 'review', version: 3,
      current_submission_id: 'synthetic-current-submission' as string | null, cancel_reason: null, created_at_ms: 1000, updated_at_ms: 2000, stop_confirmation: 'unavailable_no_runner' },
    lease: { task_id: id, holder_id: 'synthetic:alpha', lease_epoch: 1, expires_at_ms: 0 }, submission: submission() as ReturnType<typeof submission> | null, server_time_ms: 2000, lease_active: false,
    ...(operation ? { operation: { type: operation, idempotency_key: key } } : {}),
  }, meta: { request_id: 'synthetic-current-submission', schema_version: '1', server_time: '2026-11-07T00:00:00.000Z', ...(operation ? { idempotency_key: key, replayed: false } : {}) } };
}
async function probe(args: string[], body: unknown) {
  const requests: { method?: string; url?: string; key?: string; body: string }[] = [];
  const server = createServer((req, res) => { let text = ''; req.on('data', b => { text += String(b); }); req.on('end', () => { requests.push({ method: req.method, url: req.url, key: req.headers['idempotency-key'] as string | undefined, body: text }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const addr = server.address(); assert.ok(addr && typeof addr === 'object');
  const child = spawn(process.execPath, ['dist/workroom.mjs', ...args], { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: 'UTC', WORKROOM_URL: 'http://127.0.0.1:' + addr.port, WORKROOM_LOCAL_TOKEN: 'local-alpha-fixture' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false; child.stdout.on('data', b => { stdout += String(b); }); child.stderr.on('data', b => { stderr += String(b); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(timedOut, false); assert.equal(stdout.trim().split('\n').length, 1);
    return { code, stdout, stderr, requests, response: JSON.parse(stdout) as { ok: boolean; error?: { code: string; outcome: string } } };
  } finally { clearTimeout(timer); child.kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test('CLI current submission rejects a different same-task submission selected by GET', async t => {
  const body = reply(); body.data.submission!.id = 'synthetic-other-submission';
  const result = await probe(['task', 'get', '--room', 'room_main', '--task', id], body); t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 7); assert.equal(result.response.error?.code, 'TEMPORARY_FAILURE'); assert.equal(result.response.error?.outcome, 'not_applied');
  assert.deepEqual(result.requests, [{ method: 'GET', url: '/api/v1/rooms/room_main/tasks/' + id, key: undefined, body: '' }]);
});
test('CLI current submission rejects a missing submission behind a non-null submit pointer', async t => {
  const body = reply('task.submit'); body.data.submission = null;
  const result = await probe(['task', 'submit', '--room', 'room_main', '--task', id, '--expected-version', '2', '--lease-epoch', '1', '--artifact-message', 'synthetic-artifact', '--artifact-revision', '1', '--idempotency-key', key], body); t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 7); assert.equal(result.response.error?.code, 'TEMPORARY_FAILURE'); assert.equal(result.response.error?.outcome, 'unknown');
  assert.equal(result.requests.length, 1); assert.equal(result.requests[0]?.method, 'POST'); assert.equal(result.requests[0]?.url, '/api/v1/rooms/room_main/tasks/' + id + '/submit'); assert.equal(result.requests[0]?.key, key);
});
test('CLI current submission rejects an unselected submission in operation recovery', async t => {
  const body = reply('task.submit'); body.data.task.current_submission_id = null;
  const result = await probe(['operation', 'get', '--operation', 'task.submit', '--idempotency-key', key], body); t.diagnostic(JSON.stringify(result));
  assert.equal(result.code, 7); assert.equal(result.response.error?.code, 'TEMPORARY_FAILURE'); assert.equal(result.response.error?.outcome, 'not_applied');
  assert.equal(result.requests.length, 1); assert.equal(result.requests[0]?.method, 'GET'); assert.equal(result.requests[0]?.url, '/api/v1/operations/task.submit/' + key);
});
