// P1 verifier receipt. PASS binds a full sha, a gate version, per-case evidence, and a lineage
// that is not the author's. SHA mismatch or missing evidence is HOLD, never PASS.
// F2, F3, and F6 are unpublished. Red-case descriptions are TBD by Dots.

import {
  Problems, checkKeys, defined, includesConst, readArray, readEnvelope, readEnum, readId, readNullableText,
  readObject, readSha40, readText, recordIsLiveProof, type PhaseCheck, type PhaseEnvelope,
} from './check.ts';

export const VERDICTS = ['PASS', 'HOLD', 'NOT_RUN'] as const;
export type Verdict = typeof VERDICTS[number];

export const RED_CASE_IDS = ['RC1', 'RC2', 'RC3', 'RC4', 'RC5', 'RC6', 'RC7', 'RC8'] as const;
export type RedCaseId = typeof RED_CASE_IDS[number];

/** Descriptions are not defined in W0. Dots publishes them. Do not treat TBD as a definition. */
export const RED_CASE_DESCRIPTIONS: { readonly [K in RedCaseId]: 'TBD' } = {
  RC1: 'TBD', RC2: 'TBD', RC3: 'TBD', RC4: 'TBD', RC5: 'TBD', RC6: 'TBD', RC7: 'TBD', RC8: 'TBD',
};

export const CASE_STATES = ['passed', 'missing', 'not_run'] as const;
export type CaseState = typeof CASE_STATES[number];

export interface UnpublishedGateField {
  id: 'F2' | 'F3' | 'F6';
  description: 'TBD';
}

export interface MethodLineage {
  method: string;
  dependencies: string[];
}

export interface VerifierCase {
  case_id: RedCaseId;
  state: CaseState;
  evidence: string | null;
}

export interface FailurePacket {
  failed_cases: RedCaseId[];
  evidence: string[];
  next_maker: string;
}

export interface VerifierReceipt extends PhaseEnvelope {
  sha: string;
  observed_sha: string;
  gate_version: string;
  cases: VerifierCase[];
  author_lineage: MethodLineage;
  verifier_lineage: MethodLineage;
  producer_id: string;
  acceptor_id: string;
  verdict: Verdict;
  failure_packet: FailurePacket | null;
  f2: UnpublishedGateField;
  f3: UnpublishedGateField;
  f6: UnpublishedGateField;
}

const RECEIPT_KEYS = [
  'schema_version', 'consumer', 'provenance', 'proof_mode',
  'sha', 'observed_sha', 'gate_version', 'cases', 'author_lineage', 'verifier_lineage',
  'producer_id', 'acceptor_id', 'verdict', 'failure_packet', 'f2', 'f3', 'f6',
] as const;
const LINEAGE_KEYS = ['method', 'dependencies'] as const;
const CASE_KEYS = ['case_id', 'state', 'evidence'] as const;
const PACKET_KEYS = ['failed_cases', 'evidence', 'next_maker'] as const;

/** NOT_RUN and HOLD both withhold a pass. Only a verdict of PASS passes the gate. */
export function gateDisposition(receipt: VerifierReceipt): 'PASS' | 'HOLD' {
  return receipt.verdict === 'PASS' ? 'PASS' : 'HOLD';
}

/** A synthetic, NOT_RUN, or evidence-missing receipt is not live proof. */
export function receiptIsLiveProof(receipt: VerifierReceipt): boolean {
  return recordIsLiveProof(receipt)
    && gateDisposition(receipt) === 'PASS'
    && receipt.sha === receipt.observed_sha
    && receipt.failure_packet === null
    && receipt.cases.every(row => row.state === 'passed' && row.evidence !== null);
}

function readPlaceholder(
  problems: Problems, obj: Record<string, unknown>, key: 'f2' | 'f3' | 'f6', id: 'F2' | 'F3' | 'F6',
): UnpublishedGateField | undefined {
  const value = obj[key];
  const path = `verifier_receipt.${key}`;
  const record = readObject(problems, value, path);
  if (!record) return undefined;
  checkKeys(problems, record, ['id', 'description'], path);
  if (record.id !== id || record.description !== 'TBD') {
    problems.add(path, `${id} is unpublished; the only accepted placeholder is {"id":"${id}","description":"TBD"}`);
    return undefined;
  }
  return { id, description: 'TBD' };
}

