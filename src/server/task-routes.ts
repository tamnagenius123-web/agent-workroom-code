import { Fault,keySchema } from './contracts.ts';
import { taskSchemas,type TaskCreate,type TaskAction } from './task-contracts.ts';
import type { Workroom } from './domain.ts';
export async function taskRoute(service:Workroom,request:Request,url:URL,readJSON:()=>Promise<unknown>) {
  const m=/^\/api\/v1\/rooms\/([^/]+)\/tasks(?:\/([^/]+)(?:\/(claim|renew|submit|cancel|approve|request_changes))?)?$/.exec(url.pathname);
  if(!m)return null;
  const room=decodeURIComponent(m[1]!),task_id=m[2]?decodeURIComponent(m[2]):undefined,action=task_id?(m[3]??'get'):'create';
  if(!task_id&&request.method==='GET'&&url.searchParams.get('state')==='blocked'&&url.searchParams.getAll('state').length===1&&[...url.searchParams.keys()].every(key=>key==='state')) return service.tasks.listBlocked(room);
  if(url.search)throw new Fault('INVALID_INPUT','Task query parameters unsupported.');
  if(action==='get'&&request.method==='GET')return service.tasks.get(taskSchemas.get.parse({schema_version:'1',room,task_id}));
  if(action==='get'||request.method!=='POST')throw new Fault('UNSUPPORTED','Method unsupported.',405);
  const body=await readJSON();
  if(!body||typeof body!=='object'||Array.isArray(body)||['room','task_id','idempotency_key'].some(k=>k in body))throw new Fault('INVALID_INPUT','Task path/key fields cannot be supplied in body.');
  const idempotency_key=keySchema.parse(request.headers.get('idempotency-key'));
  if(action==='create')return service.tasks.create(taskSchemas.create.parse({...body,room,idempotency_key}) as TaskCreate);
  const name=action as 'claim'|'renew'|'submit'|'cancel'|'approve'|'request_changes';
  return service.tasks.action(name,taskSchemas[name].parse({...body,room,task_id,idempotency_key}) as TaskAction);
}
