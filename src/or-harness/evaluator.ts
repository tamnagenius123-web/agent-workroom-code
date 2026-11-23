// Independent evaluator (U8-G5). Evaluates a producer run record against a
// fixed, content-addressed cohort by independently replaying one deterministic
// shard of the cohort through the dispatch harness, then sealing the verdict
// as a P1 verifier receipt (src/server/verifier-receipt.ts). Migration 0029
// stays reserved; nothing here writes D1.
//
// Independence boundary: the evaluator owns its ledger and its receipt store.
// The producer run record is read-only input; replay reservations are booked
// under an `eval:` project namespace on the evaluator's own ledger, never on
// the producer's. The evaluator's lineage must differ from the author's and
// the evaluator must not be the producer, or the receipt stays unsealed.
//
// No real provider calls: dispatch runs only through the injected fetch and
// ledger seams. Receipts sealed here are synthetic proof mode, exactly like
// evaluateVerifierReceipt output; live proof is a Phase 2 gate concern.
import { createHash } from 'node:crypto';
import type { PhaseConsumer } from '../phase-contracts/check.ts';
import {
  RED_CASE_IDS, type MethodLineage, type RedCaseId, type VerifierReceipt,
} from '../phase-contracts/verifier-receipt.ts';
import {
  evaluateVerifierReceipt, GATE_VERSION, type CaseRun, type ReceiptObservation,
} from '../server/verifier-receipt.ts';
import { dispatch, type FetchLike, type Ledger } from './client.ts';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Fixed cohort and deterministic sharding
// ---------------------------------------------------------------------------

export interface EvalItem {
  item_id: string;
  prompt: string;
  /** Deterministic score: the replayed dispatch text must contain this. */
  expect_text: string;
}

export interface Cohort {
  cohort_id: string;
  version: number;
  items: readonly EvalItem[];
}

/** Content address of the cohort: canonical item order, so any drift changes the digest. */
export function cohortDigest(cohort: Cohort): string {
  const items = [...cohort.items]
    .sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0))
    .map(item => ({ item_id: item.item_id, prompt: item.prompt, expect_text: item.expect_text }));
  return sha256(JSON.stringify({ cohort_id: cohort.cohort_id, version: cohort.version, items }));
}

export function shardIndexFor(item_id: string, shard_count: number): number {
  if (!Number.isSafeInteger(shard_count) || shard_count < 1) throw new Error('shard_count must be a positive integer');
  return parseInt(sha256(item_id).slice(0, 8), 16) % shard_count;
}

/** The shard is a pure function of the cohort: same cohort, same shard, byte for byte. */
export function selectShard(cohort: Cohort, shard_count: number, shard_index: number): EvalItem[] {
  if (!Number.isSafeInteger(shard_index) || shard_index < 0 || shard_index >= shard_count) {
    throw new Error('shard_index out of range');
  }
  return cohort.items.filter(item => shardIndexFor(item.item_id, shard_count) === shard_index);
}

// ---------------------------------------------------------------------------
// Producer run record: read-only evaluation input
// ---------------------------------------------------------------------------

export interface ProducerRunRecord {
  producer_id: string;
  task_id: string;
  attempt_id: string;
  sha: string;
  observed_sha: string;
  artifact_digest: string;
  author_lineage: MethodLineage;
  lease: { epoch: string; stale: boolean } | null;
  capability_label_as_authority: boolean;
  approval_events: readonly ('accept' | 'revoke')[];
  /** Producer-supplied case evidence. Integrity is verified, never trusted. */
  evidence_bundle: readonly CaseRun[];
  observation_complete: boolean;
}

// ---------------------------------------------------------------------------
// Evaluation journal: hash-chained lineage record owned by the evaluator
// ---------------------------------------------------------------------------

export interface JournalEntry {
  seq: number;
  prev_hash: string;
  entry_hash: string;
  kind: 'commit' | 'rollback';
  cohort_digest: string;
  shard_index: number;
  producer_id: string;
  evaluator_id: string;
  author_lineage: MethodLineage;
  verifier_lineage: MethodLineage;
  disposition: 'PASS' | 'HOLD';
  reasons: readonly string[];
  /** sha256 of the sealed receipt JSON, or null when no receipt is stored. */
  receipt_digest: string | null;
}

interface JournalDraft {
  cohort_digest: string;
  shard_index: number;
  producer_id: string;
  evaluator_id: string;
  author_lineage: MethodLineage;
  verifier_lineage: MethodLineage;
  disposition: 'PASS' | 'HOLD';
  reasons: readonly string[];
}

