import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  evaluateWakeProof,
  type EmittedDelivery,
  type HostRun,
  type PersistedMessage,
  type ReadOutcome,
  type RelayReceipt,
  type WakeProofInput,
  type WakeProofResult,
} from '../src/server/wake-proof.ts';

const AGENT = 'agent:muse';
const MESSAGE = 'msg-1';
const EVENT = 'evt-1';
const DELIVERY = 'del-1';
const RUN = 'run-1';
const ORIGIN = Date.parse('2026-10-24T00:00:00.000Z');
const at = (delta: number) => new Date(ORIGIN + delta).toISOString();

function persisted(over: Partial<PersistedMessage> = {}): PersistedMessage {
  return { message_id: MESSAGE, created_at: at(0), mentions: [AGENT, 'agent:grok'], ...over };
}
function emitted(over: Partial<EmittedDelivery> = {}): EmittedDelivery {
  return { delivery_id: DELIVERY, event_id: EVENT, message_id: MESSAGE, agent: AGENT, attempt: 1, emitted_at: at(1000), ...over };
}
function receipt(over: Partial<RelayReceipt> = {}): RelayReceipt {
  return {
    delivery_id: DELIVERY, event_id: EVENT, message_id: MESSAGE, agent: AGENT,
    received_at: at(2000), signature_verified: true, source: 'relay', ...over,
  };
}
function hostRun(over: Partial<HostRun> = {}): HostRun {
  return { run_id: RUN, delivery_id: DELIVERY, event_id: EVENT, agent: AGENT, started_at: at(3000), cause: 'delivery', ...over };
}
function readOutcome(over: Partial<ReadOutcome> = {}): ReadOutcome {
  return { run_id: RUN, message_id: MESSAGE, agent: AGENT, read_at: at(4000), principal_authenticated: true, outcome_ref: 'out-1', ...over };
}

interface Over {
  persisted?: PersistedMessage | null;
  emitted?: EmittedDelivery[];
  relay_receipts?: RelayReceipt[];
  host_runs?: HostRun[];
  read_outcomes?: ReadOutcome[];
  clockSkewMs?: number;
}

function proof(over: Over = {}): WakeProofInput {
  return {
    agent: AGENT,
    message_id: MESSAGE,
    persisted: over.persisted === undefined ? persisted() : over.persisted,
    emitted: over.emitted ?? [emitted()],
    relay_receipts: over.relay_receipts ?? [receipt()],
    host_runs: over.host_runs ?? [hostRun()],
    read_outcomes: over.read_outcomes ?? [readOutcome()],
    ...(over.clockSkewMs !== undefined ? { clockSkewMs: over.clockSkewMs } : {}),
  };
}

const emptyDup = { receipts: [], replays: [] };

function provenShape(over: { delivery?: string; attempt?: number; run?: string; outcome?: string | null; event?: string } = {}): WakeProofResult {
  const delivery = over.delivery ?? DELIVERY;
  const event = over.event ?? EVENT;
  const attempt = over.attempt ?? 1;
  const runId = over.run ?? RUN;
  const outcome = over.outcome === undefined ? 'out-1' : over.outcome;
  return {
    agent: AGENT,
    message_id: MESSAGE,
    stages: {
      persisted: { status: 'proven', reasons: [], ids: { message_id: MESSAGE } },
      emitted: { status: 'proven', reasons: [], ids: { delivery_id: delivery, event_id: event, message_id: MESSAGE, attempt } },
      relay_receipt: { status: 'proven', reasons: [], ids: { delivery_id: delivery, event_id: event, message_id: MESSAGE } },
      host_run: { status: 'proven', reasons: [], ids: { run_id: runId, delivery_id: delivery, event_id: event } },
      read_outcome: { status: 'proven', reasons: [], ids: { run_id: runId, message_id: MESSAGE, outcome_ref: outcome } },
    },
    verdict: 'proven',
    duplicates: emptyDup,
    notes: [],
  };
}

test('proven chain ties persisted, emitted, relay receipt, host run, and the exact read', () => {
  assert.deepEqual(evaluateWakeProof(proof()), provenShape());
  assert.deepEqual(evaluateWakeProof(proof({ relay_receipts: [receipt({ source: 'webhook' })] })), provenShape());
  const silent = evaluateWakeProof(proof({ read_outcomes: [readOutcome({ outcome_ref: null })] }));
  assert.equal(silent.verdict, 'proven');
  assert.equal(silent.stages.read_outcome.ids.outcome_ref, null);
});

