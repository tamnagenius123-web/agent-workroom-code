import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { harness } from './local-harness.ts';

const app = await harness();
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [], external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== new URL(app.url).origin) {
      external.push(route.request().url()); return route.abort();
    }
    return route.continue();
  });
  await page.goto(app.url);
  await page.getByRole('button', { name: '저장 기록 조회' }).click();
  await page.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('조회 오류'));
  await page.locator('#token').fill('local-alpha-fixture');
  await page.locator('#read').click();
  await page.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('0개 조회'));
  const hostile = '<script>window.compromised=1</script> ![remote](https://evil.test/pixel)\n[click](javascript:alert(1))';
  await page.locator('#text').fill(hostile);
  await page.locator('#format').selectOption('markdown');
  await page.locator('#form').evaluate(form => {
    (form as HTMLFormElement).requestSubmit(); (form as HTMLFormElement).requestSubmit();
  });
  await page.waitForFunction(() => document.querySelector('#status')!.textContent!.startsWith('저장 완료') && !document.querySelector<HTMLButtonElement>('#post')!.disabled);
  assert.equal(await page.locator('article').count(), 1);
  assert.equal(await page.locator('article pre').textContent(), hostile);
  assert.equal(await page.locator('article script, article img, article a').count(), 0);
  assert.equal(await page.evaluate(() => 'compromised' in window), false);
  let lostKey: string | null = null;
  await page.route('**/api/v1/rooms/room_main/messages', async route => {
    if (route.request().method() !== 'POST' || lostKey) return route.fallback();
    lostKey = route.request().headers()['idempotency-key']!;
    const committed = await route.fetch(); assert.equal(committed.status(), 200);
    await committed.body();
    return route.abort('timedout');
  });
  await page.locator('#text').fill('Browser lost-response recovery');
  await page.locator('#post').click();
  await page.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('결과 미확인'));
  assert.ok(lostKey); assert.ok((await page.locator('#status').textContent())!.includes(lostKey));
  assert.equal(await page.locator('#text').isDisabled(), true);
  await page.locator('#post').click();
  await page.waitForFunction(() => document.querySelector('#status')!.textContent!.startsWith('저장 완료') && !document.querySelector<HTMLButtonElement>('#post')!.disabled);
  assert.equal(await page.locator('article').count(), 2);
  await page.reload();
  await page.locator('#token').fill('local-alpha-fixture');
  await page.locator('#read').click();
  await page.waitForFunction(() => document.querySelector('#status')!.textContent!.includes('2개 조회'));
  assert.equal(await page.locator('article').count(), 2);
  assert.ok((await page.locator('body').textContent())!.includes('실제 연결되지 않음'));
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  const audit = await app.db.prepare('SELECT count(*) total FROM audit').first<{ total: number }>();
  assert.equal(audit?.total, 2);
  process.stdout.write(JSON.stringify({ ok: true, browser: browser.version(), messages: 2, audit: 2,
    checks: ['unauthenticated','read','post','double-submit','literal-malicious-md','no-external-fetch','lost-response-same-key','reload'],
    real_agents_connected: false }) + '\n');
} finally { await browser.close(); await app.close(); }
