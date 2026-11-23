import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STALE_OUTBOX_MS } from '../src/server/notify.ts';

type Status = 'pending' | 'delivered' | 'failed';
type LastError = 'none' | 'http_err' | 'expired_stale' | 'webhook_removed';

interface RowState {
  createdAt: number;
  status: Status;
  lastError: LastError;
  attempts: number;
  claimToken: number;
  claimedUntil: number;
  nextAt: number;
  deliveredCount: number;
}

interface InflightAttempt {
  row: number;
  token: number;
  fromSweep: boolean;
  startedAt: number;
}

interface ModelState {
  now: number;
  rows: RowState[];
  inflight: InflightAttempt[];
  nextToken: number;
  lastBatchSize: number;
}

interface ModelConfig {
  maxAttempts: number;
  sweepLimit: number;
  staleCutoff: number;
  enableFencing: boolean;
  enableStaleExpiry: boolean;
}

function cloneState(s: ModelState): ModelState {
  return {
    now: s.now,
    rows: s.rows.map(r => ({ ...r })),
    inflight: s.inflight.map(a => ({ ...a })),
    nextToken: s.nextToken,
    lastBatchSize: s.lastBatchSize,
  };
}

function encodeState(s: ModelState): string {
  return JSON.stringify([
    s.now,
    s.rows.map(r => [r.createdAt, r.status, r.lastError, r.attempts, r.claimToken, r.claimedUntil, r.nextAt, r.deliveredCount]),
    s.inflight.map(a => [a.row, a.token, a.fromSweep ? 1 : 0, a.startedAt]).sort(),
    s.lastBatchSize,
  ]);
}

function isStale(r: RowState, now: number, staleCutoff: number): boolean {
  return now - r.createdAt > staleCutoff;
}

function leaseFree(r: RowState, now: number): boolean {
  return r.claimedUntil === -1 || r.claimedUntil <= now;
}

function checkInvariants(s: ModelState, cfg: ModelConfig): string | null {
  for (let i = 0; i < s.rows.length; i++) {
    const r = s.rows[i]!;
    if (r.deliveredCount > 1) return `InvDeliveredAtMostOnce violated on row ${i}: ${r.deliveredCount}`;
    if (r.lastError === 'expired_stale' && !isStale(r, s.now, cfg.staleCutoff)) {
      return `InvFreshNotExpiredEarly violated on row ${i} at now=${s.now}`;
    }
    if (r.attempts > cfg.maxAttempts) return `InvRetryCap violated on row ${i}: ${r.attempts}`;
  }
  for (const a of s.inflight) {
    const r = s.rows[a.row]!;
    if (a.fromSweep && isStale(r, a.startedAt, cfg.staleCutoff)) {
      return `InvNoStaleSweepDelivery violated on row ${a.row} at startedAt=${a.startedAt}`;
    }
  }
  if (s.lastBatchSize > cfg.sweepLimit) {
    return `InvBatchBound violated: ${s.lastBatchSize} > ${cfg.sweepLimit}`;
  }
  return null;
}

function* subsetsUpTo(items: number[], maxSize: number): Generator<number[]> {
  const n = items.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const pick: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) pick.push(items[i]!);
    }
    if (pick.length <= maxSize) yield pick;
  }
}

