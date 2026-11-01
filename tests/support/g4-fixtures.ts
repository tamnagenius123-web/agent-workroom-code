import type { Assertion,Binding,AuditEvent,ConnectionOptions } from '../../src/connection/authority.ts';

// Public synthetic assertions are fabricated only inside tests. This is not a provider verifier.
export function connectionFixtures(){
  const resource='https://central.example.invalid/mcp',ingress='synthetic-ingress',issuer='synthetic-issuer',now=1800000000000;
  const assertions=new Map<string,Assertion>(),bindings=new Map<string,Binding>(),audit:AuditEvent[]=[];
  for(const name of ['alpha','beta','human']){
    const a:Assertion={issuer,subject:'subject:'+name,subject_kind:name==='human'?'user':'agent',credential_id:'fixture:'+name,credential_version:1,audience:resource,ingress_id:ingress,issued_at_ms:now-1000,expires_at_ms:now+60000,scopes:['connection.identity','connection.echo','room.read']};
    const b:Binding={issuer,subject:a.subject,credential_id:a.credential_id,principal_id:'synthetic:'+name,kind:name==='human'?'user':'agent',agent_id:name==='human'?null:'agent:'+name,room_id:'room_main',audience:resource,ingress_id:ingress,active:true,credential_version:1,not_before_ms:now-1000,expires_at_ms:now+120000,scopes:[...a.scopes]};
    assertions.set('g4-'+name+'-fixture',a);bindings.set(a.credential_id,b);
  }
  const options:ConnectionOptions={resource,ingress_id:ingress,issuers:[issuer],now:()=>now,
    verifier:async input=>structuredClone(assertions.get(input.headers.get('authorization')?.replace(/^Bearer /,'')??'')),
    bindings:async key=>structuredClone(bindings.get(key.credential_id)),audit:async event=>{audit.push({...event});}};
  return {resource,options,assertions,bindings,audit,now};
}
