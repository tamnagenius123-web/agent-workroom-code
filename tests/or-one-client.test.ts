import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as client from '../src/or-harness/client.ts';
import { budgetCapUsdMicros } from '../src/server/dispatch-wire.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLIENT = 'src/or-harness/client.ts';
function sources(dir = join(ROOT, 'src')): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|mts)$/.test(name) ? [relative(ROOT, path).replaceAll('\\', '/')] : [];
  }).sort();
}
function filesMatching(pattern: RegExp): string[] {
  return sources().filter(file => pattern.test(readFileSync(join(ROOT, file), 'utf8')));
}
function exportedNames(file: string): Set<string> {
  return new Set([...readFileSync(join(ROOT, file), 'utf8').matchAll(/^export\s+(?:declare\s+)?(?:interface|type|class|const|function|async function)\s+(\w+)/gm)].map(m => m[1]!));
}

test('chat and generation endpoint literals have one source of truth', () => {
  assert.deepEqual(filesMatching(/openrouter\.ai\/api\/v1\/chat\/completions/), [CLIENT]);
  assert.deepEqual(filesMatching(/openrouter\.ai\/api\/v1\/generation/), [CLIENT]);
});

test('only the reservation-aware client calls the raw chat helper', () => {
  assert.deepEqual(filesMatching(/\bchatOnce\s*\(/), [CLIENT]);
});

test('counted holds have one declaration and both ledger vocabularies are shared', () => {
  assert.deepEqual(client.COUNTED_HOLD_STATES, ['open', 'pending_actual', 'unknown']);
  const fromClient = exportedNames(CLIENT);
  assert.deepEqual([...exportedNames('src/or-harness/ledger.ts')].filter(n => fromClient.has(n)), []);
});

test('wallet default follows the roster, including zero, and invalid defaults fail closed', () => {
  const roster = client.loadRoster();
  const source = (cap_usd: number): client.Roster => ({ ...roster, project_defaults: { test: { cap_usd } } });
  assert.equal(budgetCapUsdMicros({}, source(7)), 7_000_000);
  assert.equal(budgetCapUsdMicros({}, source(0)), 0);
  assert.equal(budgetCapUsdMicros({}, source(0.25)), 250_000);
  assert.equal(budgetCapUsdMicros({ BUDGET_CAP_USD_MICROS: '5' }, source(7)), 5);
  assert.throws(() => budgetCapUsdMicros({}, { ...roster, project_defaults: {} }), /not configured/i);
  for (const value of [-1, 0.0000001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => budgetCapUsdMicros({}, source(value)), /not configured/i);
  }
});

test('exact cap conversion rejects fractional micros and overflows', () => {
  assert.equal(client.rosterCapMicros({ test: { cap_usd: 3 } }, 'test'), 3_000_000);
  assert.equal(client.rosterCapMicros({ test: { cap_usd: 0 } }, 'test'), 0);
  for (const value of [1e-7, 1.0000001, Number.MAX_SAFE_INTEGER, -1, Number.NaN]) {
    assert.throws(() => client.rosterCapMicros({ test: { cap_usd: value } }, 'test'));
  }
  assert.throws(() => client.rosterCapMicros({}, 'missing'));
});
