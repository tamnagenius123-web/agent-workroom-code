import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildPresenceReport, parseDeliveriesJsonl, renderPresenceMarkdown,
  type PresenceReport,
} from '../src/presence/index.ts';

const AS_OF = '2026-11-01T00:00:00.000Z';
const FIX = new URL('./fixtures/presence/', import.meta.url);

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
}
function loadText(name: string): string {
  return readFileSync(new URL(name, FIX), 'utf8');
}
function basicReport(): PresenceReport {
  const { entries } = parseDeliveriesJsonl(loadText('deliveries-basic.jsonl'));
  return buildPresenceReport(
    { messages: loadJson('messages-basic.json'), deliveries: entries },
    { asOf: AS_OF, deliveriesAgent: 'agent:muse' },
  );
}
function byAgent(report: PresenceReport, id: string) {
  const row = report.agents.find((a) => a.agent_id === id);
  assert.ok(row, `missing agent row ${id}`);
  return row;
}

test('US1: basic projection — maxima, evidence refs, counts, classes', () => {
  const report = basicReport();
  assert.deepEqual(report.agents.map((a) => a.agent_id), ['agent:claude', 'agent:dots', 'agent:muse']);

  const muse = byAgent(report, 'agent:muse');
  assert.equal(muse.last_message_id, 'm1');
  assert.equal(muse.last_delivery_at, '2026-10-31T23:59:35.000Z');
  assert.equal(muse.last_activity_at, '2026-10-31T23:59:35.000Z');
  assert.deepEqual(muse.evidence, { message_ids: ['m1'], delivery_ids: ['dlv-1'] });
  assert.deepEqual(muse.counts, { messages: 2, deliveries: 2 });
  assert.equal(muse.classification, 'active');
  assert.equal(muse.clock_skew, false);

  const dots = byAgent(report, 'agent:dots');
  assert.equal(dots.last_message_id, 'm3');
  assert.equal(dots.last_delivery_at, '2026-10-31T23:00:04.000Z');
  assert.equal(dots.last_activity_at, '2026-10-31T23:00:04.000Z');
  assert.equal(dots.classification, 'recent');

  const claude = byAgent(report, 'agent:claude');
  assert.equal(claude.last_delivery_at, null);
  assert.equal(claude.last_activity_at, '2026-10-31T10:00:00.000Z');
  assert.equal(claude.classification, 'stale');
  assert.deepEqual(claude.evidence.delivery_ids, []);

  assert.deepEqual(report.inputs, { messages_seen: 4, messages_used: 4, deliveries_seen: 4, deliveries_used: 3 });
  assert.equal(report.omitted.duplicate_deliveries, 1);
  assert.equal(report.omitted.messages_invalid, 0);
  assert.equal(report.clock_skew_detected, false);
  assert.equal(report.as_of, AS_OF);
});

test('US2: envelope basis flags — activity evidence, never wake proof', () => {
  const report = basicReport();
  assert.equal(report.basis, 'activity-evidence');
  assert.equal(report.not_wake_proof, true);
  const keys: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { keys.push(k); walk(val); }
  };
  walk(report);
  assert.deepEqual(keys.filter((k) => /wake/i.test(k)), ['not_wake_proof']);
});

test('US2: markdown rendering carries basis line and NOT wake proof banner', () => {
  const md = renderPresenceMarkdown(basicReport());
  assert.match(md, /activity-evidence/);
  assert.match(md, /NOT wake proof/);
  assert.match(md, /agent:dots/);
  assert.match(md, /agent:muse/);
  assert.ok(md.indexOf('NOT wake proof') < md.indexOf('| agent'), 'banner precedes the table');
});

test('US3: order independence — shuffled messages give identical agents', () => {
  const msgs = loadJson('messages-basic.json') as unknown[];
  const a = buildPresenceReport({ messages: msgs }, { asOf: AS_OF });
  const b = buildPresenceReport({ messages: [...msgs].reverse() }, { asOf: AS_OF });
  assert.deepEqual(b.agents, a.agents);
});

test('US3: edge messages — invalid entries counted, future clamped + skew flagged', () => {
  const report = buildPresenceReport({ messages: loadJson('messages-edge.json') }, { asOf: AS_OF });
  assert.equal(report.inputs.messages_seen, 8);
  assert.equal(report.inputs.messages_used, 3);
  assert.equal(report.omitted.messages_invalid, 5);

  const grok = byAgent(report, 'agent:grok');
  assert.equal(grok.last_message_id, 'e2');
  assert.equal(grok.last_activity_at, '2026-10-31T23:30:00.000Z');
  assert.equal(grok.classification, 'recent');
  assert.equal(grok.clock_skew, false);

  const skewy = byAgent(report, 'agent:skewy');
  assert.equal(skewy.last_activity_at, AS_OF, 'future timestamp clamped to effective now');
  assert.equal(skewy.clock_skew, true);
  assert.equal(skewy.classification, 'active');
  assert.equal(report.omitted.clamped_timestamps, 1);
  assert.equal(report.clock_skew_detected, true);
});

