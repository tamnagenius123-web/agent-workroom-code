// The merge implementation lives in the gate MCP repo. This file checks the
// fail-closed stub with an injected Artifacts double that must not be called.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Fault } from '../src/server/contracts.ts';
import type { ArtifactsBinding } from '../src/server/wrgit/artifacts-binding.ts';
import { gitRoute } from '../src/server/wrgit/routes.ts';
import { mergeTask, reclaimWriteOpen, reconcileMergeIntents, submitWorkspace, takeoverExpiredLease } from '../src/server/wrgit/merge.ts';
import type { Database, Env } from '../src/server/db.ts';

function untouched(): ArtifactsBinding {
  return new Proxy({} as ArtifactsBinding, {
    get() { throw new Error('injected double was called'); },
  });
}

const env = (flag: '0' | '1'): Env => ({ DB: {} as Database, WRGIT_ENABLED: flag });

test('WRGIT_ENABLED off returns null and does not touch the injected double', async () => {
  const url = new URL('http://127.0.0.1/git/merge');
  const result = await gitRoute(new Request(url, { method: 'POST' }), url, env('0'), untouched(), 'agent.author', async () => ({}));
  assert.equal(result, null);
});

test('WRGIT_ENABLED on fails closed from the contract Fault and does not touch the injected double', async () => {
  const url = new URL('http://127.0.0.1/git/workspaces/ws-1/submit');
  const artifacts = untouched();
  await assert.rejects(
    () => gitRoute(new Request(url, { method: 'POST' }), url, env('1'), artifacts, 'agent.author', async () => ({ sha: 'a'.repeat(40) })),
    (error: unknown) => error instanceof Fault && error.code === 'UNAVAILABLE' && error.status === 503,
  );
});

test('merge, reclaim, and reconcile fail closed', async () => {
  const artifacts = untouched();
  const db = {} as Database;
  const calls = [
    () => submitWorkspace(db, artifacts, 'agent.author', 'ws-1', 'a'.repeat(40)),
    () => mergeTask(db, artifacts, 'agent.merger', 'task-1'),
    () => reclaimWriteOpen(db, artifacts, 'intent-1', 0, 'agent.reclaim'),
    () => takeoverExpiredLease(db, artifacts, 'intent-1', 'agent.reclaim'),
    () => reconcileMergeIntents(db, artifacts),
  ];
  for (const call of calls) {
    await assert.rejects(call, (error: unknown) => error instanceof Fault && error.code === 'UNAVAILABLE' && error.status === 503);
  }
});
