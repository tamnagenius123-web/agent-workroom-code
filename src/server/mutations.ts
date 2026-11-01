import { Fault, ROOM } from './contracts.ts';
import { AUTH } from './policy.ts';
import type { Database, Statement, Value } from './db.ts';

export type Access = (room?:string,write?:boolean)=>Promise<void>;
export interface Predicate {sql:string;args:Value[]}
export interface Row {request_hash:string;result_json:string}
// One idempotent write, built but not yet run. `statements` end with the read-back of the operation row;
// `applied` is true inside the same batch only if this op's row exists with this request hash.
// `finish` turns the read-back row into the result (or the precise fault) and must run after commit.
export interface Plan<T> {statements:Statement[];applied:Predicate;finish(row:Row|undefined):Promise<T>}
interface Options { authority?:Predicate; result?:Predicate; audit?:'g2_audit'|'task_audit' }
// Flat G2 inputs and nested G3 references share one deterministic serialization.
export function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(value!==null && typeof value==='object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export async function sha256(text:string) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function run<T>(db:Database,plan:Plan<T>):Promise<T> {
  const output=await db.batch<Row>(plan.statements);
  return plan.finish(output.at(-1)?.results[0]);
}
export async function mutate(db:Database,principal:string,access:Access,action:string,key:string,request:object,data:Record<string,unknown>,target:string,version:number|null,
  guard:Predicate,effects:(fresh:string,args:Value[])=>Statement[],write=true,onMissing?:()=>Promise<void>,options:Options={}) {
  return run(db,await planMutation(db,principal,access,action,key,request,data,target,version,guard,effects,write,onMissing,options));
}
export async function planMutation(db:Database,principal:string,access:Access,action:string,key:string,request:object,data:Record<string,unknown>,target:string,version:number|null,
  guard:Predicate,effects:(fresh:string,args:Value[])=>Statement[],write=true,onMissing?:()=>Promise<void>,options:Options={}):Promise<Plan<{data:{operation:{id:string}};meta:{idempotency_key:string;replayed:boolean}}>> {
  await access(ROOM,write);
  const authority=options.authority??{sql:'1',args:[]};
  const checkAuthority=async()=>{
    if(!await db.prepare('SELECT 1 WHERE '+authority.sql).bind(...authority.args).first()) throw new Fault('FORBIDDEN','Task authority denied.',403);
  };
  await checkAuthority();
  const hash=await sha256(JSON.stringify(canonical(request)));
  const id=crypto.randomUUID(),now=new Date().toISOString();
  const operation={type:action,idempotency_key:key,id};
  const result=options.result??{sql:'?',args:[JSON.stringify(data)]};
  const permission=AUTH+(write?' AND m.can_post=1':'')+` AND (${authority.sql})`;
  const fresh=`EXISTS (SELECT 1 FROM operations WHERE principal_id=? AND operation=? AND key=? AND json_extract(result_json,'$.operation.id')=?)`;
  const args=[principal,action,key,id];
  const statements=[
    db.prepare(`INSERT INTO operations(principal_id,operation,key,room_id,request_hash,result_json,created_at)
      SELECT ?,?,?,?,?,json_set(json(${result.sql}),'$.operation',json(?)),? WHERE EXISTS (${permission}) AND (${guard.sql})
      AND (SELECT count(*) FROM operations WHERE principal_id=? AND created_at>=?)<60
      ON CONFLICT(principal_id,operation,key) DO NOTHING`)
      .bind(principal,action,key,ROOM,hash,...result.args,JSON.stringify(operation),now,principal,ROOM,...authority.args,...guard.args,principal,now.slice(0,16)+':00.000Z'),
    ...effects(fresh,args),
    db.prepare(`INSERT INTO ${options.audit??'g2_audit'}(id,principal_id,room_id,operation,target_id,version,created_at) SELECT ?,?,?,?,?,?,? WHERE ${fresh}`)
      .bind(crypto.randomUUID(),principal,ROOM,action,target,version,now,...args),
    db.prepare(`SELECT request_hash,result_json FROM operations WHERE principal_id=? AND operation=? AND key=? AND EXISTS (${permission})`)
      .bind(principal,action,key,principal,ROOM,...authority.args),
  ];
  return {statements,
    applied:{sql:`EXISTS (SELECT 1 FROM operations WHERE principal_id=? AND operation=? AND key=? AND request_hash=? AND EXISTS (${permission}))`,args:[principal,action,key,hash,principal,ROOM,...authority.args]},
    async finish(row) {
      if(!row) {
        await access(ROOM,write);await checkAuthority();await onMissing?.();
        throw new Fault('RATE_LIMITED','Mutation limit reached; retry the same key later.',429,'not_applied',true,{retry_after:60-new Date().getUTCSeconds()});
      }
      if(row.request_hash!==hash) throw new Fault('IDEMPOTENCY_CONFLICT','Key already has different content.',409,'not_applied',false,
        {operation:action,idempotency_key:key,lookup:`/api/v1/operations/${action}/${key}`});
      const stored=JSON.parse(row.result_json) as {operation:{id:string}};
      return {data:stored,meta:{idempotency_key:key,replayed:stored.operation.id!==id}};
    }};
}
