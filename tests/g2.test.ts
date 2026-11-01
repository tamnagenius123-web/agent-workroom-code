import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { harness,migrate } from '../scripts/local-harness.ts';
import { Workroom } from '../src/server/domain.ts';
import type { Database } from '../src/server/db.ts';

interface Msg {id:string;text:string;version:number;thread_id:string|null;actor_id:string}
interface Rev {message_id:string;version:number;text:string}
interface Event {event_id:string;seq:number;kind:string;version:number|null;text:string|null}
interface RecordRow {source_message_id:string;source_revision:number;source_thread_id:string|null;text:string}
interface Body {ok:boolean;data:{thread:{id:string;title:string};message:Msg;messages:Msg[];revisions:Rev[];events:Event[];receipt:string|null;execution_accepted:boolean;processing_complete:boolean;ack:{through_seq:number};operation:{type:string};records:RecordRow[];text:string;range:{max_message_seq:number;revision_event_watermark:number;include:string}};meta:{next_cursor:string|null;has_more:boolean;replayed:boolean};error:{code:string;current_version:number;outcome:string}}
let app:Awaited<ReturnType<typeof harness>>;
beforeEach(async()=>{app=await harness();});
afterEach(async()=>{await app.close();});
async function api(path:string,body?:object,key?:string,token='local-alpha-fixture') {
  const response=await app.mf.dispatchFetch('http://127.0.0.1/api/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify({schema_version:'1',...body}):undefined});
  return {status:response.status,body:await response.json() as Body};
}
const room='/rooms/room_main';
async function thread(title='thread',key:string=crypto.randomUUID()) {const r=await api(room+'/threads',{title},key);assert.equal(r.status,200,JSON.stringify(r));return r.body.data.thread.id;}
async function post(text='original',thread_id?:string,reply_to_message_id?:string,key:string=crypto.randomUUID()) {const r=await api(room+'/messages',{text,thread_id,reply_to_message_id},key);assert.equal(r.status,200,JSON.stringify(r));return r.body.data.message.id;}
const revise=(id:string,expected_version:number,text:string,key:string=crypto.randomUUID(),token='local-alpha-fixture')=>api(room+'/messages/'+id+'/revisions',{expected_version,text,format:'markdown'},key,token);
async function cli(args:string[],input='') {
  const child=spawn(process.execPath,['dist/workroom.mjs',...args],{env:{...process.env,WORKROOM_URL:app.url,WORKROOM_LOCAL_TOKEN:'local-alpha-fixture'},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',v=>{stdout+=String(v);});child.stderr.on('data',v=>{stderr+=String(v);});child.stdin.end(input);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  assert.equal(stdout.trim().split('\n').length,1);return {code,stderr,body:JSON.parse(stdout) as Body};
}

test('G2 threads/replies stay separated; thread create replays once and SQL rejects cross-room relations',async()=>{
  const all=await Promise.all(Array.from({length:10},()=>api(room+'/threads',{title:'one'},'thread-repeat-001')));
  assert.ok(all.every(r=>r.status===200));assert.equal(new Set(all.map(r=>r.body.data.thread.id)).size,1);
  assert.equal((await app.db.prepare('SELECT count(*) n FROM threads').first<{n:number}>())!.n,1);
  assert.equal((await api(room+'/threads',{title:'other'},'thread-repeat-001')).status,409);
  const t=all[0]!.body.data.thread.id,other=await thread('other');
  const a=await post('a',t),b=await post('b',t,a);await post('foreign thread',other);
  const read=await api(room+'/threads/'+t);assert.deepEqual(read.body.data.messages.map(m=>m.id),[a,b]);
  assert.equal((await api(room+'/messages',{text:'bad',thread_id:other,reply_to_message_id:a},'cross-reply-001')).status,400);
  assert.equal((await api(room+'/messages',{text:'bad',reply_to_message_id:a},'no-thread-001')).status,400);
  await app.db.batch([app.db.prepare("INSERT INTO rooms(id) VALUES ('other')"),app.db.prepare("INSERT INTO threads(id,room_id,creator_id,title,created_at) VALUES ('foreign-thread','other','synthetic:alpha','private','2026-01-01T00:00:00.000Z')")]);
  assert.equal((await api(room+'/messages',{text:'bad',thread_id:'foreign-thread'},'cross-room-001')).status,404);
  await assert.rejects(app.db.prepare('INSERT INTO message_links(message_id,thread_id) VALUES (?,?)').bind(await post('unlinked'),'foreign-thread').run(),/invalid message relation/);
  assert.equal((await api('/rooms/other/threads/foreign-thread')).status,403);
});

test('G2 concurrent author revisions append once, conflict stale versions, preserve historical replay and every original',async()=>{
  const id=await post('version one');
  const attempts=Array.from({length:10},(_,i)=>({key:'revision-race-'+i,text:'candidate '+i}));
  const results=await Promise.all(attempts.map(a=>revise(id,1,a.text,a.key)));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,9);
  const winner=results.findIndex(r=>r.status===200),winning=attempts[winner]!;
  assert.equal((await api(room+'/messages')).body.data.messages[0]!.version,2);
  const stale=await revise(id,1,'stale');assert.equal(stale.body.error.code,'VERSION_CONFLICT');assert.equal(stale.body.error.current_version,2);
  assert.equal((await revise(id,2,'spoof',undefined,'local-beta-fixture')).status,403);
  assert.equal((await revise(id,2,'reader',undefined,'local-reader-fixture')).status,403);
  const first=await api(room+'/messages/'+id+'/history?limit=1');assert.equal(first.body.data.revisions[0]!.text,'version one');
  assert.equal((await revise(id,2,'version three')).status,200);
  const oldPage=await api(room+'/messages/'+id+'/history?limit=1&cursor='+first.body.meta.next_cursor);assert.deepEqual(oldPage.body.data.revisions.map(r=>r.version),[2]);assert.equal(oldPage.body.meta.has_more,false);
  const replay=await revise(id,1,winning.text,winning.key);assert.equal(replay.status,200);assert.equal(replay.body.meta.replayed,true);assert.equal(replay.body.data.message.version,2);
  assert.equal((await revise(id,1,'different',winning.key)).body.error.code,'IDEMPOTENCY_CONFLICT');
  const history=await api(room+'/messages/'+id+'/history');assert.deepEqual(history.body.data.revisions.map(r=>r.version),[1,2,3]);
  assert.equal((await app.db.prepare('SELECT text FROM messages WHERE id=?').bind(id).first<{text:string}>())!.text,'version one');
  await assert.rejects(app.db.prepare('UPDATE message_revisions SET text=? WHERE message_id=?').bind('erase',id).run(),/immutable/);
});

test('G2 audit failure rolls back thread/revision/event/ack/operation effects and same keys recover',async()=>{
  const id=await post();const page=await api(room+'/inbox');
  await app.db.prepare("CREATE TRIGGER g2_fail BEFORE INSERT ON g2_audit BEGIN SELECT RAISE(ABORT,'injected'); END").run();
  try {
    assert.equal((await api(room+'/threads',{title:'rollback'},'rollback-thread-001')).status,503);
    assert.equal((await revise(id,1,'rollback','rollback-revise-001')).status,503);
    assert.equal((await api(room+'/inbox/ack',{receipt:page.body.data.receipt},'rollback-ack-001')).status,503);
    assert.equal((await app.db.prepare('SELECT count(*) n FROM threads').first<{n:number}>())!.n,0);
    assert.equal((await app.db.prepare('SELECT count(*) n FROM message_revisions').first<{n:number}>())!.n,0);
    assert.equal((await app.db.prepare('SELECT count(*) n FROM inbox_state').first<{n:number}>())!.n,0);
    assert.equal((await app.db.prepare('SELECT count(*) n FROM room_events').first<{n:number}>())!.n,1);
    assert.equal((await api('/operations/message.revise/rollback-revise-001')).status,404);
  } finally {await app.db.prepare('DROP TRIGGER g2_fail').run();}
  assert.equal((await api(room+'/threads',{title:'rollback'},'rollback-thread-001')).status,200);
  assert.equal((await revise(id,1,'rollback','rollback-revise-001')).status,200);
  assert.equal((await api(room+'/inbox/ack',{receipt:page.body.data.receipt},'rollback-ack-001')).status,200);
});

test('G2 inbox delivers at least once, rejects skip/foreign receipts, and acknowledges monotonically without execution',async()=>{
  for(let i=0;i<5;i++) await post('event '+i);
  const first=await api(room+'/inbox?limit=2'),repeat=await api(room+'/inbox?limit=2');
  assert.deepEqual(first.body.data.events,repeat.body.data.events);assert.equal(first.body.data.execution_accepted,false);assert.equal(first.body.data.processing_complete,false);
  const second=await api(room+'/inbox?limit=2&cursor='+first.body.meta.next_cursor);
  assert.equal((await api(room+'/inbox/ack',{receipt:second.body.data.receipt},'skip-page-001')).body.error.code,'ACK_OUT_OF_ORDER');
  assert.equal((await api(room+'/inbox?cursor='+first.body.meta.next_cursor,undefined,undefined,'local-beta-fixture')).status,403);
  assert.equal((await api(room+'/inbox/ack',{receipt:first.body.data.receipt},'foreign-ack-001','local-beta-fixture')).status,403);
  assert.equal((await api(room+'/inbox/ack',{receipt:crypto.randomUUID()},'invented-ack-001')).status,403);
  assert.equal((await api(room+'/inbox/ack',{receipt:first.body.data.receipt,through_seq:999},'forged-offset-001')).status,400);
  const ack=await api(room+'/inbox/ack',{receipt:first.body.data.receipt},'ack-first-001');assert.equal(ack.status,200);
  assert.equal((await api(room+'/inbox/ack',{receipt:first.body.data.receipt},'ack-first-001')).body.meta.replayed,true);
  assert.equal((await api(room+'/inbox/ack',{receipt:second.body.data.receipt},'ack-second-001')).status,200);
  const third=await api(room+'/inbox?cursor='+second.body.meta.next_cursor);assert.equal(third.body.data.events.length,1);
  await api(room+'/inbox/ack',{receipt:third.body.data.receipt},'ack-third-001');
  await api(room+'/inbox/ack',{receipt:first.body.data.receipt},'old-receipt-001');
  assert.deepEqual((await api(room+'/inbox')).body.data.events,[]);
  assert.deepEqual((await api(room+'/inbox?limit=2&cursor='+first.body.meta.next_cursor)).body.data.events,second.body.data.events);
  const reader=await api(room+'/inbox',undefined,undefined,'local-reader-fixture');assert.equal((await api(room+'/inbox/ack',{receipt:reader.body.data.receipt},'reader-ack-001','local-reader-fixture')).status,200);
  await post('late');assert.equal((await api(room+'/inbox')).body.data.events.length,1);
});

test('G2 interrupted inbox pagination and receipts survive process recreation with stable event IDs',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'workroom-g2-inbox-'));
  await app.close();app=await harness({persist:dir});
  try {
    for(let i=0;i<3;i++) await post('persistent '+i);
    const first=await api(room+'/inbox?limit=1'),second=await api(room+'/inbox?limit=1&cursor='+first.body.meta.next_cursor);
    await app.close();app=await harness({persist:dir,seed:false});
    assert.deepEqual((await api(room+'/inbox?limit=1')).body.data.events,first.body.data.events);
    assert.deepEqual((await api(room+'/inbox?limit=1&cursor='+first.body.meta.next_cursor)).body.data.events,second.body.data.events);
    assert.equal((await api(room+'/inbox/ack',{receipt:first.body.data.receipt},'restart-ack-001')).status,200);
    assert.equal((await api(room+'/inbox/ack',{receipt:second.body.data.receipt},'restart-ack-002')).status,200);
    assert.equal((await api(room+'/inbox')).body.data.events.length,1);
  } finally {await app.close();await rm(dir,{recursive:true});app=await harness();}
});

