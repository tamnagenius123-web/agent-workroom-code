import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { harness } from '../scripts/local-harness.ts';

type App = Awaited<ReturnType<typeof harness>>;
type Row = Record<string, unknown>;
interface Data extends Row { item?: Row; fold?: Row; sources?: Row[]; content_digest?: string; folds?: Row[]; sections?: Record<string, Row[]>; lineage?: string[]; fold_ids?: string[]; review_queue?: { pending_items: number; pending_folds: number }; timestamps?: { claimed: { server_verified: boolean } } }
interface Rpc { result?: { isError: boolean; structuredContent?: { ok: boolean; data?: Data; error?: { code: string } } }; error?: unknown }
interface Message { id: string; room_id: string; actor_id: string; text: string; created_at: string }
// Optional evidence capture; normal repository/CI execution needs no environment setup.
const evidenceFile = process.env.WORKROOM_COMPOSITION_EVIDENCE_FILE;
const observations: object[] = [];
let app: App, a: Message, b: Message, fold: Data, memory: Rpc, initialAuthority: unknown;
let outbound = 0;
const historical = '0100-01-01T00:00:00+00:01';
const from = '0099-12-31T23:58:00.000Z';
const modern = '2099-01-01T00:00:00.000Z';
const sourceText = 'compositionneedle original synthetic source revision';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function call(name: string, args: object): Promise<Rpc> {
  const res = await app.mf.dispatchFetch('http://127.0.0.1/mcp', { method:'POST',headers:{
    Authorization:'Bearer local-alpha-fixture','Content-Type':'application/json',Accept:'application/json, text/event-stream',
    'MCP-Protocol-Version':'2026-07-28','MCP-Method':'tools/call','Mcp-Name':name,
  },body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{schema_version:'1',room:'room_main',...args},
    _meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}}}) });
  const reply=await res.json() as Rpc;assert.equal(res.status,200,JSON.stringify(reply));return reply;
}
function accepted(r: Rpc): Data { assert.equal(r.result?.isError,false,JSON.stringify(r));assert.equal(r.result?.structuredContent?.ok,true,JSON.stringify(r));const d=r.result?.structuredContent?.data;assert.ok(d);return d; }
async function post(key: string,text: string): Promise<Message> {
  const res=await app.mf.dispatchFetch('http://127.0.0.1/api/v1/rooms/room_main/messages',{method:'POST',headers:{Authorization:'Bearer local-alpha-fixture','Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({schema_version:'1',text})});
  const body=await res.json() as {data?:{message?:Message}};assert.equal(res.status,200,JSON.stringify(body));assert.ok(body.data?.message);return body.data.message;
}
async function table(name: string): Promise<Row[]> {return (await app.db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all<Row>()).results;}
async function authority(){const out:Record<string,Row[]>={};for(const name of ['principals','memberships','principal_roles','memory_reviewers','memory_reviewer_log','memory_reviews'])out[name]=await table(name);return out;}
async function memoryState(){const out:Record<string,Row[]>={};for(const name of ['memory_items','memory_edges','memory_folds','fold_edges','fold_sources','message_history'])out[name]=await table(name);return out;}
async function pack(at: string,folds: boolean){return call('workroom_context_pack',{task:'compositionneedle',budget_chars:8000,at,folds});}
before(async()=>{
  app=await harness({through:9999,outboundService:()=>{outbound++;throw new Error('no outbound');}});
  initialAuthority=await authority();
  a=await post('composition-source-a',sourceText);b=await post('composition-source-b','distinct synthetic control source');
  for(let i=0;i<20;i++)await post('composition-tail-'+i,'ordinary synthetic tail '+i);
  fold=accepted(await call('workroom_fold_propose',{id:'composition-pending-fold',summary:'compositionneedle pending fold summary',valid_from:a.created_at,message_ids:[a.id]}));
  assert.ok(fold.fold);assert.equal(fold.fold.review_state,'pending');assert.equal(fold.fold.valid_from,a.created_at);
  assert.equal(fold.sources?.length,1);assert.equal(fold.sources?.[0]?.source_version,1);assert.equal(fold.sources?.[0]?.source_hash,hash(sourceText));
  const f=fold.fold;
  const expected=hash(JSON.stringify(['workroom.memory_fold.v1',f.id,f.room_id,f.summary,f.first_message_id,f.last_message_id,f.span_from,f.span_to,f.valid_from,[[a.id,1,hash(sourceText)]],[]]));
  assert.equal(fold.content_digest,expected);assert.equal(f.content_digest,expected);
  memory=await call('workroom_memory_propose',{kind:'decision',tier:0,title:'compositionneedle pending decision',body:'Synthetic pending decision only.',source_message_id:a.id,valid_from:from});
  observations.push({case:'native-fixture',a,b,tail_count:20,fold,memory,authority:initialAuthority});
});
after(async()=>{
  try {if(app){const finalAuthority=await authority();observations.push({case:'final-authority',initialAuthority,finalAuthority});assert.deepEqual(finalAuthority,initialAuthority);}}
  finally {await app?.close();if(evidenceFile)await writeFile(evidenceFile,JSON.stringify({outbound,synthetic_only:true,observations},null,2)+'\n');}
  assert.equal(outbound,0);
});

test('populated pending stores preserve temporal query and current queue contracts',async()=>{
  const beforeRows=await memoryState();
  const lowPlain=await pack(historical,false),lowFolded=await pack(historical,true);
  const brief=await call('workroom_brief_get',{at:historical,max_chars:8000});
  const modernFold=await call('workroom_fold_view',{at:modern,include_pending:true});
  const approvedOnly=await call('workroom_fold_view',{at:modern,include_pending:false});
  const afterRows=await memoryState();observations.push({case:'populated-temporal',memory,lowPlain,lowFolded,brief,modernFold,approvedOnly,beforeRows,afterRows});
  assert.deepEqual(afterRows,beforeRows);
  const item=accepted(memory).item;assert.ok(item);assert.equal(item.valid_from,from);assert.equal(item.review_state,'pending');assert.equal(item.source_version,1);
  for(const reply of [lowPlain,lowFolded]){const d=accepted(reply);assert.ok(d.sections);assert.ok(Object.values(d.sections).every(s=>s.length===0));assert.deepEqual(d.lineage,[]);}
  const briefData=accepted(brief);assert.equal(briefData.at,'0099-12-31T23:59:00.000Z');assert.deepEqual(briefData.decisions,[]);
  assert.equal(briefData.review_queue?.pending_items,1);assert.equal(briefData.review_queue?.pending_folds,1);
  const visible=accepted(modernFold).folds;assert.equal(visible?.length,1);assert.equal(visible?.[0]?.id,fold.fold?.id);
  const pins=visible?.[0]?.sources as Row[];assert.equal(pins[0]?.effective_provenance,'resolvable');assert.equal(pins[0]?.source_hash,hash(sourceText));assert.equal(pins[0]?.source_version,1);
  assert.deepEqual(accepted(approvedOnly).folds,[]);
});

test('same-message raw context lineage coexists with corrected wake report binding',async()=>{
  const beforeRows=await memoryState();
  const plain=accepted(await pack(modern,false)),folded=accepted(await pack(modern,true));
  for(const p of [plain,folded]){
    assert.deepEqual(p.sections?.decisions,[]);assert.deepEqual(p.sections?.skills,[]);assert.deepEqual(p.sections?.facts,[]);
    assert.equal(p.sections?.messages?.length,1);const hit=p.sections?.messages?.[0];assert.equal(hit?.source_message_id,a.id);assert.equal(hit?.source_version,1);assert.equal(hit?.source_current_version,1);assert.equal(hit?.source_version_basis,'current');assert.equal(hit?.source_excerpt,sourceText);assert.deepEqual(p.lineage,[a.id]);
  }
  assert.deepEqual(folded.sections?.folds,[]);assert.deepEqual(folded.fold_ids,[]);
  const host={run_id:'composition-synthetic-run',delivery_id:'composition-undelivered',event_id:'composition-synthetic-event',agent:'synthetic:alpha',started_at:a.created_at,cause:'delivery'};
  const args={idempotency_key:'composition-host-report',stage:'host_run',host_run:host};
  const first=accepted(await call('workroom_wake_report',{...args,message_id:a.id}));assert.equal(first.timestamps?.claimed.server_verified,false);
  const wakeBefore=await table('wake_evidence');
  const wrong=await call('workroom_wake_report',{...args,message_id:b.id});
  const replay=accepted(await call('workroom_wake_report',{...args,message_id:a.id}));
  const wakeAfter=await table('wake_evidence');
  const afterRows=await memoryState();const afterPack=accepted(await pack(modern,true));
  observations.push({case:'coexistence',plain,folded,first,wrong,replay,wakeBefore,wakeAfter,beforeRows,afterRows,afterPack});
  assert.deepEqual(wakeAfter,wakeBefore);assert.deepEqual(afterRows,beforeRows);assert.deepEqual(afterPack,folded);
  assert.equal(replay.replayed,true);assert.equal(replay.id,first.id);assert.equal(replay.recorded_at,first.recorded_at);
  assert.equal(wrong.result?.structuredContent?.ok,false,'another message must not replay the source-bound report');assert.equal(wrong.result?.structuredContent?.error?.code,'IDEMPOTENCY_CONFLICT');
});
