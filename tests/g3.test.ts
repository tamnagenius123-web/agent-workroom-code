import assert from 'node:assert/strict';
import { afterEach,beforeEach,test } from 'node:test';
import { spawn } from 'node:child_process';
import { taskFixtures } from '../scripts/task-fixtures.ts';
import { harness,migrate } from '../scripts/local-harness.ts';
import { Workroom } from '../src/server/domain.ts';
import { taskSchemas } from '../src/server/task-contracts.ts';
import type { Tasks } from '../src/server/tasks.ts';
import type { Database } from '../src/server/db.ts';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

type Bundle=Awaited<ReturnType<Tasks['get']>>['data'];
interface Body {ok:boolean;data:Bundle&{message:{id:string};operation:{type:string;idempotency_key:string}};meta:{replayed:boolean};error:{code:string;outcome:string}}
let app:Awaited<ReturnType<typeof harness>>;
beforeEach(async()=>{app=await harness();});afterEach(async()=>{await app.close();});
const room='/rooms/room_main',collection=room+'/tasks';
async function api(path:string,body?:object,key?:string,token='local-alpha-fixture') {
  const response=await app.mf.dispatchFetch('http://127.0.0.1/api/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify({schema_version:'1',...body}):undefined});
  return {status:response.status,body:await response.json() as Body};
}
async function create(extra:object={},key:string=crypto.randomUUID(),token='local-alpha-fixture') {const r=await api(collection,{goal:'goal',done_conditions:['verified'],...extra},key,token);assert.equal(r.status,200,JSON.stringify(r));return r.body.data;}
const act=(id:string,name:string,body:object,key:string=crypto.randomUUID(),token='local-alpha-fixture')=>api(collection+'/'+id+'/'+name,body,key,token);
const get=async(id:string,token='local-alpha-fixture')=>(await api(collection+'/'+id,undefined,undefined,token)).body.data;
const claim=(b:Bundle,key?:string,token?:string)=>act(b.task.id,'claim',{expected_version:b.task.version,lease_epoch:b.lease.lease_epoch},key,token);
async function claimed(extra:object={}) {const r=await claim(await create(extra));assert.equal(r.status,200,JSON.stringify(r));return r.body.data;}
async function artifact(text='artifact',token='local-alpha-fixture'){const r=await api(room+'/messages',{text,format:'markdown'},crypto.randomUUID(),token);assert.equal(r.status,200);return r.body.data.message.id;}
const submit=(b:Bundle,message_id:string,extra:object={},key?:string,token?:string)=>act(b.task.id,'submit',{expected_version:b.task.version,lease_epoch:b.lease.lease_epoch,artifact_message_id:message_id,artifact_revision:1,...extra},key,token);
const approve=(b:Bundle,extra:object={},key?:string,token='local-human-fixture')=>act(b.task.id,'approve',{expected_version:b.task.version,submission_id:b.submission!.id,artifact_message_id:b.submission!.artifact_message_id,artifact_revision:b.submission!.artifact_revision,...extra},key,token);
async function count(table:string){return (await app.db.prepare('SELECT count(*) n FROM '+table).first<{n:number}>())!.n;}
async function cli(args:string[],input='',token='local-alpha-fixture') {
  const p=spawn(process.execPath,['dist/workroom.mjs',...args],{env:{...process.env,WORKROOM_URL:app.url,WORKROOM_LOCAL_TOKEN:token},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',v=>{stdout+=String(v);});p.stderr.on('data',v=>{stderr+=String(v);});p.stdin.end(input);
  const code=await new Promise<number|null>((resolve,reject)=>{p.once('close',resolve);p.once('error',reject);});assert.equal(stdout.trim().split('\n').length,1);return {code,stderr,body:JSON.parse(stdout) as Body};
}

test('G3 twenty concurrent claims have one winner; lease is separate, server-timed and explicit renew increments version only',async()=>{
  const task=await create();const results=await Promise.all(Array.from({length:20},(_,i)=>claim(task,'claim-race-'+String(i).padStart(3,'0'),i%2?'local-beta-fixture':'local-alpha-fixture')));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,19);
  const winner=results.find(r=>r.status===200)!.body.data;assert.equal(winner.task.state,'in_progress');assert.equal(winner.task.version,2);assert.equal(winner.lease.lease_epoch,1);assert.equal(winner.lease.expires_at_ms-winner.server_time_ms,30000);
  assert.ok(!('lease_epoch' in winner.task));assert.equal(await count('task_audit'),2);
  const token=winner.lease.holder_id==='synthetic:alpha'?'local-alpha-fixture':'local-beta-fixture';
  const renewed=await act(task.task.id,'renew',{expected_version:2,lease_epoch:1},'renew-current-001',token);assert.equal(renewed.status,200,JSON.stringify(renewed));assert.equal(renewed.body.data.task.version,3);assert.equal(renewed.body.data.lease.lease_epoch,1);
  assert.equal((await act(task.task.id,'renew',{expected_version:2,lease_epoch:1},'renew-stale-001',token)).body.error.code,'VERSION_CONFLICT');
  assert.equal((await act(task.task.id,'renew',{expected_version:3,lease_epoch:2},'renew-epoch-001',token)).body.error.code,'LEASE_CONFLICT');
});

test('G3 expiry and explicit reclaim fence old epoch/version; late results never change canonical state or submission count',async()=>{
  const old=await claimed(),a=await artifact();await app.db.prepare('UPDATE task_leases SET expires_at_ms=0 WHERE task_id=?').bind(old.task.id).run();
  assert.equal((await get(old.task.id)).task.state,'in_progress'); // no automatic allocation
  assert.equal((await submit(old,a)).body.error.code,'LEASE_CONFLICT');
  assert.equal((await act(old.task.id,'renew',{expected_version:1,lease_epoch:1})).body.error.code,'LEASE_CONFLICT');
  const next=await claim(await get(old.task.id),undefined,'local-beta-fixture');assert.equal(next.status,200);assert.equal(next.body.data.lease.lease_epoch,2);
  const state=await get(old.task.id),late=await submit(old,a);assert.equal(late.status,409);assert.equal(late.body.error.code,'LEASE_CONFLICT');assert.equal(late.body.error.outcome,'not_applied');
  assert.deepEqual((await get(old.task.id)).task,state.task);assert.equal(await count('task_submissions'),0);
  const b=await artifact('beta','local-beta-fixture');assert.equal((await submit(next.body.data,b,{},undefined,'local-beta-fixture')).status,200);
});

test('G3 agents submit review only; assigned owner cannot approve; human approval pins exact retained artifact revision',async()=>{
  const b=await claimed({owner:'synthetic:alpha'}),id=await artifact();const r=await submit(b,id);assert.equal(r.status,200,JSON.stringify(r));const review=r.body.data;
  assert.equal(review.task.state,'review');assert.equal(review.lease.expires_at_ms,0);assert.equal(review.lease_active,false);
  assert.equal((await approve(review,{},undefined,'local-alpha-fixture')).status,403);
  assert.equal((await approve(review,{artifact_revision:2})).body.error.code,'TASK_CONFLICT');
  assert.equal((await approve(review,{submission_id:crypto.randomUUID()})).status,409);
  assert.equal((await api(room+'/messages/'+id+'/revisions',{expected_version:1,text:'newer artifact'},'artifact-edit-001')).status,200);
  const done=await approve(review,{},'approve-exact-001');assert.equal(done.status,200,JSON.stringify(done));assert.equal(done.body.data.task.state,'done');assert.equal(done.body.data.submission!.artifact_revision,1);
  assert.equal((await act(b.task.id,'cancel',{expected_version:done.body.data.task.version,reason:'too late'})).status,409);
  assert.equal((await claim(done.body.data)).status,409);assert.equal((await approve(review,{},'approve-exact-001')).body.meta.replayed,true);
  await assert.rejects(app.db.prepare("UPDATE task_submissions SET artifact_revision=2 WHERE task_id=?").bind(b.task.id).run(),/immutable/);
});

test('G3 cancel fences late submit, clears current result, preserves historical replay and never claims external stop',async()=>{
  const b=await claimed(),id=await artifact(),key='submitted-old-001';const review=(await submit(b,id,{},key)).body.data;
  const canceled=await act(b.task.id,'cancel',{expected_version:review.task.version,reason:'cancel explicitly'},'cancel-task-001');assert.equal(canceled.status,200);
  assert.equal(canceled.body.data.task.state,'canceled');assert.equal(canceled.body.data.task.current_submission_id,null);assert.equal(canceled.body.data.submission,null);assert.equal(canceled.body.data.task.stop_confirmation,'unavailable_no_runner');assert.ok(!('stop_confirmed' in canceled.body.data.task));
  assert.equal((await submit(b,id)).body.error.code,'LEASE_CONFLICT');assert.equal(await count('task_submissions'),1);
  const replay=await submit(b,id,{},key);assert.equal(replay.status,200);assert.equal(replay.body.meta.replayed,true);assert.equal(replay.body.data.task.state,'review');
  assert.equal((await get(b.task.id)).task.state,'canceled');
  assert.equal((await submit(b,id,{artifact_revision:2},key)).body.error.code,'IDEMPOTENCY_CONFLICT');
  assert.equal((await approve(review)).status,409);
  const ownerOnly=await create({owner:'synthetic:beta'});assert.equal((await act(ownerOnly.task.id,'cancel',{expected_version:1,reason:'not creator'},undefined,'local-beta-fixture')).status,403);
});

test('G3 blocked/dependencies/pinned inputs stay immutable and room-bound; claim does not grant owner reviewer authority',async()=>{
  const dep=await create(),id=await artifact();const child=await create({dependencies:[dep.task.id],input_versions:[{message_id:id,revision:1}],owner:'synthetic:alpha'});
  assert.equal((await claim(child)).body.error.code,'DEPENDENCY_CONFLICT');assert.equal((await claim(child,undefined,'local-beta-fixture')).status,403);
  const c=(await claim(dep)).body.data,review=(await submit(c,id)).body.data;await approve(review);
  const running=(await claim(child)).body.data;const blocked=await submit(running,id,{disposition:'blocked',reason:'needs input'});assert.equal(blocked.status,200);assert.equal(blocked.body.data.task.state,'blocked');assert.equal(blocked.body.data.task.current_submission_id,null);
  assert.equal((await claim(blocked.body.data)).status,200);assert.equal(await count('task_submissions'),2);
  assert.equal((await api(collection,{goal:'x',done_conditions:['x'],dependencies:[dep.task.id,dep.task.id]},'duplicate-deps-001')).status,400);
  assert.equal((await api(collection,{goal:'x',done_conditions:['x'],input_versions:[{message_id:id,revision:99}]},'absent-input-001')).status,400);
  await app.db.prepare("INSERT INTO rooms(id) VALUES ('foreign')").run();
  await app.db.prepare("INSERT INTO messages(id,room_id,actor_id,text,format,created_at) VALUES ('foreign-message','foreign','synthetic:alpha','private','text','2026-01-01T00:00:00.000Z')").run();
  assert.equal((await api(collection,{goal:'x',done_conditions:['x'],input_versions:[{message_id:'foreign-message',revision:1}]},'foreign-input-001')).status,400);
  assert.equal((await api('/rooms/foreign/tasks/'+child.task.id)).status,403);
  await app.db.prepare("INSERT INTO tasks(id,room_id,creator_id,spec_json,state,version,created_at_ms,updated_at_ms) VALUES ('foreign-task','foreign','synthetic:alpha','{}','open',1,0,0)").run();
  assert.equal((await api(collection,{goal:'x',done_conditions:['x'],dependencies:['foreign-task']},'foreign-dependency-001')).status,400);
  assert.equal((await submit(await claimed(),'foreign-message')).status,400);
  await assert.rejects(app.db.prepare("UPDATE tasks SET spec_json='{}',version=version+1 WHERE id=?").bind(child.task.id).run(),/immutable task spec/);
});

test('G3 all task effects/result/audit roll back together and same keys recover across six mutations',async()=>{
  const id=await artifact();
  async function fault(call:()=>ReturnType<typeof api>,inspect:()=>Promise<void>){await app.db.prepare("CREATE TRIGGER fail_task BEFORE INSERT ON task_audit BEGIN SELECT RAISE(ABORT,'injected'); END").run();try{assert.equal((await call()).status,503);await inspect();}finally{await app.db.prepare('DROP TRIGGER fail_task').run();}assert.equal((await call()).status,200);}
  await fault(()=>api(collection,{goal:'rollback',done_conditions:['x']},'atomic-create-001'),async()=>assert.equal(await count('tasks'),0));
  let b=await get((await api('/operations/task.create/atomic-create-001')).body.data.task.id);
  await fault(()=>act(b.task.id,'claim',{expected_version:1,lease_epoch:0},'atomic-claim-001'),async()=>assert.equal((await get(b.task.id)).task.version,1));b=await get(b.task.id);
  await fault(()=>act(b.task.id,'renew',{expected_version:2,lease_epoch:1},'atomic-renew-001'),async()=>assert.equal((await get(b.task.id)).task.version,2));b=await get(b.task.id);
  await fault(()=>submit(b,id,{},'atomic-submit-001'),async()=>{assert.equal(await count('task_submissions'),0);assert.equal((await get(b.task.id)).task.state,'in_progress');assert.equal((await api('/operations/task.submit/atomic-submit-001')).status,404);});b=await get(b.task.id);
  await fault(()=>approve(b,{},'atomic-approve-001'),async()=>assert.equal((await get(b.task.id)).task.state,'review'));
  const cancelable=await claimed();await fault(()=>act(cancelable.task.id,'cancel',{expected_version:2,reason:'atomic'},'atomic-cancel-001'),async()=>assert.equal((await get(cancelable.task.id)).task.state,'in_progress'));
});

test('G3 current principal/membership/write/role authority applies to replay and transaction-time revocation',async()=>{
  const b=await claimed(),id=await artifact();const review=(await submit(b,id,{},'revoke-submit-001')).body.data;
  const approved=await approve(review,{},'revoke-approve-001');assert.equal(approved.status,200);
  await app.db.prepare("UPDATE principal_roles SET kind='agent' WHERE principal_id='synthetic:human'").run();assert.equal((await approve(review,{},'revoke-approve-001')).status,403);
  await app.db.prepare("UPDATE memberships SET active=0 WHERE principal_id='synthetic:alpha'").run();assert.equal((await submit(b,id,{},'revoke-submit-001')).status,403);assert.equal((await api(collection+'/'+b.task.id)).status,403);
  await app.db.prepare("UPDATE memberships SET active=1 WHERE principal_id='synthetic:alpha'").run();
  const db=app.db as unknown as Database;
  await app.db.prepare("UPDATE principal_roles SET kind='user' WHERE principal_id='synthetic:human'").run();
  const reviewer=new Workroom({prepare:s=>db.prepare(s),batch:async statements=>{await app.db.prepare("UPDATE principal_roles SET kind='agent' WHERE principal_id='synthetic:human'").run();return db.batch(statements);}},'synthetic:human');
  await assert.rejects(reviewer.tasks.action('approve',taskSchemas.approve.parse({schema_version:'1',room:'room_main',task_id:b.task.id,expected_version:review.task.version,submission_id:review.submission!.id,artifact_message_id:id,artifact_revision:1,idempotency_key:'revoke-approve-001'})),/denied/);
  for(const sql of ["UPDATE memberships SET can_post=0 WHERE principal_id='synthetic:alpha'","UPDATE principals SET active=0 WHERE id='synthetic:alpha'","DELETE FROM principal_roles WHERE principal_id='synthetic:alpha'"]){
    await app.db.batch([app.db.prepare("UPDATE memberships SET can_post=1 WHERE principal_id='synthetic:alpha'"),app.db.prepare("UPDATE principals SET active=1 WHERE id='synthetic:alpha'"),app.db.prepare("INSERT INTO principal_roles(principal_id,kind) VALUES ('synthetic:alpha','agent') ON CONFLICT(principal_id) DO UPDATE SET kind='agent'")]);
    const service=new Workroom({prepare:s=>db.prepare(s),batch:async statements=>{await app.db.prepare(sql).run();return db.batch(statements);}},'synthetic:alpha');
    await assert.rejects(service.tasks.action('submit',taskSchemas.submit.parse({schema_version:'1',room:'room_main',task_id:b.task.id,expected_version:2,lease_epoch:1,artifact_message_id:id,artifact_revision:1,idempotency_key:'revoke-submit-001'})),/denied/);
  }
});

test('G3 REST/CLI/official MCP parity includes same-key nested spec replay and human approval action recovery',async()=>{
  const spec={goal:'from CLI',done_conditions:['tested'],input_versions:[]};
  const made=await cli(['task','create','--room','room_main','--stdin','--idempotency-key','cli-task-create-001'],JSON.stringify(spec));assert.equal(made.code,0,made.stderr);
  const client=new Client({name:'g3-synthetic',version:'0.0.1'},{versionNegotiation:{mode:'auto'}});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',app.url),{requestInit:{headers:{Authorization:'Bearer local-alpha-fixture'}}}));
  try{
    const replay=await client.callTool({name:'workroom_task_create',arguments:{schema_version:'1',room:'room_main',...spec,idempotency_key:'cli-task-create-001'}});assert.equal(replay.isError,false,JSON.stringify(replay));assert.deepEqual((replay.structuredContent as Body).data,made.body.data);
    const id=made.body.data.task.id;const c=await cli(['task','claim','--room','room_main','--task',id,'--expected-version','1','--lease-epoch','0','--idempotency-key','cli-task-claim-001']);assert.equal(c.code,0,c.stderr);
    const renew=await client.callTool({name:'workroom_task_renew',arguments:{schema_version:'1',room:'room_main',task_id:id,expected_version:2,lease_epoch:1,idempotency_key:'mcp-task-renew-001'}});assert.equal(renew.isError,false,JSON.stringify(renew));
    const a=await artifact();const r=await cli(['task','submit','--room','room_main','--task',id,'--expected-version','3','--lease-epoch','1','--artifact-message',a,'--artifact-revision','1','--idempotency-key','cli-task-submit-001']);assert.equal(r.code,0,r.stderr);
    const approved=await approve(r.body.data,{},'human-task-approve-001');assert.equal(approved.status,200);
    const recovered=await cli(['operation','get','--operation','task.approve','--idempotency-key','human-task-approve-001'],'','local-human-fixture');assert.equal(recovered.code,0,recovered.stderr);assert.deepEqual(recovered.body.data,approved.body.data);
    const fetched=await client.callTool({name:'workroom_task_get',arguments:{schema_version:'1',room:'room_main',task_id:id}});assert.equal((fetched.structuredContent as Body).data.task.state,'done');
    assert.equal((await cli(['task','submit','--room','room_main','--task',id,'--expected-version','3','--lease-epoch','1','--artifact-message',a,'--artifact-revision','1','--idempotency-key','cli-task-late-001'])).code,5);
  }finally{await client.close();}
});

test('G3 fresh duplicate create keys/recovery and upgrade preserve G2 messages/events/operation bytes',async()=>{
  const specs={goal:'same',done_conditions:['same']};const repeated=await Promise.all(Array.from({length:10},()=>api(collection,specs,'task-same-key-001')));assert.ok(repeated.every(r=>r.status===200),JSON.stringify(repeated));assert.equal(new Set(repeated.map(r=>r.body.data.task.id)).size,1);assert.equal(await count('tasks'),1);assert.equal(await count('task_audit'),1);
  assert.equal((await api(collection,{...specs,goal:'different'},'task-same-key-001')).status,409);
  await app.close();app=await harness({through:2});const a=await artifact();const old=await api('/operations/message.post/not-recorded-001');assert.equal(old.status,404);
  const messages=(await api(room+'/messages')).body.data;const events=await count('room_events'),operation=await app.db.prepare("SELECT result_json FROM operations WHERE operation='message.post'").first();await migrate(app.db,3);
  assert.deepEqual((await api(room+'/messages')).body.data,messages);assert.equal(await count('room_events'),events);assert.equal(await count('tasks'),0);assert.equal((await api(room+'/messages/'+a+'/history')).status,200);assert.deepEqual(await app.db.prepare("SELECT result_json FROM operations WHERE operation='message.post'").first(),operation);
  await taskFixtures(app.db);await app.db.prepare("UPDATE principal_roles SET kind='agent' WHERE principal_id='synthetic:human'").run();await taskFixtures(app.db);assert.equal((await app.db.prepare("SELECT kind FROM principal_roles WHERE principal_id='synthetic:human'").first<{kind:string}>())!.kind,'agent');
});

test('G3 strict identity/state/time inputs reject and current membership protects all endpoints including late results',async()=>{
  const b=await claimed(),a=await artifact();
  for(const fields of [{actor_id:'synthetic:human'},{state:'done'},{role:'user'},{server_time_ms:0},{expires_at_ms:9999999999999}])assert.equal((await act(b.task.id,'submit',{expected_version:2,lease_epoch:1,artifact_message_id:a,artifact_revision:1,...fields})).status,400);
  assert.equal((await submit(b,await artifact('beta','local-beta-fixture'))).status,400);
  assert.equal((await api(collection,{goal:'x',done_conditions:['x'],owner:'synthetic:human'},'human-owner-001')).status,400);
  assert.equal((await api(collection,{goal:'x',done_conditions:['x']},'reader-task-001','local-reader-fixture')).status,403);
  await app.db.prepare("UPDATE memberships SET active=0 WHERE principal_id='synthetic:alpha'").run();
  assert.equal((await submit(b,a)).status,403);assert.equal((await claim(b)).status,403);assert.equal((await getRaw(b.task.id,'local-outsider-fixture')).status,403);
  function getRaw(id:string,token:string){return api(collection+'/'+id,undefined,undefined,token);}
});

test('G3 lost committed response gives CLI unknown and same-key recovery preserves a single claim/lease/audit',async()=>{
  const b=await create(),{createServer}=await import('node:http');let requests=0;
  const server=createServer(async(req,res)=>{requests++;const body:Buffer[]=[];for await(const chunk of req)body.push(Buffer.from(chunk));const committed=await app.mf.dispatchFetch('http://127.0.0.1'+req.url,{method:'POST',headers:{Authorization:'Bearer local-alpha-fixture','Content-Type':'application/json','Idempotency-Key':'task-lost-claim-001'},body:Buffer.concat(body)});assert.equal(committed.status,200);await committed.text();res.writeHead(200,{'Content-Type':'application/json'});res.write('{'); // commit succeeded; body never completes before the CLI timeout
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert.ok(addr&&typeof addr==='object');
  try{
    const p=spawn(process.execPath,['dist/workroom.mjs','task','claim','--room','room_main','--task',b.task.id,'--expected-version','1','--lease-epoch','0','--idempotency-key','task-lost-claim-001','--timeout','0.25'],{env:{...process.env,WORKROOM_URL:'http://127.0.0.1:'+addr.port,WORKROOM_LOCAL_TOKEN:'local-alpha-fixture'},stdio:['ignore','pipe','pipe']});let output='';p.stdout.on('data',v=>{output+=String(v);});p.stderr.resume();const code=await new Promise<number|null>(resolve=>p.once('close',resolve));assert.equal(code,7);assert.equal((JSON.parse(output) as Body).error.outcome,'unknown');assert.equal(requests,1);
    const recorded=await api('/operations/task.claim/task-lost-claim-001');assert.equal(recorded.status,200);assert.equal((await claim(b,'task-lost-claim-001')).body.meta.replayed,true);assert.equal(await count('task_audit'),2);assert.equal((await get(b.task.id)).task.version,2);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('G3 future expected version cannot restore a pre-read holder/epoch after an intervening explicit reclaim',async()=>{
  const old=await claimed();await app.db.prepare('UPDATE task_leases SET expires_at_ms=0 WHERE task_id=?').bind(old.task.id).run();
  const db=app.db as unknown as Database;let changed=false;
  const service=new Workroom({prepare:s=>db.prepare(s),batch:async statements=>{
    if(!changed){changed=true;const takeover=await claim(old,'intervening-claim-001','local-beta-fixture');assert.equal(takeover.status,200);}
    return db.batch(statements);
  }},'synthetic:beta');
  await assert.rejects(service.tasks.action('renew',taskSchemas.renew.parse({schema_version:'1',room:'room_main',task_id:old.task.id,expected_version:3,lease_epoch:2,idempotency_key:'future-renew-001'})),/version|snapshot/i);
  const current=await get(old.task.id);assert.equal(current.task.version,3);assert.equal(current.lease.holder_id,'synthetic:beta');assert.equal(current.lease.lease_epoch,2);
  assert.equal((await api('/operations/task.renew/future-renew-001',undefined,undefined,'local-beta-fixture')).status,404);
  assert.equal((await act(old.task.id,'renew',{expected_version:3,lease_epoch:2},'real-renew-001','local-beta-fixture')).status,200);
});

test('G3 task get returns one coherent task/lease/submission/clock snapshot across a concurrent claim',async()=>{
  const initial=await create(),db=app.db as unknown as Database;let injected=false;
  const service=new Workroom({prepare:sql=>{
    let statement=db.prepare(sql);const wrapped={bind:(...args:import('../src/server/db.ts').Value[])=>{statement=statement.bind(...args);return wrapped;},first:async<T>()=>{const value=await statement.first<T>();if(!injected&&/SELECT [\s\S]*FROM tasks/.test(sql)){injected=true;assert.equal((await claim(initial,undefined,'local-beta-fixture')).status,200);}return value;},all:<T>()=>statement.all<T>()};return wrapped;
  },batch:s=>db.batch(s)},'synthetic:alpha');
  const observed=(await service.tasks.get({schema_version:'1',room:'room_main',task_id:initial.task.id})).data;
  assert.equal(injected,true);assert.equal(observed.task.version,1);assert.equal(observed.task.state,'open');assert.equal(observed.lease.lease_epoch,0);assert.equal(observed.lease.holder_id,null);
  assert.equal((await get(initial.task.id)).task.version,2);
});

test('G3 mutations share G2 quota and historical replay still succeeds when new mutations are limited',async()=>{
  const first=await create({},'quota-task-first-001');
  for(let i=0;i<58;i++)await create({},'quota-task-'+String(i).padStart(3,'0'));
  await artifact('one G2 mutation'); // 59 tasks + one post = shared 60
  const pinned='9999-01-01T00:00:00.000Z'; // one window: operations_no_update blocks a quota reset, so drop it, pin, restore
  await app.db.prepare('DROP TRIGGER operations_no_update').run();
  try{await app.db.prepare("UPDATE operations SET created_at=? WHERE principal_id='synthetic:alpha'").bind(pinned).run();}
  finally{await app.db.prepare("CREATE TRIGGER operations_no_update BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'immutable'); END").run();}
  assert.equal((await api(collection,{goal:'over',done_conditions:['over']},'quota-over-001')).status,429);
  const replay=await api(collection,{goal:'goal',done_conditions:['verified']},'quota-task-first-001');assert.equal(replay.status,200);assert.equal(replay.body.meta.replayed,true);assert.equal(replay.body.data.task.id,first.task.id);assert.equal(await count('tasks'),59);assert.equal(await count('task_audit'),59);
});

test('G3 accepts the documented maximum twenty dependencies and twenty pinned revisions with an owner',async()=>{
  const dependencies:string[]=[],input_versions:{message_id:string;revision:number}[]=[];
  for(let i=0;i<20;i++){dependencies.push((await create()).task.id);input_versions.push({message_id:await artifact('input '+i),revision:1});}
  const maximum=await create({owner:'synthetic:alpha',dependencies,input_versions});assert.equal(maximum.task.dependencies.length,20);assert.equal(maximum.task.input_versions.length,20);
});