test('G2 all pagination tokens bind actor/room/kind/scope; revoked access blocks tokens and ack',async()=>{
  const t=await thread(),other=await thread('other');const id=await post('one',t);await post('two',t);await revise(id,1,'revised');
  const paths=[room+'/messages?limit=1',room+'/threads/'+t+'?limit=1',room+'/messages/'+id+'/history?limit=1',room+'/inbox?limit=1',room+'/export?limit=1'];
  const pages=await Promise.all(paths.map(p=>api(p)));
  for(let i=0;i<paths.length;i++) assert.equal((await api(paths[i]+'&cursor='+pages[i]!.body.meta.next_cursor,undefined,undefined,'local-beta-fixture')).status,403);
  assert.equal((await api(room+'/threads/'+other+'?cursor='+pages[1]!.body.meta.next_cursor)).status,403);
  assert.equal((await api(room+'/export?cursor='+pages[3]!.body.meta.next_cursor)).status,403);
  assert.equal((await api(room+'/export?format=markdown&cursor='+pages[4]!.body.meta.next_cursor)).status,403);
  await app.db.prepare("UPDATE memberships SET active=0 WHERE principal_id='synthetic:alpha'").run();
  for(const p of paths) assert.equal((await api(p)).status,403);
  assert.equal((await api(room+'/inbox/ack',{receipt:pages[3]!.body.data.receipt},'revoked-ack-001')).status,403);
});

