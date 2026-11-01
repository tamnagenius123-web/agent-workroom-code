import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ingest, runHook, pending, readLog, recover, verify, canonicalBody, acquireLock, assertOwner, fencedAppend, releaseLock, LockLost, type Entry } from '../src/wake-listener/listener.ts';

const S = 'synthetic-test-secret', NOW = 1_800_000_000;
const sign = (ts: string, body: string) => 'sha256=' + createHmac('sha256', S).update(ts + '.' + body, 'utf8').digest('hex');
const dlv = (id: string, body = JSON.stringify({ type: 'message.mention', message: { id: 'm-' + id, text: '한글 🙂 "q" \\ \n' } }), ts = String(NOW)) => ({ delivery_id: id, ts, signature: sign(ts, body), body });
const dir = () => mkdtempSync(join(tmpdir(), 'wl-'));
const lines = (d: string) => readFileSync(join(d, 'deliveries.jsonl'), 'utf8').split('\n').filter(Boolean);

test('① invalid signature does not poison seen IDs; later valid same id is accepted', () => {
  const d = dir(), good = dlv('d1');
  assert.equal(ingest(d, S, { ...good, signature: 'sha256=' + '0'.repeat(64) }, NOW), 'rejected');
  assert.equal(ingest(d, S, good, NOW), 'accepted');
  assert.deepEqual(readLog(join(d, 'deliveries.jsonl')).map(e => e.delivery_id), ['d1']);
  const woke: Entry[][] = []; runHook(d, b => woke.push(b)); assert.equal(woke[0]?.length, 1);
});

test('② torn tail after crash: first resend is recorded, not glued to the fragment', () => {
  const d = dir(); ingest(d, S, dlv('d0'), NOW);
  appendFileSync(join(d, 'deliveries.jsonl'), '{"delivery_id":"d1","rec'); // crash mid-append, no newline
  assert.equal(ingest(d, S, dlv('d1'), NOW), 'accepted');
  assert.deepEqual(readLog(join(d, 'deliveries.jsonl')).map(e => e.delivery_id), ['d0', 'd1']);
  assert.equal(ingest(d, S, dlv('d1'), NOW), 'duplicate');
});

test('③ crash between WAKE and state write re-wakes (at-least-once), never silently lost', () => {
  const d = dir(); ingest(d, S, dlv('d1'), NOW);
  assert.throws(() => runHook(d, () => { throw new Error('crash during wake'); }));
  assert.equal(pending(d).length, 1, 'state not committed before wake');
  let n = 0; runHook(d, b => { n = b.length; }); assert.equal(n, 1);
  assert.equal(runHook(d, () => assert.fail('no double wake after commit')), 0);
});

test('④ checkpoint absent from log (log reset): all unprocessed entries pending, not latest-1', () => {
  const d = dir(); writeFileSync(join(d, 'state.json'), JSON.stringify({ processed: ['gone-1'], watermark: 7 }));
  for (const id of ['a', 'b', 'c']) ingest(d, S, dlv(id), NOW);
  const got: string[] = []; runHook(d, b => got.push(...b.map(e => e.delivery_id))); assert.deepEqual(got, ['a', 'b', 'c']);
});

test('④b no state file at all: every entry pending', () => {
  const d = dir(); for (const id of ['x', 'y']) ingest(d, S, dlv(id), NOW); assert.equal(pending(d).length, 2);
});

test('⑤ concurrent listeners: dedup is atomic across processes', async () => {
  const d = dir(), b = dlv('z').body, ts = String(NOW), run = promisify(execFile);
  writeFileSync(join(d, 'deliveries.jsonl'), Array.from({ length: 30000 }, (_, i) => JSON.stringify({ delivery_id: 'seed-' + i, received_at: 0, body: '{}' })).join('\n') + '\n');
  const startAt = String(Date.now() + 2500);
  const outs = await Promise.all([0, 1, 2, 3].map(() => run(process.execPath, ['--import', 'tsx', 'tests/wake-listener-worker.mts', d, S, ts, sign(ts, b), b, '15', startAt])));
  assert.equal(outs.reduce((a, o) => a + Number(o.stdout), 0), 15);
  const ids = lines(d).map(l => JSON.parse(l).delivery_id).filter(i => i.startsWith('d-race-')); assert.equal(ids.length, 15); assert.equal(new Set(ids).size, 15);
});

