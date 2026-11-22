import { Fault } from '../server/contracts.ts';

export const PROTOCOL='2026-07-28';
export const REQUEST_LIMIT=49152,RESPONSE_LIMIT=524288;
const rejected=()=>new Fault('UNSUPPORTED','Connection transport policy rejected the request.',400);
export function endpoint(value:string) {
  try {
    const u=new URL(value),host=u.hostname;
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.search||u.hash||u.pathname!=='/mcp'||value!==u.origin+'/mcp'
      ||host.includes(':')||/^[\d.]+$/.test(host)||!host.includes('.')||host.endsWith('.')||/(^|\.)(localhost|local|internal|home|lan)$/.test(host))throw rejected();
    return u;
  }catch{throw rejected();}
}
export async function boundedText(body:ReadableStream<Uint8Array>|null,limit=REQUEST_LIMIT) {
  if(!body)return '';
  const reader=body.getReader(),parts:Uint8Array[]=[];let size=0;
  try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.byteLength;if(size>limit){await reader.cancel();throw new Fault('BODY_TOO_LARGE','Connection payload limit exceeded.',413);}parts.push(v.value);}}finally{reader.releaseLock();}
  const data=new Uint8Array(size);let n=0;for(const part of parts){data.set(part,n);n+=part.byteLength;}
  try{return new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw new Fault('INVALID_INPUT','Connection payload must be UTF-8.');}
}
export type ProbeTransport=(request:Request)=>Promise<Response>;
// No global fetch fallback. Only explicitly injected, operator-reviewed transports may ever run.
export function guardedFetch(resource:string,transport?:ProbeTransport):typeof fetch {
  const approved=endpoint(resource).href;
  return async(input,init)=>{
    if(!transport)throw new Fault('AUTH_NOT_CONFIGURED','Connection transport is not configured.',503);
    try {
      const request=new Request(input,init);
      if(request.url!==approved||request.method!=='POST')throw rejected();
      const text=await boundedText(request.body),outgoing=new Request(approved,{method:'POST',headers:request.headers,body:text,redirect:'error',signal:request.signal,credentials:'omit'});
      const response=await transport(outgoing);
      if(response.status>=300&&response.status<400||response.redirected||response.url&&response.url!==approved){await response.body?.cancel();throw rejected();}
      if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json'){await response.body?.cancel();throw rejected();}
      const textOut=await boundedText(response.body,RESPONSE_LIMIT),payload:unknown=JSON.parse(textOut);
      if(!response.ok||!payload||typeof payload!=='object'||Array.isArray(payload)||!('jsonrpc' in payload)||payload.jsonrpc!=='2.0'||'error' in payload||!('result' in payload)||!payload.result||typeof payload.result!=='object'||Array.isArray(payload.result)||'isError' in payload.result&&payload.result.isError)throw rejected();
      const headers=new Headers(response.headers);headers.delete('content-length');
      return new Response(textOut,{status:response.status,headers});
    }catch{throw new Fault('TEMPORARY_FAILURE','Connection transport did not complete safely.',503,'not_applied',true);}
  };
}
