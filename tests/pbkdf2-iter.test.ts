import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword, needsRehash, TARGET_ITERATIONS, BLOCK_ITERATIONS } from '../src/auth/password.ts';

// PBKDF2-ITER (owner t783u "네가 직접"): production workerd caps one PBKDF2 call at 100k iterations,
// so new hashes chain 100k blocks to reach the OWASP 2023 PBKDF2-SHA256 target of 600k.
test('PBKDF2-ITER: new hashes use the 600k chained format and verify', async () => {
  assert.equal(TARGET_ITERATIONS, 600_000);
  assert.ok(BLOCK_ITERATIONS <= 100_000);
  const h = await hashPassword('synthetic-pw');
  assert.match(h, /^pbkdf2c-sha256\$600000\$/);
  assert.equal(await verifyPassword('synthetic-pw', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(needsRehash(h), false);
});

test('PBKDF2-ITER: legacy 100k hashes still verify and are flagged for lazy rehash', async () => {
  const legacy = await hashPassword('synthetic-pw', 100_000, 'legacy');
  assert.match(legacy, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await verifyPassword('synthetic-pw', legacy), true);
  assert.equal(needsRehash(legacy), true);
});

test('PBKDF2-ITER: rejects absurd or malformed iteration counts', async () => {
  assert.equal(await verifyPassword('x', 'pbkdf2c-sha256$7000000$AAAA$AAAA'), false);
  assert.equal(await verifyPassword('x', 'pbkdf2c-sha256$150000$AAAA$AAAA'), false, 'not a multiple of the block');
  assert.equal(needsRehash('garbage'), false);
});
