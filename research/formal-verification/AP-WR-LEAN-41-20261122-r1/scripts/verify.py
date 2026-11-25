#!/usr/bin/env python3
"""Rebuild the exact local Lean package, inventory all theorem axioms, and fresh-replay.
Requires Lean/lake v4.19.0 on PATH; --checker is a matching lean4checker binary.
No provider, deployment, token, permission, or production writes occur.
"""
from pathlib import Path
import argparse,csv,datetime,hashlib,json,os,re,subprocess,sys,time
ROOT=Path(__file__).resolve().parents[1]
os.chdir(ROOT)
p=argparse.ArgumentParser();p.add_argument('--checker');p.add_argument('--clean',action='store_true');args=p.parse_args()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def run(name,command):
 started=datetime.datetime.now(datetime.timezone.utc).isoformat();t=time.monotonic()
 result=subprocess.run(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 path=ROOT/'evidence'/name;path.write_text(result.stdout)
 receipt={'command':command,'started_utc':started,'duration_seconds':round(time.monotonic()-t,3),'exit_code':result.returncode,'log':str(path.relative_to(ROOT)),'log_sha256':sha(path)}
 if result.returncode:print(result.stdout);raise SystemExit(json.dumps(receipt))
 return receipt,result.stdout
version=subprocess.check_output(['lean','--version'],text=True).strip()
assert version.startswith('Lean (version 4.19.0,'), version
if args.clean:run('lean-clean.log',['lake','clean'])
build,output=run('lean-build.log',['lake','build'])
# Include ALL theorem declarations, witnesses and supporting lemmas, not only the 41 targets.
decls=[]
for source in sorted((ROOT/'Workroom').glob('*.lean')):
 if source.name=='AxiomAudit.lean':continue
 text=source.read_text();ns=re.search(r'^namespace\s+(\S+)',text,re.M)
 for m in re.finditer(r'^theorem\s+(\w+)',text,re.M):
  assert ns,source
  decls.append((ns.group(1)+'.'+m.group(1),str(source.relative_to(ROOT))))
audit=ROOT/'Workroom/AxiomAudit.lean'
audit.write_text('import Workroom.All\nset_option pp.fullNames true\n'+''.join(f'#check {n}\n#print axioms {n}\n' for n,_ in decls))
axrun,axout=run('axiom-audit.log',['lake','env','lean','Workroom/AxiomAudit.lean'])
allowed={'propext','Classical.choice','Quot.sound'};rows=[]
for name,source in decls:
 m=re.search("'"+re.escape(name)+r"' (does not depend on any axioms|depends on axioms: \[([^\]]*)\])",axout)
 assert m,(name,'missing axiom output')
 axioms=[] if m.group(1).startswith('does not') else [x.strip() for x in m.group(2).split(',') if x.strip()]
 assert set(axioms)<=allowed,(name,axioms)
 rows.append({'theorem':name,'source':source,'source_sha256':sha(ROOT/source),'axioms':','.join(axioms) or '[]','verdict':'KERNEL_ACCEPTED_STANDARD_AXIOMS_ONLY'})
with open('PROOF_AXIOMS.tsv','w',newline='') as f:
 w=csv.DictWriter(f,fieldnames=list(rows[0]),delimiter='\t');w.writeheader();w.writerows(rows)
recheck=None
if args.checker:
 recheck,_=run('kernel-fresh.log',['lake','env',str(Path(args.checker).resolve()),'--fresh','Workroom.All'])
receipt={'contract':'AP-WR-LEAN-41-20261122-r1','toolchain':version,'mathlib':'none for Workroom package','clean_requested':args.clean,'build':build,'axiom_audit':axrun,'theorems_audited':len(rows),'allowed_axioms':sorted(allowed),'unexpected_axioms':[],'fresh_kernel_recheck':recheck,'source_files':{str(x.relative_to(ROOT)):sha(x) for x in sorted((ROOT/'Workroom').glob('*.lean'))},'scope':'Formal reference modules and explicit countermodels only; no production refinement certification','checker_is_external_kernel':False}
Path('LEAN_BUILD_RECEIPT.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'build_exit':build['exit_code'],'theorems_audited':len(rows),'fresh_exit':recheck['exit_code'] if recheck else None}))
