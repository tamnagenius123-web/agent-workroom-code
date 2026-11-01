// ORCH-A2 lane provisioner. Plans a worktree, branch, and log. Admission is injected
// so a test never reads host RAM and never creates a git worktree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RAM_PER_LANE_BYTES, planLane } from '../scripts/orch/lane-provision.mts';

const ROOT = '/tmp/orch-a2-wt';
const LOGS = '/tmp/orch-a2-logs';
const BASE = 'ebe056b';

type Resources = { freeRamBytes: number; nproc: number; activeLanes: number };

function resources(over: Partial<Resources> = {}): Resources {
  return { freeRamBytes: RAM_PER_LANE_BYTES, nproc: 4, activeLanes: 0, ...over };
}

function plan(over: Partial<Parameters<typeof planLane>[0]> = {}) {
  return planLane({
    unitId: 'ORCH-A2',
    baseRef: BASE,
    resources: resources(),
    worktreeRoot: ROOT,
    logRoot: LOGS,
    ...over,
  });
}

test('the RAM floor is 1.5 GiB, the byte unit of freemem', () => {
  assert.equal(RAM_PER_LANE_BYTES, 1_610_612_736);
  assert.equal(RAM_PER_LANE_BYTES, 1.5 * 1024 * 1024 * 1024);
});

test('plans a worktree path, grok/<unit> branch, and log path from the unit id and base ref', () => {
  const lane = plan();
  assert.equal(lane.admitted, true);
  assert.equal(lane.unitId, 'ORCH-A2');
  assert.equal(lane.baseRef, BASE);
  assert.equal(lane.branch, 'grok/ORCH-A2');
  assert.equal(lane.worktreePath, `${ROOT}/ORCH-A2`);
  assert.equal(lane.logPath, `${LOGS}/ORCH-A2.log`);
  assert.deepEqual(lane.reasons, []);
});

test('keeps the unit id verbatim, including an owner-style id', () => {
  const lane = plan({ unitId: 't995u' });
  assert.equal(lane.admitted, true);
  assert.equal(lane.branch, 'grok/t995u');
  assert.equal(lane.worktreePath, `${ROOT}/t995u`);
  assert.equal(lane.logPath, `${LOGS}/t995u.log`);
});

test('defaults the worktree under /workspace/gwt and the log beside it', () => {
  const lane = planLane({ unitId: 'ORCH-A2', baseRef: BASE, resources: resources() });
  assert.equal(lane.worktreePath, '/workspace/gwt/ORCH-A2');
  assert.equal(lane.logPath, '/workspace/gwt/.orch-logs/ORCH-A2.log');
  assert.equal(lane.branch, 'grok/ORCH-A2');
});

test('dry-run is the default and does not call the worktree creator', () => {
  let calls = 0;
  const lane = plan({ createWorktree() { calls += 1; } });
  assert.equal(lane.dryRun, true);
  assert.equal(lane.created, false);
  assert.equal(calls, 0);
});

test('dryRun false with no creator still does not create a worktree', () => {
  const lane = plan({ dryRun: false });
  assert.equal(lane.dryRun, false);
  assert.equal(lane.admitted, true);
  assert.equal(lane.created, false);
});

test('dryRun false calls the injected creator once and then marks the lane created', () => {
  const seen: string[] = [];
  const lane = plan({
    dryRun: false,
    createWorktree(spec) {
      seen.push(`${spec.branch} ${spec.baseRef} ${spec.worktreePath} ${spec.logPath}`);
    },
  });
  assert.equal(lane.created, true);
  assert.deepEqual(seen, [`grok/ORCH-A2 ${BASE} ${ROOT}/ORCH-A2 ${LOGS}/ORCH-A2.log`]);
});

test('a creator failure is not reported as created', () => {
  assert.throws(() => plan({
    dryRun: false,
    createWorktree() { throw new Error('disk full'); },
  }), /disk full/);
});

test('admits at exactly 1.5 GiB free and when one slot under nproc remains', () => {
  const lane = plan({ resources: resources({ freeRamBytes: RAM_PER_LANE_BYTES * 8, nproc: 8, activeLanes: 7 }) });
  assert.equal(lane.admitted, true);
  assert.deepEqual(lane.reasons, []);
});

test('refuses when free RAM is one byte under 1.5 GiB', () => {
  const lane = plan({ resources: resources({ freeRamBytes: RAM_PER_LANE_BYTES - 1, nproc: 8, activeLanes: 0 }) });
  assert.equal(lane.admitted, false);
  assert.equal(lane.created, false);
  assert.deepEqual(lane.reasons, ['insufficient_ram']);
});

test('refuses once active lanes are no longer strictly below nproc', () => {
  const full = plan({ resources: resources({ freeRamBytes: RAM_PER_LANE_BYTES * 8, nproc: 4, activeLanes: 4 }) });
  assert.equal(full.admitted, false);
  assert.equal(full.created, false);
  assert.deepEqual(full.reasons, ['lane_limit']);
  const over = plan({ resources: resources({ freeRamBytes: RAM_PER_LANE_BYTES * 8, nproc: 4, activeLanes: 5 }) });
  assert.deepEqual(over.reasons, ['lane_limit']);
});

