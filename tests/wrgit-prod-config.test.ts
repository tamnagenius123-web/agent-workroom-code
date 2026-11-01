import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

// WG-11: prod 468d888b served WR-GIT 404 because wrangler.jsonc had no ARTIFACTS binding and no WRGIT_ENABLED.
// The binding needs Wrangler >= 4.145.0; bare `npx wrangler` can resolve an older cached copy (4.86.0 on the box).
const MIN_WRANGLER = [4, 145, 0];

const jsonc = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const config = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')) as {
  artifacts?: { binding: string; namespace: string }[];
  vars: Record<string, string>;
};

// PM call (5f8a734e, ff1e2dfa): the flag ships off until repo agent-workroom exists in namespace workroom;
// with it on and no repo, every claim/claim_next returns 503.
test('wrangler.jsonc binds ARTIFACTS to the workroom namespace and ships WR-GIT off', () => {
  assert.deepEqual(config.artifacts, [{ binding: 'ARTIFACTS', namespace: 'workroom' }]);
  assert.equal(config.vars.WRGIT_ENABLED, '0');
});

test('deploy-pinned.sh runs an exact Wrangler version that supports Artifacts', () => {
  const script = readFileSync(new URL('../scripts/deploy-pinned.sh', import.meta.url), 'utf8');
  const calls = [...script.matchAll(/npx(?: --yes)? wrangler(@\S+)?/g)];
  assert.ok(calls.length >= 3, 'deploy-pinned.sh calls wrangler');
  for (const [call, pin] of calls) {
    const v = /^@(\d+)\.(\d+)\.(\d+)$/.exec(pin ?? '');
    assert.ok(v, `unpinned wrangler call: ${call}`);
    const got = v.slice(1).map(Number);
    const cmp = got.findIndex((n, i) => n !== MIN_WRANGLER[i]);
    assert.ok(cmp === -1 || (got[cmp] ?? 0) > (MIN_WRANGLER[cmp] ?? 0), `${call} is older than ${MIN_WRANGLER.join('.')}`);
  }
});