test('G2 export pages freeze both watermarks, preserve exact sources/revisions, and fence hostile Markdown',async()=>{
  const t=await thread('export'),other=await thread('not exported');
  const text='<script>bad()</script> ![remote](https://evil.test/image)\n```\noriginal',id=await post(text,t);
  await revise(id,1,'second revision');const second=await post('second message',t);await post('excluded',other);
  const first=await api(room+'/export?limit=1&format=markdown&thread_id='+t);
  assert.equal(first.body.data.records[0]!.text,text);assert.ok(first.body.data.text.includes('````text\n'+text+'\n````'));
  await revise(id,2,'later revision');const later=await post('later message',t);
  const records=[...first.body.data.records];let cursor=first.body.meta.next_cursor;
  while(cursor) {const page=await api(room+'/export?limit=1&format=markdown&thread_id='+t+'&cursor='+cursor);assert.equal(page.status,200);assert.equal(page.body.data.range.max_message_seq,first.body.data.range.max_message_seq);assert.equal(page.body.data.range.revision_event_watermark,first.body.data.range.revision_event_watermark);records.push(...page.body.data.records);cursor=page.body.meta.next_cursor;}
  assert.deepEqual(records.map(r=>[r.source_message_id,r.source_revision]),[[id,1],[id,2],[second,1]]);
  assert.ok(records.every(r=>r.source_thread_id===t&&r.source_message_id!==later));
  const current=await api(room+'/export?format=text&thread_id='+t);assert.equal(current.body.data.records.length,5);
  assert.equal(current.body.data.range.include,'all_revisions');assert.ok(!current.body.data.text.includes('libfile_'));
});

