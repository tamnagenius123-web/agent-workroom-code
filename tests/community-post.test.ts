import assert from 'node:assert/strict';
import test from 'node:test';
import { type PhaseCheck } from '../src/phase-contracts/check.ts';
import {
  COMMUNITY_KINDS, deriveActorKey, parseCommunityPost, signCommunityPost, verifyCommunityPost,
  type CommunityPost, type UnsignedCommunityPost,
} from '../src/server/community.ts';

const SECRET = 'test-only-server-secret-not-real';
const AT = '2026-10-27T05:00:00.000Z';

function must<T>(result: PhaseCheck<T>): T {
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join(' | '));
  if (!result.ok) throw new Error('expected ok');
  return result.value;
}

function errors<T>(result: PhaseCheck<T>): string {
  assert.equal(result.ok, false, 'expected a rejection');
  return result.ok ? '' : result.errors.join(' | ');
}

const bodies: Record<typeof COMMUNITY_KINDS[number], Record<string, unknown>> = {
  help_request: { unit_id: 'F1', skill_tags: ['hmac', 'd1'], urgency: 'high', budget_cap_tokens: 20000, auto_accept: false, text: 'Need a second pair of eyes on HMAC binding.' },
  help_offer: { request_id: 'post_req_1', skill_tags: ['hmac'], cost_est: { tokens: 8000, minutes: 15 }, text: 'Can review in 15 min.' },
  method: { title: 'Red before green', steps: ['commit failing test', 'show it fails', 'fix', 'show it passes'], evidence_refs: ['decisions.tsv:F1'] },
  assignment: { assignee: 'agent:dots', unit_id: 'F2', deadline: '2026-10-28T00:00:00.000Z' },
  veto: { target_id: 'post_req_1', reason: 'Duplicates F2 scope.' },
  hold: { target_id: 'post_req_1', reason: 'Wait for F0 acceptance.' },
};

function draft(kind: typeof COMMUNITY_KINDS[number], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { schema_version: '1', post_id: `post_${kind}`, room_id: 'room_community', actor_id: 'agent:claude', kind, created_at: AT, body: bodies[kind], ...over };
}

test('every thread kind parses and round-trips through sign/verify', async () => {
  for (const kind of COMMUNITY_KINDS) {
    const unsigned = must(parseCommunityPost(draft(kind)));
    assert.equal(unsigned.kind, kind);
    const signed = await signCommunityPost(SECRET, unsigned);
    must(await verifyCommunityPost(SECRET, signed, 'agent:claude'));
  }
});

test('schema rejects unknown kinds, unknown fields and wrong body shape', () => {
  assert.match(errors(parseCommunityPost(draft('help_request', { kind: 'announcement' }))), /kind/);
  assert.match(errors(parseCommunityPost(draft('method', { extra: 1 }))), /unknown field "extra"/);
  assert.match(errors(parseCommunityPost(draft('help_offer', { body: { ...bodies.help_offer, request_id: undefined } }))), /request_id/);
  assert.match(errors(parseCommunityPost(draft('help_request', { body: { ...bodies.help_request, skill_tags: [] } }))), /skill_tags/);
  assert.match(errors(parseCommunityPost(draft('help_request', { body: { ...bodies.help_request, budget_cap_tokens: 0 } }))), /budget_cap_tokens/);
  assert.match(errors(parseCommunityPost(draft('method', { body: { ...bodies.method, evidence_refs: [] } }))), /evidence_refs/);
  assert.match(errors(parseCommunityPost(draft('veto', { body: bodies.assignment }))), /target_id/);
  assert.match(errors(parseCommunityPost({ ...draft('hold'), sig: 'x' })), /sig/);
});

test('HMAC binding: another actor cannot post as agent:claude', async () => {
  const signed = await signCommunityPost(SECRET, must(parseCommunityPost(draft('help_request'))));
  // Authenticated session is agent:dots, but the post claims agent:claude.
  assert.match(errors(await verifyCommunityPost(SECRET, signed, 'agent:dots')), /actor/);
  // agent:dots re-labels the post and signs with its own derived key.
  const relabeled = { ...signed, actor_id: 'agent:dots' } as CommunityPost;
  assert.match(errors(await verifyCommunityPost(SECRET, relabeled, 'agent:dots')), /sig/);
  // Different actors derive different keys from the same server secret.
  assert.notEqual(await deriveActorKey(SECRET, 'agent:claude'), await deriveActorKey(SECRET, 'agent:dots'));
});

test('HMAC binding: any tampered field fails verification', async () => {
  const signed = await signCommunityPost(SECRET, must(parseCommunityPost(draft('help_offer'))));
  const tampers: Array<Partial<CommunityPost>> = [
    { room_id: 'room_main' },
    { post_id: 'post_other' },
    { created_at: '2026-10-27T06:00:00.000Z' },
    { body: { ...signed.body, cost_est: { tokens: 1, minutes: 15 } } } as Partial<CommunityPost>,
  ];
  for (const t of tampers) {
    assert.match(errors(await verifyCommunityPost(SECRET, { ...signed, ...t } as CommunityPost, 'agent:claude')), /sig/);
  }
  assert.match(errors(await verifyCommunityPost('another-secret', signed, 'agent:claude')), /sig/);
});

test('signature does not depend on input key order', async () => {
  const a = must(parseCommunityPost(draft('assignment')));
  const reordered = Object.fromEntries(Object.entries(draft('assignment')).reverse());
  reordered.body = Object.fromEntries(Object.entries(bodies.assignment).reverse());
  const b: UnsignedCommunityPost = must(parseCommunityPost(reordered));
  assert.equal((await signCommunityPost(SECRET, a)).sig, (await signCommunityPost(SECRET, b)).sig);
});
