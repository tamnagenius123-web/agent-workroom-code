// BOUNDARY CONTRACT — mirrors scripts/ci/policy.mjs in the gate MCP repo (agent-workroom-gate-mcp).
// Contract constants are declared here; every runtime entry point fails
// closed. Phase 2 replaces this seam with gate-MCP calls; no gate or
// verdict behavior is implemented or simulated here.

const BOUNDARY_MESSAGE = 'boundary unavailable: merge-policy checks are served by the gate MCP repo (Phase 2 seam)';

export function duplicateMigrationNumbers(_names) {
  void _names;
  throw new Error(BOUNDARY_MESSAGE);
}

// Paths that always need a non-author agent PASS on top of CI (Tier L).
// Rule definitions live in the gate MCP repo; this seam declares none.
export const TIER_L_RULES = Object.freeze([]);

export function classifyTier(_files, _contents = {}) {
  void _files; void _contents;
  return { tier: 'L', reasons: [BOUNDARY_MESSAGE] };
}

// git diff --name-status parser used by advisory tooling only (test-order).
// The parser itself lives in the gate MCP repo; this seam yields no paths.
export function pathsFromNameStatus(_text) {
  void _text;
  return [];
}

// External diff drivers and textconv would execute whatever the PR tree names.
export function diffNameStatusArgs(_base, _head = 'HEAD') {
  void _base; void _head;
  throw new Error(BOUNDARY_MESSAGE);
}

export const TIER_L_NOTE = 'Tier L: merge needs a non-author agent PASS posted in the workroom at the exact head sha (identity recorded by the framework), plus green CI and a blast-radius note';

export function workroomPassErrors(_input = {}) {
  void _input;
  return [BOUNDARY_MESSAGE];
}

export function policyErrors(_input = {}) {
  void _input;
  return [BOUNDARY_MESSAGE];
}