test('G2 REST/CLI/official MCP share thread/revision/inbox/export and generalized operation recovery',async()=>{
  const created=await cli(['thread','create','--room','room_main','--title','from CLI','--idempotency-key','cli-thread-001']);assert.equal(created.code,0,created.stderr);
  const t=created.body.data.thread.id,client=new Client({name:'g2-synthetic',version:'0.0.1'},{versionNegotiation:{mode:'auto'}});
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',app.url),{requestInit:{headers:{Authorization:'Bearer local-alpha-fixture'}}}));
  try {
    const threadReplay=await client.callTool({name:'workroom_thread_create',arguments:{schema_version:'1',room:'room_main',title:'from CLI',idempotency_key:'cli-thread-001'}});
    assert.equal(threadReplay.isError,false,JSON.stringify(threadReplay));assert.deepEqual((threadReplay.structuredContent as Body).data,created.body.data);
    const posted=await client.callTool({name:'workroom_message_post',arguments:{schema_version:'1',room:'room_main',thread_id:t,text:'from MCP',idempotency_key:'mcp-thread-post-001'}});
    const id=(posted.structuredContent as Body).data.message.id;
    assert.equal((await cli(['thread','read','--room','room_main','--thread',t])).body.data.messages[0]!.id,id);
    const revised=await revise(id,1,'revised via REST','rest-revise-001');assert.equal(revised.status,200);
    const reviseReplay=await client.callTool({name:'workroom_message_revise',arguments:{schema_version:'1',room:'room_main',message_id:id,expected_version:1,text:'revised via REST',format:'markdown',idempotency_key:'rest-revise-001'}});
    assert.equal(reviseReplay.isError,false,JSON.stringify(reviseReplay));assert.deepEqual((reviseReplay.structuredContent as Body).data,revised.body.data);
    const recovered=await client.callTool({name:'workroom_operation_get',arguments:{schema_version:'1',operation:'message.revise',idempotency_key:'rest-revise-001'}});
    assert.deepEqual((recovered.structuredContent as Body).data,revised.body.data);
    assert.equal((await cli(['message','history','--room','room_main','--message',id])).body.data.revisions.length,2);
    assert.equal((await cli(['message','revise','--room','room_main','--message',id,'--expected-version','1','--stdin','--idempotency-key','cli-stale-001'],'stale')).code,5);
    const inbox=await cli(['inbox','pull','--room','room_main']);assert.equal(inbox.code,0,inbox.stderr);
    const ack=await client.callTool({name:'workroom_inbox_ack',arguments:{schema_version:'1',room:'room_main',receipt:inbox.body.data.receipt,idempotency_key:'mcp-ack-001'}});assert.equal(ack.isError,false);
    const ackReplay=await api(room+'/inbox/ack',{receipt:inbox.body.data.receipt},'mcp-ack-001');assert.equal(ackReplay.status,200,JSON.stringify(ackReplay));assert.deepEqual(ackReplay.body.data,(ack.structuredContent as Body).data);
    const ackResult=await cli(['operation','get','--operation','inbox.ack','--idempotency-key','mcp-ack-001']);assert.equal(ackResult.code,0,ackResult.stderr);assert.equal(ackResult.body.data.operation.type,'inbox.ack');
    const exported=await cli(['room','export','--room','room_main','--thread',t,'--export-format','markdown']);assert.equal(exported.code,0,exported.stderr);
    const mcpExport=await client.callTool({name:'workroom_room_export',arguments:{schema_version:'1',room:'room_main',thread_id:t,format:'markdown'}});
    assert.deepEqual((mcpExport.structuredContent as Body).data,exported.body.data);
  } finally {await client.close();}
});

