import { Fault, VERSION, type Read } from './contracts.ts';
import type { Database, Statement, Value } from './db.ts';
import { mutate } from './mutations.ts';
import { Cursors } from './cursors.ts';
import type { ThreadCreate, ThreadRead, Thread, Revise, HistoryRead, Revision, Ack, ExportRead } from './g2-contracts.ts';

type Access = (room?:string,write?:boolean)=>Promise<void>;
interface Receipt { from_seq:number;to_seq:number;watermark:number }
interface FeedPosition { after:number;watermark:number }
interface ExportPosition { last_message_seq:number;last_version:number;max_message_seq:number;revision_event_watermark:number }

export class Conversation {
  readonly cursors:Cursors;
  constructor(private db:Database,readonly principal:string,private access:Access) { this.cursors=new Cursors(db,principal); }

  async thread(room:string,id:string):Promise<Thread> {
    await this.access(room);
    const row=await this.db.prepare('SELECT * FROM threads WHERE id=? AND room_id=?').bind(id,room).first<Thread>();
    if(!row) throw new Fault('NOT_FOUND','Thread not found.',404);
    return row;
  }
  async message(room:string,id:string) {
    await this.access(room);
    const row=await this.db.prepare('SELECT * FROM message_current WHERE id=? AND room_id=?').bind(id,room)
      .first<{id:string;room_id:string;actor_id:string;version:number;text:string;format:string;created_at:string;thread_id:string|null;reply_to_message_id:string|null}>();
    if(!row) throw new Fault('NOT_FOUND','Message not found.',404);
    return row;
  }
  async postLink(room:string,thread?:string,reply?:string):Promise<{sql:string;args:Value[]}> {
    if(!thread) {
      if(reply) throw new Fault('INVALID_INPUT','A reply requires a thread.');
      return {sql:'1',args:[]};
    }
    await this.thread(room,thread);
    if(reply && !await this.db.prepare(`SELECT 1 FROM messages m JOIN message_links l ON l.message_id=m.id
      WHERE m.id=? AND m.room_id=? AND l.thread_id=?`).bind(reply,room,thread).first())
      throw new Fault('INVALID_RELATION','Reply must belong to the same room and thread.');
    return {sql:`EXISTS (SELECT 1 FROM threads t WHERE t.id=? AND t.room_id=?) AND
      (? IS NULL OR EXISTS (SELECT 1 FROM messages m JOIN message_links l ON l.message_id=m.id WHERE m.id=? AND m.room_id=? AND l.thread_id=?))`,
      args:[thread,room,reply??null,reply??null,room,thread]};
  }

  private async mutate(action:string,key:string,request:object,data:Record<string,unknown>,target:string,version:number|null,
    guard:{sql:string;args:Value[]},effects:(fresh:string,args:Value[])=>Statement[],write=true,onMissing?:()=>Promise<void>) {
    return mutate(this.db,this.principal,this.access,action,key,request,data,target,version,guard,effects,write,onMissing);
  }

