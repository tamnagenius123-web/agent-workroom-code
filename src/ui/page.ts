export const HTML = `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Workroom · 로컬 검증</title><style>
:root{font-family:system-ui,sans-serif;color:#e9eef4;background:#121920;color-scheme:dark}body{max-width:760px;margin:40px auto;padding:0 20px;line-height:1.6}h1{font-size:1.6rem}p,small{color:#bfcbd7}label{display:block;margin-top:16px}input,textarea,select,button{font:inherit;padding:10px;border:1px solid #667586;border-radius:4px;background:#1b2733;color:inherit}input,textarea{box-sizing:border-box;width:100%}textarea{min-height:140px}button{cursor:pointer;margin:12px 8px 12px 0}button:disabled{opacity:.55;cursor:wait}article{border-top:1px solid #465564;padding:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}#status{padding:12px;background:#243544}#messages:empty:after{content:'아직 조회한 저장 기록이 없습니다.'}a{color:#acd5ff}*:focus-visible{outline:3px solid #acd5ff;outline-offset:3px}
</style><h1>Agent Workroom</h1><p>합성 로컬 검증 화면 · 고정 방 room_main</p><p><strong>Muse · Grok bot · dot: 실제 연결되지 않음</strong><br>저장은 전달 확인·에이전트 실행·승인을 뜻하지 않습니다. Markdown은 원문 텍스트로 표시합니다.</p>
<label for="token">합성 로컬 토큰</label><input id="token" type="password" autocomplete="off" placeholder="합성 토큰 (로컬 전용)"><small>이 로컬 예제의 합성 fixture만 사용합니다. production 인증은 미설정입니다.</small><br>
<button id="read">저장 기록 조회</button><button id="more" hidden>다음 페이지</button><p id="status" role="status" aria-live="polite">미연결 · 저장 기록을 조회하세요.</p><section id="messages" aria-label="저장된 메시지"></section>
<label for="title">새 스레드 제목</label><input id="title"><button id="thread-create">스레드 만들기</button><label for="thread">선택 스레드 ID (비우면 방 전체)</label><input id="thread"><label for="reply">답글 대상 메시지 ID (같은 스레드)</label><input id="reply">
<form id="form"><label for="text">메시지 (최대 UTF-8 32 KiB)</label><textarea id="text" required></textarea><label for="format">본문 형식</label><select id="format"><option value="text">텍스트</option><option value="markdown">Markdown 원문</option></select><br><button id="post" type="submit">저장</button><button id="new" type="button">새 메시지</button></form><button id="retry" hidden>미확인 요청 다시 시도</button>
<label for="limit">inbox 페이지 크기 (1–100)</label><input id="limit" type="number" min="1" max="100" value="50"><p>inbox 읽기·ack는 전달 기록이며 실행 수락·작업 완료가 아닙니다.</p><button id="inbox-pull">inbox 조회</button><button id="inbox-more" hidden>inbox 다음 페이지</button><button id="inbox-ack" disabled>이 페이지 명시적 ack</button><pre id="events"></pre>
<label for="export-format">Export 형식</label><select id="export-format"><option value="text">텍스트</option><option value="markdown">Markdown</option></select><button id="export">이력 페이지 export</button><button id="export-more" hidden>export 다음 페이지</button><pre id="details" aria-label="이력과 export 원문"></pre>
<hr><h2>합성 로컬 작업</h2><p>lease는 시험용 30초이며 자동 재할당하지 않습니다. 에이전트는 검토 요청까지만 제출합니다. 승인은 별도 합성 사용자 역할만 가능합니다. canceled는 외부 실행 중단 확인이 아닙니다.</p>
<label for="task-goal">작업 목표</label><textarea id="task-goal"></textarea><label for="task-owner">지정 실행자 ID (선택)</label><input id="task-owner" placeholder="synthetic:alpha"><label for="task-conditions">완료 조건 (한 줄에 하나)</label><textarea id="task-conditions"></textarea><label for="task-deps">선행 작업 ID (쉼표로 구분, 선택)</label><input id="task-deps"><label for="task-inputs">참조 메시지 ID@revision (쉼표로 구분, 선택)</label><input id="task-inputs"><button id="task-create">작업 만들기</button>
<label for="task-id">작업 ID</label><input id="task-id"><button id="task-get">작업 조회</button><pre id="task-view" aria-label="저장된 작업과 lease"></pre><button id="task-claim">명시적 claim</button><button id="task-renew">lease 갱신</button>
<label for="task-artifact">결과 메시지 ID</label><input id="task-artifact"><label for="task-revision">결과 revision</label><input id="task-revision" type="number" min="1" value="1"><label for="task-disposition">제출 상태</label><select id="task-disposition"><option value="review">검토 요청</option><option value="blocked">진행 차단</option></select><label for="task-reason">차단·취소 이유</label><textarea id="task-reason"></textarea><button id="task-submit">결과 제출</button><button id="task-cancel">논리적 취소</button><button id="task-approve">조회한 정확한 결과 revision 승인 (합성 사용자)</button>
<script src="/app.js" defer></script></html>`;

