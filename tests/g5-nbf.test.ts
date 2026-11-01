import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { harness } from '../scripts/local-harness.ts';
import { createConnectionGateway } from '../src/connection/gateway.ts';
import { connectionFixtures } from './support/g4-fixtures.ts';
import type { Database } from '../src/server/db.ts';

// Ported from feat/g5-local-auth-reviewed-9a11de0: optional assertion.not_before_ms, re-checked at completion.
let app: Awaited<ReturnType<typeof harness>>;
beforeEach(async () => { app = await harness(); }); afterEach(async () => { await app.close(); });
async function me(mutate: (a: Record<string, unknown>) => void, clock?: number[]) {
  const f = connectionFixtures(), a = f.assertions.get('g4-alpha-fixture')! as unknown as Record<string, unknown>;
  mutate(a);
  let i = 0;
  const gateway = createConnectionGateway({ ...f.options, now: clock ? () => clock[Math.min(i++, clock.length - 1)]! : f.options.now });
  const r = await gateway.fetch(new Request(new URL('/connection/me', f.resource), { headers: { Authorization: 'Bearer g4-alpha-fixture' } }), { DB: app.db as unknown as Database });
  return { status: r.status, now: f.now };
}
test('G4 assertion without not_before_ms is still accepted (backward compatible)', async () => {
  assert.equal((await me(() => {})).status, 200);
});
test('G4 assertion not_before_ms in the future, before issued_at, or at/after expiry is rejected', async () => {
  const f = connectionFixtures();
  assert.equal((await me(a => { a.not_before_ms = f.now + 1000; })).status, 401);
  assert.equal((await me(a => { a.not_before_ms = (a.issued_at_ms as number) - 1; })).status, 401);
  assert.equal((await me(a => { a.not_before_ms = a.expires_at_ms; })).status, 401);
  assert.equal((await me(a => { a.not_before_ms = a.issued_at_ms; })).status, 200);
});
test('G4 not_before_ms is re-checked at completion when the clock moves backward', async () => {
  const f = connectionFixtures();
  // issued_at=now-1000 stays valid at now-700; only not_before_ms=now-500 rejects the completion-time clock.
  assert.equal((await me(a => { a.not_before_ms = f.now - 500; }, [f.now, f.now, f.now - 700])).status, 401);
  assert.equal((await me(() => {}, [f.now, f.now, f.now - 700])).status, 200, 'same clock without nbf passes');
});
