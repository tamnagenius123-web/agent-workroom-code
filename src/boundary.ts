// Boundary seam for the three-repo split (owner decision D5-cm, 2026-11-01).
//
// This public codebase (agent-workroom-code) was separated from the private
// gate/security MCP repo (agent-workroom-gate-mcp). Modules that live on the
// gate side are present here only as boundary contracts: their types and
// contract constants are declared locally, and every runtime entry point
// fails closed with BoundaryUnavailableError. Phase 2 replaces these seams
// with calls to the gate MCP server; until then no auth, gate, decision, or
// harness behavior is implemented — or simulated — in this repo.

export class BoundaryUnavailableError extends Error {
  readonly code = 'BOUNDARY_UNAVAILABLE' as const;
  constructor(
    readonly boundaryModule: string,
    readonly entryPoint: string,
  ) {
    super(
      `boundary unavailable: ${boundaryModule}#${entryPoint} is served by the gate MCP repo ` +
        '(agent-workroom-gate-mcp) and is not implemented in this repo; ' +
        'Phase 2 wires this seam to the gate MCP server.',
    );
    this.name = 'BoundaryUnavailableError';
  }
}

// Trailing arguments are accepted so stub entry points can pass their own
// (otherwise unused) parameters through; the values are discarded unread and
// are never included in the error.
export function boundaryUnavailable(boundaryModule: string, entryPoint: string, ..._discarded: unknown[]): never {
  void _discarded;
  throw new BoundaryUnavailableError(boundaryModule, entryPoint);
}
