import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness } from '../scripts/local-harness.ts';

let app: Awaited<ReturnType<typeof harness>>;
before(async () => { app = await harness({ through: 9999 }); });
after(async () => { await app?.close(); });
const base = 'http://127.0.0.1/api/v1/rooms/room_main';
const auth = (who: string) => ({ Authorization: `Bearer local-${who}-fixture` });
type FileBody = { ok: boolean; data: { file: { id: string; sha256: string; availability: string }; replayed: boolean; files: { id: string }[] }; error?: { code: string } };
async function upload(who: string, key: string, bytes: Uint8Array, mime = 'application/pdf', extra: Record<string, string> = {}) {
  const r = await app.mf.dispatchFetch(`${base}/files`, { method: 'POST', body: bytes,
    headers: { ...auth(who), 'Content-Type': mime, 'Idempotency-Key': key, 'Content-Length': String(bytes.byteLength), 'Content-Disposition': "attachment; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf", ...extra } });
  return { status: r.status, body: await r.json() as FileBody };
}

test('HTTP files: upload, replay, download, list, room-scoped auth, sha mismatch', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 synthetic test bytes');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const up = await upload('alpha', 'file-http-0001', bytes);
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.data.file.sha256, sha);
  assert.equal(up.body.data.replayed, false);
  const again = await upload('alpha', 'file-http-0001', bytes);
  assert.equal(again.body.data.replayed, true);
  assert.equal(again.body.data.file.id, up.body.data.file.id);
  const id = up.body.data.file.id;
  const dl = await app.mf.dispatchFetch(`${base}/files/${id}`, { headers: auth('reader') });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.match(dl.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal(createHash('sha256').update(new Uint8Array(await dl.arrayBuffer())).digest('hex'), sha);
  const list = await app.mf.dispatchFetch(`${base}/files`, { headers: auth('reader') });
  assert.equal(list.status, 200);
  assert.ok((await list.json() as FileBody).data.files.some(f => f.id === id));
  assert.equal((await app.mf.dispatchFetch(`${base}/files/${id}`, { headers: auth('outsider') })).status, 403);
  assert.equal((await upload('reader', 'file-http-0002', bytes)).status, 403);
  const bad = await upload('alpha', 'file-http-0003', bytes, 'application/pdf', { 'X-Workroom-Sha256': '0'.repeat(64) });
  assert.notEqual(bad.status, 200);
  const html = await upload('alpha', 'file-http-0004', new TextEncoder().encode('<script>1</script>'), 'text/html');
  const hdl = await app.mf.dispatchFetch(`${base}/files/${html.body.data.file.id}`, { headers: auth('alpha') });
  assert.equal(hdl.headers.get('content-type'), 'application/octet-stream');
  await hdl.arrayBuffer();
});

test('HTTP file-links: Drive metadata only, write-gated', async () => {
  const body = { schema_version: '1', name: 'deck.pdf', mime: 'application/pdf', size_bytes: 1234, sha256: 'a'.repeat(64),
    drive_file_id: '1AbCdEfGhIjKlMnOpQ', web_link: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQ/view' };
  const send = (who: string, key: string) => app.mf.dispatchFetch(`${base}/file-links`, { method: 'POST', body: JSON.stringify(body),
    headers: { ...auth(who), 'Content-Type': 'application/json', 'Idempotency-Key': key } });
  const r = await send('alpha', 'file-link-0001');
  assert.equal(r.status, 200, await r.clone().text());
  const id = (await r.json() as FileBody).data.file.id;
  const meta = await app.mf.dispatchFetch(`${base}/files/${id}`, { headers: auth('reader') });
  assert.equal(meta.status, 200);
  assert.equal((await send('reader', 'file-link-0002')).status, 403);
});