test('poll receipt is not push', () => {
  const result = evaluateWakeProof(proof({ relay_receipts: [receipt({ source: 'poll' })] }));
  assert.equal(result.stages.persisted.status, 'proven');
  assert.equal(result.stages.emitted.status, 'proven');
  assert.deepEqual(result.stages.relay_receipt, {
    status: 'invalid', reasons: ['source_poll'],
    ids: { delivery_id: DELIVERY, event_id: EVENT, message_id: MESSAGE },
  });
  assert.equal(result.stages.host_run.status, 'proven');
  assert.equal(result.stages.read_outcome.status, 'proven');
  assert.equal(result.verdict, 'partial');
});

test('scheduled host run is not push', () => {
  const result = evaluateWakeProof(proof({ host_runs: [hostRun({ cause: 'schedule' })] }));
  assert.equal(result.stages.relay_receipt.status, 'proven');
  assert.deepEqual(result.stages.host_run, {
    status: 'invalid', reasons: ['cause_schedule'],
    ids: { run_id: RUN, delivery_id: DELIVERY, event_id: EVENT },
  });
  assert.equal(result.stages.read_outcome.status, 'proven');
  assert.equal(result.verdict, 'partial');
});

test('manual host run is not push', () => {
  const result = evaluateWakeProof(proof({ host_runs: [hostRun({ cause: 'manual' })] }));
  assert.deepEqual(result.stages.host_run.reasons, ['cause_manual']);
  assert.equal(result.stages.host_run.status, 'invalid');
  assert.equal(result.stages.relay_receipt.status, 'proven');
  assert.equal(result.verdict, 'partial');
});

test('unverified signature invalidates the relay receipt', () => {
  const unverified = evaluateWakeProof(proof({ relay_receipts: [receipt({ signature_verified: false })] }));
  assert.deepEqual(unverified.stages.relay_receipt.reasons, ['signature_unverified']);
  assert.equal(unverified.stages.relay_receipt.status, 'invalid');
  assert.equal(unverified.stages.host_run.status, 'proven');
  assert.equal(unverified.verdict, 'partial');

  const both = evaluateWakeProof(proof({ relay_receipts: [receipt({ source: 'poll', signature_verified: false })] }));
  assert.deepEqual(both.stages.relay_receipt.reasons, ['source_poll', 'signature_unverified']);
});

test('every stage has to match the claimed agent', () => {
  const emittedWrong = evaluateWakeProof(proof({ emitted: [emitted({ agent: 'agent:other' })] }));
  assert.equal(emittedWrong.stages.emitted.status, 'invalid');
  assert.deepEqual(emittedWrong.stages.emitted.reasons, ['agent_mismatch']);
  assert.equal(emittedWrong.verdict, 'unproven');

  const relayWrong = evaluateWakeProof(proof({ relay_receipts: [receipt({ agent: 'agent:other' })] }));
  assert.deepEqual(relayWrong.stages.relay_receipt.reasons, ['agent_mismatch']);
  assert.equal(relayWrong.stages.relay_receipt.status, 'invalid');
  assert.deepEqual(relayWrong.stages.host_run.reasons, ['no_relay_receipt']);
  assert.equal(relayWrong.verdict, 'partial');

  const hostWrong = evaluateWakeProof(proof({ host_runs: [hostRun({ agent: 'agent:other' })] }));
  assert.deepEqual(hostWrong.stages.host_run.reasons, ['agent_mismatch']);
  assert.equal(hostWrong.stages.relay_receipt.status, 'proven');
  assert.equal(hostWrong.verdict, 'partial');

  const readWrong = evaluateWakeProof(proof({ read_outcomes: [readOutcome({ agent: 'agent:other' })] }));
  assert.deepEqual(readWrong.stages.read_outcome.reasons, ['agent_mismatch']);
  assert.equal(readWrong.stages.host_run.status, 'proven');
  assert.equal(readWrong.verdict, 'partial');
});

