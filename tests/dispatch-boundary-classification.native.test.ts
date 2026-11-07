import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { harness } from '../scripts/local-harness.ts';

const KEY = 'synthetic-boundary-classification-key';
const tables = ['dispatch_calls', 'budget_reservations', 'budget_actuals', 'messages', 'unit_cost_records', 'room_events'];
type App = Awaited<ReturnType<typeof harness>>;
type Envelope = { ok: boolean; error?: { code: string; message: string; outcome: string; retryable: boolean } };
type Rpc = { result?: { isError: boolean; structuredContent: Envelope; content?: { type: string; text?: string }[]; tools?: { name: string }[] }; error?: { code: number } };
async function snapshot(app: App) {
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  return rows;
}
async function rpc(app: App, method: string, params: Record<string, unknown>) {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
    } } }),
  });
  return { status: response.status, body: await response.json() as Rpc };
}
for (const configured of [true, false]) {
  test(`public dispatch boundary classification, configured=${configured}`, async t => {
    let outboundCalls = 0;
    // Fresh native D1, no cached templates. Existing local-only synthetic auth remains unchanged.
    const persist = await mkdtemp(join(tmpdir(), 'dispatch-boundary-classification-'));
    const app = await harness({ through: 9999, persist,
      ...(configured ? { bindings: { OPENROUTER_API_KEY: KEY } } : {}),
      outboundService: () => { outboundCalls++; return new Response('Blocked synthetic outbound', { status: 599 }); },
    });
    try {
      const migrations = (await readdir('migrations')).filter(n => /^\d+.*\.sql$/.test(n)).sort();
      const applied = (await app.db.prepare('SELECT name FROM local_migrations ORDER BY name').all<{ name: string }>()).results.map((r: { name: string }) => r.name);
      assert.deepEqual(applied, migrations);
      const listed = await rpc(app, 'tools/list', {});
      assert.equal(listed.status, 200);
      assert.ok(listed.body.result?.tools?.some(tool => tool.name === 'workroom_agent_dispatch'));
      const before = await snapshot(app);
      for (const transport of ['REST', 'MCP']) {
        for (const malformed of [false, true]) {
          await t.test(`${transport} ${malformed ? 'malformed input' : 'same-key repeated valid input'}`, async () => {
            const responses: { status: number; envelope: Envelope; rpcError?: unknown; isError?: boolean; content?: { type: string; text?: string }[] }[] = [];
            const key = `boundary-${transport}-${malformed ? 'malformed' : 'repeat'}`;
            const args = { schema_version: '1', model: 'z-ai/glm-5.3-flash', prompt: malformed ? '' : 'Synthetic classification probe', max_tokens: 32 };
            for (let attempt = 0; attempt < 3; attempt++) {
              if (transport === 'REST') {
                const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/dispatch', {
                  method: 'POST', headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json', 'Idempotency-Key': key },
                  body: JSON.stringify(args),
                });
                responses.push({ status: response.status, envelope: await response.json() as Envelope });
              } else {
                const response = await rpc(app, 'tools/call', { name: 'workroom_agent_dispatch', arguments: { ...args, room: 'room_main', idempotency_key: key } });
                responses.push({ status: response.status, envelope: response.body.result?.structuredContent as Envelope,
                  rpcError: response.body.error, isError: response.body.result?.isError, content: response.body.result?.content });
              }
              assert.deepEqual(await snapshot(app), before, 'No claims, reservations, actuals, messages, costs or room events may mutate');
              assert.equal(outboundCalls, 0, 'No outbound calls, including synthetic calls');
            }
            const expected = malformed ? 'INVALID_INPUT' : configured ? 'NOT_AVAILABLE' : 'DISPATCH_NOT_CONFIGURED';
            for (const response of responses) {
              assert.equal(response.rpcError, undefined);
              if (transport === 'REST') assert.equal(response.status, !malformed && !configured ? 503 : 400);
              else { assert.equal(response.status, 200); assert.equal(response.isError, true); }
              if (transport === 'MCP' && malformed) {
                // SDK input-schema validation precedes the registered handler and returns text, not a domain envelope.
                assert.equal(response.envelope, undefined);
                assert.match(response.content?.[0]?.text ?? '', /Input validation error: Invalid arguments for tool workroom_agent_dispatch/);
                assert.match(response.content?.[0]?.text ?? '', /prompt/);
                assert.ok(!JSON.stringify(response).includes(KEY));
                continue;
              }
              assert.equal(response.envelope.ok, false);
              assert.equal(response.envelope.error?.code, expected);
              assert.equal(response.envelope.error?.outcome, 'not_applied');
              assert.equal(response.envelope.error?.retryable, false);
              assert.ok(!JSON.stringify(response).includes(KEY));
              if (configured && !malformed) assert.equal(response.envelope.error?.message, 'Dispatch cost estimation is not available.');
            }
          });
        }
      }
      assert.deepEqual(await snapshot(app), before);
      assert.equal(outboundCalls, 0);
      t.diagnostic(`Applied ${migrations.length} migrations; checked 12 requests and ${tables.length} unchanged tables; outbound calls=${outboundCalls}`);
    } finally { await app.close(); }
  });
}
