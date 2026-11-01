import { Fault, ROOM } from './contracts.ts';
import type { Database,Statement,Value } from './db.ts';
import { AUTH } from './policy.ts';
import { canonical,planMutation,run,sha256,type Access,type Plan,type Predicate,type Row } from './mutations.ts';
import type { TaskClaimNext,TaskCreate,TaskGet,TaskAction } from './task-contracts.ts';

export const DB_NOW="CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
export const LOCAL_LEASE_MS=30000;
const CLAIM_NEXT='task.claim_next';
// A concurrent claim moves the chosen row. The guarded update matches nothing, then setting version=version trips task_version and rolls the batch back.
function claimLost(error:unknown) {
  const message=error instanceof Error?error.message+' '+(error.cause instanceof Error?error.cause.message:''):String(error);
  return /invalid task version|SQLITE_BUSY|database is locked/i.test(message);
}
const ELIGIBLE=`t.room_id=? AND t.state='open' AND (t.owner_id IS NULL OR t.owner_id=?) AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(t.spec_json,'$.dependencies')) d LEFT JOIN tasks dep ON dep.id=d.value AND dep.room_id=t.room_id WHERE dep.id IS NULL OR dep.state!='done')`;
interface Spec {goal:string;owner:string|null;dependencies:string[];input_versions:{message_id:string;revision:number}[];done_conditions:string[]}
interface Task {id:string;room_id:string;creator_id:string;owner_id:string|null;goal:string;dependencies:string[];input_versions:Spec['input_versions'];done_conditions:string[];state:string;version:number;current_submission_id:string|null;cancel_reason:string|null;created_at_ms:number;updated_at_ms:number;stop_confirmation:'unavailable_no_runner'}
interface Lease {task_id:string;holder_id:string|null;lease_epoch:number;expires_at_ms:number}
interface Submission {id:string;task_id:string;actor_id:string;lease_epoch:number;artifact_message_id:string;artifact_revision:number;disposition:'review'|'blocked';reason:string|null;submitted_at_ms:number}
export interface Bundle {task:Task;lease:Lease;submission:Submission|null;server_time_ms:number;lease_active:boolean;submitted?:Submission;changes_requested?:{submission_id:string;reviewer_id:string;reason:string}}
interface TaskRow {id:string;room_id:string;creator_id:string;owner_id:string|null;spec_json:string;state:string;version:number;current_submission_id:string|null;cancel_reason:string|null;created_at_ms:number;updated_at_ms:number}
export type Action='claim'|'renew'|'submit'|'cancel'|'approve'|'request_changes';
export interface WrgitClaim { enabled: boolean; prepare(): Promise<void>; ensureWorkspace(taskId: string, agentId: string): Promise<void>; pendingHeld(taskId: string, agentId: string): Promise<boolean>; pendingTask(agentId: string): Promise<string | null>; pendingMarker(fresh: string, args: Value[], taskId: string, agentId: string): Statement }

/** state is task.state. lease_active is the in-progress lease that has not reached server time. get and mine both call this. */
export function taskReadStatus(state:string,expiresAtMs:number,nowMs:number):{state:string;lease_active:boolean} {
  return {state,lease_active:state==='in_progress'&&expiresAtMs>nowMs};
}

