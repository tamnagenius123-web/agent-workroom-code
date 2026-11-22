import { z } from 'zod';
import { Fault,ROOM } from '../server/contracts.ts';
import type { Database } from '../server/db.ts';
import { AUTH } from '../server/policy.ts';
import { endpoint } from './policy.ts';

export const scopes=['connection.identity','connection.echo','room.read'] as const;
export type Scope=typeof scopes[number];
const id=z.string().min(1).max(256),time=z.number().int().nonnegative().safe();
const scopeList=z.array(z.enum(scopes)).min(1).max(3).refine(a=>new Set(a).size===a.length);
export const assertionSchema=z.object({issuer:id,subject:id,subject_kind:z.enum(['agent','user','service']),credential_id:id,credential_version:z.number().int().positive().safe(),audience:id,ingress_id:id,issued_at_ms:time,not_before_ms:time.optional(),expires_at_ms:time,scopes:scopeList}).strict();
export const bindingSchema=z.object({issuer:id,subject:id,credential_id:id,principal_id:id,kind:z.enum(['agent','user']),agent_id:id.nullable(),room_id:z.literal(ROOM),audience:id,ingress_id:id,active:z.boolean(),credential_version:z.number().int().positive().safe(),not_before_ms:time,expires_at_ms:time,scopes:scopeList}).strict().refine(v=>v.kind==='agent'?v.agent_id!==null:v.agent_id===null);
export type Assertion=z.infer<typeof assertionSchema>;
export type Binding=z.infer<typeof bindingSchema>;
export interface VerificationInput {headers:Headers;method:string;url:string;ingress_id:string}
export type Verifier=(input:VerificationInput)=>Promise<unknown>;
export type BindingResolver=(key:{issuer:string;subject:string;credential_id:string})=>Promise<unknown>;
export interface AuditEvent {request_id:string;action:'identity'|'echo'|'readback'|'discovery'|'capabilities';decision:'allow'|'deny';reason:'OK'|'AUTH_NOT_CONFIGURED'|'UNAUTHENTICATED'|'FORBIDDEN'|'INVALID_INPUT'|'UNSUPPORTED'|'BODY_TOO_LARGE'|'NOT_FOUND'|'VERSION_CONFLICT'|'TEMPORARY_FAILURE';principal_id:string|null}
export interface ConnectionOptions {resource?:string;ingress_id?:string;issuers?:string[];verifier?:Verifier;bindings?:BindingResolver;audit?:(event:AuditEvent)=>Promise<void>;now?:()=>number}
export interface Context {principal_id:string;kind:'agent'|'user';agent_id:string|null;room_id:typeof ROOM;role:'agent'|'user';scopes:Scope[];stamp:string}
const unauth=()=>new Fault('UNAUTHENTICATED','Connection identity could not be verified.',401);
export class ConnectionAuthority {
  constructor(private db:Database,readonly options:ConnectionOptions={}) {}
  async check(request:Request,scope?:Scope):Promise<Context> {
    const o=this.options;
    if(!o.resource||!o.ingress_id||!o.issuers?.length||!o.verifier||!o.bindings||!o.audit)throw new Fault('AUTH_NOT_CONFIGURED','Operational connection verification is not configured.',503);
    let approved:URL;try{approved=endpoint(o.resource);}catch{throw new Fault('AUTH_NOT_CONFIGURED','Operational connection verification is not configured.',503);}
    const u=new URL(request.url),origin=request.headers.get('origin'),host=request.headers.get('host');
    if(u.origin!==approved.origin||u.username||u.password||u.search||u.hash||origin&&origin!==approved.origin||host&&host!==approved.host)throw new Fault('FORBIDDEN','Connection origin denied.',403);
    let raw:unknown;try{raw=await o.verifier({headers:new Headers(request.headers),method:request.method,url:request.url,ingress_id:o.ingress_id});}catch{throw unauth();}
    const parsed=assertionSchema.safeParse(raw);if(!parsed.success)throw unauth();
    const a=parsed.data,now=(o.now??Date.now)();
    if(!Number.isSafeInteger(now)||!o.issuers.includes(a.issuer)||a.subject_kind==='service'||a.audience!==approved.href||a.ingress_id!==o.ingress_id||a.issued_at_ms>now||(a.not_before_ms??a.issued_at_ms)>now||a.not_before_ms!==undefined&&(a.not_before_ms<a.issued_at_ms||a.not_before_ms>=a.expires_at_ms)||a.expires_at_ms<=now||a.expires_at_ms<=a.issued_at_ms||a.expires_at_ms-a.issued_at_ms>300000)throw unauth();
    let value:unknown;try{value=await o.bindings({issuer:a.issuer,subject:a.subject,credential_id:a.credential_id});}catch{throw new Fault('TEMPORARY_FAILURE','Connection policy could not be checked.',503,'not_applied',true);}
    const resolved=bindingSchema.safeParse(value);if(!resolved.success)throw unauth();const b=resolved.data;
    if(b.issuer!==a.issuer||b.subject!==a.subject||b.credential_id!==a.credential_id||b.kind!==a.subject_kind||!b.active||b.audience!==a.audience||b.ingress_id!==a.ingress_id||b.credential_version!==a.credential_version||b.not_before_ms>now||b.expires_at_ms<=now||a.expires_at_ms>b.expires_at_ms)throw unauth();
    const effective=scopes.filter(s=>a.scopes.includes(s)&&b.scopes.includes(s));
    if(!effective.length||scope&&!effective.includes(scope)||!await this.db.prepare(`SELECT 1 WHERE EXISTS (${AUTH}) AND EXISTS (SELECT 1 FROM principal_roles WHERE principal_id=? AND kind=?)`).bind(b.principal_id,ROOM,b.principal_id,b.kind).first())throw new Fault('FORBIDDEN','Connection permission denied.',403);
    const completed=(o.now??Date.now)();
    if(!Number.isSafeInteger(completed)||a.issued_at_ms>completed||(a.not_before_ms??a.issued_at_ms)>completed||a.expires_at_ms<=completed||b.not_before_ms>completed||b.expires_at_ms<=completed)throw unauth();
    return {principal_id:b.principal_id,kind:b.kind,agent_id:b.agent_id,room_id:ROOM,role:b.kind,scopes:effective,stamp:JSON.stringify({a,b})};
  }
  async record(event:AuditEvent) {
    try{await this.options.audit?.(Object.freeze({...event}));}catch{throw new Fault('TEMPORARY_FAILURE','Connection audit did not complete.',503,'not_applied',true);}
  }
}
