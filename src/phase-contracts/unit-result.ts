// H6 Report Output Contract v2. One result.json per unit. Acceptance reads these fields, never prose.
// Adapted from hallaon-meta result.json (module map entry result-json). No provider counters,
// report sections, or commit scheme. result.json describes a pushed head, so it lives outside that commit.

import {
  Problems, checkKeys, defined, readArray, readBool, readEnum, readId, readInt, readObject, readSha40, readText,
  type PhaseCheck,
} from './check.ts';

export const UNIT_RESULT_CONTRACT = 'unit-result.v2' as const;

export const UNIT_STATUSES = ['pushed', 'blocked'] as const;
export type UnitStatus = typeof UNIT_STATUSES[number];

export const TEST_PHASES = ['red', 'green'] as const;
export type TestPhase = typeof TEST_PHASES[number];

export interface TestRun {
  phase: TestPhase;
  sha: string;
  command: string;
  passed: number;
  failed: number;
  exit_code: number;
}

export interface UnitResult {
  contract: typeof UNIT_RESULT_CONTRACT;
  unit_id: string;
  author_id: string;
  branch: string;
  base_sha: string;
  head_sha: string;
  status: UnitStatus;
  changed_files: string[];
  tests: TestRun[];
  decisions_row: boolean;
  blast_radius_ref: string | null;
  blockers: string[];
}

const RESULT_KEYS = [
  'contract', 'unit_id', 'author_id', 'branch', 'base_sha', 'head_sha', 'status', 'changed_files', 'tests',
  'decisions_row', 'blast_radius_ref', 'blockers',
] as const;
const TEST_KEYS = ['phase', 'sha', 'command', 'passed', 'failed', 'exit_code'] as const;
const P = 'unit_result';

const BRANCH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._@+-]+$/;

function isRepoPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return false;
  return value.split('/').every(segment => PATH_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..');
}

function readBranch(problems: Problems, obj: Record<string, unknown>): string | undefined {
  const value = readText(problems, obj, 'branch', P, 200);
  if (!defined(value)) return undefined;
  if (!BRANCH_RE.test(value) || value.split('/').some(segment => segment === '.' || segment === '..')) {
    problems.add(`${P}.branch`, 'expected a plain ref name like claude/<unit>');
    return undefined;
  }
  return value;
}

function readPaths(problems: Problems, obj: Record<string, unknown>): string[] | undefined {
  const rows = readArray(problems, obj, 'changed_files', P);
  if (!rows) return undefined;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const item = rows[i];
    if (!isRepoPath(item)) {
      problems.add(`${P}.changed_files[${i}]`, 'expected a repo-relative path without "..", "." or a leading "/"');
      continue;
    }
    if (seen.has(item)) problems.add(`${P}.changed_files`, `duplicate ${item}`);
    seen.add(item);
    paths.push(item);
  }
  return paths;
}

function readTests(problems: Problems, obj: Record<string, unknown>): TestRun[] | undefined {
  const rows = readArray(problems, obj, 'tests', P);
  if (!rows) return undefined;
  const runs: TestRun[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const path = `${P}.tests[${i}]`;
    const row = readObject(problems, rows[i], path);
    if (!row) continue;
    checkKeys(problems, row, TEST_KEYS, path);
    const phase = readEnum(problems, row, 'phase', path, TEST_PHASES);
    const sha = readSha40(problems, row, 'sha', path);
    const command = readText(problems, row, 'command', path, 500);
    const passed = readInt(problems, row, 'passed', path);
    const failed = readInt(problems, row, 'failed', path);
    const exit_code = readInt(problems, row, 'exit_code', path);
    if (!defined(phase) || !defined(sha) || !defined(command) || !defined(passed) || !defined(failed) || !defined(exit_code)) continue;
    runs.push({ phase, sha, command, passed, failed, exit_code });
  }
  return runs;
}

function readBlockers(problems: Problems, obj: Record<string, unknown>): string[] | undefined {
  const rows = readArray(problems, obj, 'blockers', P);
  if (!rows) return undefined;
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const id = readId(problems, { id: rows[i] }, 'id', `${P}.blockers[${i}]`);
    if (defined(id)) ids.push(id);
  }
  return ids;
}