test('event, delivery, message, and run ids chain', () => {
  const event = evaluateWakeProof(proof({ relay_receipts: [receipt({ event_id: 'evt-other' })] }));
  assert.deepEqual(event.stages.relay_receipt.reasons, ['event_mismatch']);
  assert.deepEqual(event.stages.host_run.reasons, ['no_relay_receipt']);
  assert.equal(event.verdict, 'partial');

  const delivery = evaluateWakeProof(proof({ relay_receipts: [receipt({ delivery_id: 'del-other' })] }));
  assert.deepEqual(delivery.stages.relay_receipt.reasons, ['delivery_mismatch']);
  assert.equal(delivery.stages.relay_receipt.ids.delivery_id, 'del-other');
  assert.equal(delivery.verdict, 'partial');

  const hostEvent = evaluateWakeProof(proof({ host_runs: [hostRun({ event_id: 'evt-other' })] }));
  assert.deepEqual(hostEvent.stages.host_run.reasons, ['event_mismatch']);

  const hostDelivery = evaluateWakeProof(proof({ host_runs: [hostRun({ delivery_id: 'del-other' })] }));
  assert.deepEqual(hostDelivery.stages.host_run.reasons, ['delivery_mismatch']);
  assert.equal(hostDelivery.stages.host_run.ids.delivery_id, 'del-other');

  const noReceipt = evaluateWakeProof(proof({ relay_receipts: [] }));
  assert.equal(noReceipt.stages.relay_receipt.status, 'missing');
  assert.deepEqual(noReceipt.stages.host_run.reasons, ['no_relay_receipt']);
  assert.equal(noReceipt.stages.read_outcome.status, 'proven');
  assert.equal(noReceipt.verdict, 'partial');

  const noHost = evaluateWakeProof(proof({ host_runs: [] }));
  assert.equal(noHost.stages.host_run.status, 'missing');
  assert.deepEqual(noHost.stages.read_outcome.reasons, ['no_host_run']);
  assert.equal(noHost.verdict, 'partial');

  const runMismatch = evaluateWakeProof(proof({ read_outcomes: [readOutcome({ run_id: 'run-other' })] }));
  assert.deepEqual(runMismatch.stages.read_outcome.reasons, ['run_mismatch']);
  assert.equal(runMismatch.stages.read_outcome.ids.run_id, 'run-other');
  assert.equal(runMismatch.stages.host_run.status, 'proven');
  assert.equal(runMismatch.verdict, 'partial');

  const message = evaluateWakeProof(proof({ read_outcomes: [readOutcome({ message_id: 'msg-other' })] }));
  assert.deepEqual(message.stages.read_outcome.reasons, ['message_mismatch']);
  assert.equal(message.stages.read_outcome.ids.message_id, 'msg-other');
  assert.equal(message.stages.host_run.status, 'proven');
  assert.equal(message.verdict, 'partial');

  const receiptMessage = evaluateWakeProof(proof({ relay_receipts: [receipt({ message_id: 'msg-other' })] }));
  assert.deepEqual(receiptMessage.stages.relay_receipt.reasons, ['message_mismatch']);
});

test('unauthenticated read is invalid', () => {
  const result = evaluateWakeProof(proof({ read_outcomes: [readOutcome({ principal_authenticated: false, outcome_ref: 'out-x' })] }));
  assert.deepEqual(result.stages.read_outcome, {
    status: 'invalid', reasons: ['principal_unauthenticated'],
    ids: { run_id: RUN, message_id: MESSAGE, outcome_ref: 'out-x' },
  });
  assert.equal(result.stages.host_run.status, 'proven');
  assert.equal(result.verdict, 'partial');
});