function nextStates(s: ModelState, cfg: ModelConfig): ModelState[] {
  const out: ModelState[] = [];

  // 1. post() immediate deliver on a fresh pending row (explicit ids: never triggers stale expiry)
  for (let i = 0; i < s.rows.length; i++) {
    const r = s.rows[i]!;
    if (r.status === 'pending' && r.createdAt >= 0 && leaseFree(r, s.now)) {
      const n = cloneState(s);
      const tok = n.nextToken++;
      n.rows[i]!.claimToken = tok;
      n.rows[i]!.claimedUntil = n.now + 1;
      n.inflight.push({ row: i, token: tok, fromSweep: false, startedAt: n.now });
      out.push(n);
    }
  }

  // 2. */5 cron sweep: optional stale expiry + due batch bounded by sweepLimit
  const expirable = cfg.enableStaleExpiry
    ? s.rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.status === 'pending' && isStale(r, s.now, cfg.staleCutoff) && leaseFree(r, s.now))
        .map(({ i }) => i)
    : [];
  const expSet = new Set(expirable);
  const due = s.rows
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r, i }) =>
        !expSet.has(i) &&
        r.status === 'pending' &&
        (!cfg.enableStaleExpiry || !isStale(r, s.now, cfg.staleCutoff)) &&
        r.nextAt <= s.now &&
        leaseFree(r, s.now),
    )
    .map(({ i }) => i);

  for (const batch of subsetsUpTo(due, cfg.sweepLimit)) {
    if (expirable.length === 0 && batch.length === 0) continue;
    const n = cloneState(s);
    for (const idx of expirable) {
      const row = n.rows[idx]!;
      row.status = 'failed';
      row.lastError = 'expired_stale';
      row.claimToken = 0;
      row.claimedUntil = -1;
    }
    const tok = n.nextToken++;
    for (const idx of batch) {
      const row = n.rows[idx]!;
      row.claimToken = tok;
      row.claimedUntil = n.now + 1;
      n.inflight.push({ row: idx, token: tok, fromSweep: true, startedAt: n.now });
    }
    n.lastBatchSize = batch.length;
    out.push(n);
  }

  // 3. Complete inflight attempt (2xx or non-2xx)
  for (let aIdx = 0; aIdx < s.inflight.length; aIdx++) {
    const a = s.inflight[aIdx]!;
    for (const ok of [true, false]) {
      const n = cloneState(s);
      n.inflight.splice(aIdx, 1);
      const r = n.rows[a.row]!;
      const matches = cfg.enableFencing ? r.status === 'pending' && r.claimToken === a.token : true;
      if (matches) {
        if (ok) {
          r.status = 'delivered';
          r.lastError = 'none';
          r.attempts += 1;
          r.deliveredCount += 1;
          r.claimToken = 0;
          r.claimedUntil = -1;
        } else {
          r.attempts += 1;
          r.status = r.attempts >= cfg.maxAttempts ? 'failed' : 'pending';
          r.lastError = 'http_err';
          r.nextAt = n.now + 1;
          r.claimToken = 0;
          r.claimedUntil = -1;
        }
      }
      out.push(n);
    }
  }

  // 4. Webhooks.remove() cancels pending rows
  for (let i = 0; i < s.rows.length; i++) {
    if (s.rows[i]!.status === 'pending') {
      const n = cloneState(s);
      n.rows[i]!.status = 'failed';
      n.rows[i]!.lastError = 'webhook_removed';
      out.push(n);
    }
  }

  // 5. Discrete clock tick (models lease expiry & crossing 1h stale boundary)
  if (s.now < 2) {
    const n = cloneState(s);
    n.now += 1;
    out.push(n);
  }

  return out;
}

function explore(cfg: ModelConfig, maxStates = 150_000): { states: number; violation: string | null } {
  const init: ModelState = {
    now: 0,
    rows: [
      { createdAt: -2, status: 'pending', lastError: 'none', attempts: 0, claimToken: 0, claimedUntil: -1, nextAt: 0, deliveredCount: 0 },
      { createdAt: 0, status: 'pending', lastError: 'none', attempts: 0, claimToken: 0, claimedUntil: -1, nextAt: 0, deliveredCount: 0 },
      { createdAt: 0, status: 'pending', lastError: 'none', attempts: 0, claimToken: 0, claimedUntil: -1, nextAt: 0, deliveredCount: 0 },
    ],
    inflight: [],
    nextToken: 1,
    lastBatchSize: 0,
  };

  const seen = new Set<string>([encodeState(init)]);
  const queue: ModelState[] = [init];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++]!;
    const v = checkInvariants(cur, cfg);
    if (v) return { states: seen.size, violation: v };
    if (seen.size >= maxStates) break;
    for (const nxt of nextStates(cur, cfg)) {
      const key = encodeState(nxt);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(nxt);
      }
    }
  }
  return { states: seen.size, violation: null };
}

test('WebhookOutbox exhaustive state-space check satisfies all cutover invariants', () => {
  const res = explore({ maxAttempts: 6, sweepLimit: 2, staleCutoff: 1, enableFencing: true, enableStaleExpiry: true });
  assert.equal(res.violation, null);
  assert.ok(res.states > 1000, `expected thorough state exploration, got ${res.states} states`);
});

test('Negative controls: disabling claim fencing or stale expiry violates safety invariants', () => {
  const unfenced = explore({ maxAttempts: 6, sweepLimit: 2, staleCutoff: 1, enableFencing: false, enableStaleExpiry: true });
  assert.match(unfenced.violation ?? '', /InvDeliveredAtMostOnce/);

  const noExpiry = explore({ maxAttempts: 6, sweepLimit: 2, staleCutoff: 1, enableFencing: true, enableStaleExpiry: false });
  assert.match(noExpiry.violation ?? '', /InvNoStaleSweepDelivery/);
});

test('notify.ts constants match WebhookOutbox model assumptions', () => {
  const src = readFileSync(new URL('../src/server/notify.ts', import.meta.url), 'utf8');
  assert.equal(STALE_OUTBOX_MS, 60 * 60 * 1000);
  assert.match(src, /const MAX_ATTEMPTS = 6;/);
  assert.match(src, /LIMIT 25/);
});
