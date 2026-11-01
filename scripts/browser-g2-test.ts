import assert from 'node:assert/strict';
import { chromium,type Page } from 'playwright-core';
import { harness } from './local-harness.ts';

const app=await harness(),browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
interface Body {data:{thread:{id:string};message:{id:string};events:{event_id:string}[];receipt:string|null;execution_accepted:boolean;processing_complete:boolean;records:{source_message_id:string;source_revision:number;text:string}[];range:{room:string;include:string}};meta:{next_cursor:string|null;has_more:boolean};error?:{code:string}}
async function action(page:Page,id:string,path:string,method='POST') {
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1'+path&&r.request().method()===method);
  await page.locator('#'+id).click();const r=await response;
  await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('#read')!.disabled);
  return {status:r.status(),body:await r.json() as Body};
}
async function api(path:string,body:object) {
  const response=await app.mf.dispatchFetch('http://127.0.0.1/api/v1'+path,{method:'POST',headers:{Authorization:'Bearer local-alpha-fixture','Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({schema_version:'1',...body})});
  assert.equal(response.status,200,await response.clone().text());return await response.json() as Body;
}
try {
  const page=await browser.newPage(),errors:string[]=[],external:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==new URL(app.url).origin){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(app.url);await page.locator('#token').fill('local-alpha-fixture');
  await page.locator('#title').fill('first thread');const first=(await action(page,'thread-create','/rooms/room_main/threads')).body.data.thread.id;
  const hostile='<script>window.compromised=1</script> ![remote](https://evil.test/pixel)\n```\noriginal';
  await page.locator('#text').fill(hostile);await page.locator('#format').selectOption('markdown');
  const id=(await action(page,'post','/rooms/room_main/messages')).body.data.message.id;
  assert.equal(await page.locator('article').count(),1);
  await page.locator('#title').fill('second thread');const second=(await action(page,'thread-create','/rooms/room_main/threads')).body.data.thread.id;
  await page.locator('#text').fill('second thread only');await action(page,'post','/rooms/room_main/messages');
  assert.equal(await page.locator('article').count(),1);assert.equal(await page.locator('article pre').textContent(),'second thread only');assert.notEqual(first,second);
  await page.locator('#thread').fill(first);await action(page,'read','/rooms/room_main/threads/'+first,'GET');
  await page.locator('article').getByRole('button',{name:'수정',exact:true}).click();
  await api('/rooms/room_main/messages/'+id+'/revisions',{expected_version:1,text:'concurrent revision',format:'text'});
  await page.locator('#text').fill('stale browser text');const stale=await action(page,'post','/rooms/room_main/messages/'+id+'/revisions');
  assert.equal(stale.status,409);assert.equal(stale.body.error?.code,'VERSION_CONFLICT');assert.ok((await page.locator('#status').textContent())!.includes('현재 v2'));
  await action(page,'read','/rooms/room_main/threads/'+first,'GET');assert.equal(await page.locator('article pre').textContent(),'concurrent revision');
  await page.locator('article').getByRole('button',{name:'수정',exact:true}).click();await page.locator('#text').fill('browser version three');
  assert.equal((await action(page,'post','/rooms/room_main/messages/'+id+'/revisions')).status,200);
  await page.locator('article').getByRole('button',{name:'이력',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#status')!.textContent==='원문과 수정 이력 조회');
  const history=JSON.parse((await page.locator('#details').textContent())!) as {revisions:{version:number;text:string}[]};
  assert.deepEqual(history.revisions.map(r=>r.version),[1,2,3]);assert.equal(history.revisions[0]!.text,hostile);
  await page.locator('#new').click();await page.locator('#reply').fill(id);await page.locator('#text').fill('a reply');await action(page,'post','/rooms/room_main/messages');
  assert.equal(await page.locator('article').count(),2);
  await page.locator('#limit').fill('2');const page1=await action(page,'inbox-pull','/rooms/room_main/inbox','GET');
  const repeated=await action(page,'inbox-pull','/rooms/room_main/inbox','GET');assert.deepEqual(repeated.body.data.events,page1.body.data.events);
  const foreign=await page.evaluate(async cursor=>{const r=await fetch('/api/v1/rooms/room_main/inbox?cursor='+cursor,{headers:{Authorization:'Bearer local-beta-fixture'}});return r.status;},page1.body.meta.next_cursor!);
  assert.equal(foreign,403);
  const page2=await action(page,'inbox-more','/rooms/room_main/inbox','GET');assert.equal((await action(page,'inbox-ack','/rooms/room_main/inbox/ack')).body.error?.code,'ACK_OUT_OF_ORDER');
  await action(page,'inbox-pull','/rooms/room_main/inbox','GET');await action(page,'inbox-ack','/rooms/room_main/inbox/ack');
  const secondAgain=await action(page,'inbox-pull','/rooms/room_main/inbox','GET');assert.deepEqual(secondAgain.body.data.events,page2.body.data.events);await action(page,'inbox-ack','/rooms/room_main/inbox/ack');
  const received=[...page1.body.data.events,...page2.body.data.events];
  for(;;){const next=await action(page,'inbox-pull','/rooms/room_main/inbox','GET');assert.equal(next.body.data.execution_accepted,false);assert.equal(next.body.data.processing_complete,false);if(!next.body.data.events.length)break;received.push(...next.body.data.events);await action(page,'inbox-ack','/rooms/room_main/inbox/ack');}
  assert.equal(new Set(received.map(e=>e.event_id)).size,received.length);assert.equal(received.length,7);
  await app.db.prepare("UPDATE memberships SET active=0 WHERE principal_id='synthetic:alpha'").run();
  assert.equal((await action(page,'read','/rooms/room_main/threads/'+first,'GET')).status,403);
  assert.equal((await action(page,'inbox-pull','/rooms/room_main/inbox','GET')).status,403);
  assert.equal((await action(page,'export','/rooms/room_main/export','GET')).status,403);
  await app.db.prepare("UPDATE memberships SET active=1 WHERE principal_id='synthetic:alpha'").run();
  for(let i=0;i<10;i++)await api('/rooms/room_main/messages',{thread_id:first,text:'export item '+i});
  await page.locator('#export-format').selectOption('markdown');const exported=await action(page,'export','/rooms/room_main/export','GET');
  assert.equal(exported.body.data.records.length,10);assert.equal(exported.body.data.records[0]!.text,hostile);assert.equal(exported.body.data.range.include,'all_revisions');assert.equal(exported.body.data.range.room,'room_main');
  assert.ok((await page.locator('#details').textContent())!.includes(hostile));assert.equal(exported.body.meta.has_more,true);
  const last=await action(page,'export-more','/rooms/room_main/export','GET');assert.equal(last.body.data.records.length,4);
  const exportedKeys=[...exported.body.data.records,...last.body.data.records].map(r=>r.source_message_id+':'+r.source_revision);assert.equal(new Set(exportedKeys).size,14);
  assert.equal(await page.locator('article script,article img,#details img,#details script').count(),0);assert.equal(await page.evaluate(()=>'compromised' in window),false);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  process.stdout.write(JSON.stringify({ok:true,browser:browser.version(),slice:'G2',checks:['thread-isolation','stale-revision','history-original','reply','inbox-replay','actor-cursor-denied','ack-skip-denied','explicit-ordered-ack','revoked-membership','export-page-source-range','literal-markdown-no-fetch'],inbox_events:7,export_records:14,real_agents_connected:false})+'\n');
}finally{await browser.close();await app.close();}
