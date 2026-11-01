import test from 'node:test';
import assert from 'node:assert/strict';
import { bodySchema, readSchema, keySchema } from '../src/server/contracts.ts';
import { boundedBody } from '../src/server/app.ts';

test('shared input contracts preserve text, enforce UTF-8 byte bounds and reject spoofed fields', () => {
  const text = '# Request\n\n<svg onload=alert(1)> ![image](https://invalid.test/x)';
  assert.equal(bodySchema.parse({ schema_version: '1', text }).text, text);
  assert.equal(bodySchema.parse({ schema_version: '1', text }).format, 'text');
  for (const extra of ['actor_id','role','sender','name']) assert.equal(bodySchema.safeParse({ schema_version: '1', text, [extra]: 'admin' }).success, false);
  for (const value of ['', '  \n', '\0', '\ud800', '한'.repeat(10923)]) assert.equal(bodySchema.safeParse({ schema_version: '1', text: value }).success, false);
  assert.equal(bodySchema.safeParse({ schema_version: '1', text: 'x'.repeat(32768) }).success, true);
  assert.equal(readSchema.safeParse({ schema_version: '1', room: 'room_main', limit: 101 }).success, false);
  assert.equal(keySchema.safeParse('bad key').success, false);
});

test('streaming request limit works without Content-Length and rejects malformed UTF-8', async () => {
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(30000)); c.enqueue(new Uint8Array(30000)); c.close(); } });
  await assert.rejects(boundedBody(new Request('http://127.0.0.1', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)), /48 KiB/);
  await assert.rejects(boundedBody(new Request('http://127.0.0.1', { method: 'POST', body: new Uint8Array([0xc3, 0x28]) })), /UTF-8/);
});
