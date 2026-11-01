// Pure P1 verifier-receipt evaluator. Rules: docs/specs/p1-receipt.md.
// Reuses W0 receipt types. Does not edit them. Migration 0029 stays reserved.
// No clock, no I/O. A sealed receipt has passed validateVerifierReceipt.
// Same-lineage and acceptor==producer stay unsealed so the collision is not rewritten.

import { createHash } from 'node:crypto';
import { includesConst, PHASE_CONSUMERS, SCHEMA_VERSION, type PhaseConsumer } from '../phase-contracts/check.ts';
import {
  gateDisposition, RED_CASE_IDS, validateVerifierReceipt,
  type FailurePacket, type MethodLineage, type RedCaseId, type Verdict, type VerifierCase, type VerifierReceipt,
} from '../phase-contracts/verifier-receipt.ts';

export const GATE_VERSION = 'p1.0' as const;
export const SEPARATE_GATES = ['trusted_auth', 'atomic_approval'] as const;

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SHA40_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface CaseRun {
  case_id: RedCaseId;
  evidence: string | null;
  evidence_sha256: string | null;
}

export interface ReceiptObservation {
  consumer: PhaseConsumer;
  producer_id: string;
  acceptor_id: string;
  next_maker: string;
  author_lineage: MethodLineage;
  verifier_lineage: MethodLineage;
  sha: string;
  observed_sha: string;
  claimed_gate_version: string;
  task_id: string;
  attempt_id: string;
  artifact_digest: string;
  verifier_id: string;
  lease: { epoch: string; stale: boolean } | null;
  capability_label_as_authority: boolean;
  approval_events: readonly ('accept' | 'revoke')[];
  observation_ok: boolean;
  runs: readonly CaseRun[];
}

export interface ReceiptEvaluation {
  disposition: 'PASS' | 'HOLD';
  receipt: VerifierReceipt | null;
  reasons: readonly string[];
  failure_packet: FailurePacket | null;
  observation_report: 'RETAINED' | 'UNKNOWN';
  separate_gates: typeof SEPARATE_GATES;
}

type Kind = 'passed' | 'not_run' | 'blank' | 'tamper' | 'stale_lease' | 'capability_label' | 'race' | 'approval_missing' | 'blocked';

