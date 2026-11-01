import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CREDIT_EXPIRES_AT, CREDIT_USD, creditRemaining, meterSnapshot, readWakeLog, unitOf, usageByUnit } from '../scripts/claude-meter.mts';

const dir = mkdtempSync(join(tmpdir(), 'claude-meter-'));
const wake = join(dir, 'wake.log'), ledger = join(dir, 'api-spend.json');
const before = Date.parse('2026-10-28T12:00:00+09:00');
writeFileSync(wake, [
  { t: '2026-10-27T01:00:00Z', ev: 'wake', id: 'm0' },
  { t: '2026-10-27T01:00:10Z', ev: 'replied', id: 'm1', unit: 'CLAUDE-METER', auth: 'api', usage: { input: 100, output: 50, cache_read: 1000, cache_write: 10 }, cost_usd: 0.5 },
  { t: '2026-10-27T01:05:00Z', ev: 'replied', id: 'm2', unit: 'CLAUDE-METER', auth: 'api', usage: { input: 200, output: 25 }, cost_usd: 0.25 },
  { t: '2026-10-27T01:06:00Z', ev: 'replied', id: 'm3', unit: 'TRK-FIX2', auth: 'subscription', usage: { input: 10, output: 5 } },
  { t: '2026-10-27T01:07:00Z', ev: 'replied', id: 'm4', auth: 'api', usage: { input: 1, output: 1 }, cost_usd: 0.01 },
].map(o => JSON.stringify(o)).join('\n') + '\nnot json\n');

test('per-unit usage: tokens and cost summed per unit, untagged wakes under unattributed', () => {
  const u = usageByUnit(readWakeLog(wake).entries);
  assert.deepEqual(Object.keys(u).sort(), ['CLAUDE-METER', 'TRK-FIX2', 'unattributed']);
  assert.deepEqual(u['CLAUDE-METER'], { wakes: 2, input: 300, output: 75, cache_read: 1000, cache_write: 10, tokens_total: 1385, cost_usd: 0.75, api_wakes: 2 });
  assert.equal(u['TRK-FIX2']!.cost_usd, 0); assert.equal(u['TRK-FIX2']!.api_wakes, 0); assert.equal(u['TRK-FIX2']!.tokens_total, 15);
  assert.equal(u.unattributed!.wakes, 1);
});

test('remaining credit = 199.99 - ledger usd, method ledger', () => {
  writeFileSync(ledger, JSON.stringify({ usd: 12.5, updated: '2026-10-27T01:07:00Z' }));
  const c = creditRemaining(ledger, before);
  assert.equal(CREDIT_USD, 199.99);
  assert.equal(c.method, 'ledger'); assert.equal(c.spent_usd, 12.5); assert.equal(c.remaining_credit_usd, 187.49); assert.equal(c.expired, false);
  assert.equal(c.null_reason, null);
});

test('credit is 0 and expired from 2026-11-01 00:00 KST; one second before it is still live', () => {
  writeFileSync(ledger, JSON.stringify({ usd: 10, updated: 'x' }));
  assert.equal(CREDIT_EXPIRES_AT, Date.parse('2026-11-01T00:00:00+09:00'));
  const at = creditRemaining(ledger, CREDIT_EXPIRES_AT);
  assert.equal(at.expired, true); assert.equal(at.remaining_credit_usd, 0);
  const pre = creditRemaining(ledger, CREDIT_EXPIRES_AT - 1000);
  assert.equal(pre.expired, false); assert.equal(pre.remaining_credit_usd, 189.99);
});

test('missing or bad ledger gives null remaining with a reason, never the full 199.99', () => {
  for (const f of [join(dir, 'nope.json'), (writeFileSync(join(dir, 'bad.json'), '{"usd":"x"}'), join(dir, 'bad.json')), (writeFileSync(join(dir, 'junk.json'), 'junk'), join(dir, 'junk.json'))]) {
    const c = creditRemaining(f, before);
    assert.equal(c.remaining_credit_usd, null); assert.equal(c.method, 'unavailable'); assert.ok(c.null_reason && c.null_reason.length > 0);
  }
});

test('missing wake.log gives empty units and a reason; snapshot uses the UsageSource shape for agent claude', () => {
  assert.deepEqual(readWakeLog(join(dir, 'missing.log')), { entries: [], reason: 'wake.log missing' });
  writeFileSync(ledger, JSON.stringify({ usd: 12.5, updated: 'x' }));
  const s = meterSnapshot({ wakeLog: wake, ledger, now: before });
  assert.equal(s.agent, 'claude'); assert.equal(s.method, 'ledger'); assert.equal(s.observed_at, new Date(before).toISOString());
  assert.equal(s.tokens_total, 1385 + 15 + 2); assert.equal(s.remaining_credit_usd, 187.49); assert.ok(s.basis.length <= 400);
  assert.equal(s.units['CLAUDE-METER']!.cost_usd, 0.75);
  const e = meterSnapshot({ wakeLog: join(dir, 'missing.log'), ledger: join(dir, 'nope.json'), now: before });
  assert.equal(e.method, 'unavailable'); assert.deepEqual(e.units, {}); assert.equal(e.remaining_credit_usd, null); assert.match(e.basis, /wake\.log missing/);
});

test('unitOf extracts the tracker unit id from a message', () => {
  assert.equal(unitOf('**Unit CLAUDE-METER** (tracker, CLAUDE PEER)'), 'CLAUDE-METER');
  assert.equal(unitOf('Tracker unit: **MERGE-GATE** (tracker.md)'), 'MERGE-GATE');
  assert.equal(unitOf('please resume [unit:TRK-FIX2] now'), 'TRK-FIX2');
  assert.equal(unitOf('auth check, reply with one line'), null);
  assert.equal(unitOf(undefined), null);
});