test('time order is enforced at each boundary', () => {
  const emittedEarly = evaluateWakeProof(proof({ emitted: [emitted({ emitted_at: at(-2001) })] }));
  assert.deepEqual(emittedEarly.stages.emitted.reasons, ['emitted_before_created']);
  assert.equal(emittedEarly.stages.emitted.status, 'invalid');
  assert.equal(emittedEarly.stages.persisted.status, 'proven');
  assert.equal(emittedEarly.verdict, 'unproven');

  const receivedEarly = evaluateWakeProof(proof({ relay_receipts: [receipt({ received_at: at(1000 - 2001) })] }));
  assert.deepEqual(receivedEarly.stages.relay_receipt.reasons, ['received_before_emitted']);
  assert.equal(receivedEarly.stages.emitted.status, 'proven');
  assert.equal(receivedEarly.stages.host_run.status, 'proven');
  assert.equal(receivedEarly.verdict, 'partial');

  const startedEarly = evaluateWakeProof(proof({ host_runs: [hostRun({ started_at: at(2000 - 2001) })] }));
  assert.deepEqual(startedEarly.stages.host_run.reasons, ['started_before_received']);
  assert.equal(startedEarly.stages.relay_receipt.status, 'proven');
  assert.equal(startedEarly.stages.read_outcome.status, 'proven');
  assert.equal(startedEarly.verdict, 'partial');

  const readEarly = evaluateWakeProof(proof({ read_outcomes: [readOutcome({ read_at: at(3000 - 2001) })] }));
  assert.deepEqual(readEarly.stages.read_outcome.reasons, ['read_before_started']);
  assert.equal(readEarly.stages.host_run.status, 'proven');
  assert.equal(readEarly.verdict, 'partial');
});

test('default clock skew is 2000ms and zero skew is strict', () => {
  const inside = proof({
    emitted: [emitted({ emitted_at: at(-2000) })],
    relay_receipts: [receipt({ received_at: at(-2000) })],
    host_runs: [hostRun({ started_at: at(-2000) })],
    read_outcomes: [readOutcome({ read_at: at(-2000) })],
  });
  assert.equal(evaluateWakeProof(inside).verdict, 'proven');
  assert.deepEqual(evaluateWakeProof(inside), evaluateWakeProof({ ...inside, clockSkewMs: 2000 }));

  const outside = evaluateWakeProof(proof({ emitted: [emitted({ emitted_at: at(-2001) })] }));
  assert.deepEqual(outside.stages.emitted.reasons, ['emitted_before_created']);
  assert.equal(outside.verdict, 'unproven');

  const tight = proof({
    clockSkewMs: 0,
    emitted: [emitted({ emitted_at: at(0) })],
    relay_receipts: [receipt({ received_at: at(0) })],
    host_runs: [hostRun({ started_at: at(0) })],
    read_outcomes: [readOutcome({ read_at: at(0) })],
  });
  assert.equal(evaluateWakeProof(tight).verdict, 'proven');
  const oneMs = evaluateWakeProof(proof({
    clockSkewMs: 0,
    read_outcomes: [readOutcome({ read_at: at(2999) })],
  }));
  assert.deepEqual(oneMs.stages.read_outcome.reasons, ['read_before_started']);

  // +09:00 instants, not string order. 09:00+09 == 00:00Z; 08:59:57+09 == 00:00Z minus 3s.
  const sameInstant = evaluateWakeProof(proof({
    persisted: persisted({ created_at: '2026-10-24T00:00:00.000Z' }),
    emitted: [emitted({ emitted_at: '2026-10-24T09:00:00.000+09:00' })],
  }));
  assert.equal(sameInstant.stages.emitted.status, 'proven');
  const earlierInstant = evaluateWakeProof(proof({
    persisted: persisted({ created_at: '2026-10-24T00:00:00.000Z' }),
    emitted: [emitted({ emitted_at: '2026-10-24T08:59:57.000+09:00' })],
  }));
  assert.deepEqual(earlierInstant.stages.emitted.reasons, ['emitted_before_created']);
});

