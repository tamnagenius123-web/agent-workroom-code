import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

// PR40-FOLLOWUP: a unit's 상태 line copied from another unit hides its real status (V6-4 carried V6-2's).
// Groups below are known debt still waiting for their own evidence; shrink this list, never grow it.
const KNOWN_SHARED = new Set(['V0-2 V3-5', 'V2-1 V2-1a V2-1b', 'V2-3 V3-6 V3-8', 'V3-1 V3-7']);

function sharedStatusGroups(md: string): string[] {
  const byStatus = new Map<string, string[]>();
  let unit = '';
  for (const line of md.split('\n')) {
    const h = /^### (V\d+-\d+[a-z]?)\b/.exec(line);
    if (h) unit = h[1] ?? '';
    else if (unit && line.startsWith('- 상태:')) byStatus.set(line, [...(byStatus.get(line) ?? []), unit]);
  }
  return [...byStatus.values()].filter((u) => u.length > 1).map((u) => u.sort().join(' '));
}

test('no roadmap unit shares a status line except known debt', () => {
  const groups = sharedStatusGroups(readFileSync('docs/roadmap.md', 'utf8'));
  assert.deepEqual(groups.filter((g) => !KNOWN_SHARED.has(g)), []);
});

test('known-debt list only names groups that still share a line', () => {
  const groups = new Set(sharedStatusGroups(readFileSync('docs/roadmap.md', 'utf8')));
  assert.deepEqual([...KNOWN_SHARED].filter((g) => !groups.has(g)), []);
});
