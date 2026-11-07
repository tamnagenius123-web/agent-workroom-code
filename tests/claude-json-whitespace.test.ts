import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMessage } from '../src/claude/anthropic.ts';

const syntheticKey = 'synthetic-offline-only';
for (const [name, prefix] of Object.entries({ none: '', space: ' ', tab: '\t', cr: '\r', lf: '\n', mixed: ' \t\r\n \t' })) {
  test(`JSON object prefix: ${name}`, async () => {
    const actual = await createMessage(async () => new Response(`${prefix}{"usage":{"input_tokens":17}} \r\n`), syntheticKey, {});
    assert.deepEqual(actual, { usage: { input_tokens: 17 } });
  });
}
for (const [name, text] of Object.entries({ empty: '', whitespace: ' \t\r\n', array: ' [1,2]', string: ' "x"', number: ' 42', bool: '\ttrue', null: '\nnull', bom: '\uFEFF{}', nbsp: '\u00A0{}', verticalTab: '\u000B{}', formFeed: '\u000C{}', plain: 'hello {}' })) {
  test(`Non-object bytes preserved: ${name}`, async () => {
    // Response.text strips an encoding BOM, so use a text fixture to isolate call() detection.
    const response = { ok: true, text: async () => text } as Response;
    assert.equal(await createMessage(async () => response, syntheticKey, {}), text);
  });
}
for (const [name, text] of Object.entries({ bare: '{', prefixed: ' \t\r\n{', trailing: ' {} invalid' })) {
  test(`Malformed object rejects: ${name}`, async () => {
    await assert.rejects(createMessage(async () => new Response(text), syntheticKey, {}), SyntaxError);
  });
}
for (const status of [400, 503]) {
  test(`HTTP failure stays authoritative: ${status}`, async () => {
    const text = ' \n{' + 'x'.repeat(400);
    await assert.rejects(createMessage(async () => new Response(text, { status }), syntheticKey, {}), {
      message: `anthropic POST /v1/messages -> ${status}: ${text.slice(0, 300)}`,
    });
  });
}

test('Actual live-check all mode runs cache and batch exclusively against strict synthetic fixtures', () => {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  // No inherited environment, no original fetch reference, no passthrough. Install before source import.
  const program = `
import assert from 'node:assert/strict';
const key = 'synthetic-offline-only';
const model = 'synthetic-model';
const cold = { input_tokens: 11, output_tokens: 2, cache_creation_input_tokens: 1234, cache_read_input_tokens: 0 };
const warm = { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 1234 };
const seen = [];
const output = [];
const emit = console.log.bind(console);
console.log = (...args) => output.push(args);
const resultsUrl = 'https://api.anthropic.com/v1/messages/batches/synthetic-batch/results';
const base = 'https://api.anthropic.com';
const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
const decisions = Array.from({ length: 400 }, (_, i) => ({ id: 'd' + i, text: 'Decision ' + i + ': leases use epoch fencing; stale-epoch writes are rejected; owner approval revision ' + i + ' is immutable.' }));
const canonical = value => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const system = [{ type: 'text', text: 'Answer in one word.' }, { type: 'text', text: '<room_brief>\\n' + canonical({ room: 'live-check', decisions }) + '\\n</room_brief>', cache_control: { type: 'ephemeral' } }];
const expected = [
  { url: base + '/v1/messages', method: 'POST', body: { model, max_tokens: 8, system, messages: [{ role: 'user', content: 'Is fencing used? yes/no' }] } },
  { url: base + '/v1/messages', method: 'POST', body: { model, max_tokens: 8, system, messages: [{ role: 'user', content: 'Are revisions immutable? yes/no' }] } },
  { url: base + '/v1/messages/batches', method: 'POST', body: { requests: ['grade-a', 'grade-b'].map(id => ({ custom_id: id, params: { model, max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the single word OK (' + id + ').' }] } })) } },
  { url: base + '/v1/messages/batches/synthetic-batch', method: 'GET', body: undefined },
  { url: resultsUrl, method: 'GET', body: undefined },
];
const rows = ['grade-a', 'grade-b'].map(custom_id => ({ custom_id, result: { type: 'succeeded', message: { content: [{ type: 'text', text: 'OK' }], usage: warm } } }));
const fixtures = [' \\n' + JSON.stringify({ usage: cold }), '\\t' + JSON.stringify({ usage: warm }), '\\r\\n' + JSON.stringify({ id: 'synthetic-batch' }), ' \\t' + JSON.stringify({ processing_status: 'ended', results_url: resultsUrl }), rows.map(row => JSON.stringify(row)).join('\\n')];
globalThis.fetch = async (url, init) => {
  const i = seen.length;
  seen.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
  assert.ok(i < expected.length, 'Unexpected extra request; no passthrough');
  assert.equal(url, expected[i].url, 'Unrecognized or out-of-order URL; denied offline');
  assert.deepEqual(init.headers, headers);
  assert.equal(init.method, expected[i].method);
  assert.equal(init.body, expected[i].body === undefined ? undefined : JSON.stringify(expected[i].body));
  return new Response(fixtures[i]);
};
globalThis.setTimeout = () => { throw new Error('Unexpected polling wait; denied offline'); };
process.argv = [process.execPath, 'scripts/claude-live-check.mts', 'all'];
try {
  await import('./scripts/claude-live-check.mts');
  assert.equal(seen.length, 5);
  assert.deepEqual(output[0], [JSON.stringify({ cold, warm })]);
  assert.deepEqual(output[1], ['batch', 'synthetic-batch']);
  assert.deepEqual(JSON.parse(output[2][0]), rows.map(row => ({ custom_id: row.custom_id, type: 'succeeded', text: 'OK', usage: warm })));
  emit(JSON.stringify({ completed: true, requests: seen.length, output }));
} catch (error) {
  emit(JSON.stringify({ completed: false, requests: seen.length, output, lastUrl: seen.at(-1)?.url, error: String(error) }));
  process.exitCode = 1;
}
`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
    cwd, env: { ANTHROPIC_API_KEY: syntheticKey, CLAUDE_CHECK_MODEL: 'synthetic-model' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `Offline actual-consumer transcript: ${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).completed, true);
});
