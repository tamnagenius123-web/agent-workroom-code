import assert from 'node:assert/strict';
import test from 'node:test';
import { telegramWebhook, telegramNotify, type TelegramDeps } from '../src/server/telegram.ts';

// TELEGRAM (owner t783u "그냥 진행해. 내가 올린 토큰으로"; TG-BRIDGE t745u). Synthetic values only.
const env = { TELEGRAM_BOT_TOKEN: 'synthetic:bot-token', TELEGRAM_WEBHOOK_SECRET: 'synthetic-webhook-secret-0123456789', TELEGRAM_OWNER_CHAT_ID: '4242' };
function deps() {
  const posts: { text: string; key: string }[] = [], sent: { url: string; body: string }[] = [];
  const d: TelegramDeps = {
    postAsOwner: async (text, key) => { posts.push({ text, key }); },
    fetch: async (url, init) => { sent.push({ url: String(url), body: String(init?.body ?? '') }); return new Response('{"ok":true}'); },
  };
  return { d, posts, sent };
}
const update = (chat: number, text: string, id = 7) => JSON.stringify({ update_id: id, message: { message_id: 1, chat: { id: chat, type: 'private' }, from: { id: chat }, text } });
const req = (body: string, secret?: string) => new Request('https://w.test/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-telegram-bot-api-secret-token': secret } : {}) }, body });

test('TELEGRAM: webhook secret mismatch is rejected and records nothing', async () => {
  const { d, posts } = deps();
  assert.equal((await telegramWebhook(req(update(4242, 'hi')), env, d))?.status, 401);
  assert.equal((await telegramWebhook(req(update(4242, 'hi'), 'wrong'), env, d))?.status, 401);
  assert.equal(posts.length, 0);
});

test('TELEGRAM: non-owner chat is rejected (allowlist) and records nothing', async () => {
  const { d, posts } = deps();
  const r = await telegramWebhook(req(update(999, 'pwn'), env.TELEGRAM_WEBHOOK_SECRET), env, d);
  assert.equal(r?.status, 200, 'ack to Telegram so it does not retry');
  assert.equal(posts.length, 0);
});

test('TELEGRAM: owner message becomes an owner room post, idempotent by update_id', async () => {
  const { d, posts } = deps();
  const r = await telegramWebhook(req(update(4242, '배포해', 55), env.TELEGRAM_WEBHOOK_SECRET), env, d);
  assert.equal(r?.status, 200);
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.text, /배포해/);
  assert.equal(posts[0]!.key, 'telegram-update-55');
});

test('TELEGRAM: unconfigured bridge is 503 and other paths pass through', async () => {
  const { d } = deps();
  assert.equal((await telegramWebhook(req(update(4242, 'x'), 's'), {}, d))?.status, 503);
  assert.equal(await telegramWebhook(new Request('https://w.test/other'), env, d), null);
});

test('TELEGRAM: notify sends only to the owner chat and never echoes the token', async () => {
  const { d, sent } = deps();
  const out = await telegramNotify('slip: E3 07:10', env, d);
  assert.equal(out.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0]!.body).chat_id, '4242');
  assert.ok(!JSON.stringify(out).includes(env.TELEGRAM_BOT_TOKEN));
});