test('G1 to G2 migration is schema-only and retains original messages/operation bytes without retroactive inbox events',async()=>{
  await app.close();app=await harness({through:1});
  const id=await post('retained G1',undefined,undefined,'retained-g1-001');
  const old=await api('/operations/message.post/retained-g1-001');
  await migrate(app.db,2);
  assert.deepEqual((await api('/operations/message.post/retained-g1-001')).body.data,old.body.data);
  assert.equal((await api(room+'/messages/'+id+'/history')).body.data.revisions[0]!.text,'retained G1');
  assert.equal((await api(room+'/export')).body.data.records.length,1);
  assert.equal((await api(room+'/inbox')).body.data.events.length,0);
  assert.equal((await api(room+'/messages',{text:'retained G1'},'retained-g1-001')).body.meta.replayed,true);
  await post('new G2');assert.equal((await api(room+'/inbox')).body.data.events.length,1);
});

test('G2 mutation transaction rechecks grants for revision replay and reader receipt ack',async()=>{
  const id=await post();await revise(id,1,'edited','race-revise-001');
  const db=app.db as unknown as Database;
  const service=new Workroom({prepare:s=>db.prepare(s),batch:async statements=>{
    await app.db.prepare("UPDATE memberships SET can_post=0 WHERE principal_id='synthetic:alpha'").run();return db.batch(statements);
  }},'synthetic:alpha');
  await assert.rejects(service.g2.revise({schema_version:'1',room:'room_main',message_id:id,expected_version:1,text:'edited',format:'markdown',idempotency_key:'race-revise-001'}),/access denied/);
  const p=await api(room+'/inbox',undefined,undefined,'local-reader-fixture');
  const reader=new Workroom({prepare:s=>db.prepare(s),batch:async statements=>{
    await app.db.prepare("UPDATE memberships SET active=0 WHERE principal_id='synthetic:reader'").run();return db.batch(statements);
  }},'synthetic:reader');
  await assert.rejects(reader.g2.ack({schema_version:'1',room:'room_main',receipt:p.body.data.receipt!,idempotency_key:'race-reader-ack-001'}),/access denied/);
  assert.equal((await app.db.prepare('SELECT count(*) n FROM inbox_state').first<{n:number}>())!.n,0);
});
