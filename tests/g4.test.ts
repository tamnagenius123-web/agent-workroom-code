import assert from 'node:assert/strict';
import { beforeEach,afterEach,test } from 'node:test';
import { spawn } from 'node:child_process';
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { harness } from '../scripts/local-harness.ts';
import { createConnectionGateway } from '../src/connection/gateway.ts';
import { ConnectionAuthority } from '../src/connection/authority.ts';
import { guardedFetch,endpoint,PROTOCOL } from '../src/connection/policy.ts';
import { connectionPlan } from '../src/connection/plan.ts';
import { connectionFixtures } from './support/g4-fixtures.ts';
import type { Database } from '../src/server/db.ts';

let app:Awaited<ReturnType<typeof harness>>,f:ReturnType<typeof connectionFixtures>,gateway:ReturnType<typeof createConnectionGateway>;
const secret='DO_NOT_DISCLOSE_PROVIDER_SECRET_123';
interface Body {ok:boolean;data:{principal_id:string;kind:string;agent_id:string|null;scopes:string[];operational_connection:boolean;nonce:string;persisted:boolean;source_revision:number;message:{id:string;text:string}};error:{code:string;message:string};meta:{schema_version:string}}
beforeEach(async()=>{app=await harness();f=connectionFixtures();gateway=createConnectionGateway(f.options);});afterEach(async()=>{await app.close();});
function req(path:string,body?:object,token='g4-alpha-fixture',extra:Record<string,string>={}){return new Request(new URL(path,f.resource),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...extra},body:body?JSON.stringify(body):undefined});}
async function api(path:string,body?:object,token?:string,extra?:Record<string,string>){const r=await gateway.fetch(req(path,body,token,extra),{DB:app.db as unknown as Database});return {status:r.status,body:await r.json() as Body};}
async function rpc(name:string,args:object={},token='g4-alpha-fixture',version=PROTOCOL,method='tools/call'){
  const r=await gateway.fetch(new Request(f.resource,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':version,'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':name}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...(method==='tools/call'?{name,arguments:args}:{}),_meta:{'io.modelcontextprotocol/protocolVersion':PROTOCOL,'io.modelcontextprotocol/clientCapabilities':{}}}})}),{DB:app.db as unknown as Database});
  return {status:r.status,body:await r.json() as {error?:unknown;result:{structuredContent:Body;isError:boolean;tools:{name:string}[];supportedVersions:string[]}}};
}
async function post(){const r=await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/messages',{method:'POST',headers:{Authorization:'Bearer local-alpha-fixture','Content-Type':'application/json','Idempotency-Key':'g4-readback-fixture-001'},body:JSON.stringify({schema_version:'1',text:'synthetic <script>literal</script> ![remote](https://evil.test/pixel)'})});assert.equal(r.status,200);return (await r.json() as Body).data.message.id;}

test('G4 absent verifier/resolver/audit configuration denies even forged Site/user/service headers without DB effects',async()=>{
  for(const options of [{},{...f.options,verifier:undefined},{...f.options,bindings:undefined},{...f.options,audit:undefined}]){
    const r=await createConnectionGateway(options).fetch(req('/connection/me',undefined,'g4-alpha-fixture',{'oai-authenticated-user-id':'synthetic:human','OAI-Sites-Authorization':'Bearer '+secret}),{DB:app.db as unknown as Database});assert.equal(r.status,503);assert.ok(!(await r.text()).includes(secret));
  }
  assert.equal((await api('/connection/me',undefined,'',{'oai-authenticated-user-id':'synthetic:human','OAI-Sites-Authorization':'Bearer '+secret})).status,401);
  assert.equal((await api('/connection/me',undefined,'g4-alpha-fixture',{'oai-authenticated-user-id':'synthetic:human','X-Agent-Id':'agent:human'})).body.data.principal_id,'synthetic:alpha');
});

test('G4 distinct synthetic agent/user principals share the central domain; echo/readback have no mutation effects',async()=>{
  const id=await post(),before=await app.db.prepare('SELECT (SELECT count(*) FROM operations) ops,(SELECT count(*) FROM audit) audit,(SELECT count(*) FROM page_tokens) cursors').first();
  const alpha=await api('/connection/me'),beta=await api('/connection/me',undefined,'g4-beta-fixture'),human=await api('/connection/me',undefined,'g4-human-fixture');
  assert.equal(alpha.body.data.principal_id,'synthetic:alpha');assert.equal(alpha.body.data.agent_id,'agent:alpha');assert.equal(beta.body.data.agent_id,'agent:beta');assert.equal(human.body.data.kind,'user');assert.equal(human.body.data.agent_id,null);assert.equal(alpha.body.data.operational_connection,false);
  const echo=await api('/connection/echo',{schema_version:'1',nonce:'synthetic_nonce_1234'});assert.equal(echo.status,200);assert.equal(echo.body.data.nonce,'synthetic_nonce_1234');assert.equal(echo.body.data.persisted,false);
  const read=await api('/connection/readback',{schema_version:'1',room:'room_main',message_id:id,expected_version:1});assert.equal(read.status,200);assert.equal(read.body.data.source_revision,1);assert.ok(read.body.data.message.text.includes('<script>'));
  assert.deepEqual(await app.db.prepare('SELECT (SELECT count(*) FROM operations) ops,(SELECT count(*) FROM audit) audit,(SELECT count(*) FROM page_tokens) cursors').first(),before);
  assert.equal((await api('/connection/readback',{schema_version:'1',room:'room_main',message_id:id,expected_version:2})).status,409);
});

test('G4 invalid issuer/audience/ingress/kind/expiry/future/lifetime and service assertions never grant identity',async()=>{
  const original=structuredClone(f.assertions.get('g4-alpha-fixture')!);
  for(const change of [{issuer:'forged'},{audience:'https://other.example.invalid/mcp'},{ingress_id:'other'},{subject_kind:'service'},{subject_kind:'user'},{expires_at_ms:f.now},{issued_at_ms:f.now+1},{issued_at_ms:f.now-400000},{credential_version:2},{subject:'not-registered'}]){
    f.assertions.set('g4-alpha-fixture',{...original,...change} as typeof original);assert.equal((await api('/connection/me')).status,401,JSON.stringify(change));
  }
  f.assertions.set('g4-alpha-fixture',original);
});

test('G4 binding revocation/rotation/room/role/scope are current and cannot be supplied by the caller',async()=>{
  const original=structuredClone(f.bindings.get('fixture:alpha')!);
  for(const change of [{active:false},{credential_version:2},{room_id:'other'},{kind:'user',agent_id:null},{agent_id:null},{audience:'https://other.example.invalid/mcp'},{not_before_ms:f.now+1},{expires_at_ms:f.now}]){
    f.bindings.set('fixture:alpha',{...original,...change} as typeof original);assert.ok((await api('/connection/me')).status>=400,JSON.stringify(change));
  }
  f.bindings.set('fixture:alpha',{...original,credential_version:2});assert.equal((await api('/connection/me')).status,401);f.assertions.get('g4-alpha-fixture')!.credential_version=2;assert.equal((await api('/connection/me')).status,200);
  f.bindings.get('fixture:alpha')!.scopes=['connection.identity'];assert.equal((await api('/connection/echo',{schema_version:'1',nonce:'synthetic_nonce_1234'})).status,403);
  f.bindings.get('fixture:alpha')!.scopes=[...original.scopes];
  for(const field of ['actor_id','agent_id','role','scope','expires_at_ms'])assert.equal((await api('/connection/echo',{schema_version:'1',nonce:'synthetic_nonce_1234',[field]:secret})).status,400);
  await app.db.prepare("UPDATE principal_roles SET kind='user' WHERE principal_id='synthetic:alpha'").run();assert.equal((await api('/connection/me')).status,403);
});

test('G4 principal/membership revocation and authority changes between read and release prevent success',async()=>{
  const id=await post();
  for(const sql of ["UPDATE principals SET active=0 WHERE id='synthetic:alpha'","UPDATE memberships SET active=0 WHERE principal_id='synthetic:alpha'"]){
    await app.db.prepare(sql).run();assert.equal((await api('/connection/me')).status,403);await app.db.batch([app.db.prepare("UPDATE principals SET active=1 WHERE id='synthetic:alpha'"),app.db.prepare("UPDATE memberships SET active=1 WHERE principal_id='synthetic:alpha'")]);
  }
  let calls=0;const verifier=f.options.verifier!;gateway=createConnectionGateway({...f.options,verifier:async input=>{if(++calls===3)f.bindings.get('fixture:alpha')!.active=false;return verifier(input);}});
  assert.equal((await api('/connection/readback',{schema_version:'1',room:'room_main',message_id:id,expected_version:1})).status,401);assert.equal(f.audit.at(-1)!.decision,'deny');
  f.bindings.get('fixture:alpha')!.active=true;gateway=createConnectionGateway({...f.options,audit:async()=>{await app.db.prepare("UPDATE memberships SET active=0 WHERE principal_id='synthetic:alpha'").run();}});assert.equal((await api('/connection/me')).status,403);
});

test('G4 verifier/resolver/audit errors and malformed requests stay redacted; audit has a fixed non-secret field set',async()=>{
  for(const replace of [{verifier:async()=>{throw new Error(secret);}},{bindings:async()=>{throw new Error(secret);}},{audit:async()=>{throw new Error(secret);}}]){
    gateway=createConnectionGateway({...f.options,...replace});const r=await api('/connection/me');assert.ok(r.status>=400);assert.ok(!JSON.stringify(r).includes(secret));
  }
  gateway=createConnectionGateway(f.options);const r=await api('/connection/echo',{schema_version:'1',nonce:'bad '+secret});assert.equal(r.status,400);assert.ok(!JSON.stringify(r).includes(secret));
  assert.ok(f.audit.every(a=>JSON.stringify(Object.keys(a).sort())===JSON.stringify(['action','decision','principal_id','reason','request_id'])));assert.ok(!JSON.stringify(f.audit).includes(secret));
  assert.equal((await api('/connection/me',undefined,undefined,{Origin:'https://evil.test'})).status,403);
});

test('G4 standalone MCP negotiates official SDK2026 protocol and parity through guarded in-process transport',async()=>{
  const id=await post(),seen:string[]=[];
  const fetch=guardedFetch(f.resource,async request=>{const response=await gateway.fetch(request,{DB:app.db as unknown as Database});assert.equal(response.headers.get('content-type')?.split(';')[0],'application/json');seen.push(request.redirect);return response;});
  const client=new Client({name:'synthetic-not-a-proof-of-agent',version:'0.0.1'},{versionNegotiation:{mode:'auto'}});
  try{await client.connect(new StreamableHTTPClientTransport(new URL(f.resource),{fetch,requestInit:{headers:{Authorization:'Bearer g4-alpha-fixture'}}}));}catch(e){assert.fail(JSON.stringify({error:String(e),observed:seen}));}
  try{
    const listed=await client.listTools();assert.equal(listed.tools.length,3);
    const who=await client.callTool({name:'workroom_connection_whoami',arguments:{schema_version:'1'}});assert.equal(who.isError,false,JSON.stringify(who));assert.deepEqual((who.structuredContent as Body).data,(await api('/connection/me')).body.data);
    const nonce='sdk_synthetic_nonce_1234',echo=await client.callTool({name:'workroom_connection_echo',arguments:{schema_version:'1',nonce}});assert.equal((echo.structuredContent as Body).data.nonce,nonce);
    const read=await client.callTool({name:'workroom_connection_readback',arguments:{schema_version:'1',room:'room_main',message_id:id,expected_version:1}});assert.equal((read.structuredContent as Body).data.message.id,id);
    assert.ok(seen.length>=4&&seen.every(v=>v==='error'));
  }finally{await client.close();}
});

test('G4 legacy/version mismatch/unknown or spoofed MCP inputs reject without echoing raw errors',async()=>{
  for(const r of [await rpc('',{},undefined,'2025-03-26','tools/list'),await rpc(secret,{}),await rpc('workroom_connection_echo',{schema_version:'1',nonce:'synthetic_nonce_1234',[secret]:'forged'})]){
    assert.ok(r.body.error||r.body.result?.isError,JSON.stringify(r));assert.ok(!JSON.stringify(r).includes(secret));
  }
  const raw=new Request(f.resource,{method:'POST',headers:{Authorization:'Bearer g4-alpha-fixture','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',clientInfo:{name:secret,version:'1'},capabilities:{}}})});
  const legacy=await gateway.fetch(raw,{DB:app.db as unknown as Database});assert.ok(legacy.status>=400||JSON.parse(await legacy.text()).error);
});

test('G4 HTTPS policy rejects URL tricks and absent transport without any connection attempt',async()=>{
  for(const value of ['http://central.example.invalid/mcp','https://127.0.0.1/mcp','https://2130706433/mcp','https://[::1]/mcp','https://host.local/mcp','https://user:secret@central.example.invalid/mcp','https://central.example.invalid:444/mcp','https://central.example.invalid/mcp?q=secret','https://central.example.invalid/mcp#secret','https://central.example.invalid/x/../mcp','https://central.example.invalid/%6dcp','https://central.example.invalid./mcp'])assert.throws(()=>endpoint(value),/rejected/,value);
  await assert.rejects(guardedFetch(f.resource)(f.resource,{method:'POST',body:'{}'}),/not configured/);
  let calls=0;const guarded=guardedFetch(f.resource,async()=>{calls++;return Response.json({});});
  await assert.rejects(guarded('https://other.example.invalid/mcp',{method:'POST',body:'{}'}));await assert.rejects(guarded(f.resource,{method:'GET'}));assert.equal(calls,0);
});

test('G4 outbound redirects, foreign final URL, oversized/malformed payload and upstream secret errors reject safely',async()=>{
  for(const response of [new Response(null,{status:302,headers:{Location:'https://evil.test/'+secret}}),new Response('x',{headers:{'Content-Type':'text/html'}}),Response.json({text:'x'.repeat(524288)})]){
    const guard=guardedFetch(f.resource,async request=>{assert.equal(request.redirect,'error');assert.equal(request.credentials,'omit');return response;});await assert.rejects(guard(f.resource,{method:'POST',body:'{}'}),e=>String(e).includes('safely')&&!String(e).includes(secret));
  }
  const foreign=Response.json({});Object.defineProperty(foreign,'url',{value:'https://other.example.invalid/mcp'});await assert.rejects(guardedFetch(f.resource,async()=>foreign)(f.resource,{method:'POST',body:'{}'}));
  let calls=0;await assert.rejects(guardedFetch(f.resource,async()=>{calls++;throw new Error(secret);})(f.resource,{method:'POST',body:'x'.repeat(49153)}));assert.equal(calls,0);
  await assert.rejects(guardedFetch(f.resource,async()=>{throw new Error(secret);})(f.resource,{method:'POST',body:'{}'}),e=>!String(e).includes(secret));
});

test('G4 offline CLI plans never claim connection, accept stdin/file and redact unknown credential fields',async()=>{
  const {readFile}=await import('node:fs/promises'),example=await readFile('handoff/g4/connection-plan.example.json','utf8');
  async function cli(args:string[],input='') {const p=spawn(process.execPath,['dist/workroom-connection-plan.mjs',...args],{stdio:['pipe','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',v=>{stdout+=String(v);});p.stderr.on('data',v=>{stderr+=String(v);});p.stdin.end(input);const code=await new Promise<number|null>((resolve,reject)=>{p.once('close',resolve);p.once('error',reject);});assert.equal(stdout.trim().split('\n').length,1);return {code,stdout,stderr,body:JSON.parse(stdout) as {ready:boolean;connected:boolean;outcome:string}};}
  for(const r of [await cli(['--stdin'],example),await cli(['--file','handoff/g4/connection-plan.example.json'])]){assert.equal(r.code,0);assert.equal(r.body.ready,false);assert.equal(r.body.connected,false);assert.equal(r.body.outcome,'not_executed');}
  const invalid=await cli(['--stdin'],JSON.stringify({...JSON.parse(example),token:secret}));assert.equal(invalid.code,2);assert.ok(!(invalid.stdout+invalid.stderr).includes(secret));
  const full=connectionPlan({...JSON.parse(example),endpoint:f.resource,expected_principal:'synthetic:alpha',expected_agent:'agent:alpha'});assert.equal(full.ready,false);assert.ok(full.blockers.includes('operational_verifier_missing'));
});

test('G4 assertion/binding scopes intersect and changed identity cannot be swapped during a request',async()=>{
  f.assertions.get('g4-alpha-fixture')!.scopes=['connection.echo'];assert.equal((await api('/connection/me')).status,403);assert.equal((await api('/connection/echo',{schema_version:'1',nonce:'synthetic_nonce_1234'})).status,200);
  f.assertions.get('g4-alpha-fixture')!.scopes=['connection.identity','connection.echo','room.read'];let checks=0;const original=f.options.bindings!;
  gateway=createConnectionGateway({...f.options,bindings:async key=>{const b=await original(key);if(++checks===3)return {...b as object,principal_id:'synthetic:beta',agent_id:'agent:beta'};return b;}});assert.equal((await api('/connection/me')).status,403);
  const noCache=new ConnectionAuthority(app.db as unknown as Database,f.options);await noCache.check(req('/connection/me'));f.bindings.get('fixture:alpha')!.active=false;await assert.rejects(noCache.check(req('/connection/me')),/verified/);
});

test('G4 assertion expiry during asynchronous policy lookup is rejected at check completion',async()=>{
  let now=f.now;const resolve=f.options.bindings!;
  const authority=new ConnectionAuthority(app.db as unknown as Database,{...f.options,now:()=>now,bindings:async key=>{const value=await resolve(key);now+=61000;return value;}});
  await assert.rejects(authority.check(req('/connection/me')),/verified/);
});

test('G4 discovery rechecks authority after audit and SDK protocol rejections are audited as deny',async()=>{
  gateway=createConnectionGateway({...f.options,audit:async event=>{f.audit.push(event);f.bindings.get('fixture:alpha')!.active=false;}});
  assert.equal((await rpc('',{},undefined,PROTOCOL,'tools/list')).status,401);
  f.bindings.get('fixture:alpha')!.active=true;gateway=createConnectionGateway(f.options);
  for(const run of [()=>rpc(secret,{}),()=>rpc('workroom_connection_whoami',{schema_version:'1',unknown:true}),()=>rpc('',{},undefined,'2025-03-26','tools/list')]){f.audit.length=0;await run();assert.equal(f.audit.at(-1)?.decision,'deny');assert.notEqual(f.audit.at(-1)?.reason,'OK');}
});

test('G4 malformed JSON and upstream HTTP/protocol errors never reach SDK with raw secret payloads',async()=>{
  for(const response of [new Response('{invalid '+secret,{headers:{'Content-Type':'application/json'}}),Response.json({error:secret},{status:500}),Response.json({jsonrpc:'2.0',id:1,error:{code:-32603,message:secret}}),Response.json({jsonrpc:'2.0',id:1,result:{isError:true,content:[{type:'text',text:secret}]}})]){
    await assert.rejects(guardedFetch(f.resource,async()=>response)(f.resource,{method:'POST',body:'{}'}),e=>String(e).includes('safely')&&!String(e).includes(secret));
  }
});