export interface EvalStore {
  stage(receipt: VerifierReceipt | null, draft: JournalDraft): string;
  commit(staged_id: string): JournalEntry;
  rollback(staged_id: string, reason: string): JournalEntry;
  entries(): readonly JournalEntry[];
  receipts(): readonly VerifierReceipt[];
}

const GENESIS_HASH = '0'.repeat(64);

export class MemoryEvalStore implements EvalStore {
  private staged = new Map<string, { receipt: VerifierReceipt | null; draft: JournalDraft }>();
  private committed: JournalEntry[] = [];
  private stored: VerifierReceipt[] = [];
  private counter = 0;

  stage(receipt: VerifierReceipt | null, draft: JournalDraft): string {
    this.counter += 1;
    const id = `staged-${this.counter}`;
    this.staged.set(id, { receipt, draft });
    return id;
  }

  private append(kind: 'commit' | 'rollback', draft: JournalDraft, receipt: VerifierReceipt | null, reasons: readonly string[]): JournalEntry {
    const prev = this.committed[this.committed.length - 1];
    const prev_hash = prev ? prev.entry_hash : GENESIS_HASH;
    const receipt_digest = receipt ? sha256(JSON.stringify(receipt)) : null;
    const seq = this.committed.length;
    const entry_hash = sha256(JSON.stringify([
      seq, prev_hash, kind, draft.cohort_digest, draft.shard_index, draft.producer_id,
      draft.evaluator_id, draft.disposition, receipt_digest,
    ]));
    const entry: JournalEntry = {
      seq, prev_hash, entry_hash, kind,
      cohort_digest: draft.cohort_digest,
      shard_index: draft.shard_index,
      producer_id: draft.producer_id,
      evaluator_id: draft.evaluator_id,
      author_lineage: { method: draft.author_lineage.method, dependencies: [...draft.author_lineage.dependencies] },
      verifier_lineage: { method: draft.verifier_lineage.method, dependencies: [...draft.verifier_lineage.dependencies] },
      disposition: draft.disposition,
      reasons,
      receipt_digest,
    };
    this.committed.push(entry);
    return entry;
  }

  commit(staged_id: string): JournalEntry {
    const held = this.staged.get(staged_id);
    if (!held) throw new Error(`unknown staged evaluation: ${staged_id}`);
    this.staged.delete(staged_id);
    if (held.receipt) this.stored.push(held.receipt);
    return this.append('commit', held.draft, held.receipt, held.draft.reasons);
  }

  rollback(staged_id: string, reason: string): JournalEntry {
    const held = this.staged.get(staged_id);
    if (!held) throw new Error(`unknown staged evaluation: ${staged_id}`);
    this.staged.delete(staged_id);
    // The staged receipt is dropped, never stored. The journal keeps the
    // rollback itself, with its reason, so the aborted evaluation is auditable.
    return this.append('rollback', held.draft, null, [...held.draft.reasons, `rollback:${reason}`]);
  }

  entries(): readonly JournalEntry[] {
    return [...this.committed];
  }

