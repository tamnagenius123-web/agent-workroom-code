import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from 'miniflare';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { Workroom } from '../src/server/domain.ts';
import {
  STALE_CLAIM_THRESHOLD_MS, listStaleClaims, verifierQueue, type ClaimRow, type VerificationRow,
} from '../src/server/claim-views.ts';
import { claimViewsRoute, type StaleClaimsData, type VerifierQueueData } from '../src/server/claim-views-route.ts';

const MIN = 60_000;
const NOW = Date.parse('2026-10-27T06:00:00.000Z');

function claim(over: Partial<ClaimRow> & Pick<ClaimRow, 'unit_id' | 'claimed_at_ms'>): ClaimRow {
  return { assignee: 'agent:grok', state: 'in_progress', ...over };
}

test('fixture stale 41 min listed', () => {
  assert.equal(STALE_CLAIM_THRESHOLD_MS, 30 * MIN);
  const rows: ClaimRow[] = [
    claim({ unit_id: 'unit-stale-41', assignee: 'agent:grok', claimed_at_ms: NOW - 41 * MIN }),
    claim({ unit_id: 'unit-fresh-10', assignee: 'agent:dots', claimed_at_ms: NOW - 10 * MIN }),
    claim({ unit_id: 'unit-exact-30', assignee: 'agent:muse', claimed_at_ms: NOW - 30 * MIN }),
    claim({ unit_id: 'unit-claimed-45', assignee: 'agent:claude', state: 'claimed', claimed_at_ms: NOW - 45 * MIN }),
    claim({ unit_id: 'unit-open', assignee: 'agent:muse', state: 'open', claimed_at_ms: NOW - 90 * MIN }),
    claim({ unit_id: 'unit-unowned', assignee: null, claimed_at_ms: NOW - 80 * MIN }),
  ];
  const stale = listStaleClaims(rows, NOW);
  const hit = stale.find(row => row.unit_id === 'unit-stale-41');
  assert.ok(hit, 'fixture stale 41 min listed');
  assert.equal(hit.assignee, 'agent:grok');
  assert.equal(hit.claimed_at, new Date(NOW - 41 * MIN).toISOString());
  assert.equal(hit.age_minutes, 41);
  assert.deepEqual(stale.map(row => row.unit_id), ['unit-claimed-45', 'unit-stale-41']);
  assert.equal(stale.some(row => row.unit_id === 'unit-fresh-10'), false);
  assert.equal(stale.some(row => row.unit_id === 'unit-exact-30'), false);
  const lowered = listStaleClaims(rows, NOW, 5 * MIN);
  assert.equal(lowered.some(row => row.unit_id === 'unit-fresh-10'), true);
});

test('verifier queue groups by verifier oldest first and flags worker equals verifier', () => {
  const rows: VerificationRow[] = [
    { unit_id: 'u-new', state: 'review', worker_principal: 'agent:grok', verifier_principal: 'agent:muse', awaiting_since_ms: NOW - 5 * MIN },
    { unit_id: 'u-old', state: 'review', worker_principal: 'agent:dots', verifier_principal: 'agent:muse', awaiting_since_ms: NOW - 50 * MIN },
    { unit_id: 'u-other', state: 'awaiting_verification', worker_principal: 'agent:grok', verifier_principal: 'agent:claude', awaiting_since_ms: NOW - 20 * MIN },
    { unit_id: 'u-self', state: 'review', worker_principal: 'agent:grok', verifier_principal: 'agent:grok', awaiting_since_ms: NOW - 80 * MIN },
    { unit_id: 'u-done', state: 'done', worker_principal: 'agent:dots', verifier_principal: 'agent:muse', awaiting_since_ms: NOW - 100 * MIN },
    { unit_id: 'u-done-self', state: 'done', worker_principal: 'agent:grok', verifier_principal: 'agent:grok', awaiting_since_ms: NOW - 120 * MIN },
  ];
  const queue = verifierQueue(rows);
  assert.deepEqual(queue.groups.map(group => group.verifier), ['agent:muse', 'agent:claude']);
  assert.deepEqual(queue.groups[0]?.units.map(unit => unit.unit_id), ['u-old', 'u-new']);
  assert.equal(queue.groups[0]?.units[0]?.awaiting_since, new Date(NOW - 50 * MIN).toISOString());
  assert.equal(queue.groups[0]?.units[0]?.worker_principal, 'agent:dots');
  assert.deepEqual(queue.groups[1]?.units.map(unit => unit.unit_id), ['u-other']);
  assert.deepEqual(queue.flagged.map(row => row.unit_id), ['u-self']);
  assert.equal(queue.flagged[0]?.flag, 'worker_equals_verifier');
  assert.equal(queue.flagged[0]?.worker_principal, 'agent:grok');
  assert.equal(queue.flagged[0]?.verifier_principal, 'agent:grok');
  const valid = queue.groups.flatMap(group => group.units.map(unit => unit.unit_id));
  assert.equal(valid.includes('u-self'), false);
  assert.equal(valid.includes('u-done'), false);
  assert.equal(valid.includes('u-done-self'), false);
});

