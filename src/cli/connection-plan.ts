#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { connectionPlan } from '../connection/plan.ts';

// Offline only: no credentials, fetch, remote registration or environment-based connection settings.
try{
  const args=process.argv.slice(2);let input:AsyncIterable<Uint8Array>;
  if(args.length===1&&args[0]==='--stdin')input=process.stdin;
  else if(args.length===2&&args[0]==='--file'&&args[1]){const info=await stat(args[1]);if(!info.isFile()||info.size>32768)throw new Error();input=createReadStream(args[1],{highWaterMark:8192});}
  else throw new Error();
  let size=0;const chunks:Uint8Array[]=[];
  for await(const bytes of input){size+=bytes.byteLength;if(size>32768)throw new Error();chunks.push(bytes);}
  const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
  process.stdout.write(JSON.stringify(connectionPlan(JSON.parse(text)))+'\n');
}catch{process.stdout.write(JSON.stringify({ok:false,error:{code:'INVALID_PLAN',message:'Use --stdin or --file with a valid non-secret connection plan.',outcome:'not_executed'},ready:false,connected:false})+'\n');process.stderr.write('INVALID_PLAN: Offline plan validation failed.\n');process.exitCode=2;}
