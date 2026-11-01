import assert from 'node:assert/strict';
import { afterEach,beforeEach,test } from 'node:test';
import { spawn } from 'node:child_process';
import { harness } from '../scripts/local-harness.ts';
import type { Tasks } from '../src/server/tasks.ts';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type Bundle=Awaited<ReturnType<Tasks['get']>>['data'];
interface Body {ok:boolean;data:Bundle&{message:{id:string};changes_requested?:{submission_id:string;reviewer_id:string;reason:string}};meta:{replayed:boolean};error:{code:string}}
let app:Awaited<ReturnType<typeof harness>>;
beforeEach(async()=>{app=await harness();});afterEach(async()=>{await app.close();});
const room='/rooms/room_main',collection=room+'/tasks';
const ALPHA='local-alpha-fixture',BETA='local-beta-fixture',HUMAN='local-human-fixture';
async function api(path:string,body?:object,key?:string,token=ALPHA) {
  const response=await app.mf.dispatchFetch('http://127.0.0.1/api/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify({schema_version:'1',...body}):undefined});
  return {status:response.status,body:await response.json() as Body};
}
const act=(id:string,name:string,body:object,key:string=crypto.randomUUID(),token=ALPHA)=>api(collection+'/'+id+'/'+name,body,key,token);
const get=async(id:string)=>(await api(collection+'/'+id)).body.data;
const count=async(sql:string,...args:string[])=>(await app.db.prepare(sql).bind(...args).first<{n:number}>())!.n;
const pin=(b:Bundle)=>({expected_version:b.task.version,submission_id:b.submission!.id,artifact_message_id:b.submission!.artifact_message_id,artifact_revision:b.submission!.artifact_revision});
const requestChanges=(b:Bundle,extra:object={},key?:string,token=BETA)=>act(b.task.id,'request_changes',{...pin(b),reason:'tests missing',...extra},key,token);

/** alpha (agent, owner) claims and submits; returns the bundle in state review. */
async function inReview(text='artifact') {
  const made=(await api(collection,{goal:'goal',done_conditions:['verified'],owner:'synthetic:alpha'},crypto.randomUUID())).body.data;
  const c=await act(made.task.id,'claim',{expected_version:1,lease_epoch:0});assert.equal(c.status,200,JSON.stringify(c));
  return resubmit(c.body.data,text);
}
async function resubmit(claimed:Bundle,text:string) {
  const m=await api(room+'/messages',{text,format:'markdown'},crypto.randomUUID());assert.equal(m.status,200);
  const s=await act(claimed.task.id,'submit',{expected_version:claimed.task.version,lease_epoch:claimed.lease.lease_epoch,artifact_message_id:m.body.data.message.id,artifact_revision:1});
  assert.equal(s.status,200,JSON.stringify(s));assert.equal(s.body.data.task.state,'review');return s.body.data;
}

test('UXB-03 producer cannot request changes on its own submission; nothing changes',async()=>{
  const review=await inReview();const audits=await count('SELECT count(*) n FROM task_audit');
  const self=await requestChanges(review,{},undefined,ALPHA);
  assert.equal(self.status,403,JSON.stringify(self));
  assert.deepEqual((await get(review.task.id)).task,review.task);assert.equal(await count('SELECT count(*) n FROM task_audit'),audits);
});

test('UXB-03 non-author reviewer sends review back to open with reason; submission history and audit row kept',async()=>{
  const review=await inReview();const before=await app.db.prepare('SELECT * FROM task_submissions WHERE id=?').bind(review.submission!.id).first();
  const r=await requestChanges(review,{reason:'add the red test'},'rc-beta-001');
  assert.equal(r.status,200,JSON.stringify(r));
  const d=r.body.data;
  assert.equal(d.task.state,'open');assert.equal(d.task.version,review.task.version+1);assert.equal(d.task.current_submission_id,null);assert.equal(d.submission,null);
  assert.equal(d.task.owner_id,'synthetic:alpha');assert.equal(d.lease.holder_id,null);assert.equal(d.lease.expires_at_ms,0);assert.equal(d.lease_active,false);
  assert.deepEqual(d.changes_requested,{submission_id:review.submission!.id,reviewer_id:'synthetic:beta',reason:'add the red test'});
  assert.deepEqual(await app.db.prepare('SELECT * FROM task_submissions WHERE id=?').bind(review.submission!.id).first(),before);
  assert.equal(await count("SELECT count(*) n FROM task_audit WHERE operation='task.request_changes' AND principal_id='synthetic:beta' AND target_id=?",review.task.id),1);
  assert.deepEqual((await get(review.task.id)).task,d.task);
  const replay=await requestChanges(review,{reason:'add the red test'},'rc-beta-001');assert.equal(replay.status,200);assert.equal(replay.body.meta.replayed,true);
  const recovered=await api('/operations/task.request_changes/rc-beta-001',undefined,undefined,BETA);assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.body.data.changes_requested!.reason,'add the red test');
});

