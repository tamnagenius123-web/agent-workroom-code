import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

// Literal path so test:affected treats this markdown as a dependency of this file.
const indexPath = 'docs/audits/pstack-audit-claude.md';
const skillsDir = 'docs/audits/skills';

const idx = readFileSync(indexPath, 'utf8');
const section = (start: string, end: string): string => {
  const from = idx.indexOf(start);
  assert.ok(from >= 0, `section "${start}" missing`);
  return idx.slice(from, idx.indexOf(end, from));
};
const stated = (re: RegExp): number => {
  const m = idx.match(re);
  assert.ok(m, `header ${re} missing`);
  return Number(m[1]);
};

const applied = section('**Applied, with a file each', '**Applied as method');
const method = section('**Applied as method', '**Skipped');
const skipped = section('**Skipped', '## Process notes');

const linked = [...applied.matchAll(/\]\((skills\/[^)]+\.md)\)/g)].map((m) => m[1] ?? '');
const methodItems = [...method.matchAll(/^- (.+?):\*\*/gm)].flatMap((m) => (m[1] ?? '').replace(/\*/g, '').split(' and '));
const skipItems = [...skipped.matchAll(/^\| ([a-z][^|]*?) \|/gm)].map((m) => m[1] ?? '').filter((s) => s !== 'skill').flatMap((s) => s.split(', '));

test('applied header matches linked files and the files in docs/audits/skills', () => {
  const files = readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
  assert.equal(stated(/Applied, with a file each \((\d+)\)/), linked.length);
  assert.equal(linked.length, files.length);
});

test('principle header matches principle links', () => {
  assert.equal(stated(/all (\d+) principle-\* skills/), linked.filter((p) => p.startsWith('skills/principle-')).length);
});

test('method and skipped headers match their lists', () => {
  assert.equal(stated(/Applied as method, no separate file \((\d+)\)/), methodItems.length);
  assert.equal(stated(/Skipped \((\d+)\)/), skipItems.length);
});

test('applied + method + skipped equals the SKILL.md total', () => {
  assert.equal(linked.length + methodItems.length + skipItems.length, stated(/\((\d+) SKILL\.md found/));
});
