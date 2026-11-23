import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cohortDigest, createEvaluator, MemoryEvalStore, selectShard, shardIndexFor,
  type Cohort, type ProducerRunRecord,
} from '../src/or-harness/evaluator.ts';
import type { FetchLike, Ledger } from '../src/or-harness/client.ts';
import { validateVerifierReceipt } from '../src/phase-contracts/verifier-receipt.ts';

const MODEL = 'z-ai/glm-5.3-flash';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const DIGEST = 'b'.repeat(64);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function cohort(): Cohort {
  return {
    cohort_id: 'eval-cohort-1',
    version: 1,
    items: ['item-a', 'item-b', 'item-c', 'item-d', 'item-e', 'item-f'].map(item_id => ({
      item_id,
      prompt: `eval prompt ${item_id}`,
      expect_text: `answer ${item_id}`,
    })),
  };
}

function record(over: Partial<ProducerRunRecord> = {}): ProducerRunRecord {
  return {
    producer_id: 'agent:producer',
    task_id: 'task-1',
    attempt_id: 'task-1-a1',
    sha: SHA,
    observed_sha: SHA,
    artifact_digest: DIGEST,
    author_lineage: { method: 'producer-method', dependencies: ['dep-a'] },
    lease: { epoch: 'epoch-1', stale: false },
    capability_label_as_authority: false,
    approval_events: ['accept'],
    evidence_bundle: [],
    observation_complete: true,
    ...over,
  };
}

function mockFetch(wrongFor: string | null = null): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const prompt = body.messages[0]?.content ?? '';
      const text = wrongFor !== null && prompt.includes(wrongFor) ? 'unrelated text' : prompt.replace('eval prompt ', 'answer ');
      return Response.json({
        id: 'gen-eval',
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
    }
    if (method === 'GET' && url.includes('/generation')) {
      return Response.json({ data: { id: 'gen-eval', total_cost: 0.00001, tokens_prompt: 3, tokens_completion: 1, provider_name: 'mock', model: MODEL } });
    }
    throw new Error('unexpected url ' + url);
  };
}

function mockLedger(): Ledger & { reserves: number; settles: number; projects: string[] } {
  return {
    reserves: 0,
    settles: 0,
    projects: [],
    async reserve(input) {
      this.reserves += 1;
      this.projects.push(input.project);
      return { ok: true, reservation_id: `res-${this.reserves}` };
    },
    async markPending() { /* hold stays pending */ },
    async settle() { this.settles += 1; },
    async summary() { return { remaining_micro_usd: 1_000_000 }; },
  };
}

function setup(over: { wrongFor?: string | null; pinned?: string } = {}) {
  const ledger = mockLedger();
  const store = new MemoryEvalStore();
  const evaluator = createEvaluator({
    evaluator_id: 'agent:evaluator-g5',
    verifier_lineage: { method: 'evaluator-method', dependencies: ['dep-b'] },
    consumer: 'P1',
    next_maker: 'agent:producer',
    ledger,
    fetchImpl: mockFetch(over.wrongFor ?? null),
    apiKey: 'test-key',
    model: MODEL,
    store,
    pinned_cohort_digest: over.pinned,
  });
  return { evaluator, ledger, store };
}

test('cohort digest is stable and drift-sensitive', () => {
  const a = cohort();
  assert.equal(cohortDigest(a), cohortDigest(cohort()));
  const drifted: Cohort = { ...a, items: a.items.map((item, i) => (i === 0 ? { ...item, expect_text: 'changed' } : item)) };
  assert.notEqual(cohortDigest(a), cohortDigest(drifted));
});

test('sharding partitions the cohort deterministically with no overlap', () => {
  const fixed = cohort();
  const shards = [0, 1].map(index => selectShard(fixed, 2, index));
  const all = shards.flat().map(item => item.item_id).sort();
  assert.deepEqual(all, fixed.items.map(item => item.item_id).sort());
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual(selectShard(fixed, 2, 0), shards[0]);
  for (const item of fixed.items) {
    assert.equal(shards[shardIndexFor(item.item_id, 2)]?.some(row => row.item_id === item.item_id), true);
  }
});

test('a clean run evaluates to PASS with a sealed receipt and a chained journal', async () => {
  const { evaluator, ledger, store } = setup();
  const outcome = await evaluator.evaluateCohort(record(), cohort(), 2);
  assert.equal(outcome.disposition, 'PASS');
  assert.equal(outcome.rolled_back, false);
  assert.equal(outcome.shards.length, 2);
  for (const shard of outcome.shards) {
    assert.equal(shard.disposition, 'PASS');
    assert.equal(shard.replay.settled, shard.replay.total);
    assert.equal(shard.replay.scored, shard.replay.total);
    assert.ok(shard.receipt);
    assert.equal(validateVerifierReceipt(shard.receipt).ok, true);
    // Synthetic proof mode: an evaluator receipt is not live proof.
    assert.equal(shard.receipt?.proof_mode, 'synthetic');
  }
  assert.equal(store.receipts().length, 2);
  const entries = store.entries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.prev_hash, '0'.repeat(64));
  assert.equal(entries[1]?.prev_hash, entries[0]?.entry_hash);
  assert.equal(entries[0]?.verifier_lineage.method, 'evaluator-method');
  assert.equal(entries[0]?.author_lineage.method, 'producer-method');
  assert.ok(ledger.reserves > 0);
  assert.ok(ledger.projects.every(project => project === 'eval:eval-cohort-1'));
});

