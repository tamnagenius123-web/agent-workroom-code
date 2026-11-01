import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceReady, validateUnitResult } from '../src/phase-contracts/unit-result.ts';

const BASE = '1111111111111111111111111111111111111111';
const RED = '2222222222222222222222222222222222222222';
const HEAD = '3333333333333333333333333333333333333333';

function pushed(): Record<string, unknown> {
  return {
    contract: 'unit-result.v2',
    unit_id: 'H6',
    author_id: 'agent:claude',
    branch: 'claude/h6-result-contract',
    base_sha: BASE,
    head_sha: HEAD,
    status: 'pushed',
    changed_files: ['src/phase-contracts/unit-result.ts', 'tests/unit-result.test.ts', 'reports/h6/blast-radius.md', 'decisions.tsv'],
    tests: [
      { phase: 'red', sha: RED, command: 'node --import tsx --test tests/unit-result.test.ts', passed: 0, failed: 1, exit_code: 1 },
      { phase: 'green', sha: HEAD, command: 'node --import tsx --test tests/unit-result.test.ts', passed: 12, failed: 0, exit_code: 0 },
    ],
    decisions_row: true,
    blast_radius_ref: 'reports/h6/blast-radius.md',
    blockers: [],
  };
}

function blocked(): Record<string, unknown> {
  return { ...pushed(), status: 'blocked', tests: [], decisions_row: false, blast_radius_ref: null, changed_files: [], blockers: ['MS1'] };
}

function errorsOf(input: unknown): string[] {
  const result = validateUnitResult(input);
  assert.equal(result.ok, false, 'expected the result to be rejected');
  return result.ok ? [] : result.errors;
}

test('a pushed result with red-before-green, decisions row and blast radius validates', () => {
  const result = validateUnitResult(pushed());
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('\n'));
});

test('a blocked result names its blockers and carries no test claims', () => {
  assert.equal(validateUnitResult(blocked()).ok, true);
  assert.match(errorsOf({ ...blocked(), blockers: [] }).join('\n'), /blockers/);
});

test('prose fields are rejected: acceptance reads structure only', () => {
  for (const key of ['summary', 'notes', 'report']) {
    assert.match(errorsOf({ ...pushed(), [key]: 'all good, trust me' }).join('\n'), new RegExp(`unknown field "${key}"`));
  }
});

test('pushed without a failing red run on an earlier sha is rejected', () => {
  const tests = (pushed().tests as Array<Record<string, unknown>>).filter(row => row.phase === 'green');
  assert.match(errorsOf({ ...pushed(), tests }).join('\n'), /red/);
  const passingRed = [{ ...(pushed().tests as Array<Record<string, unknown>>)[0], failed: 0, passed: 1, exit_code: 0 }, (pushed().tests as unknown[])[1]];
  assert.match(errorsOf({ ...pushed(), tests: passingRed }).join('\n'), /red/);
  const redAtHead = [{ ...(pushed().tests as Array<Record<string, unknown>>)[0], sha: HEAD }, (pushed().tests as unknown[])[1]];
  assert.match(errorsOf({ ...pushed(), tests: redAtHead }).join('\n'), /red/);
});

test('pushed without a clean green run at head_sha is rejected', () => {
  const rows = pushed().tests as Array<Record<string, unknown>>;
  assert.match(errorsOf({ ...pushed(), tests: [rows[0], { ...rows[1], sha: RED }] }).join('\n'), /green/);
  assert.match(errorsOf({ ...pushed(), tests: [rows[0], { ...rows[1], failed: 1 }] }).join('\n'), /green/);
  assert.match(errorsOf({ ...pushed(), tests: [rows[0], { ...rows[1], exit_code: 1 }] }).join('\n'), /green/);
  assert.match(errorsOf({ ...pushed(), tests: [rows[0], { ...rows[1], passed: 0 }] }).join('\n'), /green/);
});

test('pushed requires a decisions row and a blast-radius note that is in changed_files', () => {
  assert.match(errorsOf({ ...pushed(), decisions_row: false }).join('\n'), /decisions_row/);
  assert.match(errorsOf({ ...pushed(), blast_radius_ref: null }).join('\n'), /blast_radius_ref/);
  assert.match(errorsOf({ ...pushed(), blast_radius_ref: 'reports/other.md' }).join('\n'), /blast_radius_ref/);
  const files = (pushed().changed_files as string[]).filter(path => path !== 'decisions.tsv');
  assert.match(errorsOf({ ...pushed(), changed_files: files }).join('\n'), /decisions\.tsv/);
});

test('shas are full lowercase 40-hex and head differs from base', () => {
  assert.match(errorsOf({ ...pushed(), head_sha: '3333333' }).join('\n'), /head_sha/);
  assert.match(errorsOf({ ...pushed(), head_sha: 'ABCDEF'.repeat(6) + 'ABCD' }).join('\n'), /head_sha/);
  assert.match(errorsOf({ ...pushed(), head_sha: BASE }).join('\n'), /head_sha/);
});

test('changed_files are unique repo-relative paths', () => {
  for (const bad of ['/etc/passwd', '../outside.ts', 'src/../../x.ts', 'a\0b', '']) {
    assert.match(errorsOf({ ...pushed(), changed_files: [...(pushed().changed_files as string[]), bad] }).join('\n'), /changed_files/);
  }
  const dup = [...(pushed().changed_files as string[]), 'decisions.tsv'];
  assert.match(errorsOf({ ...pushed(), changed_files: dup }).join('\n'), /duplicate/);
});

test('branch must be a plain ref name and counts must be integers', () => {
  assert.match(errorsOf({ ...pushed(), branch: 'claude/x;rm -rf' }).join('\n'), /branch/);
  assert.match(errorsOf({ ...pushed(), branch: 'claude/../main' }).join('\n'), /branch/);
  const rows = pushed().tests as Array<Record<string, unknown>>;
  assert.match(errorsOf({ ...pushed(), tests: [rows[0], { ...rows[1], passed: 1.5 }] }).join('\n'), /passed/);
});

test('contract version is exact', () => {
  assert.match(errorsOf({ ...pushed(), contract: 'unit-result.v1' }).join('\n'), /contract/);
  assert.match(errorsOf(null).join('\n'), /expected an object/);
});

test('acceptanceReady reads only structure: matching head, non-author acceptor, pushed status', () => {
  const parsed = validateUnitResult(pushed());
  assert.ok(parsed.ok);
  assert.deepEqual(acceptanceReady(parsed.value, { observed_head_sha: HEAD, acceptor_id: 'agent:muse' }), { ready: true });
  const self = acceptanceReady(parsed.value, { observed_head_sha: HEAD, acceptor_id: 'agent:claude' });
  assert.equal(self.ready, false);
  assert.match(self.ready ? '' : self.reasons.join('\n'), /author/);
  const moved = acceptanceReady(parsed.value, { observed_head_sha: RED, acceptor_id: 'agent:muse' });
  assert.equal(moved.ready, false);
  assert.match(moved.ready ? '' : moved.reasons.join('\n'), /head/);
  const parsedBlocked = validateUnitResult(blocked());
  assert.ok(parsedBlocked.ok);
  const notPushed = acceptanceReady(parsedBlocked.value, { observed_head_sha: HEAD, acceptor_id: 'agent:muse' });
  assert.equal(notPushed.ready, false);
  assert.match(notPushed.ready ? '' : notPushed.reasons.join('\n'), /blocked/);
});
