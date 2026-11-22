import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { DECISION_LIVE_ENABLED } from '../src/decision/config.ts';
import { loadRoster } from '../src/decision/llm-fallback.ts';
import type { FetchLike } from '../src/decision/llm-fallback.ts';
import { claimUnitId, shadowClaim } from '../src/server/decision-shadow.ts';
import type { Database } from '../src/server/db.ts';

const KEY = 'test-key';
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async () => {
    throw new Error('unexpected network');
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

function statements(sql: string, db: Database) {
  const body = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  return body.split(';').map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement));
}

async function database() {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response(null) } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'shadow-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  return { mf, db, env: { DB: db } };
}

test('a task claim path is the only shadow trigger', () => {
  assert.equal(claimUnitId('https://oauth.test/api/v1/rooms/room_main/tasks/unit-1/claim', 'POST'), 'unit-1');
  assert.equal(claimUnitId('https://oauth.test/api/v1/rooms/room_main/tasks/unit-1/claim', 'GET'), null);
  assert.equal(claimUnitId('https://oauth.test/api/v1/me', 'POST'), null);
});

test('a missing judgments table does not throw and does not apply', async () => {
  const { mf, env } = await database();
  try {
    const result = await shadowClaim(env, 'unit-1', (async () => {
      throw new Error('called');
    }) as FetchLike);
    assert.equal(DECISION_LIVE_ENABLED, false);
    assert.equal(result.applied, false);
    assert.equal(result.verdict, 'fallback_rule');
  } finally {
    await mf.dispose();
  }
});

test('a present judgments table records the shadow row', async () => {
  const { mf, db, env } = await database();
  try {
    const sql = readFileSync(new URL('../migrations/0078_judgments.sql', import.meta.url), 'utf8');
    await db.batch(statements(sql, db));
    const result = await shadowClaim(env, 'unit-2', (async () => {
      throw new Error('called');
    }) as FetchLike);
    assert.equal(result.applied, false);
    const row = await db.prepare('SELECT provider_path, verdict, consumed_by FROM judgments').first<{ provider_path: string; verdict: string; consumed_by: string | null }>();
    assert.equal(row?.provider_path, 'rule');
    assert.equal(row?.verdict, 'fallback_rule');
    assert.equal(row?.consumed_by, null);
  } finally {
    await mf.dispose();
  }
});

test('a configured claim records d1 and does not call Decider', async () => {
  const { mf, db, env } = await database();
  const calls: { url: string; body: string }[] = [];
  try {
    const judgments = readFileSync(new URL('../migrations/0078_judgments.sql', import.meta.url), 'utf8');
    const budget = readFileSync(new URL('../migrations/0028_budget_ledger.sql', import.meta.url), 'utf8');
    await db.batch([...statements(budget, db), ...statements(judgments, db)]);
    const fetchImpl: FetchLike = async (input, init) => {
      calls.push({ url: String(input), body: typeof init?.body === 'string' ? init.body : '' });
      return new Response(JSON.stringify({
        id: 'gen-dec-1',
        model: 'liquid/d1.2-ultra',
        provider: 'TypeSafe',
        answers: { waiting_on_external_reply: { type: 'noul', noul: 0.1 } },
        usage: { input_tokens: 20, output_tokens: 4, cost: 0.0000384, is_byok: false, cost_details: { upstream_inference_cost: 0.0000384, upstream_inference_prompt_cost: 0.0000384, upstream_inference_completions_cost: 0 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const result = await shadowClaim({ ...env, OPENROUTER_API_KEY: KEY }, 'unit-3', fetchImpl);
    assert.equal(result.applied, false);
    assert.equal(result.verdict, 'act');
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0]?.body ?? '{}').model, 'liquid/d1.2-ultra');
    assert.equal(calls.some(call => call.body.includes('pplx-decider') || call.body.includes('decider')), false);
    const row = await db.prepare('SELECT provider_path, model, verdict FROM judgments').first<{ provider_path: string; model: string; verdict: string }>();
    assert.equal(row?.provider_path, 'd1');
    assert.equal(row?.model, 'liquid/d1.2-ultra');
    assert.equal(row?.verdict, 'act');
  } finally {
    await mf.dispose();
  }
});

test('the general roster loads inside a workerd bundle', async () => {
  assert.equal(loadRoster().models.some(model => model.id === 'z-ai/glm-5.3'), true);
  const dir = await mkdtemp(join(tmpdir(), 'roster-worker-'));
  try {
    const entry = join(dir, 'entry.ts');
    const source = join(process.cwd(), 'src/decision/llm-fallback.ts');
    await writeFile(entry, `import { loadRoster } from ${JSON.stringify(source)};\nexport default { fetch() { const row = loadRoster().models.find(model => model.id === 'z-ai/glm-5.3'); return Response.json({ id: row ? row.id : null }); } };\n`);
    const outfile = join(dir, 'worker.mjs');
    await build({ bundle: true, format: 'esm', platform: 'browser', target: 'es2023', entryPoints: [entry], outfile, logLevel: 'silent' });
    const bundled = readFileSync(outfile, 'utf8');
    assert.equal(bundled.includes('node:fs'), false);
    assert.equal(bundled.includes('readFileSync'), false);
    const mf = new Miniflare({ modules: true, script: bundled, compatibilityDate: '2026-07-28', cf: false } as ConstructorParameters<typeof Miniflare>[0]);
    try {
      const response = await mf.dispatchFetch('https://roster.test/');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id: 'z-ai/glm-5.3' });
    } finally {
      await mf.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