export class Tasks {
  constructor(private db:Database,private principal:string,private access:Access,private wrgit?:WrgitClaim) {}
  private async beforeClaim() { if(this.wrgit?.enabled) await this.wrgit.prepare(); }
  private async afterClaim(taskId:string) { if(this.wrgit?.enabled) await this.wrgit.ensureWorkspace(taskId,this.principal); }
  async get(input:TaskGet):Promise<{data:Bundle;meta:object}> {
    await this.access(input.room);
    const row=await this.db.prepare(`SELECT t.*,json_object('task_id',l.task_id,'holder_id',l.holder_id,'lease_epoch',l.lease_epoch,'expires_at_ms',l.expires_at_ms) AS lease_json,
      CASE WHEN s.id IS NULL THEN NULL ELSE json_object('id',s.id,'task_id',s.task_id,'actor_id',s.actor_id,'lease_epoch',s.lease_epoch,'artifact_message_id',s.artifact_message_id,'artifact_revision',s.artifact_revision,'disposition',s.disposition,'reason',s.reason,'submitted_at_ms',s.submitted_at_ms) END AS submission_json,
      ${DB_NOW} AS server_time_ms FROM tasks t JOIN task_leases l ON l.task_id=t.id LEFT JOIN task_submissions s ON s.id=t.current_submission_id AND s.task_id=t.id WHERE t.id=? AND t.room_id=?`)
      .bind(input.task_id,input.room).first<TaskRow&{lease_json:string;submission_json:string|null;server_time_ms:number}>();
    if(!row) throw new Fault('NOT_FOUND','Task not found.',404);
    const {spec_json,lease_json,submission_json,server_time_ms,...rest}=row,spec=JSON.parse(spec_json) as Spec;
    const task:Task={...rest,goal:spec.goal,dependencies:spec.dependencies,input_versions:spec.input_versions,done_conditions:spec.done_conditions,stop_confirmation:'unavailable_no_runner'};
    const lease=JSON.parse(lease_json) as Lease,submission=submission_json?JSON.parse(submission_json) as Submission:null,now=server_time_ms;
    const read=taskReadStatus(task.state,lease.expires_at_ms,now);
    return {data:{task,lease,submission,server_time_ms:now,lease_active:read.lease_active},meta:{}};
  }
  // Owner and holder are separate. Ownership keeps a row unless state is done or canceled. A holder-only row stays only while lease_active is true.
  async mine(input:{room:string}):Promise<{id:string;state:string;lease_active:boolean}[]> {
    await this.access(input.room);
    const rows=await this.db.prepare(`SELECT t.id AS id,t.state AS state,t.owner_id AS owner_id,l.holder_id AS holder_id,l.expires_at_ms AS expires_at_ms,${DB_NOW} AS server_time_ms FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE t.room_id=? AND (t.owner_id=? OR l.holder_id=?) ORDER BY t.created_at_ms,t.id`).bind(input.room,this.principal,this.principal).all<{id:string;state:string;owner_id:string|null;holder_id:string|null;expires_at_ms:number;server_time_ms:number}>();
    const out:{id:string;state:string;lease_active:boolean}[]=[];
    for(const row of rows.results) {
      const read=taskReadStatus(row.state,row.expires_at_ms,row.server_time_ms);
      if(row.owner_id===this.principal) {
        if(read.state==='done'||read.state==='canceled') continue;
        out.push({id:row.id,state:read.state,lease_active:read.lease_active});
        continue;
      }
      if(row.holder_id===this.principal&&read.lease_active) out.push({id:row.id,state:read.state,lease_active:read.lease_active});
    }
    return out;
  }
  async listBlocked(room:string):Promise<{data:{tasks:{id:string;state:string;dep_ids:string[]}[]};meta:object}> {
    await this.access(room);
    const loaded=await this.db.prepare(`SELECT t.id AS id, t.state AS state,
      COALESCE((SELECT json_group_array(d.value ORDER BY d.key) FROM json_each(json_extract(t.spec_json,'$.dependencies')) d
        LEFT JOIN tasks dep ON dep.id=d.value AND dep.room_id=t.room_id
        WHERE dep.id IS NULL OR dep.state!='done'),'[]') AS dep_ids
      FROM tasks t WHERE t.room_id=? AND t.state='blocked' ORDER BY t.created_at_ms, t.id`).bind(room).all<{id:string;state:string;dep_ids:string}>();
    return {data:{tasks:loaded.results.map(row=>({id:row.id,state:row.state,dep_ids:JSON.parse(row.dep_ids) as string[]}))},meta:{}};
  }
  private role(kind:string):Predicate {return {sql:'EXISTS (SELECT 1 FROM principal_roles WHERE principal_id=? AND kind=?)',args:[this.principal,kind]};}
  private async check(p:Predicate) {return !!await this.db.prepare('SELECT 1 WHERE '+p.sql).bind(...p.args).first();}
  private refs(spec:Spec):Predicate {
    const parts=['1'],args:Value[]=[];
    if(spec.owner!==null) {parts.push(`EXISTS (SELECT 1 FROM memberships m JOIN principals p ON p.id=m.principal_id JOIN principal_roles r ON r.principal_id=p.id WHERE p.id=? AND p.active=1 AND m.room_id=? AND m.active=1 AND m.can_post=1 AND r.kind='agent')`);args.push(spec.owner,ROOM);}
    parts.push('NOT EXISTS (SELECT 1 FROM json_each(?) d LEFT JOIN tasks t ON t.id=d.value AND t.room_id=? WHERE t.id IS NULL)');args.push(JSON.stringify(spec.dependencies),ROOM);
    parts.push("NOT EXISTS (SELECT 1 FROM json_each(?) v LEFT JOIN message_history h ON h.message_id=json_extract(v.value,'$.message_id') AND h.version=json_extract(v.value,'$.revision') AND h.room_id=? WHERE h.message_id IS NULL)");args.push(JSON.stringify(spec.input_versions),ROOM);
    return {sql:parts.join(' AND '),args};
  }
  private snapshot(data:Bundle,action:'create'|Action):Predicate {
    const changes=["'$.task.updated_at_ms'",DB_NOW,"'$.server_time_ms'",DB_NOW];
    if(action==='create') changes.push("'$.task.created_at_ms'",DB_NOW);
    if(action==='claim'||action==='renew') changes.push("'$.lease.expires_at_ms'",DB_NOW+'+'+LOCAL_LEASE_MS);
    if(action==='submit'){changes.push("'$.submitted.submitted_at_ms'",DB_NOW);if(data.submission)changes.push("'$.submission.submitted_at_ms'",DB_NOW);}
    return {sql:`json_set(json(?),${changes.join(',')})`,args:[JSON.stringify(data)]};
  }
  private effects(action:'create'|Action,spec?:Spec,claimTaskId?:string) {
    return (fresh:string,args:Value[]):Statement[]=>{
      const cte="WITH fresh AS (SELECT result_json AS j FROM operations WHERE principal_id=? AND operation=? AND key=? AND json_extract(result_json,'$.operation.id')=?) ";
      const j=(path:string)=>`json_extract(j,'$.${path}')`;
      const taskFields=['id','room_id','creator_id','owner_id'];
      const statements:Statement[]=[];
      if(action==='create') statements.push(this.db.prepare(cte+`INSERT INTO tasks(id,room_id,creator_id,owner_id,spec_json,state,version,current_submission_id,cancel_reason,created_at_ms,updated_at_ms) SELECT ${taskFields.map(f=>j('task.'+f)).join(',')},?,${['state','version','current_submission_id','cancel_reason','created_at_ms','updated_at_ms'].map(f=>j('task.'+f)).join(',')} FROM fresh`).bind(...args,JSON.stringify(spec)));
      if(action==='submit') {
        const fields=['id','task_id','actor_id','lease_epoch','artifact_message_id','artifact_revision','disposition','reason','submitted_at_ms'];
        statements.push(this.db.prepare(cte+`INSERT INTO task_submissions(${fields.join(',')}) SELECT ${fields.map(f=>j('submitted.'+f)).join(',')} FROM fresh`).bind(...args));
      }
      if(action!=='create') {
        const fields=['state','version','current_submission_id','cancel_reason','updated_at_ms'];
        statements.push(this.db.prepare(cte+`UPDATE tasks SET (${fields.join(',')})=(SELECT ${fields.map(f=>j('task.'+f)).join(',')} FROM fresh) WHERE id=(SELECT ${j('task.id')} FROM fresh)`).bind(...args));
      }
      const fields=['task_id','holder_id','lease_epoch','expires_at_ms'];
      statements.push(this.db.prepare(cte+`INSERT INTO task_leases(${fields.join(',')}) SELECT ${fields.map(f=>j('lease.'+f)).join(',')} FROM fresh WHERE 1 ON CONFLICT(task_id) DO UPDATE SET holder_id=excluded.holder_id,lease_epoch=excluded.lease_epoch,expires_at_ms=excluded.expires_at_ms`).bind(...args));
      // Same batch as the claim. A version trigger blocks rolling the claim back, so the marker has to land before any Artifacts call.
      if(action==='claim'&&claimTaskId&&this.wrgit?.enabled) statements.push(this.wrgit.pendingMarker(fresh,args,claimTaskId,this.principal));
      return statements;
    };
  }
  async create(input:TaskCreate) {return run(this.db,await this.planCreate(input));}
  async action(action:Action,input:TaskAction) {
    if(action==='claim') await this.beforeClaim();
    try {
      const result=await run(this.db,await this.planAction(action,input));
      if(action==='claim') await this.afterClaim(input.task_id);
      return result;
    } catch(error) {
      // 409 on a held claim with a pending fork: finish the workspace instead of staying stuck.
      if(action==='claim' && await this.finishPending(input,error)) return this.get({schema_version:'1',room:input.room,task_id:input.task_id});
      throw error;
    }
  }
  private async finishPending(input:TaskAction,error:unknown) {
    if(!this.wrgit?.enabled || !(error instanceof Fault) || error.status!==409) return false;
    if(!await this.wrgit.pendingHeld(input.task_id,this.principal)) return false;
    await this.afterClaim(input.task_id);
    return true;
  }
  async claimNext(input:TaskClaimNext) {
    await this.access(input.room,true);
    await this.beforeClaim();
    const pending=this.wrgit?.enabled?await this.wrgit.pendingTask(this.principal):null;
    if(pending) {
      await this.afterClaim(pending);
      return this.get({schema_version:'1',room:input.room,task_id:pending});
    }
    for(let attempt=0;;attempt++) {
      // Repo hash needs the task id in JS. Pin that id and insert the marker in this batch; a lost race retries.
      const pinned=this.wrgit?.enabled?(await this.oldestEligibleId(input.room)??''):undefined;
      try {
        const result=await run(this.db,await this.planClaimNext(input,pinned));
        const taskId=(result.data as {task?:{id?:string}}).task?.id;
        if(taskId) await this.afterClaim(taskId);
        return result;
      }
      catch(error) {
        if(pinned!==undefined&&attempt<3&&await this.pinnedTaskMoved(input.room,pinned,error)) continue;
        if(attempt>=3||error instanceof Fault||!claimLost(error)) throw error;
      }
    }
  }
  private async oldestEligibleId(room:string):Promise<string|null> {
    const row=await this.db.prepare(`SELECT t.id AS id FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE ${ELIGIBLE} ORDER BY t.created_at_ms,t.id LIMIT 1`).bind(room,this.principal).first<{id:string}>();
    return row?.id??null;
  }
  private async pinnedTaskMoved(room:string,pinned:string,error:unknown):Promise<boolean> {
    if(!(error instanceof Fault)||error.code!=='RATE_LIMITED') return false;
    const next=await this.oldestEligibleId(room);
    return next!==(pinned===''?null:pinned);
  }
  private async planClaimNext(input:TaskClaimNext,pinnedId?:string):Promise<Plan<{data:{operation:{id:string}};meta:{idempotency_key:string;replayed:boolean}}>> {
    await this.access(input.room,true);
    const authority=this.role('agent'),key=input.idempotency_key,id=crypto.randomUUID(),now=new Date().toISOString();
    const hash=await sha256(JSON.stringify(canonical(input)));
    const operation={type:CLAIM_NEXT,idempotency_key:key,id};
    const permission=AUTH+' AND m.can_post=1 AND ('+authority.sql+')';
    const args=[this.principal,CLAIM_NEXT,key,id];
    const cte="WITH fresh AS (SELECT result_json AS j FROM operations WHERE principal_id=? AND operation=? AND key=? AND json_extract(result_json,'$.operation.id')=?) ";
    const j=(path:string)=>`json_extract(j,'$.${path}')`;
    const taskFields=['state','version','current_submission_id','cancel_reason','updated_at_ms'];
    const leaseFields=['task_id','holder_id','lease_epoch','expires_at_ms'];
    const landed=`EXISTS (SELECT 1 FROM tasks t, fresh WHERE t.id=${j('task.id')} AND t.room_id=? AND t.version=${j('task.version')} AND t.state='in_progress')`;
    const minute=now.slice(0,16)+':00.000Z';
    const pick=pinnedId===undefined?ELIGIBLE:`${ELIGIBLE} AND t.id=?`;
    const pickArgs=pinnedId===undefined?[input.room,this.principal]:[input.room,this.principal,pinnedId];
    const fresh=`EXISTS (SELECT 1 FROM operations WHERE principal_id=? AND operation=? AND key=? AND json_extract(result_json,'$.operation.id')=?)`;
    const statements:Statement[]=[
      this.db.prepare(`INSERT INTO operations(principal_id,operation,key,room_id,request_hash,result_json,created_at)
        SELECT ?,?,?,?,?,json_set(json(json_object(
          'task',json_object('id',picked.id,'room_id',picked.room_id,'creator_id',picked.creator_id,'owner_id',picked.owner_id,
            'goal',json_extract(picked.spec_json,'$.goal'),'dependencies',json_extract(picked.spec_json,'$.dependencies'),
            'input_versions',json_extract(picked.spec_json,'$.input_versions'),'done_conditions',json_extract(picked.spec_json,'$.done_conditions'),
            'state','in_progress','version',picked.version+1,'current_submission_id',NULL,'cancel_reason',picked.cancel_reason,
            'created_at_ms',picked.created_at_ms,'updated_at_ms',picked.now_ms,'stop_confirmation','unavailable_no_runner'),
          'lease',json_object('task_id',picked.id,'holder_id',?,'lease_epoch',picked.lease_epoch+1,'expires_at_ms',picked.now_ms+${LOCAL_LEASE_MS}),
          'submission',NULL,'server_time_ms',picked.now_ms,'lease_active',json('true')
        )),'$.operation',json(?)),?
        FROM (SELECT t.id AS id,t.room_id AS room_id,t.creator_id AS creator_id,t.owner_id AS owner_id,t.spec_json AS spec_json,
          t.version AS version,t.cancel_reason AS cancel_reason,t.created_at_ms AS created_at_ms,l.lease_epoch AS lease_epoch,${DB_NOW} AS now_ms
          FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE ${pick} ORDER BY t.created_at_ms,t.id LIMIT 1) picked
        WHERE EXISTS (${permission}) AND (SELECT count(*) FROM operations WHERE principal_id=? AND created_at>=?)<60
        ON CONFLICT(principal_id,operation,key) DO NOTHING`)
        .bind(this.principal,CLAIM_NEXT,key,ROOM,hash,this.principal,JSON.stringify(operation),now,...pickArgs,this.principal,input.room,...authority.args,this.principal,minute),
      this.db.prepare(cte+`UPDATE tasks SET (${taskFields.join(',')})=(SELECT ${taskFields.map(f=>j('task.'+f)).join(',')} FROM fresh) WHERE id=(SELECT ${j('task.id')} FROM fresh) AND room_id=? AND version=(SELECT ${j('task.version')} FROM fresh)-1 AND state='open'`).bind(...args,input.room),
      this.db.prepare(cte+`UPDATE tasks SET version=version WHERE changes()=0 AND id=(SELECT ${j('task.id')} FROM fresh) AND room_id=?`).bind(...args,input.room),
      this.db.prepare(cte+`INSERT INTO task_leases(${leaseFields.join(',')}) SELECT ${leaseFields.map(f=>j('lease.'+f)).join(',')} FROM fresh WHERE ${landed} ON CONFLICT(task_id) DO UPDATE SET holder_id=excluded.holder_id,lease_epoch=excluded.lease_epoch,expires_at_ms=excluded.expires_at_ms`).bind(...args,input.room),
      this.db.prepare(cte+`INSERT INTO task_audit(id,principal_id,room_id,operation,target_id,version,created_at) SELECT ?,?,?,?,${j('task.id')},${j('task.version')},? FROM fresh`).bind(...args,crypto.randomUUID(),this.principal,ROOM,CLAIM_NEXT,now),
      this.db.prepare(`SELECT request_hash,result_json FROM operations WHERE principal_id=? AND operation=? AND key=? AND EXISTS (${permission})`).bind(this.principal,CLAIM_NEXT,key,this.principal,input.room,...authority.args),
    ];
    if(pinnedId&&this.wrgit?.enabled) statements.splice(statements.length-1,0,this.wrgit.pendingMarker(fresh,args,pinnedId,this.principal));
    return {statements,applied:{sql:'0',args:[]},finish:async(row?:Row)=>{
      if(!row) {
        await this.access(input.room,true);
        if(!await this.check(authority)) throw new Fault('FORBIDDEN','Task authority denied.',403);
        const next=await this.db.prepare(`SELECT t.id AS id FROM tasks t WHERE ${ELIGIBLE} LIMIT 1`).bind(input.room,this.principal).first();
        if(!next) throw new Fault('NOT_FOUND','No eligible open task.',404);
        throw new Fault('RATE_LIMITED','Mutation limit reached; retry the same key later.',429,'not_applied',true,{retry_after:60-new Date().getUTCSeconds()});
      }
      if(row.request_hash!==hash) throw new Fault('IDEMPOTENCY_CONFLICT','Key already has different content.',409,'not_applied',false,{operation:CLAIM_NEXT,idempotency_key:key,lookup:`/api/v1/operations/${CLAIM_NEXT}/${key}`});
      const stored=JSON.parse(row.result_json) as {operation:{id:string}};
      return {data:stored,meta:{idempotency_key:key,replayed:stored.operation.id!==id}};
    }};
  }
  async planCreate(input:TaskCreate) {
    await this.access(input.room,true);
    const spec:Spec={goal:input.goal,owner:input.owner,dependencies:input.dependencies,input_versions:input.input_versions,done_conditions:input.done_conditions},refs=this.refs(spec);
    const id=crypto.randomUUID();
    const data:Bundle={task:{id,room_id:ROOM,creator_id:this.principal,owner_id:spec.owner,goal:spec.goal,dependencies:spec.dependencies,input_versions:spec.input_versions,done_conditions:spec.done_conditions,state:'open',version:1,current_submission_id:null,cancel_reason:null,created_at_ms:0,updated_at_ms:0,stop_confirmation:'unavailable_no_runner'},lease:{task_id:id,holder_id:null,lease_epoch:0,expires_at_ms:0},submission:null,server_time_ms:0,lease_active:false};
    return planMutation(this.db,this.principal,this.access,'task.create',input.idempotency_key,input,{},id,1,refs,this.effects('create',spec),true,async()=>{if(!await this.check(refs))throw new Fault('INVALID_RELATION','Owner/dependency/input revision must be authorized in this room.');},{result:this.snapshot(data,'create'),audit:'task_audit'});
  }
  async planAction(action:Action,input:TaskAction) {
    await this.access(input.room,true);
    const before=(await this.get(input)).data,task={...before.task,version:input.expected_version+1},lease={...before.lease};
    let authority=this.role('agent');
    if(action==='approve') authority=this.role('user');
    if(action==='cancel') authority={sql:"EXISTS (SELECT 1 FROM tasks t WHERE t.id=? AND t.room_id=? AND (t.creator_id=? OR EXISTS (SELECT 1 FROM principal_roles r WHERE r.principal_id=? AND r.kind='user')))",args:[task.id,input.room,this.principal,this.principal]};
    if(action==='request_changes') authority={sql:"EXISTS (SELECT 1 FROM principal_roles WHERE principal_id=? AND kind IN ('agent','user')) AND NOT EXISTS (SELECT 1 FROM tasks t JOIN task_submissions s ON s.id=t.current_submission_id WHERE t.id=? AND t.room_id=? AND s.actor_id=?)",args:[this.principal,task.id,input.room,this.principal]};
    if(action==='claim') authority={sql:`(${authority.sql}) AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND room_id=? AND (owner_id IS NULL OR owner_id=?))`,args:[...authority.args,task.id,input.room,this.principal]};
    const guard:Predicate={sql:'EXISTS (SELECT 1 FROM tasks t JOIN task_leases l ON l.task_id=t.id WHERE t.id=? AND t.room_id=? AND t.version=? AND t.version=? AND l.lease_epoch=?',args:[task.id,input.room,input.expected_version,before.task.version,before.lease.lease_epoch]};
    const add=(sql:string,...args:Value[])=>{guard.sql+=' AND ('+sql+')';guard.args.push(...args);};
    const data:Bundle={...before,task,lease,lease_active:false};
    if(action==='claim') {
      add('l.lease_epoch=?','lease_epoch' in input?input.lease_epoch:-1);
      add(`(t.state IN ('open','blocked') OR (t.state='in_progress' AND l.expires_at_ms<=${DB_NOW}))`);
      add("NOT EXISTS (SELECT 1 FROM json_each(json_extract(t.spec_json,'$.dependencies')) d LEFT JOIN tasks dep ON dep.id=d.value AND dep.room_id=t.room_id WHERE dep.id IS NULL OR dep.state!='done')");
      task.state='in_progress';task.current_submission_id=null;lease.holder_id=this.principal;lease.lease_epoch++;data.submission=null;data.lease_active=true;
    }
    if(action==='renew'||action==='submit') {
      const epoch='lease_epoch' in input?input.lease_epoch:0;
      add(`t.state='in_progress' AND l.holder_id=? AND l.lease_epoch=? AND l.expires_at_ms>${DB_NOW}`,this.principal,epoch);
      if(action==='renew')data.lease_active=true;
      else {
        if(!('artifact_message_id' in input && 'disposition' in input)) throw new Fault('INVALID_INPUT','Submit fields required.');
        add('EXISTS (SELECT 1 FROM message_history h WHERE h.room_id=t.room_id AND h.message_id=? AND h.version=? AND h.actor_id=?)',input.artifact_message_id,input.artifact_revision,this.principal);
        const submission:Submission={id:crypto.randomUUID(),task_id:task.id,actor_id:this.principal,lease_epoch:epoch,artifact_message_id:input.artifact_message_id,artifact_revision:input.artifact_revision,disposition:input.disposition,reason:input.reason??null,submitted_at_ms:0};
        task.state=input.disposition;task.current_submission_id=input.disposition==='review'?submission.id:null;lease.expires_at_ms=0;
        data.submitted=submission;data.submission=input.disposition==='review'?submission:null;
      }
    }
    if(action==='cancel') {
      if(!('reason' in input))throw new Fault('INVALID_INPUT','Cancel reason required.');
      add("t.state NOT IN ('done','canceled')");task.state='canceled';task.current_submission_id=null;task.cancel_reason=input.reason??null;
      lease.expires_at_ms=0;lease.lease_epoch++;lease.holder_id=null;data.submission=null;
    }
    if(action==='approve'||action==='request_changes') {
      if(!('submission_id' in input))throw new Fault('INVALID_INPUT','Review fields required.');
      add("t.state='review' AND EXISTS (SELECT 1 FROM task_submissions s WHERE s.id=t.current_submission_id AND s.task_id=t.id AND s.disposition='review' AND s.id=? AND s.artifact_message_id=? AND s.artifact_revision=?)",input.submission_id,input.artifact_message_id,input.artifact_revision);
      lease.expires_at_ms=0;
      if(action==='approve') task.state='done';
      else {
        if(!('reason' in input))throw new Fault('INVALID_INPUT','Change request reason required.');
        // The submission row stays in task_submissions; the reason lives in this operation's result and its task_audit row.
        task.state='open';task.current_submission_id=null;lease.holder_id=null;data.submission=null;
        data.changes_requested={submission_id:input.submission_id,reviewer_id:this.principal,reason:input.reason};
      }
    }
    guard.sql+=')';
    return planMutation(this.db,this.principal,this.access,'task.'+action,input.idempotency_key,input,{},task.id,task.version,guard,this.effects(action,undefined,action==='claim'?task.id:undefined),true,async()=>{
      const current=(await this.get(input)).data;
      if(action==='renew'||action==='submit') {
        const epoch='lease_epoch' in input?input.lease_epoch:0;
        if(current.task.state!=='in_progress'||current.lease.holder_id!==this.principal||current.lease.lease_epoch!==epoch||!current.lease_active)throw new Fault('LEASE_CONFLICT','Lease is no longer valid; requery the task.',409,'not_applied',false,{lease_epoch:current.lease.lease_epoch});
      }
      if(current.task.version!==input.expected_version||before.task.version!==input.expected_version||current.lease.lease_epoch!==before.lease.lease_epoch)throw new Fault('VERSION_CONFLICT','Task version changed.',409,'not_applied',false,{current_version:current.task.version});
      if(action==='claim') {
        if(!('lease_epoch' in input)||input.lease_epoch!==current.lease.lease_epoch)throw new Fault('LEASE_CONFLICT','Observed claim epoch changed.',409,'not_applied',false,{lease_epoch:current.lease.lease_epoch});
        const unmet:string[]=[];
        for(const dep of current.task.dependencies) if((await this.get({schema_version:'1',room:input.room,task_id:dep})).data.task.state!=='done') unmet.push(dep);
        if(unmet.length) throw new Fault('DEPENDENCY_CONFLICT','Dependencies are not done.',409,'not_applied',false,{dep_ids:unmet});
        if(current.task.state!=='open'&&current.task.state!=='blocked'&&(current.task.state!=='in_progress'||current.lease_active))throw new Fault('TASK_CONFLICT','Task is not claimable.',409);
      }
      if(action==='submit')throw new Fault('INVALID_RELATION','Artifact revision must be in this room and authored by the holder.');
      if(action==='cancel'||action==='approve'||action==='request_changes')throw new Fault('TASK_CONFLICT','State or exact current submission does not match.',409);
    },{authority,result:this.snapshot(data,action),audit:'task_audit'});
  }
}
