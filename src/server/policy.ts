// BOUNDARY CONTRACT — mirrors src/server/policy.ts in the gate MCP repo (agent-workroom-gate-mcp).
// Boundary contract constant: the AUTH fragment below is contract data, kept
// verbatim. The predicate's semantics are determined by this repo's own
// schema and tests (migrations define principals, memberships, and the
// active flags the fragment reads); the fragment contains no secrets.
// This constant is flagged for owner/dots ratification in the Phase 1
// report; the fail-closed alternative (a match-no-rows fragment) is a
// one-line change recorded in that report. Phase 2 replaces this seam
// with gate-MCP calls; no gate or verdict behavior is implemented or
// simulated here.

export const AUTH = `SELECT 1 FROM principals p JOIN memberships m ON m.principal_id=p.id
  WHERE p.id=? AND p.active=1 AND m.room_id=? AND m.active=1`;