function readBlastRef(problems: Problems, obj: Record<string, unknown>): string | null | undefined {
  if (!('blast_radius_ref' in obj)) {
    problems.add(`${P}.blast_radius_ref`, 'required');
    return undefined;
  }
  const value = obj.blast_radius_ref;
  if (value === null) return null;
  if (!isRepoPath(value)) {
    problems.add(`${P}.blast_radius_ref`, 'expected a repo-relative path or null');
    return undefined;
  }
  return value;
}

export function validateUnitResult(input: unknown): PhaseCheck<UnitResult> {
  const problems = new Problems();
  const obj = readObject(problems, input, P);
  if (!obj) return problems.fail();
  checkKeys(problems, obj, RESULT_KEYS, P);
  if (obj.contract !== UNIT_RESULT_CONTRACT) problems.add(`${P}.contract`, `expected ${JSON.stringify(UNIT_RESULT_CONTRACT)}`);
  const unit_id = readId(problems, obj, 'unit_id', P);
  const author_id = readId(problems, obj, 'author_id', P);
  const branch = readBranch(problems, obj);
  const base_sha = readSha40(problems, obj, 'base_sha', P);
  const head_sha = readSha40(problems, obj, 'head_sha', P);
  const status = readEnum(problems, obj, 'status', P, UNIT_STATUSES);
  const changed_files = readPaths(problems, obj);
  const tests = readTests(problems, obj);
  const decisions_row = readBool(problems, obj, 'decisions_row', P);
  const blast_radius_ref = readBlastRef(problems, obj);
  const blockers = readBlockers(problems, obj);
  if (problems.bad || obj.contract !== UNIT_RESULT_CONTRACT || !defined(unit_id) || !defined(author_id) || !defined(branch)
    || !defined(base_sha) || !defined(head_sha) || !defined(status) || !defined(changed_files) || !defined(tests)
    || !defined(decisions_row) || blast_radius_ref === undefined || !defined(blockers)) {
    return problems.fail();
  }
  if (head_sha === base_sha) problems.add(`${P}.head_sha`, 'must differ from base_sha');
  if (status === 'pushed') {
    if (blockers.length > 0) problems.add(`${P}.blockers`, 'pushed carries no blockers');
    const red = tests.filter(run => run.phase === 'red' && run.sha !== head_sha && run.failed > 0 && run.exit_code !== 0);
    if (red.length === 0) problems.add(`${P}.tests`, 'pushed requires a red run that failed on a sha before head_sha');
    const green = tests.filter(run => run.phase === 'green' && run.sha === head_sha && run.failed === 0 && run.exit_code === 0 && run.passed > 0);
    if (green.length === 0) problems.add(`${P}.tests`, 'pushed requires a green run at head_sha with passed > 0, failed 0, exit 0');
    if (!decisions_row) problems.add(`${P}.decisions_row`, 'pushed requires a decisions.tsv row');
    if (!changed_files.includes('decisions.tsv')) problems.add(`${P}.changed_files`, 'pushed must change decisions.tsv');
    if (blast_radius_ref === null) problems.add(`${P}.blast_radius_ref`, 'pushed requires a blast-radius note');
    else if (!changed_files.includes(blast_radius_ref)) problems.add(`${P}.blast_radius_ref`, 'must be one of changed_files');
  } else {
    if (blockers.length === 0) problems.add(`${P}.blockers`, 'blocked names at least one blocker');
    if (tests.length > 0) problems.add(`${P}.tests`, 'blocked carries no test claims');
  }
  if (problems.bad) return problems.fail();
  return {
    ok: true,
    value: {
      contract: UNIT_RESULT_CONTRACT, unit_id, author_id, branch, base_sha, head_sha, status, changed_files, tests,
      decisions_row, blast_radius_ref, blockers,
    },
  };
}

export interface AcceptanceObservation {
  observed_head_sha: string;
  acceptor_id: string;
}

export type AcceptanceCheck = { ready: true } | { ready: false; reasons: string[] };

/** Ready for a verifier to accept. Not a PASS: the verifier still reruns the green command at the head. */
export function acceptanceReady(result: UnitResult, observation: AcceptanceObservation): AcceptanceCheck {
  const reasons: string[] = [];
  if (result.status !== 'pushed') reasons.push(`status is ${result.status}, not pushed`);
  if (observation.observed_head_sha !== result.head_sha) reasons.push('observed head does not match head_sha');
  if (observation.acceptor_id === result.author_id) reasons.push('acceptor is the author');
  return reasons.length === 0 ? { ready: true } : { ready: false, reasons };
}