export const BROWSER = String.raw`
'use strict';
const byId=id=>document.getElementById(id),status=byId('status');
let busy=false,pending=null,cursor=null,editing=null,inboxCursor=null,receipt=null,exportCursor=null,taskSnapshot=null;
const controls=['read','more','post','token','text','format','title','thread','reply','thread-create','new','limit','inbox-pull','inbox-more','inbox-ack','export','export-more','export-format','retry','task-goal','task-owner','task-conditions','task-deps','task-inputs','task-create','task-id','task-get','task-claim','task-renew','task-artifact','task-revision','task-disposition','task-reason','task-submit','task-cancel','task-approve'];
function lock(value){busy=value;for(const id of controls) byId(id).disabled=value||!!(pending&&!['read','more','post','retry'].includes(id));byId('inbox-ack').disabled=value||!!pending||!receipt;}
async function call(path,init={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 try{const response=await fetch('/api/v1'+path,{...init,signal:controller.signal,headers:{Authorization:'Bearer '+byId('token').value,'Content-Type':'application/json',...init.headers}});
 const result=await response.json();if(!result.ok) throw Object.assign(new Error(result.error.message),{result});return result;}finally{clearTimeout(timer);}
}
function threadPath(){return byId('thread').value.trim()?'/rooms/room_main/threads/'+encodeURIComponent(byId('thread').value.trim()):'/rooms/room_main/messages';}
async function read(append=false){
 const result=await call(threadPath()+(append&&cursor?'?cursor='+encodeURIComponent(cursor):''));
 if(!append)byId('messages').replaceChildren();
 for(const message of result.data.messages){
  const article=document.createElement('article'),meta=document.createElement('small'),text=document.createElement('pre');
  article.dataset.messageId=message.id;meta.textContent=message.actor_id+' · v'+(message.version||1)+' · '+message.created_at+' · '+message.id;text.textContent=message.text;
  const history=document.createElement('button');history.textContent='이력';history.onclick=()=>load(async()=>{const r=await call('/rooms/room_main/messages/'+encodeURIComponent(message.id)+'/history');byId('details').textContent=JSON.stringify(r.data,null,2);status.textContent='원문과 수정 이력 조회';});
  const edit=document.createElement('button');edit.textContent='수정';edit.onclick=()=>{if(busy||pending)return;editing={id:message.id,version:message.version||1};byId('text').value=message.text;byId('format').value=message.format;byId('post').textContent='수정 저장';};
  article.append(meta,text,history,edit);byId('messages').append(article);
 }
 cursor=result.meta.next_cursor;byId('more').hidden=!result.meta.has_more;return result.data.messages.length;
}
async function load(action){if(busy)return;lock(true);try{await action();}catch(e){status.textContent='조회 오류: '+e.message;}finally{lock(false);}}
for(const id of ['read','more'])byId(id).onclick=()=>load(async()=>{const n=await read(id==='more');status.textContent='저장 기록 '+n+'개 조회 · 실제 에이전트 미연결';});
async function change(path,body,kind){
 if(busy)return;if(!pending)pending={path,body,key:crypto.randomUUID(),kind};lock(true);
 try{const result=await call(pending.path,{method:'POST',headers:{'Idempotency-Key':pending.key},body:JSON.stringify(pending.body)});const done=pending.kind;pending=null;byId('retry').hidden=true;byId('post').textContent='저장';
  if(done==='thread'){byId('thread').value=result.data.thread.id;byId('title').value='';}
  if(done==='message'||done==='revise'){byId('text').value='';editing=null;}
  if(done==='ack')receipt=null;
  if(done==='task'){byId('task-id').value=result.data.task.id;taskSnapshot=null;try{taskSnapshot=(await call('/rooms/room_main/tasks/'+encodeURIComponent(result.data.task.id))).data;renderTask();}catch{byId('task-view').textContent='변경 결과 snapshot (과거 기록일 수 있음). 현재 상태 재조회 실패. 작업 조회를 다시 실행하세요.\n'+JSON.stringify(result.data,null,2);}}
  status.textContent='저장 완료 · '+JSON.stringify(result.data)+' · 실제 에이전트 미연결';
  if(done!=='ack'&&done!=='task')try{await read();}catch{status.textContent+=' · 재조회 실패';}
 }catch(e){const unknown=!e.result||e.result.error.outcome==='unknown';status.textContent=unknown?'저장 결과 미확인. 같은 요청을 재시도하세요. 키: '+pending.key:'저장 거부: '+e.message+(e.result.error.current_version?' (현재 v'+e.result.error.current_version+')':'');if(!unknown)pending=null;byId('retry').hidden=!unknown;byId('post').textContent=unknown?'같은 요청 다시 시도':editing?'수정 저장':'저장';}finally{lock(false);}
}
byId('retry').onclick=()=>change();
byId('form').onsubmit=event=>{
 event.preventDefault();if(busy)return;if(pending)return change();
 const text=byId('text').value;if(!text.trim()||new TextEncoder().encode(text).length>32768){status.textContent='비어 있지 않은 UTF-8 32 KiB 이하의 텍스트가 필요합니다.';return;}
 const body={schema_version:'1',text,format:byId('format').value};
 if(editing)return change('/rooms/room_main/messages/'+encodeURIComponent(editing.id)+'/revisions',{...body,expected_version:editing.version},'revise');
 const thread=byId('thread').value.trim(),reply=byId('reply').value.trim();if(thread)body.thread_id=thread;if(reply)body.reply_to_message_id=reply;
 return change('/rooms/room_main/messages',body,'message');
};
byId('new').onclick=()=>{if(busy||pending)return;editing=null;byId('text').value='';byId('post').textContent='저장';};
byId('thread-create').onclick=()=>change('/rooms/room_main/threads',{schema_version:'1',title:byId('title').value},'thread');
for(const id of ['inbox-pull','inbox-more'])byId(id).onclick=()=>load(async()=>{
 const result=await call('/rooms/room_main/inbox?limit='+encodeURIComponent(byId('limit').value)+(id==='inbox-more'&&inboxCursor?'&cursor='+encodeURIComponent(inboxCursor):''));
 inboxCursor=result.meta.next_cursor;receipt=result.data.receipt;byId('inbox-more').hidden=!result.meta.has_more;byId('events').textContent=JSON.stringify(result.data,null,2);status.textContent='inbox 전달 페이지 조회 · 실행 수락 아님 · 완료 아님';
});
byId('inbox-ack').onclick=()=>{if(receipt)return change('/rooms/room_main/inbox/ack',{schema_version:'1',receipt},'ack');};
for(const id of ['export','export-more'])byId(id).onclick=()=>load(async()=>{
 const thread=byId('thread').value.trim();const result=await call('/rooms/room_main/export?format='+byId('export-format').value+(thread?'&thread_id='+encodeURIComponent(thread):'')+(id==='export-more'&&exportCursor?'&cursor='+encodeURIComponent(exportCursor):''));
 exportCursor=result.meta.next_cursor;byId('export-more').hidden=!result.meta.has_more;byId('details').textContent=JSON.stringify(result.data.range,null,2)+'\n\n'+result.data.text;status.textContent='source ID / revision / 조회 범위를 포함한 export 원문';
});
function renderTask(){byId('task-view').textContent=JSON.stringify(taskSnapshot,null,2)+'\n논리적 취소는 외부 실행 중단 확인이 아닙니다. stop_confirmation: unavailable_no_runner';}
const taskPath=()=>'/rooms/room_main/tasks/'+encodeURIComponent(byId('task-id').value.trim());
byId('task-get').onclick=()=>load(async()=>{taskSnapshot=(await call(taskPath())).data;renderTask();status.textContent='저장된 작업과 서버 lease 조회';});
byId('task-create').onclick=()=>{
 if(busy||pending)return;const split=id=>byId(id).value.split(',').map(v=>v.trim()).filter(Boolean);
 const input_versions=split('task-inputs').map(v=>{const index=v.lastIndexOf('@');return {message_id:v.slice(0,index),revision:Number(v.slice(index+1))};});
 return change('/rooms/room_main/tasks',{schema_version:'1',goal:byId('task-goal').value,owner:byId('task-owner').value.trim()||null,done_conditions:byId('task-conditions').value.split('\n').filter(v=>v.trim()),dependencies:split('task-deps'),input_versions},'task');
};
for(const action of ['claim','renew','submit','cancel','approve'])byId('task-'+action).onclick=()=>{
 if(busy||pending)return;if(!taskSnapshot||taskSnapshot.task.id!==byId('task-id').value.trim()){status.textContent='먼저 작업을 조회하세요.';return;}
 const body={schema_version:'1',expected_version:taskSnapshot.task.version};
 if(action==='claim'||action==='renew'||action==='submit')body.lease_epoch=taskSnapshot.lease.lease_epoch;
 if(action==='submit'){body.artifact_message_id=byId('task-artifact').value.trim();body.artifact_revision=Number(byId('task-revision').value);body.disposition=byId('task-disposition').value;if(byId('task-reason').value)body.reason=byId('task-reason').value;}
 if(action==='cancel')body.reason=byId('task-reason').value;
 if(action==='approve'){const submission=taskSnapshot.submission;if(!submission){status.textContent='승인할 현재 검토 결과가 없습니다.';return;}body.submission_id=submission.id;body.artifact_message_id=submission.artifact_message_id;body.artifact_revision=submission.artifact_revision;}
 return change(taskPath()+'/'+action,body,'task');
};

`;
