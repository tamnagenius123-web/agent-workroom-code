import assert from 'node:assert/strict';
import test from 'node:test';
import { authEnv, authOrder, claudeArgs } from '../scripts/claude-runner.mts';

test('runner uses Opus 5.5, effort medium, and allows Task for subagents', () => {
  const a = claudeArgs('p', 's');
  assert.equal(a[a.indexOf('--model') + 1], 'claude-opus-5-5');
  assert.equal(a[a.indexOf('--effort') + 1], 'medium');
  assert.match(a[a.indexOf('--allowedTools') + 1]!, /^Task,/);
});

test('subscription auth strips API credentials; api auth requires a key', () => {
  const e = authEnv('subscription', { ANTHROPIC_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y', PATH: '/bin' });
  assert.equal(e.ANTHROPIC_API_KEY, undefined); assert.equal(e.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(e.PATH, '/bin');
  assert.throws(() => authEnv('api', {}));
  assert.equal(authEnv('api', { ANTHROPIC_API_KEY: 'x' }).ANTHROPIC_API_KEY, 'x');
});

test('auth order: api-first before 2026-11-01 KST, subscription-first after, budget guard, env override', () => {
  const sw = Date.parse('2026-11-01T00:00:00+09:00'), k = { ANTHROPIC_API_KEY: 'x' };
  assert.deepEqual(authOrder(sw - 1, k, 0), ['api', 'subscription']);
  assert.deepEqual(authOrder(sw, k, 0), ['subscription', 'api']);
  assert.deepEqual(authOrder(sw - 1, k, 199), ['subscription']);
  assert.deepEqual(authOrder(sw - 1, k, 198.99), ['api', 'subscription']);
  assert.deepEqual(authOrder(sw - 1, {}, 0), ['subscription']);
  assert.deepEqual(authOrder(sw - 1, { ...k, CLAUDE_AUTH: 'subscription' }, 0), ['subscription', 'api']);
  assert.deepEqual(authOrder(sw, { ...k, CLAUDE_AUTH: 'api', CLAUDE_AUTH_FALLBACK: '0' }, 0), ['api']);
});
