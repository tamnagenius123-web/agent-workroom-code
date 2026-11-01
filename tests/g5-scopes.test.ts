import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeSet } from '../src/auth/g5.ts';

test('G5 scope default: clients allowed offline_access get it when no or only non-workroom scopes are requested', () => {
  const all = ['workroom.read', 'workroom.write', 'offline_access'];
  for (const raw of [null, '', 'openid', 'openid profile email']) assert.deepEqual(scopeSet(raw, all).granted, all, String(raw));
  assert.deepEqual(scopeSet('openid', ['workroom.read', 'workroom.write']).granted, ['workroom.read', 'workroom.write'], 'not granted when not allowed');
  assert.deepEqual(scopeSet('workroom.read workroom.write', all).granted, ['workroom.read', 'workroom.write', 'offline_access'], 'offline_access always added when allowed');
  assert.deepEqual(scopeSet('workroom.read', all).granted, ['workroom.read', 'offline_access']);
  assert.deepEqual(scopeSet('offline_access workroom.read workroom.write', all).granted, ['offline_access', 'workroom.read', 'workroom.write']);
});