  async create(input:ThreadCreate) {
    await this.access(input.room,true);
    const thread:Thread={id:crypto.randomUUID(),room_id:input.room,creator_id:this.principal,title:input.title,created_at:new Date().toISOString()};
    return this.mutate('thread.create',input.idempotency_key,input,{thread},thread.id,null,{sql:'1',args:[]},(fresh,args)=>[
      this.db.prepare(`INSERT INTO threads(id,room_id,creator_id,title,created_at) SELECT ?,?,?,?,? WHERE ${fresh}`)
        .bind(thread.id,thread.room_id,thread.creator_id,thread.title,thread.created_at,...args),
    ]);
  }
  async read(input:ThreadRead) {
    const thread=await this.thread(input.room,input.thread_id);
    const scope={room:input.room,thread_id:input.thread_id};
    const position=input.cursor?await this.cursors.load<{after:number}>(input.cursor,'thread',scope):{after:0};
    const rows=(await this.db.prepare(`SELECT * FROM message_current WHERE room_id=? AND thread_id=? AND seq>? ORDER BY seq LIMIT ?`)
      .bind(input.room,input.thread_id,position.after,input.limit+1).all<Record<string,unknown>&{seq:number}>()).results;
    const has_more=rows.length>input.limit,page=rows.slice(0,input.limit);
    return {data:{thread,messages:page.map(({seq:_,...rest})=>{void _;return rest;})},meta:{has_more,next_cursor:has_more?await this.cursors.save('thread',scope,{after:page.at(-1)!.seq}):null}};
  }
  async revise(input:Revise) {
    await this.access(input.room,true);
    const original=await this.message(input.room,input.message_id);
    if(original.actor_id!==this.principal) throw new Fault('FORBIDDEN','Only the original author may revise.',403);
    const version=input.expected_version+1,id=crypto.randomUUID(),now=new Date().toISOString();
    const message={...original,text:input.text,format:input.format,version,editor_id:this.principal,created_at:now};
    return this.mutate('message.revise',input.idempotency_key,input,{message},original.id,version,
      {sql:'EXISTS (SELECT 1 FROM message_current WHERE id=? AND room_id=? AND actor_id=? AND version=?)',args:[original.id,input.room,this.principal,input.expected_version]},
      (fresh,args)=>[this.db.prepare(`INSERT INTO message_revisions(id,message_id,version,editor_id,text,format,created_at) SELECT ?,?,?,?,?,?,? WHERE ${fresh}`)
        .bind(id,original.id,version,this.principal,input.text,input.format,now,...args)],true,async()=>{
        const current=await this.message(input.room,original.id);
        if(current.version!==input.expected_version) throw new Fault('VERSION_CONFLICT','Message version changed.',409,'not_applied',false,
          {current_version:current.version,lookup:`/api/v1/rooms/${input.room}/messages/${original.id}/history`});
      });
  }
  async history(input:HistoryRead) {
    const current=await this.message(input.room,input.message_id),scope={room:input.room,message_id:input.message_id};
    const p=input.cursor?await this.cursors.load<{after:number;max:number}>(input.cursor,'history',scope):{after:0,max:current.version};
    const rows=(await this.db.prepare(`SELECT * FROM message_history WHERE room_id=? AND message_id=? AND version>? AND version<=? ORDER BY version LIMIT ?`)
      .bind(input.room,input.message_id,p.after,p.max,input.limit+1).all<Revision>()).results;
    const has_more=rows.length>input.limit,page=rows.slice(0,input.limit);
    return {data:{message_id:current.id,revisions:page},meta:{has_more,next_cursor:has_more?await this.cursors.save('history',scope,{after:page.at(-1)!.version,max:p.max}):null}};
  }

  async pull(input:Read) {
    await this.access(input.room);
    const scope={room:input.room};
    const p=input.cursor?await this.cursors.load<FeedPosition>(input.cursor,'inbox',scope):
      (await this.db.prepare(`SELECT COALESCE((SELECT acked_seq FROM inbox_state WHERE principal_id=? AND room_id=?),0) AS after,
        COALESCE((SELECT max(seq) FROM room_events WHERE room_id=?),0) AS watermark`).bind(this.principal,input.room,input.room).first<FeedPosition>())!;
    const rows=(await this.db.prepare(`SELECT e.seq,e.id AS event_id,e.kind,e.message_id,e.version,COALESCE(e.thread_id,h.thread_id) AS thread_id,
      e.actor_id,e.created_at,h.text,h.format,h.reply_to_message_id,t.title FROM room_events e
      LEFT JOIN message_history h ON h.message_id=e.message_id AND h.version=e.version
      LEFT JOIN threads t ON t.id=e.thread_id WHERE e.room_id=? AND e.seq>? AND e.seq<=? ORDER BY e.seq LIMIT ?`)
      .bind(input.room,p.after,p.watermark,input.limit+1).all<{seq:number;[key:string]:unknown}>()).results;
    const has_more=rows.length>input.limit,page=rows.slice(0,input.limit),end=page.at(-1)?.seq??p.after;
    const receipt=page.length?await this.cursors.save('inbox-receipt',scope,{from_seq:p.after,to_seq:end,watermark:p.watermark}):null;
    return {data:{events:page,receipt,execution_accepted:false,processing_complete:false},meta:{has_more,
      next_cursor:has_more?await this.cursors.save('inbox',scope,{after:end,watermark:p.watermark}):null}};
  }
  async ack(input:Ack) {
    await this.access(input.room);
    const receipt=await this.cursors.load<Receipt>(input.receipt,'inbox-receipt',{room:input.room});
    return this.mutate('inbox.ack',input.idempotency_key,input,{ack:{receipt:input.receipt,through_seq:receipt.to_seq,execution_accepted:false,processing_complete:false}},input.receipt,null,
      {sql:'COALESCE((SELECT acked_seq FROM inbox_state WHERE principal_id=? AND room_id=?),0)>=?',args:[this.principal,input.room,receipt.from_seq]},
      (fresh,args)=>[this.db.prepare(`INSERT INTO inbox_state(principal_id,room_id,acked_seq) SELECT ?,?,? WHERE ${fresh}
        ON CONFLICT(principal_id,room_id) DO UPDATE SET acked_seq=max(inbox_state.acked_seq,excluded.acked_seq)`)
        .bind(this.principal,input.room,receipt.to_seq,...args)],false,async()=>{
        const state=await this.db.prepare('SELECT acked_seq FROM inbox_state WHERE principal_id=? AND room_id=?').bind(this.principal,input.room).first<{acked_seq:number}>();
        if((state?.acked_seq??0)<receipt.from_seq) throw new Fault('ACK_OUT_OF_ORDER','Acknowledge the earlier delivered page first.',409);
      });
  }

