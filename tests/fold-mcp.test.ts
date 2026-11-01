import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../scripts/local-harness.ts';

let app: Awaited<ReturnType<typeof harness>>;
before(async () => { app = await harness({ through: 9999 }); });
after(async () => { await app?.close(); });
type Res = { status: number; body: { data: { message: { id: string; created_at: string } } } };
async function post(key: string, text: string): Promise<Res> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/messages', { method: 'POST',
    headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ schema_version: '1', text }) });
  return { status: response.status, body: await response.json() as Res['body'] };
}
async function rpc(method: string, params: { name: string; arguments: object }) {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST',
    headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method, 'Mcp-Name': params.name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  return { status: response.status, body: await response.json() as { result: { structuredContent: { data: unknown }; isError: boolean } } };
}

test('MCP fold tools: propose stays pending, view and folded context pack read it back', async () => {
  const msg = await post('fold-mcp-src-001', 'fold source for MCP wiring');
  const id = msg.body.data.message.id;
  for (let n = 0; n < 20; n++) assert.equal((await post(`fold-mcp-tail-${String(n).padStart(3, '0')}`, `tail ${n}`)).status, 200);
  type FoldData = { fold: { id: string; review_state: string }; content_digest: string; folds: { id: string }[]; fold_ids: string[] };
  const data = (r: { body: { result: { structuredContent: { data: unknown } } } }) => r.body.result.structuredContent.data as FoldData;
  const call = (name: string, args: object) => rpc('tools/call', { name, arguments: { schema_version: '1', room: 'room_main', ...args } });
  const proposed = await call('workroom_fold_propose', { summary: 'MCP wiring fold', valid_from: msg.body.data.message.created_at, message_ids: [id] });
  assert.equal(proposed.body.result.isError, false, JSON.stringify(proposed.body));
  const fold = data(proposed).fold;
  assert.equal(fold.review_state, 'pending');
  assert.match(data(proposed).content_digest, /^[0-9a-f]{64}$/);
  const hidden = await call('workroom_fold_view', {});
  assert.equal(data(hidden).folds.some(f => f.id === fold.id), false);
  const shown = await call('workroom_fold_view', { include_pending: true });
  assert.equal(data(shown).folds.some(f => f.id === fold.id), true);
  const selfReview = await call('workroom_fold_review', { target: 'fold', id: fold.id, verdict: 'approve', reason: 'self', content_digest: data(proposed).content_digest });
  assert.equal(selfReview.body.result.isError, true);
  const pack = await call('workroom_context_pack', { task: 'fold', budget_chars: 2000, folds: true });
  assert.equal(pack.body.result.isError, false, JSON.stringify(pack.body));
  assert.ok(Array.isArray(data(pack).fold_ids));
  assert.equal(data(pack).fold_ids.includes(fold.id), false);
});
