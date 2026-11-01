import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { migrate } from '../scripts/local-harness.ts';
import { cloneD1, D1_TEMPLATE_NAME } from '../scripts/d1-template.ts';
import { sha256Hex } from '../src/server/canonical.ts';
import { Fault } from '../src/server/contracts.ts';
import type { Database } from '../src/server/db.ts';
import { foldReviewQueue } from '../src/server/fold-pack.ts';
import { foldContentDigest, foldView, proposeFold, provenanceOf, reviewFold, reviewFoldEdge, type FoldProposal } from '../src/server/fold.ts';

const ROOM = 'room_main';
const FROM = '2026-10-02T00:00:00.000Z';
const AT = '2026-10-03T00:00:00.000Z';

function iso(ms: number): string {
  return new Date(Date.UTC(2026, 9, 1, 0, 0, 0, ms)).toISOString();
}

async function start(): Promise<{ db: Database; close: () => Promise<void> }> {
  const d1 = await cloneD1(25);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response(null, { status: 204 }); } }',
    compatibilityDate: '2026-07-28',
    d1Databases: { DB: D1_TEMPLATE_NAME }, d1Persist: d1.dir,
    cf: false,
  } as ConstructorParameters<typeof Miniflare>[0]);
  try {
  await mf.ready;
  const db = await mf.getD1Database('DB') as Database;
  await migrate(db, 25);
  await db.batch([
    db.prepare("INSERT INTO rooms(id) VALUES ('room_main')"),
    db.prepare("INSERT INTO rooms(id) VALUES ('room_other')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:grok')"),
    db.prepare("INSERT INTO principals(id) VALUES ('agent:dots')"),
    db.prepare("INSERT INTO memory_reviewers(principal_id, added_at) VALUES ('agent:dots', '2026-10-22T00:00:00.000Z')"),
  ]);
  return { db, close: () => mf.dispose().then(d1.cleanup) };
  } catch (err) { await mf.dispose(); d1.cleanup(); throw err; }
}

async function say(db: Database, id: string, text: string, createdAt: string): Promise<void> {
  await db.prepare('INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES (?,?,?,?,?,?)')
    .bind(id, ROOM, 'agent:grok', text, 'text', createdAt).all();
}

async function roomMessages(db: Database, n: number, textFor: (i: number) => string = i => `body ${i}`): Promise<void> {
  for (let i = 1; i <= n; i += 1) await say(db, `m${i}`, textFor(i), iso(i));
}

async function approveFold(db: Database, proposed: FoldProposal): Promise<void> {
  for (const edge of proposed.edges) {
    await reviewFoldEdge(db, 'agent:dots', ROOM, edge.id, 'approve', 'Recorded.', edge.content_digest);
  }
  await reviewFold(db, 'agent:dots', ROOM, proposed.fold.id, 'approve', 'Recorded.', proposed.content_digest);
}

