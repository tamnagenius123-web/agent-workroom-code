import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCommunityPost, type CommunityPost } from '../src/server/community.ts';
import { harness } from '../scripts/local-harness.ts';

// F1b: rooms.kind=community (0057) + REST wiring for the F1a post contract.
const SECRET = 'test-only-community-secret-not-real';
const ALPHA = 'local-alpha-fixture';
const BETA = 'local-beta-fixture';
const READER = 'local-reader-fixture';
const ROOM = 'room_community';
const PATH = `/api/v1/rooms/${ROOM}/community-posts`;

type App = Awaited<ReturnType<typeof harness>>;
interface Envelope {
  ok: boolean;
  data?: { post?: CommunityPost & { sig_valid?: boolean }; posts?: (CommunityPost & { sig_valid: boolean })[]; replayed?: boolean };
  error?: { code: string; message: string };
}

let app: App;
let unconfigured: App;
before(async () => {
  app = await harness({ through: 9999, bindings: { COMMUNITY_SIGNING_SECRET: SECRET } });
  unconfigured = await harness({ through: 9999 });
  for (const target of [app, unconfigured]) {
    await target.db.batch([
      target.db.prepare("INSERT INTO memberships(principal_id,room_id,can_post) VALUES ('synthetic:alpha',?,1)").bind(ROOM),
      target.db.prepare("INSERT INTO memberships(principal_id,room_id,can_post) VALUES ('synthetic:reader',?,0)").bind(ROOM),
    ]);
  }
});
after(async () => { await app?.close(); await unconfigured?.close(); });

async function rest(target: App, method: string, path: string, token: string, body?: object, key?: string): Promise<{ status: number; body: Envelope }> {
  const response = await target.mf.dispatchFetch('http://127.0.0.1' + path, { method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body ? JSON.stringify({ schema_version: '1', ...body }) : undefined });
  return { status: response.status, body: await response.json() as Envelope };
}

const helpRequest = {
  kind: 'help_request',
  body: { unit_id: 'F1', skill_tags: ['hmac'], urgency: 'normal', budget_cap_tokens: 5000, auto_accept: false, text: 'Need review.' },
};

test('0057 adds rooms.kind: existing rooms stay main, room_community is seeded as community', async () => {
  const rows = (await app.db.prepare('SELECT id, kind FROM rooms ORDER BY id').all<{ id: string; kind: string }>()).results;
  assert.deepEqual(rows.map((r: { id: string; kind: string }) => [r.id, r.kind]), [['room_community', 'community'], ['room_main', 'main']]);
  await assert.rejects(app.db.prepare("INSERT INTO rooms(id, kind) VALUES ('room_bad','lobby')").run(), /CHECK/);
});

test('a member posts; actor_id is the session principal and the server signature verifies', async () => {
  const res = await rest(app, 'POST', PATH, ALPHA, helpRequest, 'community-post-0001');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const post = res.body.data!.post!;
  assert.equal(post.actor_id, 'synthetic:alpha');
  assert.equal(post.room_id, ROOM);
  assert.equal(post.kind, 'help_request');
  assert.equal(res.body.data!.replayed, false);
  const checked = await verifyCommunityPost(SECRET, post, 'synthetic:alpha');
  assert.equal(checked.ok, true, checked.ok ? '' : checked.errors.join('; '));

  const replay = await rest(app, 'POST', PATH, ALPHA, helpRequest, 'community-post-0001');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data!.replayed, true);
  assert.equal(replay.body.data!.post!.post_id, post.post_id);
  assert.equal(replay.body.data!.post!.sig, post.sig);

  const conflict = await rest(app, 'POST', PATH, ALPHA, { ...helpRequest, body: { ...helpRequest.body, text: 'Changed.' } }, 'community-post-0001');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error?.code, 'IDEMPOTENCY_CONFLICT');
});

test('the body cannot set actor_id, room_id, post_id, created_at or sig', async () => {
  for (const [field, value] of [['actor_id', 'synthetic:beta'], ['room_id', 'room_main'], ['post_id', 'x'], ['created_at', '2026-10-27T00:00:00Z'], ['sig', 'abc']] as const) {
    const res = await rest(app, 'POST', PATH, ALPHA, { ...helpRequest, [field]: value }, `community-block-${field}`);
    assert.equal(res.status, 400, field);
    assert.equal(res.body.error?.code, 'INVALID_INPUT', field);
  }
});

test('the F1a parser rejects a bad body', async () => {
  const res = await rest(app, 'POST', PATH, ALPHA, { kind: 'veto', body: { target_id: 'p1' } }, 'community-bad-0001');
  assert.equal(res.status, 400);
  assert.equal(res.body.error?.code, 'INVALID_INPUT');
  assert.match(res.body.error!.message, /post\.body\.reason/);
});

test('only community rooms, only members, only can_post members write', async () => {
  const main = await rest(app, 'POST', '/api/v1/rooms/room_main/community-posts', ALPHA, helpRequest, 'community-main-0001');
  assert.equal(main.status, 403);
  const stranger = await rest(app, 'POST', PATH, BETA, helpRequest, 'community-beta-0001');
  assert.equal(stranger.status, 403);
  assert.equal((await rest(app, 'GET', PATH, BETA)).status, 403);
  const reader = await rest(app, 'POST', PATH, READER, helpRequest, 'community-reader-01');
  assert.equal(reader.status, 403);
  assert.equal((await rest(app, 'GET', PATH, READER)).status, 200);
});

test('GET lists posts newest first and flags a row edited in D1', async () => {
  const second = await rest(app, 'POST', PATH, ALPHA, { kind: 'hold', body: { target_id: 'F2', reason: 'Wait for F0.' } }, 'community-post-0002');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const listed = await rest(app, 'GET', PATH, READER);
  const posts = listed.body.data!.posts!;
  assert.deepEqual(posts.map(p => [p.kind, p.sig_valid]), [['hold', true], ['help_request', true]]);

  await app.db.prepare("UPDATE community_posts SET post_json=json_set(post_json,'$.body.reason','Forged.') WHERE id=?").bind(second.body.data!.post!.post_id).run();
  const tampered = (await rest(app, 'GET', PATH, READER)).body.data!.posts!;
  assert.deepEqual(tampered.map(p => [p.kind, p.sig_valid]), [['hold', false], ['help_request', true]]);
});

test('without COMMUNITY_SIGNING_SECRET the route fails closed', async () => {
  const res = await rest(unconfigured, 'POST', PATH, ALPHA, helpRequest, 'community-nocfg-001');
  assert.equal(res.status, 503);
  assert.equal(res.body.error?.code, 'COMMUNITY_NOT_CONFIGURED');
  assert.equal((await unconfigured.db.prepare('SELECT count(*) AS n FROM community_posts').first<{ n: number }>())?.n, 0);
});