test('UXB-03 owner reclaims and resubmits; only the new submission is approvable',async()=>{
  const first=await inReview('v1');const open=(await requestChanges(first)).body.data;
  assert.equal((await act(open.task.id,'claim',{expected_version:open.task.version,lease_epoch:open.lease.lease_epoch},undefined,BETA)).status,403);
  const c=await act(open.task.id,'claim',{expected_version:open.task.version,lease_epoch:open.lease.lease_epoch});assert.equal(c.status,200,JSON.stringify(c));
  const second=await resubmit(c.body.data,'v2');assert.notEqual(second.submission!.id,first.submission!.id);
  assert.equal(await count('SELECT count(*) n FROM task_submissions WHERE task_id=?',first.task.id),2);
  assert.equal((await act(first.task.id,'approve',{...pin(first),expected_version:second.task.version},undefined,HUMAN)).status,409);
  const done=await act(first.task.id,'approve',pin(second),undefined,HUMAN);assert.equal(done.status,200,JSON.stringify(done));assert.equal(done.body.data.task.state,'done');
});

test('UXB-03 stale pin, wrong state, missing reason and reader are refused',async()=>{
  const review=await inReview();
  assert.equal((await requestChanges(review,{artifact_revision:2})).body.error.code,'TASK_CONFLICT');
  assert.equal((await requestChanges(review,{submission_id:crypto.randomUUID()})).status,409);
  assert.equal((await requestChanges(review,{expected_version:review.task.version+1})).status,409);
  assert.equal((await act(review.task.id,'request_changes',pin(review),undefined,BETA)).status,400);
  assert.equal((await requestChanges(review,{reason:''})).status,400);
  assert.equal((await requestChanges(review,{},undefined,'local-reader-fixture')).status,403);
  assert.equal((await get(review.task.id)).task.state,'review');
  const human=await requestChanges(review,{reason:'owner says redo'},undefined,HUMAN);assert.equal(human.status,200,JSON.stringify(human));
  assert.equal((await requestChanges(review,{expected_version:human.body.data.task.version})).status,409);
});

test('UXB-03 MCP tool and CLI command reach the same action',async()=>{
  const review=await inReview();
  const client=new Client({name:'uxb-03',version:'0.0.1'},{versionNegotiation:{mode:'auto'}});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',app.url),{requestInit:{headers:{Authorization:'Bearer '+BETA}}}));
  try{
    const r=await client.callTool({name:'workroom_task_request_changes',arguments:{schema_version:'1',room:'room_main',task_id:review.task.id,...pin(review),reason:'via mcp',idempotency_key:'mcp-rc-001'}});
    assert.equal(r.isError,false,JSON.stringify(r));assert.equal((r.structuredContent as Body).data.task.state,'open');
  }finally{await client.close();}
  const again=await inReview('cli');
  const p=spawn(process.execPath,['dist/workroom.mjs','task','request_changes','--room','room_main','--task',again.task.id,'--expected-version',String(again.task.version),'--submission',again.submission!.id,'--artifact-message',again.submission!.artifact_message_id,'--artifact-revision','1','--reason','via cli','--idempotency-key','cli-rc-001'],{env:{...process.env,WORKROOM_URL:app.url,WORKROOM_LOCAL_TOKEN:BETA},stdio:['ignore','pipe','pipe']});
  let out='',err='';p.stdout.on('data',v=>{out+=String(v);});p.stderr.on('data',v=>{err+=String(v);});
  const code=await new Promise<number|null>(resolve=>p.once('close',resolve));assert.equal(code,0,err+out);
  assert.equal((JSON.parse(out) as Body).data.task.state,'open');
});
