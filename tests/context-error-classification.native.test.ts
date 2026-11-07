import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { harness } from '../scripts/local-harness.ts';
import { buildContextBudget, renderContext, type ContextCandidate } from '../src/phase-contracts/context-budget.ts';

type App = Awaited<ReturnType<typeof harness>>;
type Data = { rendered: string; token_count: number; token_counter: string; manifest: { id: string; actually_emitted: boolean; selected: boolean }[] };
type Envelope = { ok: boolean; data?: Data; error?: { code: string; message: string; retryable: boolean; outcome: string } };
type Rpc = { error?: unknown; result?: { isError?: boolean; structuredContent?: Envelope; tools?: { name: string }[] } };
const marker = 'MANDATORY_EXCEEDS_BUDGET';
const prefix = 'context_budget.mandatory: MANDATORY_EXCEEDS_BUDGET: ';
function item(id = 'synthetic-item'): ContextCandidate {
  return { id, source_id: 'synthetic-source', revision: 'synthetic-rev', scope: 'room_main', representation: 'body', freshness: 'FRESH', coverage: 'body', text: 'Synthetic 😀 한글', token_cost: 1, mandatory: true, correction: false };
}
async function snapshot(app: App) {
  const tables = (await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all<{ name: string }>()).results;
  const rows: Record<string, unknown> = {};
  for (const { name } of tables) rows[name] = (await app.db.prepare('SELECT * FROM "' + name.replaceAll('"', '""') + '"').all()).results.sort((a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return rows;
}
async function rpc(app: App, method: string, params: Record<string, unknown>) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
  } } });
  const response = await app.mf.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST', headers: {
    Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': method, ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
  }, body: payload });
  return { status: response.status, body: await response.json() as Rpc, payloadSha256: createHash('sha256').update(payload).digest('hex') };
}
test('native MCP context compiler error classification does not trust interpolated markers', async t => {
  let outbound = 0;
  const app = await harness({ persist: await mkdtemp(join(tmpdir(), 'context-classification-')), through: 9999,
    outboundService: () => { outbound++; return new Response('Blocked synthetic outbound', { status: 599 }); },
  });
  try {
    const migrations = (await readdir('migrations')).filter(n => /^\d+.*\.sql$/.test(n)).sort();
    const applied = (await app.db.prepare('SELECT name FROM local_migrations ORDER BY name').all<{ name: string }>()).results.map((r: { name: string }) => r.name);
    assert.deepEqual(applied, migrations);
    assert.equal(migrations.length, 43);
    const listed = await rpc(app, 'tools/list', {});
    assert.equal(listed.status, 200);
    assert.ok(listed.body.result?.tools?.some(tool => tool.name === 'workroom_context_compile'));
    const before = await snapshot(app);
    const cases: { name: string; items: unknown[]; budget: number; expected: string | null }[] = [
      { name: 'duplicate legal marker ID with ample budget', items: [item(marker), item(marker)], budget: 100000, expected: 'INVALID_INPUT' },
      { name: 'unknown marker property', items: [{ ...item(), [marker]: true }], budget: 100000, expected: 'INVALID_INPUT' },
      { name: 'embedded canonical prefix property', items: [{ ...item(), ['synthetic-' + prefix + 'tail']: true }], budget: 100000, expected: 'INVALID_INPUT' },
      { name: 'full canonical prefix property', items: [{ ...item(), [prefix]: true }], budget: 100000, expected: 'INVALID_INPUT' },
      { name: 'genuine mandatory exhaustion', items: [item()], budget: 0, expected: marker },
      { name: 'valid marker-named candidate exact UTF16 fit', items: [item(marker)], budget: renderContext([item(marker)]).length, expected: null },
    ];
    for (const c of cases) await t.test(c.name, async () => {
      const response = await rpc(app, 'tools/call', { name: 'workroom_context_compile', arguments: { schema_version: '1', room: 'room_main', budget: c.budget, items: c.items } });
      t.diagnostic(JSON.stringify({ case: c.name, payloadSha256: response.payloadSha256, response: response.body }));
      // Check side effects before classification assertions so baseline failures still exercise these guarantees.
      assert.deepEqual(await snapshot(app), before);
      assert.equal(outbound, 0);
      assert.equal(response.status, 200);
      assert.equal(response.body.error, undefined);
      const envelope = response.body.result?.structuredContent;
      assert.ok(envelope);
      if (c.expected) {
        assert.equal(response.body.result?.isError, true);
        assert.equal(envelope.ok, false);
        assert.equal(envelope.data, undefined);
        assert.equal(JSON.stringify(response.body).includes('"manifest"'), false);
        assert.equal(envelope.error?.outcome, 'not_applied');
        assert.equal(envelope.error?.retryable, false);
        const compiled = buildContextBudget(c.items, c.budget, (text: string) => text.length);
        assert.equal(compiled.ok, false);
        if (!compiled.ok) assert.equal(envelope.error?.message, compiled.errors.join(' '));
        assert.equal(envelope.error?.code, c.expected);
      } else {
        assert.equal(response.body.result?.isError, false);
        assert.equal(envelope.ok, true);
        const rendered = renderContext([item(marker)]);
        assert.equal(envelope.data?.rendered, rendered);
        assert.equal(envelope.data?.token_count, rendered.length);
        assert.ok(rendered.length > [...rendered].length);
        assert.equal(envelope.data?.token_counter, 'utf16_code_units');
        assert.deepEqual(envelope.data?.manifest.map(e => [e.id, e.selected, e.actually_emitted]), [[marker, true, true]]);
      }
    });
    assert.deepEqual(await snapshot(app), before);
    assert.equal(outbound, 0);
    t.diagnostic(`Applied ${migrations.length} migrations; six compile requests; ${Object.keys(before).length} unchanged tables; outbound=${outbound}`);
  } finally { await app.close(); }
});
