import { Fault } from '../server/contracts.ts';
import { taskSchemas,taskSpecSchema } from '../server/task-contracts.ts';
export const taskFlags:Record<string,string[]>={
  'task create':['--room','--stdin','--file','--idempotency-key'],
  'task get':['--room','--task'],
  'task claim':['--room','--task','--expected-version','--lease-epoch','--idempotency-key'],
  'task renew':['--room','--task','--expected-version','--lease-epoch','--idempotency-key'],
  'task submit':['--room','--task','--expected-version','--lease-epoch','--artifact-message','--artifact-revision','--disposition','--reason','--idempotency-key'],
  'task cancel':['--room','--task','--expected-version','--reason','--idempotency-key'],
  'task approve':['--room','--task','--expected-version','--submission','--artifact-message','--artifact-revision','--idempotency-key'],
  'task request_changes':['--room','--task','--expected-version','--submission','--artifact-message','--artifact-revision','--reason','--idempotency-key'],
};
export async function taskRequest(command:string,flags:Record<string,string|true>,readText:()=>Promise<string>) {
  const name=command.slice(5) as keyof typeof taskSchemas;
  const base={schema_version:'1',room:flags['--room']};
  if(name==='get'){
    const input=taskSchemas.get.parse({...base,task_id:flags['--task']});return {path:`/rooms/${encodeURIComponent(input.room)}/tasks/${encodeURIComponent(input.task_id)}`,body:undefined,key:undefined};
  }
  let spec:object={};
  if(name==='create') {
    let value:unknown;try{value=JSON.parse(await readText());}catch{throw new Fault('INVALID_INPUT','Task create requires a UTF-8 JSON specification.');}
    spec=taskSpecSchema.parse(value);
  }
  const fields={...base,idempotency_key:flags['--idempotency-key'],...(name==='create'?spec:{task_id:flags['--task'],expected_version:Number(flags['--expected-version']),
    ...(name==='claim'||name==='renew'||name==='submit'?{lease_epoch:Number(flags['--lease-epoch'])}:{}),
    ...(name==='submit'||name==='approve'||name==='request_changes'?{artifact_message_id:flags['--artifact-message'],artifact_revision:Number(flags['--artifact-revision'])}:{}),
    ...(name==='submit'?{disposition:flags['--disposition']??'review',...(flags['--reason']?{reason:flags['--reason']}:{})}:{}),
    ...(name==='cancel'||name==='request_changes'?{reason:flags['--reason']}:{}),...(name==='approve'||name==='request_changes'?{submission_id:flags['--submission']}:{})})};
  const input=taskSchemas[name].parse(fields),{room,idempotency_key,...rest}=input;
  const task_id='task_id' in rest?rest.task_id:undefined;
  const body=Object.fromEntries(Object.entries(rest).filter(([k])=>k!=='task_id'));
  return {path:`/rooms/${encodeURIComponent(room)}/tasks`+(task_id?`/${encodeURIComponent(task_id)}/${name}`:''),body:JSON.stringify(body),key:idempotency_key};
}
