import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../scripts/local-harness.ts';
import { sha256 } from '../src/auth/crypto.ts';
import { READ_TOOLS } from '../src/server/app.ts';
import { EXECUTION_READ_TOOLS, EXECUTION_WRITE_TOOLS } from '../src/server/execution-tools.ts';

type App = Awaited<ReturnType<typeof harness>>;
interface RpcResult {
  error?: { code: string | number };
  result?: {
    isError?: boolean;
    tools?: { name: string; annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean } }[];
    structuredContent?: { ok: boolean; data: Record<string, unknown>; error?: { code: string } };
  };
}
async function rpc(app: App, token: string, method: string, params: Record<string, unknown>): Promise<RpcResult> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/mcp', {
    method: 'POST', headers: {
      Authorization: `Bearer local-${token}-fixture`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params,
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
  });
  return response.json() as Promise<RpcResult>;
}
const call = (app: App, token: string, name: string, args: object) => rpc(app, token, 'tools/call', {
  name, arguments: { schema_version: '1', room: 'room_main', ...args },
});
function accepted(value: RpcResult) {
  assert.equal(value.result?.isError, false, JSON.stringify(value));
  assert.equal(value.result?.structuredContent?.ok, true, JSON.stringify(value));
  return value.result!.structuredContent!.data;
}
function errorCode(value: RpcResult) { return value.result?.structuredContent?.error?.code ?? value.error?.code; }

test('execution MCP frames share REST authority and persist independent evaluation evidence without a provider call', async () => {
  let outbound = 0;
  const app = await harness({ through: 9999, outboundService: () => {
    outbound += 1;
    return new Response('external network disabled in this fixture', { status: 599 });
  } });
  try {
    const listed = await rpc(app, 'alpha', 'tools/list', {});
    const tools = listed.result?.tools ?? [];
    for (const name of [...EXECUTION_READ_TOOLS, ...EXECUTION_WRITE_TOOLS]) assert.ok(tools.some(tool => tool.name === name), name);
    for (const name of EXECUTION_READ_TOOLS) {
      assert.equal(READ_TOOLS.has(name), true);
      assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, true);
    }
    for (const name of EXECUTION_WRITE_TOOLS) {
      assert.equal(READ_TOOLS.has(name), false);
      assert.equal(tools.find(tool => tool.name === name)?.annotations?.readOnlyHint, false);
    }
    assert.equal(tools.find(tool => tool.name === 'workroom_execution_start')?.annotations?.openWorldHint, true);
    assert.equal(tools.find(tool => tool.name === 'workroom_execution_resume')?.annotations?.openWorldHint, true);

    const spec = JSON.stringify({ goal: 'Return bounded output', owner: null, dependencies: [], input_versions: [], done_conditions: ['Output is complete'] });
    await app.db.batch([
      app.db.prepare(`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,created_at_ms,updated_at_ms)
        VALUES ('mcp-run-task','room_main','synthetic:alpha',NULL,?,'in_progress',2,?,?)`).bind(spec, Date.now(), Date.now()),
      app.db.prepare(`INSERT INTO task_leases(task_id,holder_id,lease_epoch,expires_at_ms) VALUES ('mcp-run-task','synthetic:alpha',1,?)`).bind(Date.now() + 60_000),
      app.db.prepare(`INSERT INTO execution_cancels(task_id,generation) VALUES ('mcp-run-task',0)`),
      app.db.prepare(`INSERT INTO execution_runs(run_id,attempt_id,project,task_id,principal_id,spec_digest,lease_epoch,intent_revision,cancel_generation,
        harness_digest,model_digest,policy_digest,context_digest,state,failure,generation_id,reservation_id,artifact_id,receipt_id,trace_json,created_at)
        VALUES ('mcp-run','mcp-attempt','mcp','mcp-run-task','synthetic:alpha',?,1,0,0,?,?,?,?,'unknown','provider_result_unknown',NULL,NULL,NULL,NULL,'[]',?)`)
        .bind(await sha256(spec), '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), Date.now()),
    ]);
    assert.equal(accepted(await call(app, 'reader', 'workroom_execution_status', { run_id: 'mcp-run' })).state, 'unknown');
    assert.equal(errorCode(await call(app, 'outsider', 'workroom_execution_status', { run_id: 'mcp-run' })), 'FORBIDDEN');
    const run = { task_id: 'mcp-run-task', run_id: 'mcp-run', attempt_id: 'mcp-attempt', lease_epoch: 1,
      intent_revision: 0, cancel_generation: 0, prompt: 'Return bounded output' };
    assert.equal(errorCode(await call(app, 'reader', 'workroom_execution_start', run)), 'FORBIDDEN');
    assert.equal(errorCode(await call(app, 'alpha', 'workroom_execution_start', run)), 'DISPATCH_NOT_CONFIGURED');
    assert.equal(errorCode(await call(app, 'alpha', 'workroom_execution_resume', run)), 'DISPATCH_NOT_CONFIGURED');

    assert.equal(errorCode(await call(app, 'alpha', 'workroom_execution_evaluation_freeze', { run_id: 'mcp-run', idempotency_key: 'mcp-author-freeze' })), 'FORBIDDEN');
    const frozen = accepted(await call(app, 'beta', 'workroom_execution_evaluation_freeze', { run_id: 'mcp-run', idempotency_key: 'mcp-review-freeze' }));
    const manifest = frozen.result as { manifest_digest: string; disposition: string };
    assert.equal(manifest.disposition, 'HOLD');
    const recorded = accepted(await call(app, 'beta', 'workroom_execution_evaluation_record', {
      run_id: 'mcp-run', idempotency_key: 'mcp-review-record', manifest_id: frozen.id, manifest_digest: manifest.manifest_digest, shards: [],
    }));
    assert.equal(recorded.current_disposition, 'HOLD');
    const read = accepted(await call(app, 'reader', 'workroom_execution_evaluation_read', { run_id: 'mcp-run' }));
    assert.equal(read.disposition, 'HOLD');
    assert.equal((read.receipts as unknown[]).length, 1);
    const forged = await call(app, 'beta', 'workroom_execution_evaluation_freeze', {
      run_id: 'mcp-run', idempotency_key: 'mcp-forged-freeze', principal_id: 'synthetic:alpha', expected_shards: [],
    });
    assert.ok(forged.error || forged.result?.isError);
    assert.equal(errorCode(await call(app, 'beta', 'workroom_execution_interrupt', { task_id: 'mcp-run-task', reason: 'not creator' })), 'FORBIDDEN');
    assert.equal(accepted(await call(app, 'alpha', 'workroom_execution_interrupt', { task_id: 'mcp-run-task', reason: 'fixture cancel' })).ok, true);
    const canceled = await app.db.prepare('SELECT generation FROM execution_cancels WHERE task_id=?').bind('mcp-run-task').first<{ generation: number }>();
    assert.equal(canceled?.generation, 1);
    assert.equal(outbound, 0);
  } finally { await app.close(); }
});
