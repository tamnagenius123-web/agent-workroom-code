// BOUNDARY CONTRACT — mirrors src/connection/policy.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Types and contract constants are declared here; runtime entry points fail closed.
// Phase 2 replaces this seam with gate-MCP calls; do not implement auth behavior here.

import { boundaryUnavailable } from '../boundary.ts';

export const PROTOCOL = '2026-07-28';
export const REQUEST_LIMIT = 49152;
export const RESPONSE_LIMIT = 524288;

export function endpoint(_value: string): URL {
  return boundaryUnavailable('src/connection/policy.ts', 'endpoint', _value);
}

export async function boundedText(_body: ReadableStream<Uint8Array> | null, _limit = REQUEST_LIMIT): Promise<string> {
  return boundaryUnavailable('src/connection/policy.ts', 'boundedText', _body, _limit);
}

export type ProbeTransport = (request: Request) => Promise<Response>;

export function guardedFetch(_resource: string, _transport?: ProbeTransport): typeof fetch {
  return boundaryUnavailable('src/connection/policy.ts', 'guardedFetch', _resource, _transport);
}