test('a rollup stores child digests, refuses a pending child or a cycle, and approves edges first', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    const left = await proposeFold(db, 'agent:grok', { id: 'fold-a', room_id: ROOM, summary: 'Span one.', valid_from: FROM, message_ids: ['m1'] });
    const right = await proposeFold(db, 'agent:grok', { id: 'fold-b', room_id: ROOM, summary: 'Span two.', valid_from: FROM, message_ids: ['m2'] });
    await approveFold(db, left);
    await approveFold(db, right);
    const pending = await proposeFold(db, 'agent:grok', { id: 'fold-c', room_id: ROOM, summary: 'Still pending.', valid_from: FROM, message_ids: ['m3'] });
    const beforeRefuse = await foldReviewQueue(db, ROOM);
    await assert.rejects(
      () => proposeFold(db, 'agent:grok', { id: 'fold-bad', room_id: ROOM, summary: 'Nope.', valid_from: FROM, child_fold_ids: ['fold-a', pending.fold.id] }),
      (err: unknown) => err instanceof Fault && /not an approved open fold/.test(err.message),
    );
    assert.deepEqual(await foldReviewQueue(db, ROOM), beforeRefuse);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM memory_folds WHERE id=?').bind('fold-bad').first<{ n: number }>().then(row => Number(row?.n ?? 0)), 0);

    const queued = await foldReviewQueue(db, ROOM);
    const parent = await proposeFold(db, 'agent:grok', {
      id: 'fold-parent', room_id: ROOM, summary: 'Rollup of the two spans.', valid_from: FROM, child_fold_ids: ['fold-b', 'fold-a'],
    });
    assert.equal(parent.sources.length, 0);
    assert.equal(parent.edges.length, 2);
    assert.deepEqual(parent.edges.map(edge => edge.type), ['FOLDED_FROM', 'FOLDED_FROM']);
    assert.deepEqual(parent.edges.map(edge => edge.dst_id).sort(), ['fold-a', 'fold-b']);
    const childKey = [...parent.edges].map(edge => [edge.dst_id, edge.dst_id === 'fold-a' ? left.fold.content_digest : right.fold.content_digest]).sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
    const digest = await foldContentDigest({
      id: parent.fold.id, room_id: ROOM, summary: parent.fold.summary,
      first_message_id: parent.fold.first_message_id, last_message_id: parent.fold.last_message_id,
      span_from: parent.fold.span_from, span_to: parent.fold.span_to, valid_from: parent.fold.valid_from,
      sources: [],
      children: childKey.map(([id, content]) => ({ child_fold_id: id ?? '', child_content_digest: content ?? '' })),
    });
    assert.equal(parent.content_digest, digest);
    assert.equal((await foldReviewQueue(db, ROOM)).pending_folds, queued.pending_folds + 1 + parent.edges.length);
    const parentSources = await db.prepare('SELECT count(*) AS n FROM fold_sources WHERE fold_id=?').bind('fold-parent').first<{ n: number }>();
    assert.equal(Number(parentSources?.n ?? 0), 0);

    const reviewsBefore = Number((await db.prepare('SELECT count(*) AS n FROM memory_reviews WHERE target_id=?').bind('fold-parent').first<{ n: number }>())?.n ?? 0);
    await assert.rejects(
      () => reviewFold(db, 'agent:dots', ROOM, 'fold-parent', 'approve', 'Too soon.', parent.content_digest),
      (err: unknown) => err instanceof Fault && /FOLDED_FROM/.test(err.message),
    );
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM memory_reviews WHERE target_id=?').bind('fold-parent').first<{ n: number }>())?.n ?? 0), reviewsBefore);
    assert.equal((await db.prepare('SELECT review_state FROM memory_folds WHERE id=?').bind('fold-parent').first<{ review_state: string }>())?.review_state, 'pending');

    await approveFold(db, parent);
    for (const child of [left, right]) {
      const row = await db.prepare('SELECT summary, review_state FROM memory_folds WHERE id=?').bind(child.fold.id).first<{ summary: string; review_state: string }>();
      assert.equal(row?.review_state, 'approved');
      assert.equal(row?.summary, child.fold.summary);
    }
    const view = await foldView(db, ROOM, { at: AT });
    const seen = view.folds.find(fold => fold.id === 'fold-parent');
    assert.ok(seen);
    assert.equal(seen.sources.length, 0);
    assert.equal(seen.truncated_lineage, false);
    assert.deepEqual(seen.lineage, ['fold-parent', 'fold-a', 'fold-b']);
    assert.deepEqual(seen.descendant_sources.map(source => source.message_id), ['m1', 'm2']);
    assert.deepEqual(seen.descendant_sources.map(source => source.source_hash), [await sha256Hex('body 1'), await sha256Hex('body 2')]);
    assert.deepEqual(seen.descendant_sources.map(source => source.effective_provenance), ['resolvable', 'resolvable']);

    const foldsBefore = Number((await db.prepare('SELECT count(*) AS n FROM memory_folds').first<{ n: number }>())?.n ?? 0);
    await assert.rejects(
      () => proposeFold(db, 'agent:grok', { id: 'fold-a', room_id: ROOM, summary: 'Cycle.', valid_from: FROM, child_fold_ids: ['fold-parent'] }),
      (err: unknown) => err instanceof Fault && /cycle/i.test(err.message),
    );
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM memory_folds').first<{ n: number }>())?.n ?? 0), foldsBefore);
  } finally { await close(); }
});

