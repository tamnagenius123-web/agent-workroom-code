// Deterministic filters run before any model call.
// Jev may only see the eligible set. A later answer cannot add someone back.

import { SEED_ROLE_CATALOG, selectRole, selectVerifier, type RoleCatalog } from '../phase-contracts/role-select.ts';
import type { IntentStatus, SourceStatus } from '../phase-contracts/freshness.ts';
import { DecisionInputError } from './errors.ts';

export const HARD_FILTER_CODES = [
  'author_is_verifier',
  'role_unheld',
  'lane',
  'capacity',
  'concurrency',
  'dispatch_not_fresh',
  'cost_hold',
] as const;

export type HardFilterCode = typeof HARD_FILTER_CODES[number];

export interface FilterCandidate {
  id: string;
  label: string;
  description: string;
  roleIds?: readonly string[];
  lane?: string;
  openUnits?: number;
  costHold?: boolean;
}

export interface HardFilterInput {
  unitId: string;
  candidates: readonly FilterCandidate[];
  authorId?: string;
  unitClass?: string;
  verifyingRoleId?: string;
  catalog?: RoleCatalog;
  requiredLane?: string;
  /** Drop a candidate at or above this many open units. */
  capacity?: number;
  concurrencyLimit?: number;
  sourceStatus?: SourceStatus;
  intentStatus?: IntentStatus;
  /** When set, the action needs source FRESH and intent VALID. */
  dispatchGate?: boolean;
  /** A counted cost hold blocks the whole action. */
  unitCostHold?: boolean;
}

export interface HardFilterDrop {
  id: string;
  code: HardFilterCode;
}

export interface HardFilterResult {
  blocked: boolean;
  eligible: readonly FilterCandidate[];
  dropped: readonly HardFilterDrop[];
}

export function runHardFilters(input: HardFilterInput): HardFilterResult {
  if (input.dispatchGate && (input.sourceStatus !== 'FRESH' || input.intentStatus !== 'VALID')) {
    return blockAll(input.candidates, 'dispatch_not_fresh');
  }
  if (input.unitCostHold) return blockAll(input.candidates, 'cost_hold');

  const catalog = input.catalog ?? SEED_ROLE_CATALOG;
  if (input.verifyingRoleId) {
    if (!input.unitClass || !input.authorId) {
      throw new DecisionInputError('hard_filter', 'a verifying role needs unitClass and authorId');
    }
    const resolved = selectRole({ catalog, unitClass: input.unitClass, roleId: input.verifyingRoleId });
    if (!resolved.ok || !resolved.value.role.verifies) {
      throw new DecisionInputError('hard_filter', 'verifyingRoleId is not a verifying role');
    }
  }

  const dropped: HardFilterDrop[] = [];
  const eligible: FilterCandidate[] = [];
  for (const candidate of input.candidates) {
    const code = dropCode(candidate, input);
    if (code) dropped.push({ id: candidate.id, code });
    else eligible.push(candidate);
  }

  if (input.verifyingRoleId && input.unitClass && input.authorId) {
    const roleId = input.verifyingRoleId;
    const check = selectVerifier({
      catalog,
      unitClass: input.unitClass,
      roleId,
      unitId: input.unitId,
      authorId: input.authorId,
      candidates: input.candidates
        .filter(candidate => (candidate.roleIds ?? []).includes(roleId))
        .map(candidate => ({ agentId: candidate.id, roleIds: candidate.roleIds ?? [] })),
    });
    // selectVerifier picks one non-author. Other filters may drop that person.
    // Keep everyone else who already passed. Fail closed if the author is still eligible
    // or if role-select found no verifier while this filter kept someone.
    if (!check.ok) {
      if (eligible.length > 0) return { blocked: true, eligible: [], dropped };
    } else if (check.value.assigneeId === input.authorId || eligible.some(row => row.id === input.authorId)) {
      return { blocked: true, eligible: [], dropped };
    }
  }

  return { blocked: false, eligible, dropped };
}

/**
 * Intersect a caller-supplied result with the computed filter.
 * The caller can remove more people. The caller cannot add a person the filter dropped.
 */
export function tighten(
  computed: HardFilterResult,
  given: HardFilterResult | undefined,
  needsChoice: boolean,
): HardFilterResult {
  if (!given) {
    const blocked = computed.blocked || (needsChoice && computed.eligible.length === 0);
    return { blocked, eligible: computed.eligible, dropped: computed.dropped };
  }
  const allowed = new Set(given.eligible.map(row => row.id));
  const eligible = computed.eligible.filter(row => allowed.has(row.id));
  const dropped = dedupeDrops([...computed.dropped, ...given.dropped]);
  const blocked = computed.blocked || given.blocked || (needsChoice && eligible.length === 0);
  return { blocked, eligible, dropped };
}

function dropCode(candidate: FilterCandidate, input: HardFilterInput): HardFilterCode | null {
  if (input.verifyingRoleId && input.authorId && candidate.id === input.authorId) return 'author_is_verifier';
  if (input.verifyingRoleId && !(candidate.roleIds ?? []).includes(input.verifyingRoleId)) return 'role_unheld';
  if (input.requiredLane !== undefined && candidate.lane !== input.requiredLane) return 'lane';
  if (typeof input.capacity === 'number' && typeof candidate.openUnits === 'number' && candidate.openUnits >= input.capacity) {
    return 'capacity';
  }
  if (
    typeof input.concurrencyLimit === 'number'
    && typeof candidate.openUnits === 'number'
    && candidate.openUnits >= input.concurrencyLimit
  ) {
    return 'concurrency';
  }
  if (candidate.costHold) return 'cost_hold';
  return null;
}

function blockAll(candidates: readonly FilterCandidate[], code: HardFilterCode): HardFilterResult {
  return {
    blocked: true,
    eligible: [],
    dropped: candidates.map(candidate => ({ id: candidate.id, code })),
  };
}

function dedupeDrops(rows: readonly HardFilterDrop[]): HardFilterDrop[] {
  const seen = new Set<string>();
  const out: HardFilterDrop[] = [];
  for (const row of rows) {
    const key = `${row.id}\n${row.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}
