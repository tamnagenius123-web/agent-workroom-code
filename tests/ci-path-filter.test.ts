import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { productChange } from '../scripts/ci/changed-paths.mjs';

test('markdown and docs diffs skip the product suite', () => {
  assert.equal(productChange(['docs/a.md']), false);
  assert.equal(productChange(['docs/specs/ci-affected.md']), false);
  assert.equal(productChange(['reports/ci.md']), false);
  assert.equal(productChange(['README.md']), false);
  assert.equal(productChange(['.cursor/skills/verify-workroom/SKILL.md']), false);
  assert.equal(productChange(['docs/a.md', 'README.mdx']), false);
});

test('any product path, an empty diff, or a missing diff runs the suite', () => {
  assert.equal(productChange(['src/server/fold.ts']), true);
  assert.equal(productChange(['tests/g2.test.ts']), true);
  assert.equal(productChange(['.github/workflows/ci.yml']), true);
  assert.equal(productChange(['docs/a.md', 'src/server/fold.ts']), true);
  assert.equal(productChange(['docs/note.ts']), true);
  assert.equal(productChange([]), true);
  assert.equal(productChange(null), true);
});

test('ci.yml filters jobs and still reports the pr check', () => {
  const yml = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.doesNotMatch(yml, /paths-ignore/);
  assert.match(yml, /node scripts\/ci\/changed-paths\.mjs/);
  assert.match(yml, /group: ci-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.sha \}\}/);
  assert.match(yml, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.match(yml, /if: always\(\) && !cancelled\(\) && github\.event_name == 'pull_request'/);
  assert.match(yml, /needs\.changes\.outputs\.product == 'true'/);
  assert.equal((yml.match(/^ {2}pr:\s*$/gm) ?? []).length, 1);
  const policy = readFileSync('.github/workflows/policy.yml', 'utf8');
  assert.doesNotMatch(policy, /paths-ignore/);
  assert.doesNotMatch(policy, /paths:/);
});
