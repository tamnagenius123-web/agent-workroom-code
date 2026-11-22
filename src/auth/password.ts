import { b64url, fromB64url, same } from './crypto.ts';

// Owner password hashes (PBKDF2-ITER, owner t783u).
// Production workerd's limit enforcer rejects a single PBKDF2 call above 100000 iterations
// ("Pbkdf2 failed: iteration counts above 100000 are not supported"), so the current format
// chains BLOCK_ITERATIONS-sized PBKDF2-SHA256 calls, feeding each block's output in as the next
// block's password, to reach TARGET_ITERATIONS (OWASP 2023 PBKDF2-HMAC-SHA256 guidance: 600000).
//   current: pbkdf2c-sha256$<total iterations>$<salt b64url>$<hash b64url>
//   legacy:  pbkdf2-sha256$<iterations <= 100000>$<salt b64url>$<hash b64url>  (verify only; lazily rehashed)
export const BLOCK_ITERATIONS = 100_000;
export const TARGET_ITERATIONS = 600_000;
const MAX_ITERATIONS = 1_200_000;
export const ITERATIONS = BLOCK_ITERATIONS;

async function derive(password: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function chained(password: string, salt: Uint8Array<ArrayBuffer>, total: number): Promise<string> {
  let out = new TextEncoder().encode(password) as Uint8Array<ArrayBuffer>;
  for (let done = 0; done < total; done += BLOCK_ITERATIONS) out = await derive(out, salt, BLOCK_ITERATIONS);
  return b64url(out);
}
async function single(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<string> {
  return b64url(await derive(new TextEncoder().encode(password) as Uint8Array<ArrayBuffer>, salt, iterations));
}

export async function hashPassword(password: string, iterations = TARGET_ITERATIONS, format: 'chained' | 'legacy' = 'chained'): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  if (format === 'legacy' || iterations < BLOCK_ITERATIONS || iterations % BLOCK_ITERATIONS !== 0) return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${await single(password, salt, iterations)}`;
  return `pbkdf2c-sha256$${iterations}$${b64url(salt)}$${await chained(password, salt, iterations)}`;
}

function parse(stored: string): { alg: string; iterations: number; salt: string; hash: string } | null {
  const [alg, it, salt, hash] = stored.split('$');
  const iterations = Number(it);
  if (!salt || !hash || !Number.isSafeInteger(iterations)) return null;
  if (alg === 'pbkdf2-sha256' && iterations >= 10_000 && iterations <= BLOCK_ITERATIONS) return { alg, iterations, salt, hash };
  if (alg === 'pbkdf2c-sha256' && iterations >= BLOCK_ITERATIONS && iterations <= MAX_ITERATIONS && iterations % BLOCK_ITERATIONS === 0) return { alg, iterations, salt, hash };
  return null;
}

export function needsRehash(stored: string): boolean {
  const p = parse(stored);
  return !!p && (p.alg !== 'pbkdf2c-sha256' || p.iterations < TARGET_ITERATIONS);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const p = parse(stored);
  if (!p) return false;
  const run = (pw: string) => p.alg === 'pbkdf2c-sha256' ? chained(pw, fromB64url(p.salt), p.iterations) : single(pw, fromB64url(p.salt), p.iterations);
  if (password.length === 0 || password.length > 1024) { await run('x'); return false; }
  return same(await run(password), p.hash);
}