test('retries share an event id and the received attempt is the proof', () => {
  const onlySecond = evaluateWakeProof(proof({
    emitted: [
      emitted({ delivery_id: 'del-2', attempt: 2, emitted_at: at(1500) }),
      emitted({ delivery_id: 'del-1', attempt: 1, emitted_at: at(1000) }),
    ],
    relay_receipts: [receipt({ delivery_id: 'del-2', received_at: at(2500) })],
    host_runs: [hostRun({ run_id: 'run-2', delivery_id: 'del-2', started_at: at(3500) })],
    read_outcomes: [readOutcome({ run_id: 'run-2', read_at: at(4500), outcome_ref: 'out-2' })],
  }));
  assert.deepEqual(onlySecond.stages.emitted.ids, { delivery_id: 'del-2', event_id: EVENT, message_id: MESSAGE, attempt: 2 });
  assert.equal(onlySecond.stages.relay_receipt.ids.delivery_id, 'del-2');
  assert.equal(onlySecond.stages.host_run.ids.run_id, 'run-2');
  assert.equal(onlySecond.stages.read_outcome.ids.outcome_ref, 'out-2');
  assert.equal(onlySecond.verdict, 'proven');
  assert.deepEqual(onlySecond.notes, ['retry evt-1 attempts 1>2 chosen del-2']);

  const onlyFirst = evaluateWakeProof(proof({
    emitted: [
      emitted({ delivery_id: 'del-2', attempt: 2, emitted_at: at(1500) }),
      emitted({ delivery_id: 'del-1', attempt: 1, emitted_at: at(1000) }),
    ],
    relay_receipts: [receipt({ delivery_id: 'del-1', received_at: at(2000) })],
    host_runs: [hostRun({ run_id: 'run-1', delivery_id: 'del-1', started_at: at(3000) })],
    read_outcomes: [readOutcome({ run_id: 'run-1', read_at: at(4000), outcome_ref: 'out-1' })],
  }));
  assert.equal(onlyFirst.stages.emitted.ids.delivery_id, 'del-1');
  assert.equal(onlyFirst.stages.emitted.ids.attempt, 1);
  assert.deepEqual(onlyFirst.notes, ['retry evt-1 attempts 1>2 chosen del-1']);
  assert.equal(onlyFirst.verdict, 'proven');
});

test('when several attempts were received, one proof is chosen', () => {
  const result = evaluateWakeProof(proof({
    emitted: [
      emitted({ delivery_id: 'del-2', attempt: 2, emitted_at: at(1500) }),
      emitted({ delivery_id: 'del-1', attempt: 1, emitted_at: at(1000) }),
    ],
    relay_receipts: [
      receipt({ delivery_id: 'del-2', received_at: at(2500) }),
      receipt({ delivery_id: 'del-1', received_at: at(2000) }),
    ],
    host_runs: [
      hostRun({ run_id: 'run-2', delivery_id: 'del-2', started_at: at(3500) }),
      hostRun({ run_id: 'run-1', delivery_id: 'del-1', started_at: at(3000) }),
    ],
    read_outcomes: [
      readOutcome({ run_id: 'run-2', read_at: at(4500), outcome_ref: 'out-2' }),
      readOutcome({ run_id: 'run-1', read_at: at(4000), outcome_ref: 'out-1' }),
    ],
  }));
  assert.equal(result.verdict, 'proven');
  assert.equal(result.stages.emitted.ids.delivery_id, 'del-1');
  assert.equal(result.stages.emitted.ids.attempt, 1);
  assert.equal(result.stages.host_run.ids.run_id, 'run-1');
  assert.equal(result.stages.read_outcome.ids.outcome_ref, 'out-1');
  assert.deepEqual(result.notes, ['retry evt-1 attempts 1>2 chosen del-1']);
  assert.deepEqual(result.duplicates, emptyDup);
});

test('duplicate receipts for one delivery count once', () => {
  const result = evaluateWakeProof(proof({
    relay_receipts: [
      receipt({ received_at: at(2500) }),
      receipt({ received_at: at(2000) }),
    ],
  }));
  assert.equal(result.verdict, 'proven');
  assert.equal(result.stages.relay_receipt.status, 'proven');
  assert.equal(result.stages.host_run.ids.run_id, RUN);
  assert.deepEqual(result.duplicates, { receipts: [{ delivery_id: DELIVERY, count: 2 }], replays: [] });
  assert.deepEqual(result.notes, ['duplicate receipt del-1 count 2']);
});