interface Classified {
  case_id: RedCaseId;
  state: VerifierCase['state'];
  evidence: string | null;
  kind: Kind;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function lineageKey(lineage: MethodLineage | undefined): string | null {
  if (!lineage || typeof lineage.method !== 'string') return null;
  const method = lineage.method;
  if (method.trim().length === 0 || method.length > 200 || method.includes('\0')) return null;
  if (!Array.isArray(lineage.dependencies)) return null;
  const deps: string[] = [];
  const seen = new Set<string>();
  for (const item of lineage.dependencies) {
    if (typeof item !== 'string' || item.trim().length === 0 || item.length > 200 || item.includes('\0')) return null;
    if (seen.has(item)) return null;
    seen.add(item);
    deps.push(item);
  }
  return JSON.stringify([method, [...deps].sort()]);
}

function structuralReasons(input: ReceiptObservation): string[] {
  const reasons: string[] = [];
  if (typeof input.consumer !== 'string' || !includesConst(PHASE_CONSUMERS, input.consumer)) reasons.push('consumer');
  if (!isId(input.producer_id)) reasons.push('producer_id');
  if (!isId(input.acceptor_id)) reasons.push('acceptor_id');
  if (input.producer_id === input.acceptor_id) reasons.push('acceptor_is_producer');
  if (!isId(input.next_maker)) reasons.push('next_maker');
  if (typeof input.sha !== 'string' || !SHA40_RE.test(input.sha)) reasons.push('sha');
  if (typeof input.observed_sha !== 'string' || !SHA40_RE.test(input.observed_sha)) reasons.push('observed_sha');
  if (!Array.isArray(input.runs)) reasons.push('runs');
  const authorKey = lineageKey(input.author_lineage);
  const verifierKey = lineageKey(input.verifier_lineage);
  if (authorKey === null || verifierKey === null) reasons.push('lineage');
  else if (authorKey === verifierKey) reasons.push('same_lineage');
  return reasons;
}

function bindingOk(input: ReceiptObservation): boolean {
  return isId(input.task_id)
    && isId(input.attempt_id)
    && typeof input.artifact_digest === 'string'
    && SHA256_RE.test(input.artifact_digest)
    && isId(input.verifier_id)
    && input.acceptor_id === input.verifier_id;
}

function blockReasons(input: ReceiptObservation): string[] {
  const reasons: string[] = [];
  if (input.observation_ok !== true) reasons.push('observation_unknown');
  if (input.claimed_gate_version !== GATE_VERSION) reasons.push('gate_unbound');
  if (!bindingOk(input)) reasons.push('binding_incomplete');
  return reasons;
}

function leaseBad(input: ReceiptObservation): boolean {
  const lease = input.lease;
  if (!lease || lease.stale !== false || !isId(lease.epoch)) return true;
  return false;
}

function approvalState(input: ReceiptObservation): 'clean' | 'race' | 'approval_missing' {
  const events = Array.isArray(input.approval_events) ? input.approval_events : [];
  const hasAccept = events.some(event => event === 'accept');
  const hasRevoke = events.some(event => event === 'revoke');
  if (hasAccept && hasRevoke) return 'race';
  if (events.length === 1 && events[0] === 'accept') return 'clean';
  return 'approval_missing';
}

function bindLog(input: ReceiptObservation, evidence: string): string | null {
  const text = `task=${input.task_id} attempt=${input.attempt_id} sha=${input.sha} digest=${input.artifact_digest} verifier=${input.verifier_id} gate=${GATE_VERSION} | ${evidence}`;
  if (text.length > 2000 || text.includes('\0')) return null;
  return text;
}

function miss(case_id: RedCaseId, kind: Kind): Classified {
  return { case_id, state: 'missing', evidence: null, kind };
}

function classifyRun(case_id: RedCaseId, run: CaseRun | 'dup' | undefined, input: ReceiptObservation): Classified {
  if (run === 'dup') return miss(case_id, 'tamper');
  if (!run || run.evidence === null) return { case_id, state: 'not_run', evidence: null, kind: 'not_run' };
  if (run.evidence.trim().length === 0 || run.evidence.includes('\0')) return miss(case_id, 'blank');
  if (digestOf(run.evidence) !== run.evidence_sha256) return miss(case_id, 'tamper');
  const evidence = bindLog(input, run.evidence);
  if (!evidence) return miss(case_id, 'blank');
  return { case_id, state: 'passed', evidence, kind: 'passed' };
}

function classifyCensus(input: ReceiptObservation): Classified[] {
  const runs = new Map<RedCaseId, CaseRun | 'dup'>();
  for (const run of input.runs) {
    if (!includesConst(RED_CASE_IDS, run.case_id)) continue;
    runs.set(run.case_id, runs.has(run.case_id) ? 'dup' : run);
  }
  const approval = approvalState(input);
  return RED_CASE_IDS.map(case_id => {
    if (case_id === 'RC2' && leaseBad(input)) return miss(case_id, 'stale_lease');
    if (case_id === 'RC6' && input.capability_label_as_authority !== false) return miss(case_id, 'capability_label');
    if (case_id === 'RC7' && approval === 'race') return miss(case_id, 'race');
    if (case_id === 'RC7' && approval === 'approval_missing') return miss(case_id, 'approval_missing');
    return classifyRun(case_id, runs.get(case_id), input);
  });
}

function blockedCensus(): Classified[] {
  return RED_CASE_IDS.map(case_id => ({ case_id, state: 'missing' as const, evidence: null, kind: 'blocked' as const }));
}

function verdictOf(shaMismatch: boolean, cases: readonly VerifierCase[]): Verdict {
  const missing = cases.some(row => row.state === 'missing');
  const notRun = cases.filter(row => row.state === 'not_run').length;
  if (shaMismatch || missing) return 'HOLD';
  if (notRun === cases.length) return 'NOT_RUN';
  if (notRun > 0) return 'HOLD';
  return 'PASS';
}

function kindReason(kind: Kind): string | null {
  if (kind === 'stale_lease') return 'stale_lease';
  if (kind === 'capability_label') return 'capability_label';
  if (kind === 'race') return 'revoke_accept_race';
  if (kind === 'approval_missing') return 'approval_missing';
  if (kind === 'tamper') return 'evidence_tampered';
  if (kind === 'blank' || kind === 'not_run') return 'partial_census';
  return null;
}

function reasonList(blocked: readonly string[], classified: readonly Classified[], shaMismatch: boolean, verdict: Verdict): string[] {
  if (blocked.length > 0) {
    const reasons = [...blocked];
    if (shaMismatch) reasons.push('sha_changed');
    return reasons;
  }
  if (verdict === 'NOT_RUN') return ['not_run'];
  const reasons: string[] = [];
  if (shaMismatch) reasons.push('sha_changed');
  const allNotRun = classified.every(row => row.kind === 'not_run');
  for (const row of classified) {
    const code = kindReason(row.kind);
    if (!code || reasons.includes(code)) continue;
    if (code === 'partial_census' && allNotRun) continue;
    reasons.push(code);
  }
  return reasons;
}

function lineFor(row: Classified): string | null {
  if (row.kind === 'stale_lease') return 'RC2 stale lease';
  if (row.kind === 'capability_label') return 'RC6 capability label is not authority';
  if (row.kind === 'race') return 'RC7 revoke/accept race';
  if (row.kind === 'approval_missing') return 'RC7 approval missing';
  if (row.kind === 'tamper') return `${row.case_id} evidence tampered`;
  if (row.kind === 'blank' || row.kind === 'not_run') return `${row.case_id} partial census`;
  return null;
}

function packetLines(blocked: readonly string[], classified: readonly Classified[], shaMismatch: boolean): string[] {
  const lines: string[] = [];
  if (shaMismatch) lines.push('RC1 sha changed');
  if (blocked.includes('observation_unknown')) lines.push('RC8 observation UNKNOWN');
  if (blocked.includes('gate_unbound')) lines.push('F2 gate unbound');
  if (blocked.includes('binding_incomplete')) lines.push('F2 binding incomplete');
  if (blocked.length > 0) return lines;
  for (const row of classified) {
    const line = lineFor(row);
    if (line && !lines.includes(line)) lines.push(line);
  }
  return lines;
}

function failedIds(shaMismatch: boolean, cases: readonly VerifierCase[]): RedCaseId[] {
  const ids = new Set<RedCaseId>();
  if (shaMismatch) for (const row of cases) ids.add(row.case_id);
  for (const row of cases) if (row.state !== 'passed') ids.add(row.case_id);
  return RED_CASE_IDS.filter(id => ids.has(id));
}

function holdPacket(input: ReceiptObservation, cases: readonly VerifierCase[], shaMismatch: boolean, classified: readonly Classified[], blocked: readonly string[]): FailurePacket {
  return {
    failed_cases: failedIds(shaMismatch, cases),
    evidence: packetLines(blocked, classified, shaMismatch),
    next_maker: input.next_maker,
  };
}

function copyLineage(lineage: MethodLineage): MethodLineage {
  return { method: lineage.method, dependencies: [...lineage.dependencies] };
}

function seal(input: ReceiptObservation, cases: VerifierCase[], verdict: Verdict, failure_packet: FailurePacket | null): VerifierReceipt | null {
  const digest = input.artifact_digest;
  const candidate: VerifierReceipt = {
    schema_version: SCHEMA_VERSION,
    consumer: input.consumer,
    provenance: {
      kind: 'synthetic_fixture',
      producer_id: input.producer_id,
      source_ref: typeof digest === 'string' && SHA256_RE.test(digest) ? `digest.${digest}` : 'p1-receipt',
    },
    proof_mode: 'synthetic',
    sha: input.sha,
    observed_sha: input.observed_sha,
    gate_version: GATE_VERSION,
    cases,
    author_lineage: copyLineage(input.author_lineage),
    verifier_lineage: copyLineage(input.verifier_lineage),
    producer_id: input.producer_id,
    acceptor_id: input.acceptor_id,
    verdict,
    failure_packet,
    f2: { id: 'F2', description: 'TBD' },
    f3: { id: 'F3', description: 'TBD' },
    f6: { id: 'F6', description: 'TBD' },
  };
  const checked = validateVerifierReceipt(candidate);
  return checked.ok ? checked.value : null;
}

function finish(
  input: ReceiptObservation,
  disposition: 'PASS' | 'HOLD',
  receipt: VerifierReceipt | null,
  reasons: readonly string[],
  failure_packet: FailurePacket | null,
): ReceiptEvaluation {
  return {
    disposition,
    receipt,
    reasons,
    failure_packet,
    observation_report: input.observation_ok === true ? 'RETAINED' : 'UNKNOWN',
    separate_gates: SEPARATE_GATES,
  };
}

function unsealed(input: ReceiptObservation, reasons: readonly string[]): ReceiptEvaluation {
  if (!isId(input.next_maker)) return finish(input, 'HOLD', null, reasons, null);
  const evidence: string[] = [];
  const failed: RedCaseId[] = [];
  if (reasons.includes('same_lineage')) evidence.push('RC5 same lineage');
  if (reasons.includes('acceptor_is_producer')) evidence.push('RC5 acceptor is producer');
  if (reasons.includes('same_lineage') || reasons.includes('acceptor_is_producer')) failed.push('RC5');
  if (reasons.includes('sha') || reasons.includes('observed_sha')) evidence.push('RC1 sha changed');
  if (reasons.includes('sha') || reasons.includes('observed_sha') || failed.length === 0) failed.push('RC1');
  if (evidence.length === 0) evidence.push(reasons.map(reason => `unsealed ${reason}`).join('; '));
  return finish(input, 'HOLD', null, reasons, { failed_cases: failed, evidence, next_maker: input.next_maker });
}

export function evaluateVerifierReceipt(input: ReceiptObservation): ReceiptEvaluation {
  const structural = structuralReasons(input);
  if (structural.length > 0) return unsealed(input, structural);
  const shaMismatch = input.sha !== input.observed_sha;
  const blocked = blockReasons(input);
  const classified = blocked.length > 0 ? blockedCensus() : classifyCensus(input);
  const cases: VerifierCase[] = classified.map(row => ({ case_id: row.case_id, state: row.state, evidence: row.evidence }));
  const verdict = verdictOf(shaMismatch, cases);
  const reasons = reasonList(blocked, classified, shaMismatch, verdict);
  const failure_packet = verdict === 'HOLD' ? holdPacket(input, cases, shaMismatch, classified, blocked) : null;
  const receipt = seal(input, cases, verdict, failure_packet);
  if (!receipt) return finish(input, 'HOLD', null, [...reasons, 'seal_rejected'], failure_packet);
  return finish(input, gateDisposition(receipt), receipt, reasons, receipt.failure_packet);
}
