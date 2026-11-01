import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach,beforeEach,test } from 'node:test';
import { harness } from '../scripts/local-harness.ts';

interface Result {data:{message?:{id:string};task?:{id:string;state:string;version:number};lease?:{lease_epoch:number;holder_id:string|null}};meta:{idempotency_key:string;replayed:boolean}}
interface Body {ok:boolean;data:{results:Result[]};error:{code:string;outcome:string;index?:number;op?:string;cause?:{code:string}}}
let app:Awaited<ReturnType<typeof harness>>;
beforeEach(async()=>{app=await harness();});afterEach(async()=>{await app.close();});
const room='room_main';
async function call(path:string,body?:object,token='local-alpha-fixture',key?:string) {
  const response=await app.mf.dispatchFetch('http://127.0.0.1/api/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify({schema_version:'1',...body}):undefined});
  return {status:response.status,body:await response.json() as Body};
}
const batch=(ops:object[],token?:string)=>call('/batch',{ops},token);
const key=()=>'e3-'+crypto.randomUUID();
async function count(table:string){return (await app.db.prepare('SELECT count(*) n FROM '+table).first<{n:number}>())!.n;}
async function openTask() {
  const r=await call('/rooms/'+room+'/tasks',{goal:'goal',done_conditions:['verified']},'local-alpha-fixture',key());
  assert.equal(r.status,200,JSON.stringify(r));return (r.body.data as unknown as Required<Result['data']>).task;
}

test('E3 /v1/batch applies post + task.create + task.claim in one call and returns per-op results in order',async()=>{
  const open=await openTask();
  const r=await batch([
    {op:'message.post',room,idempotency_key:key(),text:'claiming the task',format:'text'},
    {op:'task.create',room,idempotency_key:key(),goal:'follow-up',done_conditions:['done']},
    {op:'task.claim',room,idempotency_key:key(),task_id:open.id,expected_version:open.version,lease_epoch:0},
  ]);
  assert.equal(r.status,200,JSON.stringify(r));
  const [post,created,claimed]=r.body.data.results;
  assert.equal(r.body.data.results.length,3);
  assert.equal(post!.data.message!.id.length>0,true);
  assert.equal(created!.data.task!.state,'open');
  assert.equal(claimed!.data.task!.state,'in_progress');assert.equal(claimed!.data.lease!.holder_id,'synthetic:alpha');
  assert.equal((await app.db.prepare('SELECT state FROM tasks WHERE id=?').bind(open.id).first<{state:string}>())!.state,'in_progress');
});

test('E3 /v1/batch is atomic: one stale op aborts the batch, nothing is written, and the error names the failing op',async()=>{
  const open=await openTask();
  const before={messages:await count('messages'),operations:await count('operations'),tasks:await count('tasks'),audit:await count('task_audit')};
  const r=await batch([
    {op:'message.post',room,idempotency_key:key(),text:'should not land',format:'text'},
    {op:'task.create',room,idempotency_key:key(),goal:'should not land',done_conditions:['done']},
    {op:'task.claim',room,idempotency_key:key(),task_id:open.id,expected_version:open.version+5,lease_epoch:0},
  ]);
  assert.equal(r.status,409,JSON.stringify(r));
  assert.equal(r.body.error.code,'BATCH_ABORTED');assert.equal(r.body.error.outcome,'not_applied');
  assert.equal(r.body.error.index,2);assert.equal(r.body.error.op,'task.claim');assert.equal(r.body.error.cause!.code,'VERSION_CONFLICT');
  assert.deepEqual({messages:await count('messages'),operations:await count('operations'),tasks:await count('tasks'),audit:await count('task_audit')},before);
});

test('E3 /v1/batch replays per-op idempotency keys without duplicates; a changed body under a used key aborts with IDEMPOTENCY_CONFLICT',async()=>{
  const ops=[{op:'message.post',room,idempotency_key:key(),text:'once',format:'text'},{op:'task.create',room,idempotency_key:key(),goal:'once',done_conditions:['done']}];
  const first=await batch(ops);assert.equal(first.status,200,JSON.stringify(first));
  const messages=await count('messages'),tasks=await count('tasks');
  const again=await batch(ops);assert.equal(again.status,200,JSON.stringify(again));
  assert.deepEqual(again.body.data.results.map(x=>x.meta.replayed),[true,true]);
  assert.equal(again.body.data.results[0]!.data.message!.id,first.body.data.results[0]!.data.message!.id);
  assert.equal(await count('messages'),messages);assert.equal(await count('tasks'),tasks);
  const changed=await batch([{op:'message.post',room,idempotency_key:key(),text:'fresh',format:'text'},{...ops[1]!,goal:'different'}]);
  assert.equal(changed.status,409);assert.equal(changed.body.error.code,'BATCH_ABORTED');assert.equal(changed.body.error.index,1);assert.equal(changed.body.error.cause!.code,'IDEMPOTENCY_CONFLICT');
  assert.equal(await count('messages'),messages);
});

test('E3 refactor keeps the message.post request hash byte-identical, so keys written before E3 still replay',async()=>{
  const k=key(),text='hash pin';
  assert.equal((await batch([{op:'message.post',room,idempotency_key:k,text,format:'text'}])).status,200);
  const stored=await app.db.prepare("SELECT request_hash FROM operations WHERE operation='message.post' AND key=?").bind(k).first<{request_hash:string}>();
  assert.equal(stored!.request_hash,createHash('sha256').update(JSON.stringify({schema_version:'1',room,text,format:'text'})).digest('hex'));
});

test('E3 /v1/batch runs the full 50-op cap as one D1 batch',async()=>{
  const messages=await count('messages');
  const r=await batch(Array.from({length:50},(_,i)=>({op:'message.post',room,idempotency_key:key(),text:'bulk '+i,format:'text'})));
  assert.equal(r.status,200,JSON.stringify(r).slice(0,400));assert.equal(r.body.data.results.length,50);
  assert.equal(await count('messages'),messages+50);
});

test('E3 /v1/batch rejects bad shapes before touching storage: empty, >50 ops, unknown op, reused key, same task twice, read-only token',async()=>{
  const open=await openTask(),operations=await count('operations');
  const post=()=>({op:'message.post',room,idempotency_key:key(),text:'x',format:'text'});
  for(const ops of [[],Array.from({length:51},post),[{op:'message.delete',room,idempotency_key:key()}]]) assert.equal((await batch(ops)).body.error.code,'INVALID_INPUT');
  const dup=post();assert.equal((await batch([dup,{...dup}])).body.error.code,'INVALID_INPUT');
  const claim={op:'task.claim',room,task_id:open.id,expected_version:1,lease_epoch:0};
  assert.equal((await batch([{...claim,idempotency_key:key()},{...claim,idempotency_key:key()}])).body.error.code,'INVALID_INPUT');
  const ro=await batch([post()],'local-reader-fixture');assert.equal(ro.status,403);
  assert.equal(await count('operations'),operations);
});

test('E3 /v1/batch per-op 400s name index, op and cause: unknown op and schema mismatch at index 1, nothing written',async()=>{
  const messages=await count('messages'),operations=await count('operations');
  const post=()=>({op:'message.post',room,idempotency_key:key(),text:'x',format:'text'});
  const unknown=await batch([post(),{op:'message.delete',room,idempotency_key:key()}]);
  assert.equal(unknown.status,400,JSON.stringify(unknown));assert.equal(unknown.body.error.code,'INVALID_INPUT');
  assert.equal(unknown.body.error.index,1);assert.equal(unknown.body.error.op,'message.delete');assert.equal(unknown.body.error.cause!.code,'UNKNOWN_OPERATION');
  const bad=await batch([post(),{op:'message.post',room,idempotency_key:key(),format:'text'}]);
  assert.equal(bad.status,400,JSON.stringify(bad));assert.equal(bad.body.error.code,'INVALID_INPUT');
  assert.equal(bad.body.error.index,1);assert.equal(bad.body.error.op,'message.post');assert.equal(bad.body.error.cause!.code,'SCHEMA_MISMATCH');
  assert.equal(await count('messages'),messages);assert.equal(await count('operations'),operations);
});

test('E3 rev3 malformed entries are entry-level 400s with index and cause; op is the raw value or null; nothing written',async()=>{
  const messages=await count('messages'),operations=await count('operations');
  const post=()=>({op:'message.post',room,idempotency_key:key(),text:'x',format:'text'});
  const base={room,idempotency_key:'e3-malformed'};
  const cases:[unknown,unknown,string][]=[
    [base,null,'MALFORMED_OP'],[{...base,op:123},123,'MALFORMED_OP'],[{...base,op:null},null,'MALFORMED_OP'],
    [{...base,op:{}},{},'MALFORMED_OP'],[{...base,op:['message.post']},['message.post'],'MALFORMED_OP'],
    [null,null,'MALFORMED_ENTRY'],['message.post',null,'MALFORMED_ENTRY'],[7,null,'MALFORMED_ENTRY'],[[post()],null,'MALFORMED_ENTRY'],
  ];
  for(const [entry,op,cause] of cases){
    const r=await batch([post(),entry as object]),label=JSON.stringify(entry)+' -> '+JSON.stringify(r);
    assert.equal(r.status,400,label);assert.equal(r.body.error.code,'INVALID_INPUT',label);
    assert.equal(r.body.error.index,1,label);assert.equal(r.body.error.cause?.code,cause,label);
    assert.ok('op' in r.body.error,label);assert.deepEqual(r.body.error.op,op,label);
  }
  assert.equal(await count('messages'),messages);assert.equal(await count('operations'),operations);
});

test('E3 rev3 envelope-level errors name no entry: missing ops, non-array ops, empty, >50',async()=>{
  const post=()=>({op:'message.post',room,idempotency_key:key(),text:'x',format:'text'});
  for(const body of [{},{ops:{}},{ops:'x'},{ops:[]},{ops:Array.from({length:51},post)}]){
    const r=await call('/batch',body),label=JSON.stringify(body).slice(0,80)+' -> '+JSON.stringify(r);
    assert.equal(r.status,400,label);assert.equal(r.body.error.code,'INVALID_INPUT',label);
    assert.equal('index' in r.body.error,false,label);
  }
});