async function applyThroughG3(db: Database): Promise<void> {
  for (const name of ['0001_g1.sql', '0002_g2.sql', '0003_g3.sql']) {
    const sql = await readFile('migrations/' + name, 'utf8');
    const statements = sql.trim().split(/;\s*\n/).filter(part => part.trim()).map(part => db.prepare(part));
    await db.batch(statements);
  }
}

async function sql(db: Database, text: string, ...args: (string | number | null)[]): Promise<void> {
  await db.prepare(text).bind(...args).all();
}

function requireStale(value: { data: StaleClaimsData | VerifierQueueData } | null): StaleClaimsData {
  if (!value || !('claims' in value.data)) throw new Error('stale claims view missing');
  return value.data;
}

function requireQueue(value: { data: StaleClaimsData | VerifierQueueData } | null): VerifierQueueData {
  if (!value || !('groups' in value.data)) throw new Error('verifier queue view missing');
  return value.data;
}

test('REST reads stale claims and the verifier queue from task rows', async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'uxa09-' + crypto.randomUUID() },
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  try {
    await mf.ready;
    const db = await mf.getD1Database('DB') as Database;
    await applyThroughG3(db);
    const spec = JSON.stringify({ goal: 'g', owner: null, dependencies: [], input_versions: [], done_conditions: ['ok'] });
    const started = Date.now();
    const claimed41 = started - 41 * MIN;
    const claimed10 = started - 10 * MIN;
    for (const id of ['synthetic:alpha', 'synthetic:beta', 'synthetic:human', 'synthetic:muse', 'synthetic:outsider']) {
      await sql(db, 'INSERT INTO principals(id) VALUES (?)', id);
    }
    await sql(db, "INSERT INTO rooms(id) VALUES ('room_main')");
    for (const id of ['synthetic:alpha', 'synthetic:beta', 'synthetic:human', 'synthetic:muse']) {
      await sql(db, 'INSERT INTO memberships(principal_id, room_id, can_post) VALUES (?, ?, 1)', id, 'room_main');
    }
    await sql(db, "INSERT INTO principal_roles(principal_id, kind) VALUES ('synthetic:alpha', 'agent')");
    await sql(db, "INSERT INTO principal_roles(principal_id, kind) VALUES ('synthetic:beta', 'agent')");
    await sql(db, "INSERT INTO principal_roles(principal_id, kind) VALUES ('synthetic:human', 'user')");
    await sql(db, "INSERT INTO principal_roles(principal_id, kind) VALUES ('synthetic:muse', 'user')");
    await sql(db, `INSERT INTO tasks(id, room_id, creator_id, owner_id, spec_json, state, version, current_submission_id, cancel_reason, created_at_ms, updated_at_ms)
      VALUES ('unit-stale-41', 'room_main', 'synthetic:alpha', NULL, ?, 'in_progress', 1, NULL, NULL, ?, ?)`, spec, claimed41, started);
    await sql(db, `INSERT INTO task_leases(task_id, holder_id, lease_epoch, expires_at_ms) VALUES ('unit-stale-41', 'synthetic:beta', 1, 0)`);
    await sql(db, `INSERT INTO task_audit(id, principal_id, room_id, operation, target_id, version, created_at)
      VALUES ('audit-41', 'synthetic:beta', 'room_main', 'task.claim', 'unit-stale-41', 2, ?)`, new Date(claimed41).toISOString());
    await sql(db, `INSERT INTO tasks(id, room_id, creator_id, owner_id, spec_json, state, version, current_submission_id, cancel_reason, created_at_ms, updated_at_ms)
      VALUES ('unit-fresh-10', 'room_main', 'synthetic:alpha', NULL, ?, 'in_progress', 1, NULL, NULL, ?, ?)`, spec, claimed10, started);
    await sql(db, `INSERT INTO task_leases(task_id, holder_id, lease_epoch, expires_at_ms) VALUES ('unit-fresh-10', 'synthetic:alpha', 1, 0)`);
    await sql(db, `INSERT INTO task_audit(id, principal_id, room_id, operation, target_id, version, created_at)
      VALUES ('audit-10', 'synthetic:alpha', 'room_main', 'task.claim', 'unit-fresh-10', 2, ?)`, new Date(claimed10).toISOString());

    const service = new Workroom(db, 'synthetic:alpha');
    const staleUrl = new URL('http://127.0.0.1/api/v1/rooms/room_main/claims/stale');
    const stale = requireStale(await claimViewsRoute(service, new Request(staleUrl), staleUrl));
    const claims = stale.claims;
    assert.equal(stale.threshold_ms, STALE_CLAIM_THRESHOLD_MS);
    assert.deepEqual(claims.map(row => row.unit_id), ['unit-stale-41']);
    assert.equal(claims[0]?.assignee, 'synthetic:beta');
    assert.equal(claims[0]?.claimed_at, new Date(claimed41).toISOString());
    assert.equal(claims[0]?.age_minutes, Math.floor((stale.server_time_ms - claimed41) / MIN));
    assert.ok((claims[0]?.age_minutes ?? 0) >= 41);

    await sql(db, `INSERT INTO messages(id, room_id, actor_id, text, format, created_at) VALUES ('msg-old', 'room_main', 'synthetic:alpha', 'old', 'text', ?)`, new Date(started).toISOString());
    await sql(db, `INSERT INTO messages(id, room_id, actor_id, text, format, created_at) VALUES ('msg-new', 'room_main', 'synthetic:alpha', 'new', 'text', ?)`, new Date(started).toISOString());
    await sql(db, `INSERT INTO messages(id, room_id, actor_id, text, format, created_at) VALUES ('msg-self', 'room_main', 'synthetic:human', 'self', 'text', ?)`, new Date(started).toISOString());
    for (const [id, actor, message, submitted] of [
      ['task-old', 'synthetic:alpha', 'msg-old', started - 50 * MIN],
      ['task-new', 'synthetic:alpha', 'msg-new', started - 5 * MIN],
      ['task-self', 'synthetic:human', 'msg-self', started - 80 * MIN],
    ] as const) {
      await sql(db, `INSERT INTO tasks(id, room_id, creator_id, owner_id, spec_json, state, version, current_submission_id, cancel_reason, created_at_ms, updated_at_ms)
        VALUES (?, 'room_main', ?, NULL, ?, 'open', 1, NULL, NULL, ?, ?)`, id, actor, spec, submitted, submitted);
      await sql(db, `INSERT INTO task_leases(task_id, holder_id, lease_epoch, expires_at_ms) VALUES (?, ?, 1, 0)`, id, actor);
      await sql(db, `INSERT INTO task_submissions(id, task_id, actor_id, lease_epoch, artifact_message_id, artifact_revision, disposition, reason, submitted_at_ms)
        VALUES (?, ?, ?, 1, ?, 1, 'review', NULL, ?)`, 'sub-' + id, id, actor, message, submitted);
      await sql(db, `UPDATE tasks SET state = 'review', version = 2, current_submission_id = ?, updated_at_ms = ? WHERE id = ?`, 'sub-' + id, submitted, id);
    }
    const queueUrl = new URL('http://127.0.0.1/api/v1/rooms/room_main/verifier-queue');
    const queue = requireQueue(await claimViewsRoute(service, new Request(queueUrl), queueUrl));
    assert.deepEqual(queue.groups.map(group => group.verifier), ['synthetic:muse', 'synthetic:human']);
    assert.deepEqual(queue.groups[0]?.units.map(unit => unit.unit_id), ['task-self', 'task-old', 'task-new']);
    assert.deepEqual(queue.groups[1]?.units.map(unit => unit.unit_id), ['task-old', 'task-new']);
    assert.equal(queue.groups[1]?.units.some(unit => unit.unit_id === 'task-self'), false);
    assert.deepEqual(queue.flagged.map(row => [row.unit_id, row.worker_principal, row.verifier_principal, row.flag]), [
      ['task-self', 'synthetic:human', 'synthetic:human', 'worker_equals_verifier'],
    ]);
    const tasksUrl = new URL('http://127.0.0.1/api/v1/rooms/room_main/tasks');
    assert.equal(await claimViewsRoute(service, new Request(tasksUrl), tasksUrl), null);
    const posted = new Request(staleUrl, { method: 'POST' });
    await assert.rejects(() => claimViewsRoute(service, posted, staleUrl), (err: unknown) => err instanceof Fault && err.status === 405);
    const outsider = new Workroom(db, 'synthetic:outsider');
    await assert.rejects(() => claimViewsRoute(outsider, new Request(staleUrl), staleUrl), (err: unknown) => err instanceof Fault && err.status === 403);
  } finally {
    await mf.dispose();
  }
});