test('a replayed receipt does not create a second proof', () => {
  const replayed = proof({
    relay_receipts: [
      receipt({ received_at: at(7000) }),
      receipt({ received_at: at(2000) }),
    ],
    host_runs: [
      hostRun({ run_id: 'run-2', started_at: at(8000) }),
      hostRun({ run_id: 'run-1', started_at: at(3000) }),
    ],
    read_outcomes: [
      readOutcome({ run_id: 'run-2', read_at: at(9000), outcome_ref: 'out-2' }),
      readOutcome({ run_id: 'run-1', read_at: at(4000), outcome_ref: 'out-1' }),
    ],
  });
  const result = evaluateWakeProof(replayed);
  assert.equal(result.verdict, 'proven');
  assert.equal(result.stages.host_run.ids.run_id, 'run-1');
  assert.equal(result.stages.read_outcome.ids.run_id, 'run-1');
  assert.equal(result.stages.read_outcome.ids.outcome_ref, 'out-1');
  assert.deepEqual(result.duplicates, {
    receipts: [{ delivery_id: DELIVERY, count: 2 }],
    replays: [{ delivery_id: DELIVERY, run_id: 'run-1', received_at: at(7000) }],
  });
  assert.deepEqual(result.notes, [
    'duplicate receipt del-1 count 2',
    `replay del-1 ${at(7000)} run run-1`,
    'suppressed run run-2',
  ]);

  const reversed = evaluateWakeProof({
    ...replayed,
    relay_receipts: [...(replayed.relay_receipts ?? [])].reverse(),
    host_runs: [...(replayed.host_runs ?? [])].reverse(),
    read_outcomes: [...(replayed.read_outcomes ?? [])].reverse(),
  });
  assert.deepEqual(reversed, result);

  // Exactly skew after the run is still the same wake. One millisecond later is a replay.
  const onSkew = evaluateWakeProof(proof({
    relay_receipts: [receipt({ received_at: at(2000) }), receipt({ received_at: at(5000) })],
  }));
  assert.deepEqual(onSkew.duplicates.replays, []);
  assert.equal(onSkew.verdict, 'proven');
  assert.deepEqual(onSkew.duplicates.receipts, [{ delivery_id: DELIVERY, count: 2 }]);

  const justAfter = evaluateWakeProof(proof({
    relay_receipts: [receipt({ received_at: at(2000) }), receipt({ received_at: at(5001) })],
  }));
  assert.deepEqual(justAfter.duplicates.replays, [{ delivery_id: DELIVERY, run_id: RUN, received_at: at(5001) }]);
  assert.equal(justAfter.verdict, 'proven');
  assert.equal(justAfter.stages.host_run.ids.run_id, RUN);
});

test('a message that does not mention the agent is unproven', () => {
  for (const mentions of [[], ['agent:other'], ['prefix-agent:muse']]) {
    const result = evaluateWakeProof(proof({ persisted: persisted({ mentions }) }));
    assert.equal(result.verdict, 'unproven', JSON.stringify(mentions));
    assert.deepEqual(result.stages.persisted, {
      status: 'invalid', reasons: ['agent_not_mentioned'], ids: { message_id: MESSAGE },
    });
    assert.deepEqual(result.notes, ['agent not mentioned']);
    assert.equal(result.stages.emitted.status, 'proven');
    assert.equal(result.stages.relay_receipt.status, 'proven');
    assert.equal(result.stages.host_run.status, 'proven');
    assert.equal(result.stages.read_outcome.status, 'proven');
  }
  const foreign = evaluateWakeProof(proof({
    persisted: persisted({ message_id: 'msg-other', mentions: [AGENT] }),
  }));
  assert.deepEqual(foreign.stages.persisted.reasons, ['message_mismatch']);
  assert.equal(foreign.stages.persisted.ids.message_id, 'msg-other');
  assert.equal(foreign.verdict, 'unproven');
});

test('verdict is proven only when all five stages are proven', () => {
  assert.equal(evaluateWakeProof(proof()).verdict, 'proven');
  assert.equal(evaluateWakeProof(proof({ read_outcomes: [] })).verdict, 'partial');
  assert.equal(evaluateWakeProof(proof({ relay_receipts: [receipt({ source: 'poll' })] })).verdict, 'partial');
});

test('verdict is partial when the message was persisted and emitted but the wake did not finish', () => {
  const missingLater = evaluateWakeProof(proof({ relay_receipts: [], host_runs: [], read_outcomes: [] }));
  assert.equal(missingLater.verdict, 'partial');
  assert.equal(missingLater.stages.persisted.status, 'proven');
  assert.equal(missingLater.stages.emitted.status, 'proven');
  assert.equal(missingLater.stages.relay_receipt.status, 'missing');
  assert.equal(missingLater.stages.host_run.status, 'missing');
  assert.equal(missingLater.stages.read_outcome.status, 'missing');
  assert.deepEqual(missingLater.duplicates, emptyDup);
  assert.deepEqual(missingLater.notes, []);

  const droppedRead = evaluateWakeProof(proof({ read_outcomes: [] }));
  assert.equal(droppedRead.verdict, 'partial');
  assert.equal(droppedRead.stages.read_outcome.status, 'missing');
  assert.equal(droppedRead.stages.host_run.status, 'proven');
  assert.deepEqual(droppedRead.stages.read_outcome.ids, { run_id: null, message_id: null, outcome_ref: null });
});