test('provenance, quarantine, and the default view omit rejected folds', async () => {
  const hash = await sha256Hex('gone');
  assert.equal(await provenanceOf({ historyText: 'hello', storedHash: 'a'.repeat(64), tombstone: { source_hash: await sha256Hex('hello') } }), 'unresolved');
  assert.equal(await provenanceOf({ historyText: null, storedHash: hash, tombstone: { source_hash: hash } }), 'tombstoned');
  assert.equal(await provenanceOf({ historyText: null, storedHash: hash, tombstone: { source_hash: 'b'.repeat(64) } }), 'unresolved');
  assert.equal(await provenanceOf({ historyText: null, storedHash: hash, tombstone: null }), 'unresolved');

  const { db, close } = await start();
  try {
    const created = iso(1);
    await say(db, 'm1', 'plain body', created);
    const seq = Number((await db.prepare('SELECT seq FROM messages WHERE id=?').bind('m1').first<{ seq: number }>())?.seq);
    await db.prepare(`INSERT INTO memory_folds(id, room_id, summary, first_message_id, last_message_id, span_from, span_to, proposed_by, review_state, valid_from, valid_until, content_digest, created_at)
      VALUES ('fold-bad','room_main','clean summary','m1','m1',?,?, 'agent:grok','pending',?,NULL,?,?)`)
      .bind(created, created, FROM, 'ab'.repeat(32), FROM).all();
    await db.prepare(`INSERT INTO fold_sources(fold_id, message_id, source_version, source_hash, source_seq, source_created_at, provenance_state)
      VALUES ('fold-bad','m1',1,?,?,?,'resolvable')`).bind('cd'.repeat(32), seq, created).all();

    for (let i = 2; i <= 25; i += 1) await say(db, `m${i}`, i === 5 ? 'sk-ant-secret' : `body ${i}`, iso(i));
    const pending = await proposeFold(db, 'agent:grok', { id: 'fold-pend', room_id: ROOM, summary: 'Pending span.', valid_from: FROM, message_ids: ['m2'] });
    const kept = await proposeFold(db, 'agent:grok', { id: 'fold-keep', room_id: ROOM, summary: 'Kept span.', valid_from: FROM, message_ids: ['m3'] });
    const dropped = await proposeFold(db, 'agent:grok', { id: 'fold-drop', room_id: ROOM, summary: 'Dropped span.', valid_from: FROM, message_ids: ['m4'] });
    const secret = await proposeFold(db, 'agent:grok', { id: 'fold-secret', room_id: ROOM, summary: 'A clean summary of the span.', valid_from: FROM, message_ids: ['m5'] });
    await approveFold(db, kept);
    await reviewFold(db, 'agent:dots', ROOM, dropped.fold.id, 'reject', 'No.', dropped.content_digest);
    await approveFold(db, secret);

    const pendingView = await foldView(db, ROOM, { at: AT, includePending: true });
    const bad = pendingView.folds.find(fold => fold.id === 'fold-bad');
    assert.ok(bad);
    assert.equal(bad.sources[0]?.message_id, 'm1');
    assert.equal(bad.sources[0]?.effective_provenance, 'unresolved');
    assert.equal(JSON.stringify(bad).includes('plain body'), false);

    const def = await foldView(db, ROOM, { at: AT });
    assert.deepEqual(def.folds.map(fold => fold.id).sort(), ['fold-keep', 'fold-secret']);
    const withPending = pendingView.folds.map(fold => fold.id).sort();
    assert.deepEqual(withPending, ['fold-bad', 'fold-keep', 'fold-pend', 'fold-secret']);
    assert.equal(withPending.includes(dropped.fold.id), false);
    assert.equal(def.folds.some(fold => fold.id === pending.fold.id), false);

    const quarantined = def.folds.find(fold => fold.id === 'fold-secret');
    assert.ok(quarantined);
    assert.equal(quarantined.sources[0]?.secret_quarantine, true);
    assert.equal(quarantined.descendant_sources[0]?.message_id, 'm5');
    assert.equal('text' in (quarantined.sources[0] ?? {}), false);
    assert.equal(JSON.stringify(def).includes('sk-ant-secret'), false);
  } finally { await close(); }
});

test('lineage deeper than the depth-4 walk sets truncated_lineage', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 21);
    let current = await proposeFold(db, 'agent:grok', { id: 'span-s', room_id: ROOM, summary: 'The span.', valid_from: FROM, message_ids: ['m1'] });
    await approveFold(db, current);
    for (let depth = 1; depth <= 5; depth += 1) {
      const id = `roll-${depth}`;
      current = await proposeFold(db, 'agent:grok', { id, room_id: ROOM, summary: `Roll ${depth}.`, valid_from: FROM, child_fold_ids: [current.fold.id] });
      await approveFold(db, current);
    }
    const view = await foldView(db, ROOM, { at: AT });
    const top = view.folds.find(fold => fold.id === 'roll-5');
    assert.ok(top);
    assert.equal(top.truncated_lineage, true);
    assert.deepEqual(top.lineage, ['roll-5', 'roll-4', 'roll-3', 'roll-2', 'roll-1']);
    assert.equal(top.lineage.includes('span-s'), false);
  } finally { await close(); }
});

