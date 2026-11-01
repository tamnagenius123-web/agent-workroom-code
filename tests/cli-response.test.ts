import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const meta = { request_id: 'synthetic-response-check', schema_version: '1', server_time: '2026-10-21T00:00:00.000Z' };
const identity = { principal_id: 'synthetic:alpha', synthetic: true, room_id: 'room_main', can_post: true };
interface Result { ok: boolean; error?: { code: string; outcome: string } }
async function probe(status: number, reply: unknown, mutation = false,argsOverride?:string[]) {
  let requests = 0;
  let receivedKey: string | undefined;
  const server = createServer((request, response) => {
    requests++;
    receivedKey = request.headers['idempotency-key'] as string | undefined;
    request.resume();
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const args = argsOverride??(mutation ? ['message','post','--room','room_main','--stdin','--idempotency-key','response-check-001'] : ['whoami']);
  const child = spawn(process.execPath, ['dist/workroom.mjs', ...args], {
    env: { ...process.env, WORKROOM_URL: `http://127.0.0.1:${address.port}`, WORKROOM_LOCAL_TOKEN: 'local-alpha-fixture' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += String(bytes); });
  child.stderr.on('data', bytes => { stderr += String(bytes); });
  child.stdin.end(mutation ? 'synthetic post' : '');
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    assert.equal(stdout.trim().split('\n').length, 1);
    return { code, body: JSON.parse(stdout) as Result, stderr, requests, receivedKey };
  } finally {
    child.kill(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('CLI rejects malformed read envelopes and HTTP/body success mismatch', async () => {
  const invalid: [number, unknown][] = [
    [503, { ok: true, meta: {} }],
    [503, { ok: true, data: identity, meta }],
    [200, { ok: 'false', data: identity, meta }],
    [200, { ok: true, meta }],
    [200, { ok: true, data: {}, meta }],
    [200, { ok: true, data: identity, meta: {} }],
    [200, { ok: false, error: { code: 'FORBIDDEN', message: 'Denied', retryable: false, outcome: 'not_applied' }, meta }],
    [401, { ok: false, error: {}, meta }],
  ];
  for (const [status, body] of invalid) {
    const result = await probe(status, body);
    assert.equal(result.code, 7, JSON.stringify({ status, body, result }));
    assert.equal(result.body.error?.outcome, 'not_applied');
    assert.equal(result.requests, 1); assert.ok(result.stderr.includes('TEMPORARY_FAILURE'));
  }
});

test('unexpected mutation response is unknown/exit 7 and never automatically retried', async () => {
  const stored = { message: { id: 'message-response-check', room_id: 'room_main', actor_id: 'synthetic:alpha',
    text: 'synthetic post', format: 'text', created_at: meta.server_time },
    operation: { type: 'message.post', idempotency_key: 'response-check-001' } };
  const postMeta = { ...meta, idempotency_key: 'response-check-001', replayed: false };
  for (const [status, body] of [
    [503, { ok: true, data: stored, meta: postMeta }],
    [200, { ok: true, meta: {} }],
    [200, { ok: true, data: stored, meta: { ...postMeta, idempotency_key: 'different-key-001' } }],
  ] as [number, unknown][]) {
    const result = await probe(status, body, true);
    assert.equal(result.code, 7); assert.equal(result.body.error?.outcome, 'unknown');
    assert.equal(result.requests, 1); assert.equal(result.receivedKey, 'response-check-001');
  }
  assert.equal((await probe(200, { ok: true, data: stored, meta: postMeta }, true)).code, 0);
});

test('valid read success and valid HTTP error retain normal exit classification', async () => {
  const success = await probe(200, { ok: true, data: identity, meta });
  assert.equal(success.code, 0); assert.equal(success.body.ok, true); assert.equal(success.stderr, '');
  const error = await probe(401, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Missing fixture', retryable: false, outcome: 'not_applied' }, meta });
  assert.equal(error.code, 3); assert.equal(error.body.error?.outcome, 'not_applied');
});

test('G2 CLI ties mutation and operation recovery responses to the requested action, not only key',async()=>{
  const postMeta={...meta,idempotency_key:'response-check-001',replayed:false};
  const data={thread:{id:'thread-id',room_id:'room_main',creator_id:'synthetic:alpha',title:'title',created_at:meta.server_time},operation:{type:'inbox.ack',idempotency_key:'response-check-001'}};
  const created=await probe(200,{ok:true,data,meta:postMeta},true,['thread','create','--room','room_main','--title','title','--idempotency-key','response-check-001']);
  assert.equal(created.code,7);assert.equal(created.body.error?.outcome,'unknown');
  const readArgs=['operation','get','--operation','inbox.ack','--idempotency-key','response-check-001'];
  const wrong=await probe(200,{ok:true,data:{...data,operation:{...data.operation,type:'thread.create'}},meta:postMeta},false,readArgs);
  assert.equal(wrong.code,7);assert.equal(wrong.body.error?.outcome,'not_applied');
  const good=await probe(200,{ok:true,data:{...data,operation:{...data.operation,type:'thread.create'}},meta:postMeta},false,['operation','get','--operation','thread.create','--idempotency-key','response-check-001']);
  assert.equal(good.code,0);
});

test('G3 CLI binds task actions, validates lease/state shape, and never mistakes another action for success',async()=>{
  const postMeta={...meta,idempotency_key:'response-check-001',replayed:false};
  const data={task:{id:'task',room_id:'room_main',creator_id:'synthetic:alpha',owner_id:null,goal:'goal',dependencies:[],input_versions:[],done_conditions:['verified'],state:'in_progress',version:2,current_submission_id:null,cancel_reason:null,created_at_ms:1000,updated_at_ms:2000,stop_confirmation:'unavailable_no_runner'},lease:{task_id:'task',holder_id:'synthetic:alpha',lease_epoch:1,expires_at_ms:32000},submission:null,server_time_ms:2000,lease_active:true,operation:{type:'task.claim',idempotency_key:'response-check-001'}};
  const args=['task','claim','--room','room_main','--task','task','--expected-version','1','--lease-epoch','0','--idempotency-key','response-check-001'];
  assert.equal((await probe(200,{ok:true,data,meta:postMeta},true,args)).code,0);
  for(const bad of [{...data,operation:{...data.operation,type:'task.renew'}},{...data,lease:{...data.lease,lease_epoch:'1'}},{...data,task:{...data.task,state:'executing'}}]){
    const r=await probe(200,{ok:true,data:bad,meta:postMeta},true,args);assert.equal(r.code,7);assert.equal(r.body.error?.outcome,'unknown');assert.equal(r.requests,1);
  }
  assert.equal((await probe(200,{ok:true,data,meta:postMeta},false,['operation','get','--operation','task.renew','--idempotency-key','response-check-001'])).code,7);
});
