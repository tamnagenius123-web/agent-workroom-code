// ORCH-C2 role catalog. One unit class has many duties. A verifying role cannot be the unit author.
// Pure: no I/O, no clock, no network, no storage.

import { Problems, type PhaseCheck } from './check.ts';

export const ROLE_SELECT_VERSION = 'orch-c2.role-select.v1';

export interface CatalogRole {
  id: string;
  unitClass: string;
  duty: string;
  verifies: boolean;
}

export interface RoleCatalog {
  roles: readonly CatalogRole[];
}

export interface RoleCandidate {
  agentId: string;
  roleIds: readonly string[];
}

export const SEED_ROLE_CATALOG: RoleCatalog = {
  roles: [
    { id: 'implementer', unitClass: 'build', duty: 'implement', verifies: false },
    { id: 'spec-reviewer', unitClass: 'build', duty: 'spec-review', verifies: true },
    { id: 'security-reviewer', unitClass: 'build', duty: 'security-review', verifies: true },
    { id: 'scout', unitClass: 'research', duty: 'scout', verifies: false },
    { id: 'replicator', unitClass: 'research', duty: 'replicate', verifies: true },
  ],
};

interface RoleQuery {
  catalog: RoleCatalog;
  unitClass: string;
  roleId: string;
}

interface SelectedRole {
  unitClass: string;
  role: CatalogRole;
}

interface VerifierQuery extends RoleQuery {
  unitId: string;
  authorId: string;
  candidates: readonly RoleCandidate[];
}

interface SelectedVerifier {
  assigneeId: string;
  role: CatalogRole;
  unitId: string;
  unitClass: string;
}

function pairKey(role: CatalogRole): string {
  return JSON.stringify([role.id, role.unitClass]);
}

function hasDuplicatePair(roles: readonly CatalogRole[]): boolean {
  const seen = new Set<string>();
  for (const role of roles) {
    const key = pairKey(role);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function resolveRole(query: RoleQuery): PhaseCheck<SelectedRole> {
  const problems = new Problems();
  const { catalog, unitClass, roleId } = query;
  if (hasDuplicatePair(catalog.roles)) {
    problems.add('catalog.roles', 'duplicate role');
    return problems.fail();
  }
  const inClass = catalog.roles.some(role => role.unitClass === unitClass);
  if (!inClass) {
    problems.add('unitClass', 'unknown unit class');
    return problems.fail();
  }
  const match = catalog.roles.find(role => role.unitClass === unitClass && role.id === roleId);
  if (match !== undefined) return { ok: true, value: { unitClass, role: match } };
  const otherClass = catalog.roles.some(role => role.id === roleId);
  if (otherClass) {
    problems.add('roleId', 'role is not in this unit class');
    return problems.fail();
  }
  problems.add('roleId', 'unknown role');
  return problems.fail();
}

export function selectRole(input: RoleQuery): PhaseCheck<SelectedRole> {
  return resolveRole(input);
}

export function selectVerifier(input: VerifierQuery): PhaseCheck<SelectedVerifier> {
  const resolved = resolveRole(input);
  if (!resolved.ok) return resolved;
  const problems = new Problems();
  const { role } = resolved.value;
  if (!role.verifies) {
    problems.add('roleId', 'not a verifying role');
    return problems.fail();
  }
  const { roleId, authorId, candidates, unitId, unitClass } = input;
  let held = false;
  let assigneeId: string | undefined;
  for (const candidate of candidates) {
    if (!candidate.roleIds.includes(roleId)) continue;
    held = true;
    if (candidate.agentId === authorId) continue;
    if (assigneeId === undefined || candidate.agentId < assigneeId) assigneeId = candidate.agentId;
  }
  if (!held) {
    problems.add('candidates', 'no candidate holds role');
    return problems.fail();
  }
  if (assigneeId === undefined) {
    problems.add('authorId', 'author cannot verify own unit');
    return problems.fail();
  }
  return { ok: true, value: { assigneeId, role, unitId, unitClass } };
}