test('reports RAM and lane-count failures together', () => {
  const lane = plan({ resources: resources({ freeRamBytes: 0, nproc: 2, activeLanes: 2 }) });
  assert.equal(lane.admitted, false);
  assert.deepEqual(lane.reasons, ['insufficient_ram', 'lane_limit']);
});

test('a refused plan still names the branch, worktree, and log', () => {
  const lane = plan({ resources: resources({ freeRamBytes: 0, nproc: 1, activeLanes: 1 }) });
  assert.equal(lane.branch, 'grok/ORCH-A2');
  assert.equal(lane.worktreePath, `${ROOT}/ORCH-A2`);
  assert.equal(lane.logPath, `${LOGS}/ORCH-A2.log`);
  assert.equal(lane.baseRef, BASE);
});

test('does not create a worktree when admission fails, even with dry-run off', () => {
  let calls = 0;
  const lane = plan({
    dryRun: false,
    resources: resources({ freeRamBytes: 0, nproc: 8, activeLanes: 8 }),
    createWorktree() { calls += 1; },
  });
  assert.equal(lane.admitted, false);
  assert.equal(lane.created, false);
  assert.equal(calls, 0);
});

test('rejects a unit id that is empty or not a single safe path segment', () => {
  for (const unitId of ['', '.', '..', 'a/b', 'a\\b', '.hidden', 'ORCH A2', '-orch', 'grok/ORCH-A2']) {
    const lane = plan({ unitId });
    assert.equal(lane.admitted, false, unitId);
    assert.equal(lane.created, false, unitId);
    assert.deepEqual(lane.reasons, ['bad_unit'], unitId);
    assert.equal(lane.worktreePath, '', unitId);
    assert.equal(lane.branch, '', unitId);
    assert.equal(lane.logPath, '', unitId);
  }
});

test('rejects an empty or unsafe base ref', () => {
  for (const baseRef of ['', '.', '..', '-main', 'origin/../main', 'has space']) {
    const lane = plan({ baseRef });
    assert.equal(lane.admitted, false, baseRef);
    assert.deepEqual(lane.reasons, ['bad_base'], baseRef);
    assert.equal(lane.created, false, baseRef);
  }
  const ok = plan({ baseRef: 'origin/main' });
  assert.equal(ok.admitted, true);
  assert.equal(ok.baseRef, 'origin/main');
});

test('refuses non-finite or non-integer resource snapshots before the RAM and lane gates', () => {
  const lane = plan({ resources: { freeRamBytes: Number.NaN, nproc: 0, activeLanes: -1 } });
  assert.equal(lane.admitted, false);
  assert.equal(lane.created, false);
  assert.deepEqual(lane.reasons, ['bad_resources']);
});

test('follows the injected snapshot when the host would decide the other way', () => {
  const starved = plan({ resources: resources({ freeRamBytes: 1, nproc: 64, activeLanes: 0 }) });
  assert.deepEqual(starved.reasons, ['insufficient_ram']);
  const open = plan({ resources: resources({ freeRamBytes: RAM_PER_LANE_BYTES, nproc: 1, activeLanes: 0 }) });
  assert.equal(open.admitted, true);
});

test('the provisioner module does not spawn a process', () => {
  const src = readFileSync(new URL('../scripts/orch/lane-provision.mts', import.meta.url), 'utf8');
  assert.equal(/child_process/.test(src), false);
  assert.equal(/worktree add/.test(src), false);
  assert.equal(/\b(execFile|execSync|spawn)\s*\(/.test(src), false);
});

test('the snapshot is taken before any lane starts, so RAM must cover every active lane plus the new one', () => {
  const over = plan({ resources: resources({ freeRamBytes: RAM_PER_LANE_BYTES, nproc: 8, activeLanes: 7 }) });
  assert.equal(over.admitted, false);
  assert.deepEqual(over.reasons, ['insufficient_ram']);
  const edge = plan({ resources: resources({ freeRamBytes: RAM_PER_LANE_BYTES * 3 - 1, nproc: 8, activeLanes: 2 }) });
  assert.equal(edge.admitted, false);
  const fits = plan({ resources: resources({ freeRamBytes: RAM_PER_LANE_BYTES * 3, nproc: 8, activeLanes: 2 }) });
  assert.equal(fits.admitted, true);
});

test('lane K+1 is refused when admitting lanes one by one from one snapshot', () => {
  const snapshot = RAM_PER_LANE_BYTES * 3 + 5;
  const admitted = [0, 1, 2, 3, 4].map((activeLanes) => plan({ resources: resources({ freeRamBytes: snapshot, nproc: 8, activeLanes }) }).admitted);
  assert.deepEqual(admitted, [true, true, true, false, false]);
});
