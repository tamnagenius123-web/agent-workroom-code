// WG-5 r8: the merge lock signal has to abort inside workerd. The worker build is
// platform 'browser' with no nodejs_compat, so a Node Timeout's unref() throws there.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

function extractLockAbortSignal(source: string): string {
  const start = source.indexOf('function lockAbortSignal');
  assert.ok(start >= 0, 'merge.ts defines lockAbortSignal');
  const open = source.indexOf('{', start);
  assert.ok(open > start, 'lockAbortSignal has a body');
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unterminated lockAbortSignal');
}

const workerTail = `
export default {
  async fetch(request: Request): Promise<Response> {
    const ms = Number(new URL(request.url).searchParams.get('ms'));
    const probe = setTimeout(() => {}, 1000);
    const timerKind = typeof probe;
    clearTimeout(probe);
    try {
      const signal = lockAbortSignal(ms);
      const immediate = signal.aborted;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms + 500);
        if (signal.aborted) {
          clearTimeout(timer);
          resolve();
          return;
        }
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      const reason = signal.reason;
      const reasonName = reason instanceof Error ? reason.name : '';
      return Response.json({ ok: true, timerKind, immediate, aborted: signal.aborted, reasonName });
    } catch (error) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ ok: false, timerKind, name, message }, { status: 500 });
    }
  },
};
`;

test('lockAbortSignal aborts in workerd at the wrangler compat date with no compatibility flags', { timeout: 20_000 }, async () => {
  const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const compatibilityDate = /"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(wrangler)?.[1];
  assert.ok(compatibilityDate, 'wrangler.jsonc compatibility_date');
  const merge = await readFile(new URL('../src/server/wrgit/merge.ts', import.meta.url), 'utf8');
  const built = await build({
    stdin: {
      contents: `${extractLockAbortSignal(merge)}\n${workerTail}`,
      loader: 'ts',
      sourcefile: 'lock-abort-worker.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    conditions: ['workerd'],
    target: 'es2023',
    logLevel: 'silent',
  });
  const script = built.outputFiles[0]?.text;
  assert.ok(script, 'browser-platform bundle of lockAbortSignal');
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate,
    cf: false,
  });
  try {
    const res = await mf.dispatchFetch('http://example.com/?ms=30');
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const body: unknown = JSON.parse(text);
    assert.ok(body && typeof body === 'object');
    const row = body as { ok?: unknown; timerKind?: unknown; immediate?: unknown; aborted?: unknown; reasonName?: unknown };
    assert.equal(row.timerKind, 'number', 'workerd setTimeout is the web timer when no compatibility flags are set');
    assert.equal(row.ok, true);
    assert.equal(row.immediate, false);
    assert.equal(row.aborted, true);
    assert.equal(row.reasonName, 'TimeoutError');
  } finally {
    await mf.dispose();
  }
});