function readLineage(problems: Problems, obj: Record<string, unknown>, key: 'author_lineage' | 'verifier_lineage'): MethodLineage | undefined {
  const path = `verifier_receipt.${key}`;
  const record = readObject(problems, obj[key], path);
  if (!record) return undefined;
  checkKeys(problems, record, LINEAGE_KEYS, path);
  const method = readText(problems, record, 'method', path, 200);
  const dependencies = readArray(problems, record, 'dependencies', path);
  if (!defined(method) || !defined(dependencies)) return undefined;
  const parsed: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < dependencies.length; i += 1) {
    const item = dependencies[i];
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 200) {
      problems.add(`${path}.dependencies[${i}]`, 'expected dependency text');
      continue;
    }
    if (seen.has(item)) problems.add(`${path}.dependencies`, `duplicate ${item}`);
    seen.add(item);
    parsed.push(item);
  }
  return { method, dependencies: parsed };
}

function lineageKey(lineage: MethodLineage): string {
  return JSON.stringify([lineage.method, [...lineage.dependencies].sort()]);
}

function readCases(problems: Problems, obj: Record<string, unknown>): VerifierCase[] | undefined {
  const rows = readArray(problems, obj, 'cases', 'verifier_receipt');
  if (!rows) return undefined;
  if (rows.length < 1) problems.add('verifier_receipt.cases', 'at least one case is required');
  if (rows.length > RED_CASE_IDS.length) problems.add('verifier_receipt.cases', `at most ${RED_CASE_IDS.length} cases`);
  const cases: VerifierCase[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    const path = `verifier_receipt.cases[${i}]`;
    const row = readObject(problems, rows[i], path);
    if (!row) continue;
    checkKeys(problems, row, CASE_KEYS, path);
    const case_id = readEnum(problems, row, 'case_id', path, RED_CASE_IDS);
    const state = readEnum(problems, row, 'state', path, CASE_STATES);
    const evidence = readNullableText(problems, row, 'evidence', path, 2000);
    if (!defined(case_id) || !defined(state) || evidence === undefined) continue;
    if (seen.has(case_id)) problems.add(path, `duplicate case_id ${case_id}`);
    seen.add(case_id);
    if (state === 'passed' && evidence === null) problems.add(path, 'passed requires evidence');
    if (state !== 'passed' && evidence !== null) problems.add(path, `${state} cannot carry evidence`);
    cases.push({ case_id, state, evidence });
  }
  return cases;
}

function readPacket(problems: Problems, value: unknown, caseIds: ReadonlySet<string>): FailurePacket | null | undefined {
  if (value === null) return null;
  const path = 'verifier_receipt.failure_packet';
  const record = readObject(problems, value, path);
  if (!record) return undefined;
  checkKeys(problems, record, PACKET_KEYS, path);
  const failedRaw = readArray(problems, record, 'failed_cases', path);
  const evidenceRaw = readArray(problems, record, 'evidence', path);
  const next_maker = readId(problems, record, 'next_maker', path);
  const failed_cases: RedCaseId[] = [];
  if (failedRaw) {
    if (failedRaw.length < 1) problems.add(`${path}.failed_cases`, 'HOLD hands the next maker at least one failed case');
    const seen = new Set<string>();
    for (let i = 0; i < failedRaw.length; i += 1) {
      const item = failedRaw[i];
      if (typeof item !== 'string' || !includesConst(RED_CASE_IDS, item)) {
        problems.add(`${path}.failed_cases[${i}]`, `expected one of ${RED_CASE_IDS.join('|')}`);
        continue;
      }
      if (!caseIds.has(item)) problems.add(`${path}.failed_cases[${i}]`, `${item} is not a case on this receipt`);
      if (seen.has(item)) problems.add(`${path}.failed_cases`, `duplicate ${item}`);
      seen.add(item);
      failed_cases.push(item);
    }
  }
  const evidence: string[] = [];
  if (evidenceRaw) {
    for (let i = 0; i < evidenceRaw.length; i += 1) {
      const item = evidenceRaw[i];
      if (typeof item !== 'string' || item.trim().length === 0 || item.length > 2000) {
        problems.add(`${path}.evidence[${i}]`, 'expected evidence text');
        continue;
      }
      evidence.push(item);
    }
  }
  if (!defined(next_maker) || !failedRaw || !evidenceRaw) return undefined;
  return { failed_cases, evidence, next_maker };
}

