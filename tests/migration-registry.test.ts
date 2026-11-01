import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import {
  MIGRATION_ALLOCATIONS, findMigrationCollisions,
  type MigrationAllocation, type ReservedMigration,
} from '../src/phase-contracts/index.ts';

// Literal path so test:affected treats this markdown as a dependency of this file.
const registryPath = 'migrations/REGISTRY.md';

function parseRegistryMarkdown(markdown: string): { mergeOrder: string[]; rows: MigrationAllocation[] } {
  const orderMatch = markdown.match(/^merge_order:\s*(\d{4}(?: \d{4})*)\s*$/m);
  assert.ok(orderMatch, 'merge_order line missing');
  const orderBody = orderMatch[1];
  assert.ok(orderBody, 'merge_order line empty');
  const rows: MigrationAllocation[] = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\| (\d{4}) \| (.*) \| ([a-z_]+) \|$/);
    if (!match) continue;
    const number = match[1];
    const unit = match[2];
    const status = match[3];
    assert.ok(number && unit && status, line);
    rows.push({ number, unit, status });
  }
  assert.ok(rows.length > 0, 'reservation table missing');
  return { mergeOrder: orderBody.split(' '), rows };
}

function rowFor(rows: readonly MigrationAllocation[], number: ReservedMigration): MigrationAllocation {
  const row = rows.find(item => item.number === number);
  assert.ok(row, number);
  return row;
}

test('REGISTRY.md agrees with the registry; used numbers have SQL, reserved numbers do not', () => {
  const markdown = readFileSync(registryPath, 'utf8');
  const { mergeOrder, rows } = parseRegistryMarkdown(markdown);
  assert.deepEqual(rows, MIGRATION_ALLOCATIONS);
  assert.deepEqual(findMigrationCollisions(rows), []);
  assert.deepEqual(findMigrationCollisions(MIGRATION_ALLOCATIONS), []);
  const used = rows.filter(row => row.status === 'used').map(row => row.number);
  assert.deepEqual(mergeOrder, used);
  assert.equal(rowFor(rows, '0027').unit.includes('wake_evidence'), true);
  assert.equal(rowFor(rows, '0036').status, 'reserved');
  const sql = readdirSync('migrations').filter(name => /^\d{4}.*\.sql$/.test(name));
  for (const row of rows) {
    const files = sql.filter(name => name.startsWith(row.number));
    assert.equal(files.length, row.status === 'used' ? 1 : 0, row.number);
  }
  for (const name of sql) {
    const n = name.slice(0, 4);
    if (Number(n) > 25) assert.ok(rows.some(row => row.number === n), `unregistered migration ${name}`);
  }
});

test('migration filenames are unique and the IW-01 migration is 0044', () => {
  const sql = readdirSync('migrations').filter(name => /^\d{4}.*\.sql$/.test(name)).sort();
  const numbers = sql.map(name => name.slice(0, 4));
  const duplicates = numbers.filter((number, index) => numbers.indexOf(number) !== index);
  assert.deepEqual(duplicates, [], `duplicate migration numbers: ${duplicates.join(' ')}`);
  const iw01 = sql.filter(name => name.includes('iw01'));
  assert.deepEqual(iw01, ['0044_iw01_status_fields.sql']);
  const markdown = readFileSync(registryPath, 'utf8');
  const { rows } = parseRegistryMarkdown(markdown);
  const iw01Rows = rows.filter(row => row.unit.includes('IW-01'));
  assert.deepEqual(iw01Rows.map(row => row.number), ['0044']);
  assert.equal(iw01Rows[0]?.status, 'used');
  assert.equal(MIGRATION_ALLOCATIONS.find(row => row.unit.includes('IW-01'))?.number, '0044');
});