test('rejection 1: sha mismatch holds with sha_changed', async () => {
  const { evaluator } = setup();
  const outcome = await evaluator.evaluateShard(record({ observed_sha: OTHER_SHA }), cohort(), 2, 0);
  assert.equal(outcome.disposition, 'HOLD');
  assert.ok(outcome.reasons.includes('sha_changed'));
});

test('rejection 2: same lineage as the author stays unsealed', async () => {
  const ledger = mockLedger();
  const evaluator = createEvaluator({
    evaluator_id: 'agent:evaluator-g5',
    verifier_lineage: { method: 'producer-method', dependencies: ['dep-a'] },
    consumer: 'P1', next_maker: 'agent:producer', ledger,
    fetchImpl: mockFetch(), apiKey: 'test-key', model: MODEL, store: new MemoryEvalStore(),
  });
  const outcome = await evaluator.evaluateShard(record(), cohort(), 2, 0);
  assert.equal(outcome.disposition, 'HOLD');
  assert.equal(outcome.receipt, null);
  assert.ok(outcome.reasons.includes('same_lineage'));
});

test('rejection 3: evaluator acting as its own producer stays unsealed', async () => {
  const ledger = mockLedger();
  const evaluator = createEvaluator({
    evaluator_id: 'agent:producer',
    verifier_lineage: { method: 'evaluator-method', dependencies: ['dep-b'] },
    consumer: 'P1', next_maker: 'agent:producer', ledger,
    fetchImpl: mockFetch(), apiKey: 'test-key', model: MODEL, store: new MemoryEvalStore(),
  });
  const outcome = await evaluator.evaluateShard(record(), cohort(), 2, 0);
  assert.equal(outcome.disposition, 'HOLD');
  assert.equal(outcome.receipt, null);
  assert.ok(outcome.reasons.includes('acceptor_is_producer'));
});

test('rejection 4: a stale or missing lease holds', async () => {
  const { evaluator } = setup();
  const stale = await evaluator.evaluateShard(record({ lease: { epoch: 'epoch-1', stale: true } }), cohort(), 2, 0);
  assert.equal(stale.disposition, 'HOLD');
  assert.ok(stale.reasons.includes('stale_lease'));
  const missing = await evaluator.evaluateShard(record({ lease: null }), cohort(), 2, 0);
  assert.equal(missing.disposition, 'HOLD');
  assert.ok(missing.reasons.includes('stale_lease'));
});

test('rejection 5: tampered producer evidence holds', async () => {
  const { evaluator } = setup();
  const evidence = 'producer log line';
  const tampered = record({
    evidence_bundle: [{ case_id: 'RC1', evidence, evidence_sha256: sha256('different text') }],
  });
  const outcome = await evaluator.evaluateShard(tampered, cohort(), 2, 0);
  assert.equal(outcome.disposition, 'HOLD');
  assert.ok(outcome.reasons.includes('evidence_tampered'));
});

test('rejection 6: approval race or missing approval holds', async () => {
  const { evaluator } = setup();
  const race = await evaluator.evaluateShard(record({ approval_events: ['accept', 'revoke'] }), cohort(), 2, 0);
  assert.equal(race.disposition, 'HOLD');
  assert.ok(race.reasons.includes('revoke_accept_race'));
  const missing = await evaluator.evaluateShard(record({ approval_events: [] }), cohort(), 2, 0);
  assert.equal(missing.disposition, 'HOLD');
  assert.ok(missing.reasons.includes('approval_missing'));
});

test('a drifted cohort is rejected against the pinned digest', async () => {
  const { evaluator } = setup({ pinned: 'f'.repeat(64) });
  const outcome = await evaluator.evaluateShard(record(), cohort(), 2, 0);
  assert.equal(outcome.disposition, 'HOLD');
  assert.ok(outcome.reasons.includes('cohort_digest_mismatch'));
});

test('a replay that does not reproduce the expected output holds', async () => {
  const shard0 = selectShard(cohort(), 2, 0);
  const victim = shard0[0]?.item_id ?? 'item-a';
  const { evaluator } = setup({ wrongFor: victim });
  const outcome = await evaluator.evaluateShard(record(), cohort(), 2, 0);
  assert.equal(outcome.disposition, 'HOLD');
  assert.ok(outcome.replay.scored < outcome.replay.total);
  assert.ok(outcome.reasons.includes('partial_census'));
});

test('a HOLD canary rolls the whole evaluation back', async () => {
  const { evaluator, ledger, store } = setup();
  const outcome = await evaluator.evaluateCohort(record({ observed_sha: OTHER_SHA }), cohort(), 2);
  assert.equal(outcome.disposition, 'HOLD');
  assert.equal(outcome.rolled_back, true);
  assert.equal(outcome.shards.length, 1);
  assert.equal(outcome.shards[0]?.rolled_back, true);
  // No receipt from the aborted evaluation is stored; the journal keeps the rollback.
  assert.equal(store.receipts().length, 0);
  const entries = store.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.kind, 'rollback');
  assert.ok(entries[0]?.reasons.some(reason => reason.startsWith('rollback:')));
  // Only the canary shard was replayed; later shards never ran.
  assert.equal(ledger.reserves, outcome.shards[0]?.replay.total);
});

test('evaluation never mutates the producer record and books only eval: reservations', async () => {
  const { evaluator, ledger } = setup();
  const input = record();
  const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
  await evaluator.evaluateShard(input, cohort(), 2, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(input)) as unknown, snapshot);
  assert.ok(ledger.reserves > 0);
  assert.ok(ledger.projects.every(project => project.startsWith('eval:')));
});