export function validateVerifierReceipt(input: unknown): PhaseCheck<VerifierReceipt> {
  const problems = new Problems();
  const obj = readObject(problems, input, 'verifier_receipt');
  if (!obj) return problems.fail();
  checkKeys(problems, obj, RECEIPT_KEYS, 'verifier_receipt');
  const envelope = readEnvelope(problems, obj, 'verifier_receipt');
  const sha = readSha40(problems, obj, 'sha', 'verifier_receipt');
  const observed_sha = readSha40(problems, obj, 'observed_sha', 'verifier_receipt');
  const gate_version = readText(problems, obj, 'gate_version', 'verifier_receipt', 64);
  const cases = readCases(problems, obj);
  const author_lineage = readLineage(problems, obj, 'author_lineage');
  const verifier_lineage = readLineage(problems, obj, 'verifier_lineage');
  const producer_id = readId(problems, obj, 'producer_id', 'verifier_receipt');
  const acceptor_id = readId(problems, obj, 'acceptor_id', 'verifier_receipt');
  const verdict = readEnum(problems, obj, 'verdict', 'verifier_receipt', VERDICTS);
  const f2 = readPlaceholder(problems, obj, 'f2', 'F2');
  const f3 = readPlaceholder(problems, obj, 'f3', 'F3');
  const f6 = readPlaceholder(problems, obj, 'f6', 'F6');
  const caseIds = new Set((cases ?? []).map(row => row.case_id));
  if (!('failure_packet' in obj)) problems.add('verifier_receipt.failure_packet', 'required');
  const failure_packet = 'failure_packet' in obj ? readPacket(problems, obj.failure_packet, caseIds) : undefined;
  if (defined(producer_id) && defined(acceptor_id) && producer_id === acceptor_id) {
    problems.add('verifier_receipt.acceptor_id', 'must differ from producer_id');
  }
  if (defined(author_lineage) && defined(verifier_lineage) && lineageKey(author_lineage) === lineageKey(verifier_lineage)) {
    problems.add('verifier_receipt.verifier_lineage', 'must differ from author_lineage (method or dependency set)');
  }
  if (!defined(envelope) || !defined(sha) || !defined(observed_sha) || !defined(gate_version) || !defined(cases) || !defined(author_lineage)
    || !defined(verifier_lineage) || !defined(producer_id) || !defined(acceptor_id) || !defined(verdict)
    || failure_packet === undefined || !defined(f2) || !defined(f3) || !defined(f6)) {
    return problems.fail();
  }
  const shaMismatch = sha !== observed_sha;
  const missing = cases.filter(row => row.state === 'missing');
  const notRun = cases.filter(row => row.state === 'not_run');
  const passed = cases.filter(row => row.state === 'passed');
  if (shaMismatch || missing.length > 0) {
    if (verdict !== 'HOLD') problems.add('verifier_receipt.verdict', 'sha mismatch or missing evidence must be HOLD, not PASS or NOT_RUN');
  } else if (notRun.length === cases.length) {
    if (verdict !== 'NOT_RUN') problems.add('verifier_receipt.verdict', 'a receipt that did not run is NOT_RUN when the sha matches');
  } else if (notRun.length > 0 && passed.length > 0) {
    if (verdict !== 'HOLD') problems.add('verifier_receipt.verdict', 'a partial run is HOLD');
  } else if (verdict === 'NOT_RUN') {
    problems.add('verifier_receipt.verdict', 'NOT_RUN requires every case state not_run and a matching sha');
  }
  if (verdict === 'PASS') {
    if (shaMismatch) problems.add('verifier_receipt.sha', 'PASS cannot bind a sha that mismatches observed_sha');
    if (passed.length !== cases.length) problems.add('verifier_receipt.verdict', 'PASS requires per-case evidence on every case');
    if (failure_packet !== null) problems.add('verifier_receipt.failure_packet', 'PASS does not hand off a failure packet');
  }
  if (verdict === 'NOT_RUN' && failure_packet !== null) {
    problems.add('verifier_receipt.failure_packet', 'NOT_RUN does not hand off a failure packet');
  }
  if (verdict === 'HOLD') {
    if (failure_packet === null) {
      problems.add('verifier_receipt.failure_packet', 'HOLD hands FailurePacket to the next maker');
    } else {
      const required = new Set<RedCaseId>();
      if (shaMismatch) for (const row of cases) required.add(row.case_id);
      for (const row of cases) if (row.state !== 'passed') required.add(row.case_id);
      for (const id of required) {
        if (!failure_packet.failed_cases.includes(id)) {
          problems.add('verifier_receipt.failure_packet.failed_cases', `missing ${id}`);
        }
      }
    }
  }
  if (envelope.proof_mode === 'live' && (verdict !== 'PASS' || shaMismatch || passed.length !== cases.length || failure_packet !== null)) {
    problems.add('verifier_receipt.proof_mode', 'NOT_RUN, missing evidence, or a mock receipt cannot validate as live proof');
  }
  if (problems.bad) return problems.fail();
  const value: VerifierReceipt = {
    ...envelope,
    sha, observed_sha, gate_version, cases, author_lineage, verifier_lineage, producer_id, acceptor_id,
    verdict, failure_packet, f2, f3, f6,
  };
  return { ok: true, value };
}
