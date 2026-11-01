import assert from 'node:assert/strict';
import test from 'node:test';
import { type PhaseCheck } from '../src/phase-contracts/check.ts';
import {
  ROLE_SELECT_VERSION,
  SEED_ROLE_CATALOG,
  selectRole,
  selectVerifier,
  type CatalogRole,
  type RoleCandidate,
  type RoleCatalog,
} from '../src/phase-contracts/role-select.ts';

const IMPLEMENTER: CatalogRole = {
  id: 'implementer', unitClass: 'build', duty: 'implement', verifies: false,
};
const SPEC_REVIEWER: CatalogRole = {
  id: 'spec-reviewer', unitClass: 'build', duty: 'spec-review', verifies: true,
};
const SECURITY_REVIEWER: CatalogRole = {
  id: 'security-reviewer', unitClass: 'build', duty: 'security-review', verifies: true,
};
const SCOUT: CatalogRole = {
  id: 'scout', unitClass: 'research', duty: 'scout', verifies: false,
};
const REPLICATOR: CatalogRole = {
  id: 'replicator', unitClass: 'research', duty: 'replicate', verifies: true,
};
const ARCHIVIST: CatalogRole = {
  id: 'archivist', unitClass: 'memory', duty: 'consolidate', verifies: true,
};

const MEMORY_CATALOG: RoleCatalog = { roles: [ARCHIVIST] };

function expectOk<T>(result: PhaseCheck<T>): T {
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
  return result.value;
}

function expectFail(result: PhaseCheck<unknown>, needle: string): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some(error => error.includes(needle)), result.errors.join(' | '));
}

function held(agentId: string, ...roleIds: string[]): RoleCandidate {
  return { agentId, roleIds };
}

test('selectRole returns the catalog role for that unit class', () => {
  const build = expectOk(selectRole({
    catalog: SEED_ROLE_CATALOG, unitClass: 'build', roleId: 'implementer',
  }));
  assert.equal(build.unitClass, 'build');
  assert.deepEqual(build.role, IMPLEMENTER);

  const research = expectOk(selectRole({
    catalog: SEED_ROLE_CATALOG, unitClass: 'research', roleId: 'replicator',
  }));
  assert.equal(research.unitClass, 'research');
  assert.equal(research.role.duty, 'replicate');
  assert.equal(research.role.verifies, true);
  assert.deepEqual(research.role, REPLICATOR);

  for (const duty of [build.role.duty, research.role.duty]) {
    assert.notEqual(duty, 'builder');
    assert.notEqual(duty, 'reviewer');
  }
});

test('one unit class has many roles and does not collapse to a builder/reviewer pair', () => {
  assert.equal(ROLE_SELECT_VERSION, 'orch-c2.role-select.v1');
  assert.ok(SEED_ROLE_CATALOG.roles.length >= 5);
  assert.deepEqual(
    SEED_ROLE_CATALOG.roles.find(role => role.id === 'implementer' && role.unitClass === 'build'),
    IMPLEMENTER,
  );
  assert.deepEqual(
    SEED_ROLE_CATALOG.roles.find(role => role.id === 'spec-reviewer' && role.unitClass === 'build'),
    SPEC_REVIEWER,
  );
  assert.deepEqual(
    SEED_ROLE_CATALOG.roles.find(role => role.id === 'security-reviewer' && role.unitClass === 'build'),
    SECURITY_REVIEWER,
  );
  assert.deepEqual(
    SEED_ROLE_CATALOG.roles.find(role => role.id === 'scout' && role.unitClass === 'research'),
    SCOUT,
  );
  assert.deepEqual(
    SEED_ROLE_CATALOG.roles.find(role => role.id === 'replicator' && role.unitClass === 'research'),
    REPLICATOR,
  );

  const selected = ['implementer', 'spec-reviewer', 'security-reviewer'].map(roleId => {
    const result = expectOk(selectRole({ catalog: SEED_ROLE_CATALOG, unitClass: 'build', roleId }));
    assert.equal(result.role.id, roleId);
    assert.equal(result.unitClass, 'build');
    return result.role;
  });
  assert.deepEqual(selected, [IMPLEMENTER, SPEC_REVIEWER, SECURITY_REVIEWER]);
  assert.deepEqual(selected.map(role => role.duty), ['implement', 'spec-review', 'security-review']);

  const ids = [...new Set(SEED_ROLE_CATALOG.roles.map(role => role.id))].sort();
  assert.notDeepEqual(ids, ['builder', 'reviewer']);
});

test('selectRole rejects a role that belongs to another class', () => {
  expectFail(selectRole({
    catalog: SEED_ROLE_CATALOG, unitClass: 'research', roleId: 'spec-reviewer',
  }), 'role is not in this unit class');
});

test('selectRole rejects an unknown unit class', () => {
  expectFail(selectRole({
    catalog: SEED_ROLE_CATALOG, unitClass: 'sandbox', roleId: 'implementer',
  }), 'unknown unit class');
});

test('selectRole rejects an unknown role in a known class', () => {
  expectFail(selectRole({
    catalog: SEED_ROLE_CATALOG, unitClass: 'build', roleId: 'typo-role',
  }), 'unknown role');
});

