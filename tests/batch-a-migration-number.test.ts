import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// BATCH-A HOLD: I1 0049 is below applied 0052/0053, and H3 0053_decisions.sql
// shares 0053 with 0053_claude_alias.sql. Applied main files stay put.
// Next free numbers are 0054 (intent) and 0055 (decisions). 0049 is retired.

const APPLIED_MAIN = ['0052_bot_aliases.sql', '0053_claude_alias.sql'] as const;

test('I1 and H3 migrations are 0054 and 0055, above applied 0053, with no shared number', () => {
  const sql = readdirSync('migrations').filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const numbers = sql.map(name => name.slice(0, 4));
  const duplicates = [...new Set(numbers.filter((number, index) => numbers.indexOf(number) !== index))];
  assert.deepEqual(duplicates, [], `duplicate migration numbers: ${duplicates.join(' ')}`);
  for (const name of APPLIED_MAIN) assert.ok(sql.includes(name), `${name} was removed or renamed`);
  assert.deepEqual(sql.filter(name => name.startsWith('0052') || name.startsWith('0053')), [...APPLIED_MAIN]);
  assert.equal(sql.includes('0049_intent.sql'), false, '0049_intent.sql is below applied 0052/0053');
  assert.equal(sql.includes('0053_decisions.sql'), false, '0053_decisions.sql collides with 0053_claude_alias.sql');
  assert.ok(sql.includes('0054_intent.sql'));
  assert.ok(sql.includes('0055_decisions.sql'));

  const registry = readFileSync('migrations/REGISTRY.md', 'utf8');
  const allocations = readFileSync('src/phase-contracts/migrations.ts', 'utf8');
  assert.match(registry, /^merge_order:.*\b0052 0053 0054 0055\b/m);
  assert.match(registry, /\| 0049 \| .* \| reserved \|/);
  assert.match(registry, /\| 0054 \| I1 intent layer \(0054_intent\.sql\) \| used \|/);
  assert.match(registry, /\| 0055 \| H3 weighted decisions \(0055_decisions\.sql\) \| used \|/);
  assert.match(registry, /\| 0053 \| agent:claude aliases claude\/클로드 \(0053_claude_alias\.sql, grok\/claude-agent\) \| used \|/);
  assert.match(allocations, /'0049': \{ unit: '[^']+', status: 'reserved' \}/);
  assert.match(allocations, /'0054': \{ unit: 'I1 intent layer \(0054_intent\.sql\)', status: 'used' \}/);
  assert.match(allocations, /'0055': \{ unit: 'H3 weighted decisions \(0055_decisions\.sql\)', status: 'used' \}/);
  assert.match(allocations, /'0053': \{ unit: 'agent:claude aliases claude\/클로드 \(0053_claude_alias\.sql, grok\/claude-agent\)', status: 'used' \}/);
});
