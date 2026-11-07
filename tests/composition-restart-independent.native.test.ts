import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness } from '../scripts/local-harness.ts';

type App = Awaited<ReturnType<typeof harness>>;
type Row = Record<string, unknown>;
interface Data extends Row {
  message?: Row;
  item?: Row;
  fold?: Row;
  sources?: Row[];
  folds?: Array<Row & { sources: Row[] }>;
  revisions?: Row[];
}
interface Rpc {
  result?: { isError: boolean; structuredContent?: { ok: boolean; data?: Data } };
}

// Optional evidence capture; the native D1 fixture always uses its own temporary directory.
const evidenceFile = process.env.WORKROOM_RESTART_EVIDENCE_FILE;
const observations: object[] = [];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const versions = ['persisted source original', 'persisted source revision two', 'persisted source revision three'];
const historic = '0096-03-01T00:04:05.006+00:15';
const utcHistoric = '0096-02-29T23:49:05.006Z';
const authorityTables = ['principals', 'memberships', 'principal_roles', 'memory_reviewers', 'memory_reviewer_log', 'memory_reviews'];
const pinTables = ['memory_items', 'memory_edges', 'memory_folds', 'fold_sources', 'fold_edges', 'fold_source_tombstones'];

async function rpc(app: App, name: string, args: object): Promise<Data> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/call', 'Mcp-Name': name,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name, arguments: { schema_version: '1', room: 'room_main', ...args },
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
    } }),
  });
  const reply = await response.json() as Rpc;
  assert.equal(response.status, 200, JSON.stringify(reply));
  assert.equal(reply.result?.isError, false, JSON.stringify(reply));
  assert.equal(reply.result?.structuredContent?.ok, true, JSON.stringify(reply));
  const data = reply.result?.structuredContent?.data;
  assert.ok(data, JSON.stringify(reply));
  return data;
}

async function post(app: App, text: string, key: string): Promise<Row> {
  const response = await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/messages', {
    method: 'POST', headers: { Authorization: 'Bearer local-alpha-fixture', 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ schema_version: '1', text }),
  });
  const reply = await response.json() as { data?: Data };
  assert.equal(response.status, 200, JSON.stringify(reply));
  assert.ok(reply.data?.message);
  return reply.data.message;
}