test('US3: JSONL parsing — malformed lines skipped and counted, never thrown', () => {
  const { entries, malformedLines } = parseDeliveriesJsonl(loadText('deliveries-edge.jsonl'));
  assert.equal(malformedLines, 1);
  assert.equal(entries.length, 5);
  assert.deepEqual(parseDeliveriesJsonl(''), { entries: [], malformedLines: 0 });
  assert.deepEqual(parseDeliveriesJsonl('\n\n'), { entries: [], malformedLines: 0 });
});

test('US3: edge deliveries — invalid, duplicate, unattributed counted separately', () => {
  const { entries, malformedLines } = parseDeliveriesJsonl(loadText('deliveries-edge.jsonl'));
  const report = buildPresenceReport(
    { messages: [], deliveries: entries },
    { asOf: AS_OF, deliveryMalformedLines: malformedLines },
  );
  assert.equal(report.inputs.deliveries_seen, 5);
  assert.equal(report.inputs.deliveries_used, 1);
  assert.equal(report.omitted.delivery_lines_malformed, 1);
  assert.equal(report.omitted.deliveries_invalid, 1);
  assert.equal(report.omitted.duplicate_deliveries, 1);
  assert.equal(report.omitted.deliveries_unattributed, 2);

  const dots = byAgent(report, 'agent:dots');
  assert.equal(dots.last_message_id, null, 'deliveries-only agent has no message');
  assert.equal(dots.last_delivery_at, '2026-10-31T22:30:00.000Z');
  assert.deepEqual(dots.evidence.delivery_ids, ['dlv-x2']);
  assert.deepEqual(dots.counts, { messages: 0, deliveries: 1 });
  assert.equal(dots.classification, 'recent');
});

test('US1: deliveries fall back to the listener owner when no agent field', () => {
  const { entries } = parseDeliveriesJsonl(loadText('deliveries-edge.jsonl'));
  const report = buildPresenceReport(
    { messages: loadJson('messages-empty.json'), deliveries: entries },
    { asOf: AS_OF, deliveriesAgent: 'agent:quiet' },
  );
  assert.equal(report.omitted.deliveries_unattributed, 0);
  const quiet = byAgent(report, 'agent:quiet');
  assert.equal(quiet.last_delivery_at, '2026-10-31T22:00:00.000Z');
  assert.deepEqual(quiet.evidence.delivery_ids, ['dlv-x1']);
  assert.deepEqual(quiet.counts, { messages: 0, deliveries: 2 });
});

test('US3: empty and non-array inputs produce an empty report, no throw', () => {
  const empty = buildPresenceReport({ messages: loadJson('messages-empty.json') }, { asOf: AS_OF });
  assert.deepEqual(empty.agents, []);
  assert.deepEqual(empty.inputs, { messages_seen: 0, messages_used: 0, deliveries_seen: 0, deliveries_used: 0 });
  const junk = buildPresenceReport({ messages: null }, { asOf: AS_OF });
  assert.deepEqual(junk.agents, []);
  assert.equal(junk.basis, 'activity-evidence');
});

test('US1: window boundaries — exactly 5 min is active, exactly 2 h is recent', () => {
  const at = (iso: string) => [{ id: 'b1', actor_id: 'agent:b', created_at: iso }];
  const cls = (iso: string, opts = {}) =>
    buildPresenceReport({ messages: at(iso) }, { asOf: AS_OF, ...opts }).agents[0]?.classification;
  assert.equal(cls('2026-10-31T23:55:00.000Z'), 'active');
  assert.equal(cls('2026-10-31T23:54:59.000Z'), 'recent');
  assert.equal(cls('2026-10-31T22:00:00.000Z'), 'recent');
  assert.equal(cls('2026-10-31T21:59:59.000Z'), 'stale');
  assert.equal(cls('2026-10-31T23:58:00.000Z', { activeWithinMs: 60_000 }), 'recent', 'thresholds are configurable');
});

test('US1: no asOf — effective now is the max observed timestamp (deterministic)', () => {
  const report = buildPresenceReport({ messages: loadJson('messages-basic.json') });
  assert.equal(report.as_of, '2026-10-31T23:59:30.000Z');
  assert.equal(byAgent(report, 'agent:muse').classification, 'active');
  assert.equal(report.omitted.clamped_timestamps, 0);
});
