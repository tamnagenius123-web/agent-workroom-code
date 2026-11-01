import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminUsageReport, cachedSystem, costUsdMicros, createBatch, parseBatchResults, readUsage, stableJson, withMcpConnector, type FetchFn,
} from '../src/claude/anthropic.ts';

test('stableJson is key-order independent', () => {
  assert.equal(stableJson({ b: 1, a: { d: 2, c: 3 } }), stableJson({ a: { c: 3, d: 2 }, b: 1 }));
});

test('cachedSystem puts one breakpoint on the baseline block', () => {
  const s = cachedSystem('rules', { context_pack: { sections: {} } as never });
  assert.equal(s.length, 2);
  assert.equal(s[0]?.cache_control, undefined);
  assert.deepEqual(s[1]?.cache_control, { type: 'ephemeral' });
  assert.equal(cachedSystem('rules', {}).length, 1);
  assert.deepEqual(cachedSystem('r', { fold_pack: {} as never }, '1h')[1]?.cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('readUsage keeps cache fields and defaults missing to 0', () => {
  assert.deepEqual(readUsage({ input_tokens: 5, cache_read_input_tokens: 100 }), { input_tokens: 5, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 });
});

test('costUsdMicros applies cache multipliers and batch discount; unknown rates stay undefined', () => {
  const u = { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 };
  assert.equal(costUsdMicros(u, { input: 1, output: 5 }), 2_350_000);
  assert.equal(costUsdMicros(u, { input: 1, output: 5 }, { batch: true }), 1_175_000);
  assert.equal(costUsdMicros(u, undefined), undefined);
});

test('withMcpConnector adds mcp_servers and beta; rejects http', () => {
  const { body, beta } = withMcpConnector({ model: 'm' }, { url: 'https://x/mcp', name: 'workroom', allowed_tools: ['a'] });
  assert.equal(beta, 'mcp-client-2025-04-04');
  assert.deepEqual(body.mcp_servers, [{ type: 'url', url: 'https://x/mcp', name: 'workroom', tool_configuration: { enabled: true, allowed_tools: ['a'] } }]);
  assert.throws(() => withMcpConnector({}, { url: 'http://x', name: 'w' }));
});

test('createBatch rejects duplicate ids; parseBatchResults reads jsonl', async () => {
  const f: FetchFn = async () => new Response('{}');
  assert.throws(() => createBatch(f, 'k', [{ custom_id: 'a', params: {} }, { custom_id: 'a', params: {} }]));
  const rows = parseBatchResults('{"custom_id":"a","result":{"type":"succeeded","message":{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":3,"output_tokens":1}}}}\n');
  assert.equal(rows[0]?.text, 'hi');
  assert.equal(rows[0]?.usage?.input_tokens, 3);
});

test('adminUsageReport degrades without admin key and redacts errors', async () => {
  const f: FetchFn = async () => new Response('bad sk-ant-admin01-xyz', { status: 401 });
  assert.deepEqual(await adminUsageReport(f, undefined, 't'), { available: false, reason: 'ANTHROPIC_ADMIN_KEY not set' });
  assert.equal((await adminUsageReport(f, 'sk-ant-api', 't')).available, false);
  const r = await adminUsageReport(f, 'sk-ant-admin01-xyz', 't');
  assert.ok(!r.available && !r.reason.includes('xyz'));
});
