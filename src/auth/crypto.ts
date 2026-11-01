// BOUNDARY CONTRACT — mirrors src/auth/crypto.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; runtime entry points fail closed.
// Phase 2 replaces this seam with gate-MCP calls; do not implement auth behavior here.

import { boundaryUnavailable } from '../boundary.ts';

export function b64url(_bytes: Uint8Array): string {
  return boundaryUnavailable('src/auth/crypto.ts', 'b64url', _bytes);
}

export function fromB64url(_s: string): Uint8Array<ArrayBuffer> {
  return boundaryUnavailable('src/auth/crypto.ts', 'fromB64url', _s);
}

export const random = (_n = 32): string => boundaryUnavailable('src/auth/crypto.ts', 'random', _n);

export async function sha256(_s: string): Promise<string> {
  return boundaryUnavailable('src/auth/crypto.ts', 'sha256', _s);
}

export async function hmac(_key: string, _s: string): Promise<string> {
  return boundaryUnavailable('src/auth/crypto.ts', 'hmac', _key, _s);
}

export function same(_a: string, _b: string): boolean {
  return boundaryUnavailable('src/auth/crypto.ts', 'same', _a, _b);
}