async function tables(app: App, names: string[]): Promise<Record<string, Row[]>> {
  const state: Record<string, Row[]> = {};
  for (const name of names) {
    const rows: Row[] = (await app.db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all<Row>()).results;
    state[name] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return state;
}

async function pinnedHistory(app: App): Promise<{ item: Row[]; fold: Row[] }> {
  const item = (await app.db.prepare(`SELECT i.id, i.review_state, i.valid_from, i.source_message_id, i.source_version, h.text
    FROM memory_items i JOIN message_history h ON h.message_id=i.source_message_id AND h.version=i.source_version
    ORDER BY i.id`).all<Row>()).results;
  const fold = (await app.db.prepare(`SELECT s.fold_id, s.message_id, s.source_version, s.source_hash, h.text
    FROM fold_sources s JOIN message_history h ON h.message_id=s.message_id AND h.version=s.source_version
    ORDER BY s.fold_id, s.message_id`).all<Row>()).results;
  return { item, fold };
}

test('combined worker restart preserves different memory and fold source revision pins after a subsequent source edit', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'workroom-composition-restart-'));
  let app: App | undefined;
  let outbound = 0;
  let failure: object | undefined;
  const outboundService = () => { outbound++; throw new Error('Independent restart fixture forbids outbound requests'); };
  try {
    app = await harness({ persist, through: 9999, outboundService });
    const authorityBefore = await tables(app, authorityTables);
    const migrationsBefore = await tables(app, ['local_migrations', 'local_fixture_versions']);
    const source = await post(app, versions[0]!, 'independent-restart-source');
    assert.equal(typeof source.id, 'string');
    for (let i = 0; i < 20; i++) await post(app, 'independent restart ordinary tail ' + i, 'independent-restart-tail-' + i);
    const memory = await rpc(app, 'workroom_memory_propose', {
      kind: 'fact', tier: 0, title: 'Independent historical pending fact', body: 'Synthetic pending proposal against original revision.',
      source_message_id: source.id, valid_from: historic,
    });
    assert.equal(memory.item?.valid_from, utcHistoric);
    assert.equal(memory.item?.source_version, 1);
    assert.equal(memory.item?.review_state, 'pending');
    const second = await rpc(app, 'workroom_message_revise', {
      message_id: source.id, expected_version: 1, text: versions[1], idempotency_key: 'independent-restart-edit-two',
    });
    assert.equal(second.message?.version, 2);
    const fold = await rpc(app, 'workroom_fold_propose', {
      id: 'independent-restart-fold', summary: 'Synthetic pending fold against second revision.', valid_from: source.created_at, message_ids: [source.id],
    });
    assert.equal(fold.fold?.review_state, 'pending');
    assert.equal(fold.sources?.length, 1);
    assert.equal(fold.sources?.[0]?.source_version, 2);
    assert.equal(fold.sources?.[0]?.source_hash, hash(versions[1]!));
    const beforePins = await tables(app, pinTables);
    const beforeResolved = await pinnedHistory(app);
    assert.equal(beforeResolved.item.length, 1);
    assert.equal(beforeResolved.item[0]?.text, versions[0]);
    assert.equal(beforeResolved.fold.length, 1);
    assert.equal(beforeResolved.fold[0]?.text, versions[1]);
    const beforeHistory = await rpc(app, 'workroom_message_history', { message_id: source.id, limit: 10 });
    assert.deepEqual(beforeHistory.revisions?.map(row => [row.version, row.text]), [[1, versions[0]], [2, versions[1]]]);
    const beforeView = await rpc(app, 'workroom_fold_view', { at: '2098-01-01T00:00:00Z', include_pending: true });
    observations.push({ stage: 'before_restart', source, memory, second, fold, beforePins, beforeResolved, beforeHistory, beforeView, authorityBefore, migrationsBefore });
    await app.close();
    app = undefined;

    app = await harness({ persist, seed: false, through: 9999, outboundService });
    assert.deepEqual(await tables(app, ['local_migrations', 'local_fixture_versions']), migrationsBefore);
    assert.deepEqual(await tables(app, authorityTables), authorityBefore);
    assert.deepEqual(await tables(app, pinTables), beforePins);
    assert.deepEqual(await pinnedHistory(app), beforeResolved);
    assert.deepEqual(await rpc(app, 'workroom_message_history', { message_id: source.id, limit: 10 }), beforeHistory);
    assert.deepEqual(await rpc(app, 'workroom_fold_view', { at: '2098-01-01T00:00:00Z', include_pending: true }), beforeView);

    const third = await rpc(app, 'workroom_message_revise', {
      message_id: source.id, expected_version: 2, text: versions[2], idempotency_key: 'independent-restart-edit-three',
    });
    assert.equal(third.message?.version, 3);
    const afterHistory = await rpc(app, 'workroom_message_history', { message_id: source.id, limit: 10 });
    assert.deepEqual(afterHistory.revisions?.map(row => [row.version, row.text]), [[1, versions[0]], [2, versions[1]], [3, versions[2]]]);
    const afterView = await rpc(app, 'workroom_fold_view', { at: '2098-01-01T00:00:00Z', include_pending: true });
    assert.deepEqual(afterView, beforeView);
    assert.equal(afterView.folds?.[0]?.sources?.[0]?.effective_provenance, 'resolvable');
    assert.deepEqual(await tables(app, pinTables), beforePins);
    assert.deepEqual(await pinnedHistory(app), beforeResolved);
    assert.deepEqual(await tables(app, authorityTables), authorityBefore);
    const finalHistory = await tables(app, ['message_history', 'message_revisions']);
    observations.push({ stage: 'after_restart_and_third_revision', third, afterHistory, afterView, finalHistory, pins: await tables(app, pinTables), resolved: await pinnedHistory(app), authority: await tables(app, authorityTables) });
    assert.equal(outbound, 0);
  } catch (error) {
    failure = { name: error instanceof Error ? error.name : 'unknown', message: String(error), stack: error instanceof Error ? error.stack : undefined };
    throw error;
  } finally {
    try {
      await app?.close();
      if (evidenceFile) await writeFile(evidenceFile, JSON.stringify({ synthetic_only: true, outbound, failure, observations }, null, 2) + '\n');
    } finally {
      await rm(persist, { recursive: true, force: true });
    }
  }
});