test('selectVerifier never selects the author even when the author sorts first and holds the role', () => {
  const candidates: readonly RoleCandidate[] = [
    held('agent-a', 'spec-reviewer'),
    held('agent-m', 'spec-reviewer'),
    held('agent-b', 'spec-reviewer'),
  ];
  const picked = expectOk(selectVerifier({
    catalog: SEED_ROLE_CATALOG,
    unitClass: 'build',
    roleId: 'spec-reviewer',
    unitId: 'ORCH-C2',
    authorId: 'agent-a',
    candidates,
  }));
  assert.equal(picked.assigneeId, 'agent-b');
  assert.equal(picked.role.id, 'spec-reviewer');
  assert.equal(picked.role.verifies, true);
  assert.deepEqual(picked.role, SPEC_REVIEWER);
  assert.equal(picked.unitId, 'ORCH-C2');
  assert.equal(picked.unitClass, 'build');
  assert.notEqual(picked.assigneeId, 'agent-a');
});

test('selectVerifier refuses when the only holder is the author', () => {
  const result = selectVerifier({
    catalog: SEED_ROLE_CATALOG,
    unitClass: 'build',
    roleId: 'spec-reviewer',
    unitId: 'ORCH-C2',
    authorId: 'agent-a',
    candidates: [held('agent-a', 'spec-reviewer')],
  });
  assert.equal(result.ok, false);
  if (result.ok) {
    assert.fail('must not assign the author');
  }
  assert.ok(
    result.errors.some(error => error.includes('author cannot verify own unit')),
    result.errors.join(' | '),
  );
});

test('same class two verifying roles assign two different non-author assignees', () => {
  const candidates: readonly RoleCandidate[] = [
    held('agent-a', 'spec-reviewer', 'security-reviewer'),
    held('agent-b', 'spec-reviewer'),
    held('agent-c', 'security-reviewer'),
  ];
  const spec = expectOk(selectVerifier({
    catalog: SEED_ROLE_CATALOG,
    unitClass: 'build',
    roleId: 'spec-reviewer',
    unitId: 'ORCH-C2',
    authorId: 'agent-a',
    candidates,
  }));
  const security = expectOk(selectVerifier({
    catalog: SEED_ROLE_CATALOG,
    unitClass: 'build',
    roleId: 'security-reviewer',
    unitId: 'ORCH-C2',
    authorId: 'agent-a',
    candidates,
  }));
  assert.equal(spec.assigneeId, 'agent-b');
  assert.equal(security.assigneeId, 'agent-c');
  assert.notEqual(spec.assigneeId, 'agent-a');
  assert.notEqual(security.assigneeId, 'agent-a');
  assert.equal(spec.role.id, 'spec-reviewer');
  assert.equal(security.role.id, 'security-reviewer');
  assert.notEqual(spec.assigneeId, security.assigneeId);
});

test('selectVerifier rejects a non-verifying role even when a non-author holds it', () => {
  expectFail(selectVerifier({
    catalog: SEED_ROLE_CATALOG,
    unitClass: 'build',
    roleId: 'implementer',
    unitId: 'ORCH-C2',
    authorId: 'agent-a',
    candidates: [held('agent-b', 'implementer')],
  }), 'not a verifying role');
});

test('selectVerifier reports no candidate holds role when nobody holds it', () => {
  const result = selectVerifier({
    catalog: SEED_ROLE_CATALOG,
    unitClass: 'build',
    roleId: 'spec-reviewer',
    unitId: 'ORCH-C2',
    authorId: 'agent-a',
    candidates: [
      held('agent-a'),
      held('agent-b', 'implementer'),
    ],
  });
  expectFail(result, 'no candidate holds role');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.errors.some(error => error.includes('author cannot verify own unit')), false);
});

test('a custom catalog with no builder or reviewer names still selects a role and a non-author verifier', () => {
  const selected = expectOk(selectRole({
    catalog: MEMORY_CATALOG, unitClass: 'memory', roleId: 'archivist',
  }));
  assert.equal(selected.unitClass, 'memory');
  assert.deepEqual(selected.role, ARCHIVIST);

  const verified = expectOk(selectVerifier({
    catalog: MEMORY_CATALOG,
    unitClass: 'memory',
    roleId: 'archivist',
    unitId: 'MEM-1',
    authorId: 'agent-a',
    candidates: [held('agent-a', 'archivist'), held('agent-z', 'archivist')],
  }));
  assert.equal(verified.unitId, 'MEM-1');
  assert.equal(verified.unitClass, 'memory');
  assert.deepEqual(verified.role, ARCHIVIST);
  assert.equal(verified.assigneeId, 'agent-z');
  assert.notEqual(verified.assigneeId, 'agent-a');
});

test('duplicate id and unit class fails closed', () => {
  const catalog: RoleCatalog = {
    roles: [
      ARCHIVIST,
      { id: 'archivist', unitClass: 'memory', duty: 'index', verifies: true },
    ],
  };
  expectFail(selectRole({
    catalog, unitClass: 'memory', roleId: 'archivist',
  }), 'duplicate role');
});