test('byte contract: raw body verified; canonicalBody(JSON.parse(body)) equals sender bytes; other encodings rejected', () => {
  const g = dlv('c');
  assert.ok(verify(S, g, NOW));
  assert.equal(canonicalBody(JSON.parse(g.body)), g.body);
  assert.ok(!verify(S, { ...g, body: JSON.stringify(JSON.parse(g.body), null, 2) }, NOW));
  assert.ok(!verify(S, { ...g, body: g.body.replace('한', '\\ud55c') }, NOW));
  assert.ok(!verify(S, dlv('w', undefined, String(NOW - 301)), NOW));
  assert.ok(verify(S, dlv('w', undefined, String(NOW - 300)), NOW));
});

test('durable re-fetch recovery: fills gaps from source, resumes from cursor, no dup with live delivery', () => {
  const d = dir(); ingest(d, S, dlv('live-1'), NOW, { message_id: 'm2' });
  const pages: Record<string, { items: { message_id: string; created_at: string; body: string }[]; next: string | null }> = {
    start: { items: [{ message_id: 'm1', created_at: 't1', body: '{}' }, { message_id: 'm2', created_at: 't2', body: '{}' }], next: 'c1' },
    c1: { items: [{ message_id: 'm3', created_at: 't3', body: '{}' }], next: null } };
  assert.equal(recover(d, c => pages[c ?? 'start']!), 2);
  assert.deepEqual(readLog(join(d, 'deliveries.jsonl')).map(e => e.message_id), ['m2', 'm1', 'm3']);
  assert.equal(recover(d, c => (assert.equal(c, 'c1'), { items: pages.c1!.items, next: null })), 0);
  rmSync(d, { recursive: true });
});

test('⑥ stale lock: paused owner resumes after takeover and can neither write nor release the new owner\'s lock', () => {
  const d = mkdtempSync(join(tmpdir(), 'wl-stale-')), log = join(d, 'deliveries.jsonl');
  const tA = acquireLock(d);                                              // A holds the lock, then "pauses" past staleMs
  const tB = acquireLock(d, { staleMs: 10_000, now: () => Date.now() + 10_001 }); // deterministic clock: B sees A as stale and takes over
  assert.notEqual(tA, tB);
  assert.throws(() => assertOwner(d, tA), LockLost);                     // A resumes: fencing rejects it
  assert.throws(() => fencedAppend(d, tA, log, 'A\n'), LockLost);        // ...so A's write never lands
  assert.equal(releaseLock(d, tA), false);                               // ...and A's finally does not delete B's lock
  assert.doesNotThrow(() => assertOwner(d, tB));
  fencedAppend(d, tB, log, 'B\n');
  assert.equal(readFileSync(log, 'utf8'), 'B\n');
  assert.equal(releaseLock(d, tB), true);
  const tC = acquireLock(d, { staleMs: 10_000 });                        // fresh lock is acquirable with no clock skew needed
  assert.equal(releaseLock(d, tC), true);
});

test('⑦ fencing outrun (Dots bb9f6032): a late duplicate line after assertOwner yields exactly one accepted and one wake per delivery_id', () => {
  const d = dir(), x = dlv('race-1');
  const lateB = () => appendFileSync(join(d, 'deliveries.jsonl'), JSON.stringify({ delivery_id: 'race-1', received_at: NOW, body: x.body, n: 'B' }) + '\n');
  // B's line lands between A's ownership check and A's append (the reproduced interleaving).
  assert.equal(ingest(d, S, x, NOW, {}, { beforeAppend: lateB }), 'duplicate');
  assert.equal(lines(d).length, 2);                                  // raw log may hold the late line...
  assert.deepEqual(readLog(join(d, 'deliveries.jsonl')).map(e => e.n), ['B']); // ...but readers see only the first
  const batches: string[][] = [];
  assert.equal(runHook(d, b => batches.push(b.map(e => e.delivery_id))), 1);
  assert.deepEqual(batches, [['race-1']]);
  assert.equal(ingest(d, S, x, NOW), 'duplicate');
  // Reverse order: A first, then a stale writer's late line: A accepted, late line invisible, still one wake.
  const d2 = dir();
  assert.equal(ingest(d2, S, x, NOW), 'accepted');
  appendFileSync(join(d2, 'deliveries.jsonl'), JSON.stringify({ delivery_id: 'race-1', received_at: NOW, body: x.body, n: 'late' }) + '\n');
  assert.equal(pending(d2).length, 1);
});