  async export(input:ExportRead) {
    await this.access(input.room); if(input.thread_id) await this.thread(input.room,input.thread_id);
    const scope={room:input.room,thread_id:input.thread_id??null,format:input.format};
    const p=input.cursor?await this.cursors.load<ExportPosition>(input.cursor,'export',scope):
      {...(await this.db.prepare(`SELECT COALESCE((SELECT max(seq) FROM messages WHERE room_id=?),0) AS max_message_seq,
        COALESCE((SELECT max(seq) FROM room_events WHERE room_id=?),0) AS revision_event_watermark`).bind(input.room,input.room).first<{max_message_seq:number;revision_event_watermark:number}>())!,last_message_seq:0,last_version:0};
    const rows=(await this.db.prepare(`SELECT h.* FROM message_history h WHERE h.room_id=? AND h.message_seq<=?
      AND (? IS NULL OR h.thread_id=?) AND (h.message_seq>? OR (h.message_seq=? AND h.version>?))
      AND (h.version=1 OR EXISTS (SELECT 1 FROM room_events e WHERE e.message_id=h.message_id AND e.version=h.version AND e.seq<=?))
      ORDER BY h.message_seq,h.version LIMIT ?`)
      .bind(input.room,p.max_message_seq,input.thread_id??null,input.thread_id??null,p.last_message_seq,p.last_message_seq,p.last_version,p.revision_event_watermark,input.limit+1).all<Revision>()).results;
    const has_more=rows.length>input.limit,page=rows.slice(0,input.limit),last=page.at(-1);
    const range={...scope,max_message_seq:p.max_message_seq,revision_event_watermark:p.revision_event_watermark,
      after:{message_seq:p.last_message_seq,version:p.last_version},through:last?{message_seq:last.message_seq,version:last.version}:null,include:'all_revisions'};
    const records=page.map(r=>({source_message_id:r.message_id,source_revision:r.version,source_thread_id:r.thread_id,reply_to_message_id:r.reply_to_message_id,
      actor_id:r.actor_id,editor_id:r.editor_id,created_at:r.created_at,format:r.format,text:r.text}));
    const text=records.map(r=>{
      const header=JSON.stringify({...r,text:undefined});
      if(input.format==='text') return header+'\n'+r.text;
      const run=Math.max(2,...Array.from(r.text.matchAll(/`+/g),m=>m[0].length)),fence='`'.repeat(run+1);
      return header+'\n'+fence+'text\n'+r.text+'\n'+fence;
    }).join('\n\n');
    return {data:{schema_version:VERSION,records,text,format:input.format,range},meta:{has_more,
      next_cursor:has_more?await this.cursors.save('export',scope,{...p,last_message_seq:last!.message_seq,last_version:last!.version}):null}};
  }
}
