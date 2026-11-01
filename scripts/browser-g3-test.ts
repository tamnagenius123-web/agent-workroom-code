import assert from 'node:assert/strict';
import { chromium,type Page } from 'playwright-core';
import { harness } from './local-harness.ts';

const app=await harness(),browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});
interface Reply {ok:boolean;data:{task:{id:string;state:string;version:number;stop_confirmation:string};lease:{lease_epoch:number};submission:{artifact_revision:number}|null;message:{id:string}};error?:{code:string}}
async function api(path:string,body:object){const r=await app.mf.dispatchFetch('http://127.0.0.1/api/v1'+path,{method:'POST',headers:{Authorization:'Bearer local-alpha-fixture','Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({schema_version:'1',...body})});return await r.json() as Reply;}
async function action(page:Page,id:string,path:string,method='POST'){
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1'+path&&r.request().method()===method);
  await page.locator('#'+id).click();const r=await response;const body=await r.json() as Reply;await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('#task-get')!.disabled);return {status:r.status(),body};
}
try{
  const page=await browser.newPage(),external:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==new URL(app.url).origin){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(app.url);await page.locator('#token').fill('local-alpha-fixture');
  const hostile='<script>window.compromised=1</script> ![pixel](https://evil.test/image)',artifact=(await api('/rooms/room_main/messages',{text:hostile})).data.message.id;
  await page.locator('#task-goal').fill(hostile);await page.locator('#task-conditions').fill('reviewed exactly');await page.locator('#task-owner').fill('synthetic:alpha');await page.locator('#task-inputs').fill(artifact+'@1');
  const created=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/rooms/room_main/tasks'&&r.request().method()==='POST');
  await page.locator('#task-create').evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});const made=await (await created).json() as Reply;await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>('#task-get')!.disabled);
  const id=made.data.task.id,path='/rooms/room_main/tasks/'+id;assert.equal((await app.db.prepare('SELECT count(*) n FROM tasks').first<{n:number}>())!.n,1);assert.ok((await page.locator('#task-view').textContent())!.includes(hostile));
  assert.equal((await action(page,'task-claim',path+'/claim')).status,200);assert.equal((await action(page,'task-renew',path+'/renew')).status,200);
  await api(path+'/renew',{expected_version:3,lease_epoch:1});await page.locator('#task-artifact').fill(artifact);
  assert.equal((await action(page,'task-submit',path+'/submit')).body.error?.code,'VERSION_CONFLICT');
  await action(page,'task-get',path,'GET');assert.equal((await action(page,'task-submit',path+'/submit')).body.data.task.state,'review');
  assert.equal((await action(page,'task-approve',path+'/approve')).status,403);
  await api('/rooms/room_main/messages/'+artifact+'/revisions',{expected_version:1,text:'later artifact'});
  await page.locator('#token').fill('local-human-fixture');await action(page,'task-get',path,'GET');
  await app.db.prepare("UPDATE principal_roles SET kind='agent' WHERE principal_id='synthetic:human'").run();assert.equal((await action(page,'task-approve',path+'/approve')).status,403);
  await app.db.prepare("UPDATE principal_roles SET kind='user' WHERE principal_id='synthetic:human'").run();const done=await action(page,'task-approve',path+'/approve');assert.equal(done.body.data.task.state,'done');assert.equal(done.body.data.submission!.artifact_revision,1);
  await page.locator('#token').fill('local-alpha-fixture');await page.locator('#task-goal').fill('cancel task');const second=await action(page,'task-create','/rooms/room_main/tasks');const path2='/rooms/room_main/tasks/'+second.body.data.task.id;
  await action(page,'task-claim',path2+'/claim');await page.locator('#task-reason').fill('logical cancellation');assert.equal((await action(page,'task-cancel',path2+'/cancel')).body.data.task.state,'canceled');
  assert.ok((await page.locator('#task-view').textContent())!.includes('외부 실행 중단 확인이 아닙니다'));assert.ok((await page.locator('#task-view').textContent())!.includes('unavailable_no_runner'));
  assert.equal((await action(page,'task-submit',path2+'/submit')).body.error?.code,'LEASE_CONFLICT');
  const third=await action(page,'task-create','/rooms/room_main/tasks'),path3='/rooms/room_main/tasks/'+third.body.data.task.id;await action(page,'task-claim',path3+'/claim');
  let lost=false;await page.route('**'+path3+'/submit',async route=>{
    if(lost)return route.fallback();lost=true;const committed=await route.fetch(),snapshot=await committed.json() as Reply;assert.equal(committed.status(),200);
    assert.equal((await api(path3+'/cancel',{expected_version:snapshot.data.task.version,reason:'cancel before recovery'})).data.task.state,'canceled');return route.abort('timedout');
  });
  await page.locator('#task-submit').click();await page.waitForFunction(()=>document.querySelector('#status')!.textContent!.includes('미확인'));
  await action(page,'retry',path3+'/submit');assert.ok((await page.locator('#task-view').textContent())!.includes('"state": "canceled"'));assert.ok((await page.locator('#task-view').textContent())!.includes('"submission": null'));
  assert.equal(await page.locator('#task-view script,#task-view img').count(),0);assert.equal(await page.evaluate(()=>'compromised' in window),false);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  process.stdout.write(JSON.stringify({ok:true,slice:'G3',browser:browser.version(),checks:['create-double-click','literal-goal','claim','renew','stale-version','review-submit','agent-approve-denied','revoked-user-role','exact-revision-human-approve','logical-cancel-no-stop-claim','late-submit-denied','historical-replay-requeries-current','no-external-fetch'],real_agents_connected:false})+'\n');
}finally{await browser.close();await app.close();}
