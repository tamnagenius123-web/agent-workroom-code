import test from 'node:test';
import assert from 'node:assert/strict';
import { latestByAgent, parseSnapshot } from '../src/server/usage.ts';
import { codexFromLines, museFromLedger, render } from '../scripts/usage-collect.mts';

test('codex parser takes the highest window from the last rate_limits line', () => {
  const line = JSON.stringify({ timestamp: '2026-10-26T14:00:00Z', payload: { rate_limits: { plan_type: 'pro', primary: { used_percent: 12, window_minutes: 300, resets_at: 1792302862 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: 1792302862 } } } });
  const s = codexFromLines(['{}', line, 'garbage'], '/dev/null')!;
  assert.equal(s.method, 'measured'); assert.equal(s.used_percent, 30); assert.equal(s.resets_at, '2026-10-18T05:54:22.000Z');
});
test('muse ledger is budget minus reported tokens', () => {
  const s = museFromLedger({ budget_tokens: 280_000_000, entries: [{ at: 'a', tokens: 70_000_000 }, { at: 'b', tokens: 14_000_000 }] }, 'now');
  assert.equal(s.remaining_tokens, 196_000_000); assert.equal(s.used_percent, 30); assert.equal(s.method, 'ledger');
});
test('rendered snapshot round-trips and latest per agent wins', () => {
  const mk = (pct: number, at: string) => render({ kind: 'usage.snapshot.v1', collected_at: at, sources: [{ agent: 'codex', method: 'measured', used_percent: pct, observed_at: at, basis: 'x' }] });
  assert.equal(parseSnapshot('no marker ```json\n{}\n```'), null);
  const r = latestByAgent([{ id: 'm2', actor_id: 'grok', text: mk(40, '2'), created_at: '2' }, { id: 'm1', actor_id: 'grok', text: mk(10, '1'), created_at: '1' }]);
  assert.equal(r.length, 1); assert.equal(r[0]?.used_percent, 40); assert.equal(r[0]?.message_id, 'm2');
});
test('collect marks a codex reading whose window already reset as estimated 0%', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { collect } = await import('../scripts/usage-collect.mts');
  const h = mkdtempSync(join(tmpdir(), 'um-')); mkdirSync(join(h, '.codex/sessions'), { recursive: true });
  writeFileSync(join(h, '.codex/sessions/a.jsonl'), JSON.stringify({ timestamp: 't', payload: { rate_limits: { primary: { used_percent: 30, window_minutes: 10080, resets_at: 1792302862 } } } }));
  process.env.npm_config_offline = 'true';
  const codex = collect(h, '2026-10-26T00:00:00.000Z').sources.find(s => s.agent === 'codex');
  assert.equal(codex?.method, 'estimated'); assert.equal(codex?.used_percent, 0);
});
