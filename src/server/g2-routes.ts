import { Fault, keySchema, readSchema } from './contracts.ts';
import { threadCreateSchema,threadReadSchema,historySchema,reviseSchema,ackSchema,exportSchema } from './g2-contracts.ts';
import type { Workroom } from './domain.ts';

export async function g2Route(service:Workroom,request:Request,url:URL,readJSON:()=>Promise<unknown>) {
  const match=/^\/api\/v1\/rooms\/([^/]+)\/(threads(?:\/[^/]+)?|messages\/[^/]+\/(?:revisions|history)|inbox(?:\/ack)?|export)$/.exec(url.pathname);
  if(!match) return null;
  const room=decodeURIComponent(match[1]!),part=match[2]!,pieces=part.split('/'),method=request.method;
  const query=(extra:string[]=[])=>{
    const p=Object.fromEntries(url.searchParams);
    if(Object.keys(p).some(k=>!['cursor','limit',...extra].includes(k)) || [...url.searchParams.keys()].length!==Object.keys(p).length)
      throw new Fault('INVALID_INPUT','Unsupported query parameters.');
    return {...p,limit:p.limit===undefined?undefined:Number(p.limit),schema_version:'1' as const,room};
  };
  const mutation=()=>{if(url.search) throw new Fault('INVALID_INPUT','Mutation query parameters are unsupported.');return keySchema.parse(request.headers.get('idempotency-key'));};
  if(part==='threads'&&method==='POST') {
    const idempotency_key=mutation(),body=threadCreateSchema.omit({room:true,idempotency_key:true}).parse(await readJSON());
    return service.g2.create({...body,room,idempotency_key});
  }
  if(pieces[0]==='threads'&&pieces.length===2&&method==='GET') return service.g2.read(threadReadSchema.parse({...query(),thread_id:decodeURIComponent(pieces[1]!)}));
  if(pieces[0]==='messages'&&pieces[2]==='revisions'&&method==='POST') {
    const idempotency_key=mutation(),body=reviseSchema.omit({room:true,message_id:true,idempotency_key:true}).parse(await readJSON());
    return service.g2.revise({...body,room,message_id:decodeURIComponent(pieces[1]!),idempotency_key});
  }
  if(pieces[0]==='messages'&&pieces[2]==='history'&&method==='GET') return service.g2.history(historySchema.parse({...query(),message_id:decodeURIComponent(pieces[1]!)}));
  if(part==='inbox'&&method==='GET') return service.g2.pull(readSchema.parse(query()));
  if(part==='inbox/ack'&&method==='POST') {
    const idempotency_key=mutation(),body=ackSchema.omit({room:true,idempotency_key:true}).parse(await readJSON());
    return service.g2.ack({...body,room,idempotency_key});
  }
  if(part==='export'&&method==='GET') return service.g2.export(exportSchema.parse(query(['thread_id','format'])));
  throw new Fault('UNSUPPORTED','Method unsupported.',405);
}