test('HOLD P1: a child closed between read and write stores no rollup and no edges', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    const left = await proposeFold(db, 'agent:grok', { id: 'fold-a', room_id: ROOM, summary: 'Left.', valid_from: FROM, message_ids: ['m1', 'm2'] });
    const right = await proposeFold(db, 'agent:grok', { id: 'fold-b', room_id: ROOM, summary: 'Right.', valid_from: FROM, message_ids: ['m3', 'm4'] });
    await approveFold(db, left);
    await approveFold(db, right);
    const folds = await db.prepare('SELECT count(*) AS n FROM memory_folds').first<{ n: number }>();
    const edges = await db.prepare('SELECT count(*) AS n FROM fold_edges').first<{ n: number }>();
    let fired = false;
    const raced = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'batch') {
          return async (statements: Parameters<Database['batch']>[0]) => {
            if (!fired) {
              fired = true;
              const next = await proposeFold(target, 'agent:grok', { id: 'fold-c', room_id: ROOM, summary: 'Replaces right.', valid_from: '2026-10-03T00:00:00.000Z', message_ids: ['m5'], supersedes: 'fold-b' });
              await reviewFold(target, 'agent:dots', ROOM, 'fold-c', 'approve', 'Recorded.', next.content_digest);
              const edge = next.edges.find(item => item.type === 'SUPERSEDED_BY')!;
              await reviewFoldEdge(target, 'agent:dots', ROOM, edge.id, 'approve', 'Close it.', edge.content_digest);
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await assert.rejects(() => proposeFold(raced, 'agent:grok', {
      id: 'fold-parent', room_id: ROOM, summary: 'Rollup.', valid_from: FROM, child_fold_ids: ['fold-a', 'fold-b'],
    }), (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT' && /source or child changed/.test(err.message));
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM memory_folds').first<{ n: number }>())?.n), Number(folds?.n) + 1);
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM fold_edges').first<{ n: number }>())?.n), Number(edges?.n) + 1);
    assert.equal(await db.prepare("SELECT 1 FROM memory_folds WHERE id='fold-parent'").first(), null);
  } finally { await close(); }
});

test('same-child rollup replacement: an armed edge closes the old rollup when the replacement is approved (HOLD d0792c2)', async () => {
  const { db, close } = await start();
  try {
    await roomMessages(db, 25);
    const left = await proposeFold(db, 'agent:grok', { id: 'fold-a', room_id: ROOM, summary: 'Span one.', valid_from: FROM, message_ids: ['m1'] });
    const right = await proposeFold(db, 'agent:grok', { id: 'fold-b', room_id: ROOM, summary: 'Span two.', valid_from: FROM, message_ids: ['m2'] });
    await approveFold(db, left);
    await approveFold(db, right);
    const oldRollup = await proposeFold(db, 'agent:grok', { id: 'roll-old', room_id: ROOM, summary: 'Old rollup.', valid_from: FROM, child_fold_ids: ['fold-a', 'fold-b'] });
    await approveFold(db, oldRollup);
    const neu = await proposeFold(db, 'agent:grok', {
      id: 'roll-new', room_id: ROOM, summary: 'New rollup.', valid_from: AT, child_fold_ids: ['fold-a', 'fold-b'], supersedes: 'roll-old',
    });
    for (const edge of neu.edges.filter(item => item.type === 'FOLDED_FROM')) {
      await reviewFoldEdge(db, 'agent:dots', ROOM, edge.id, 'approve', 'Recorded.', edge.content_digest);
    }
    const before = Number((await db.prepare('SELECT count(*) AS n FROM memory_reviews WHERE target_id=?').bind('roll-new').first<{ n: number }>())?.n ?? 0);
    await assert.rejects(() => reviewFold(db, 'agent:dots', ROOM, 'roll-new', 'approve', 'Too early.', neu.content_digest),
      (err: unknown) => err instanceof Fault && err.code === 'INVALID_INPUT');
    assert.equal(Number((await db.prepare('SELECT count(*) AS n FROM memory_reviews WHERE target_id=?').bind('roll-new').first<{ n: number }>())?.n ?? 0), before);

    const sup = neu.edges.find(item => item.type === 'SUPERSEDED_BY');
    assert.ok(sup);
    await reviewFoldEdge(db, 'agent:dots', ROOM, sup.id, 'approve', 'Arm.', sup.content_digest);
    assert.equal((await db.prepare('SELECT valid_until FROM memory_folds WHERE id=?').bind('roll-old').first<{ valid_until: string | null }>())?.valid_until, null);
    await reviewFold(db, 'agent:dots', ROOM, 'roll-new', 'approve', 'Recorded.', neu.content_digest);
    assert.equal((await db.prepare('SELECT valid_until FROM memory_folds WHERE id=?').bind('roll-old').first<{ valid_until: string | null }>())?.valid_until, AT);
    assert.deepEqual((await foldView(db, ROOM, { at: AT })).folds.map(fold => fold.id).sort(), ['fold-a', 'fold-b', 'roll-new']);
    assert.deepEqual((await foldView(db, ROOM, { at: FROM })).folds.map(fold => fold.id).sort(), ['fold-a', 'fold-b', 'roll-old']);
  } finally { await close(); }
});