test('verdict is unproven without both persisted and emitted', () => {
  const none = evaluateWakeProof({ agent: AGENT, message_id: MESSAGE });
  assert.equal(none.verdict, 'unproven');
  assert.equal(none.agent, AGENT);
  assert.equal(none.message_id, MESSAGE);
  for (const stage of [none.stages.persisted, none.stages.emitted, none.stages.relay_receipt, none.stages.host_run, none.stages.read_outcome]) {
    assert.equal(stage.status, 'missing');
    assert.deepEqual(stage.reasons, []);
  }
  assert.deepEqual(none.duplicates, emptyDup);
  assert.deepEqual(none.notes, []);

  const persistedOnly = evaluateWakeProof({ agent: AGENT, message_id: MESSAGE, persisted: persisted() });
  assert.equal(persistedOnly.verdict, 'unproven');
  assert.equal(persistedOnly.stages.persisted.status, 'proven');
  assert.equal(persistedOnly.stages.emitted.status, 'missing');

  const emittedOnly = evaluateWakeProof({
    agent: AGENT, message_id: MESSAGE, emitted: [emitted()],
  });
  assert.equal(emittedOnly.verdict, 'unproven');
  assert.equal(emittedOnly.stages.persisted.status, 'missing');
  assert.equal(emittedOnly.stages.emitted.status, 'proven');

  const badClock = evaluateWakeProof(proof({ persisted: persisted({ created_at: 'yesterday' }) }));
  assert.deepEqual(badClock.stages.persisted.reasons, ['bad_timestamp']);
  assert.equal(badClock.verdict, 'unproven');
});

test('evaluation is deterministic and does not read the clock', () => {
  const input = proof({
    relay_receipts: [receipt({ received_at: at(2500) }), receipt({ received_at: at(2000) })],
  });
  const snapshot = structuredClone(input);
  const first = evaluateWakeProof(input);
  const second = evaluateWakeProof(input);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(first, second);
  assert.deepEqual(evaluateWakeProof({
    ...input,
    emitted: [...(input.emitted ?? [])].reverse(),
    relay_receipts: [...(input.relay_receipts ?? [])].reverse(),
    host_runs: [...(input.host_runs ?? [])].reverse(),
    read_outcomes: [...(input.read_outcomes ?? [])].reverse(),
  }), first);

  const source = readFileSync(new URL('../src/server/wake-proof.ts', import.meta.url), 'utf8');
  assert.equal(/\bDate\.now\b|\bnew Date\(\s*\)/.test(source), false);

  const ancient = evaluateWakeProof(proof({
    persisted: persisted({ created_at: '1999-01-01T00:00:00.000Z' }),
    emitted: [emitted({ emitted_at: '1999-01-01T00:00:01.000Z' })],
    relay_receipts: [receipt({ received_at: '1999-01-01T00:00:02.000Z' })],
    host_runs: [hostRun({ started_at: '1999-01-01T00:00:03.000Z' })],
    read_outcomes: [readOutcome({ read_at: '1999-01-01T00:00:04.000Z' })],
  }));
  const future = evaluateWakeProof(proof({
    persisted: persisted({ created_at: '2099-01-01T00:00:00.000Z' }),
    emitted: [emitted({ emitted_at: '2099-01-01T00:00:01.000Z' })],
    relay_receipts: [receipt({ received_at: '2099-01-01T00:00:02.000Z' })],
    host_runs: [hostRun({ started_at: '2099-01-01T00:00:03.000Z' })],
    read_outcomes: [readOutcome({ read_at: '2099-01-01T00:00:04.000Z' })],
  }));
  assert.equal(ancient.verdict, 'proven');
  assert.equal(future.verdict, 'proven');
  assert.equal(ancient.stages.read_outcome.status, 'proven');
});