  receipts(): readonly VerifierReceipt[] {
    return [...this.stored];
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export interface EvaluatorDeps {
  evaluator_id: string;
  verifier_lineage: MethodLineage;
  consumer: PhaseConsumer;
  next_maker: string;
  /** The evaluator's own ledger. Never the producer's. */
  ledger: Ledger;
  fetchImpl: FetchLike;
  apiKey: string;
  model: string;
  store: EvalStore;
  /** When set, a cohort whose digest differs is rejected (RC4 stays unproven). */
  pinned_cohort_digest?: string;
  max_tokens?: number;
  timeout_ms?: number;
}

export interface ReplaySummary {
  settled: number;
  scored: number;
  total: number;
  micro_usd: number;
}

export interface EvaluationOutcome {
  disposition: 'PASS' | 'HOLD';
  reasons: readonly string[];
  receipt: VerifierReceipt | null;
  cohort_digest: string;
  shard_index: number;
  shard_count: number;
  item_ids: readonly string[];
  replay: ReplaySummary;
  rolled_back: boolean;
  journal_entry: JournalEntry | null;
}

export interface CohortOutcome {
  disposition: 'PASS' | 'HOLD';
  rolled_back: boolean;
  shards: readonly EvaluationOutcome[];
}

const EVALUATOR_OWNED_CASES: ReadonlySet<RedCaseId> = new Set(['RC3', 'RC4']);

function evaluatorRuns(
  record: ProducerRunRecord,
  deps: EvaluatorDeps,
  replayRun: CaseRun,
  cohortRun: CaseRun,
): CaseRun[] {
  const constructed = new Map<RedCaseId, CaseRun>();
  const blank = (case_id: RedCaseId): CaseRun => ({ case_id, evidence: null, evidence_sha256: null });
  const filled = (case_id: RedCaseId, evidence: string): CaseRun => ({ case_id, evidence, evidence_sha256: sha256(evidence) });

  constructed.set('RC1', filled('RC1', `sha=${record.sha} observed=${record.observed_sha}`));
  constructed.set('RC2', record.lease && record.lease.stale === false
    ? filled('RC2', `lease epoch=${record.lease.epoch} fresh`)
    : blank('RC2'));
  constructed.set('RC3', replayRun);
  constructed.set('RC4', cohortRun);
  constructed.set('RC5', filled('RC5', `lineage author=${record.author_lineage.method} verifier=${deps.verifier_lineage.method}`));
  constructed.set('RC6', record.capability_label_as_authority === false
    ? filled('RC6', 'capability_label_as_authority=false')
    : blank('RC6'));
  constructed.set('RC7', record.approval_events.length === 1 && record.approval_events[0] === 'accept'
    ? filled('RC7', 'approval accept count=1')
    : blank('RC7'));
  constructed.set('RC8', record.observation_complete
    ? filled('RC8', 'observation retained')
    : blank('RC8'));

  // Producer evidence is used verbatim outside the evaluator-owned cases, so
  // a tampered or blank bundle entry classifies as such in the receipt. The
  // evaluator-owned cases (replay, cohort) can never be supplied by the producer.
  for (const entry of record.evidence_bundle) {
    if (EVALUATOR_OWNED_CASES.has(entry.case_id)) continue;
    constructed.set(entry.case_id, entry);
  }
  return RED_CASE_IDS.map(case_id => constructed.get(case_id) ?? blank(case_id));
}

export function createEvaluator(deps: EvaluatorDeps) {
  async function replayShard(
    cohort: Cohort,
    digest: string,
    shard_count: number,
    shard_index: number,
    items: readonly EvalItem[],
  ): Promise<{ run: CaseRun; replay: ReplaySummary }> {
    let settled = 0;
    let scored = 0;
    let micro = 0;
    for (const item of items) {
      const report = await dispatch({
        model: deps.model,
        project: `eval:${cohort.cohort_id}`,
        prompt: item.prompt,
        maxTokens: deps.max_tokens ?? 64,
        run_id: `eval-${digest.slice(0, 12)}-${item.item_id}`,
        attempt_id: `eval-${digest.slice(0, 12)}-${item.item_id}-a1`,
        ledger: deps.ledger,
        fetchImpl: deps.fetchImpl,
        apiKey: deps.apiKey,
        costRetries: 1,
        costDelayMs: 0,
        timeoutMs: deps.timeout_ms ?? 5_000,
      });
      if (report.state === 'settled') {
        settled += 1;
        micro += report.micro_usd ?? 0;
        if (report.text.includes(item.expect_text)) scored += 1;
      }
    }
    const replay: ReplaySummary = { settled, scored, total: items.length, micro_usd: micro };
    const complete = items.length > 0 && settled === items.length && scored === items.length;
    const evidence = complete
      ? `replay cohort=${digest.slice(0, 12)} shard=${shard_index}/${shard_count} settled=${settled}/${items.length} scored=${scored}/${items.length} micro=${micro}`
      : null;
    return { run: { case_id: 'RC3', evidence, evidence_sha256: evidence ? sha256(evidence) : null }, replay };
  }

  async function evaluateShardInternal(
    record: ProducerRunRecord,
    cohort: Cohort,
    shard_count: number,
    shard_index: number,
  ): Promise<{ outcome: EvaluationOutcome; staged_id: string | null }> {
    const digest = cohortDigest(cohort);
    const items = selectShard(cohort, shard_count, shard_index);
    const item_ids = items.map(item => item.item_id);
    if (items.length === 0) {
      return {
        outcome: {
          disposition: 'HOLD', reasons: ['empty_shard'], receipt: null, cohort_digest: digest,
          shard_index, shard_count, item_ids, replay: { settled: 0, scored: 0, total: 0, micro_usd: 0 },
          rolled_back: false, journal_entry: null,
        },
        staged_id: null,
      };
    }

    const { run: replayRun, replay } = await replayShard(cohort, digest, shard_count, shard_index, items);
    const pinned_ok = deps.pinned_cohort_digest === undefined || deps.pinned_cohort_digest === digest;
    const cohortEvidence = pinned_ok
      ? `cohort digest=${digest} version=${cohort.version} items=${cohort.items.length} shard_items=${items.length}`
      : null;
    const cohortRun: CaseRun = { case_id: 'RC4', evidence: cohortEvidence, evidence_sha256: cohortEvidence ? sha256(cohortEvidence) : null };

    const observation: ReceiptObservation = {
      consumer: deps.consumer,
      producer_id: record.producer_id,
      acceptor_id: deps.evaluator_id,
      next_maker: deps.next_maker,
      author_lineage: record.author_lineage,
      verifier_lineage: deps.verifier_lineage,
      sha: record.sha,
      observed_sha: record.observed_sha,
      claimed_gate_version: GATE_VERSION,
      task_id: record.task_id,
      attempt_id: record.attempt_id,
      artifact_digest: record.artifact_digest,
      verifier_id: deps.evaluator_id,
      lease: record.lease,
      capability_label_as_authority: record.capability_label_as_authority,
      approval_events: record.approval_events,
      observation_ok: record.observation_complete,
      runs: evaluatorRuns(record, deps, replayRun, cohortRun),
    };
    const evaluation = evaluateVerifierReceipt(observation);
    const reasons = pinned_ok ? evaluation.reasons : [...evaluation.reasons, 'cohort_digest_mismatch'];
    const draft: JournalDraft = {
      cohort_digest: digest,
      shard_index,
      producer_id: record.producer_id,
      evaluator_id: deps.evaluator_id,
      author_lineage: record.author_lineage,
      verifier_lineage: deps.verifier_lineage,
      disposition: evaluation.disposition,
      reasons,
    };
    const staged_id = deps.store.stage(evaluation.receipt, draft);
    return {
      outcome: {
        disposition: evaluation.disposition, reasons, receipt: evaluation.receipt, cohort_digest: digest,
        shard_index, shard_count, item_ids, replay, rolled_back: false, journal_entry: null,
      },
      staged_id,
    };
  }

  /** Evaluate one shard and commit its receipt (PASS and HOLD are both stored). */
  async function evaluateShard(
    record: ProducerRunRecord,
    cohort: Cohort,
    shard_count: number,
    shard_index: number,
  ): Promise<EvaluationOutcome> {
    const { outcome, staged_id } = await evaluateShardInternal(record, cohort, shard_count, shard_index);
    if (staged_id === null) return outcome;
    const entry = deps.store.commit(staged_id);
    return { ...outcome, journal_entry: entry };
  }

  /**
   * Canary-first cohort evaluation. Shard order is canary (first non-empty
   * shard) then the rest in index order. A HOLD canary rolls the whole
   * evaluation back: its staged receipt is dropped, no further shard runs,
   * and the journal records the rollback instead of a commit.
   */
  async function evaluateCohort(
    record: ProducerRunRecord,
    cohort: Cohort,
    shard_count: number,
  ): Promise<CohortOutcome> {
    if (!Number.isSafeInteger(shard_count) || shard_count < 1) throw new Error('shard_count must be a positive integer');
    const order: number[] = [];
    for (let i = 0; i < shard_count; i += 1) {
      if (selectShard(cohort, shard_count, i).length > 0) order.push(i);
    }
    if (order.length === 0) {
      return { disposition: 'HOLD', rolled_back: false, shards: [] };
    }
    const shards: EvaluationOutcome[] = [];
    const [canary_index, ...rest] = order as [number, ...number[]];
    const canary = await evaluateShardInternal(record, cohort, shard_count, canary_index);
    if (canary.staged_id === null || canary.outcome.disposition === 'HOLD') {
      if (canary.staged_id !== null) {
        const entry = deps.store.rollback(canary.staged_id, 'canary_hold');
        shards.push({ ...canary.outcome, rolled_back: true, journal_entry: entry });
      } else {
        shards.push(canary.outcome);
      }
      return { disposition: 'HOLD', rolled_back: true, shards };
    }
    const canary_entry = deps.store.commit(canary.staged_id);
    shards.push({ ...canary.outcome, journal_entry: canary_entry });
    for (const shard_index of rest) {
      shards.push(await evaluateShard(record, cohort, shard_count, shard_index));
    }
    const disposition = shards.every(shard => shard.disposition === 'PASS') ? 'PASS' : 'HOLD';
    return { disposition, rolled_back: false, shards };
  }

  return { evaluateShard, evaluateCohort };
}
