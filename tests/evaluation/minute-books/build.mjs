#!/usr/bin/env node
// Rebuilds the six edition 8 minute books and their answer keys into tests/evaluation/minute-books/.data/ (ignored by Git).
// Usage: node tests/evaluation/minute-books/build.mjs [--data DIR] [--offline] [--lean-documents CHECKOUT] [--python PYTHON]
// Fetches three pinned generator files, runs them with the recorded seed, and refuses any result whose hashes differ
// from selection.json. Never calls a model.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256,selectionProblems,buildProblems} from './lib.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv){
 const args={data:path.join(here,'.data'),offline:false,checkout:null,python:'python3'};
 for(let i=0;i<argv.length;i++){
  const a=argv[i],value=()=>{if(i+1>=argv.length)throw Error(`${a} needs a value.`);return argv[++i];};
  if(a==='--data')args.data=path.resolve(value());else if(a==='--offline')args.offline=true;
  else if(a==='--lean-documents')args.checkout=path.resolve(value());else if(a==='--python')args.python=value();
  else throw Error(`Unknown argument: ${a}`);
 }
 return args;
}

// One generator file: from the cache, else from a local lean_documents checkout, else from GitHub at the pinned commit.
async function generatorFile(generator,file,entry,dir,args){
 const local=path.join(dir,file),matches=b=>b.length===entry.size&&sha256(b)===entry.sha256;
 if(fs.existsSync(local)){const b=fs.readFileSync(local);if(matches(b))return;throw Error(`${local} does not match selection.json; delete it to fetch it again.`);}
 let buffer,origin;
 if(args.checkout){
  const run=spawnSync('git',['-C',args.checkout,'show',`${generator.commit}:${file}`],{maxBuffer:64*1024*1024});
  if(run.status!==0)throw Error(`git show ${generator.commit.slice(0,12)}:${file} failed in ${args.checkout}: ${String(run.stderr).trim()}`);
  buffer=run.stdout;origin=`${args.checkout} at ${generator.commit.slice(0,12)}`;
 }else{
  if(args.offline)throw Error(`${file} is not cached and --offline was given.`);
  const url=`https://raw.githubusercontent.com/${generator.repository}/${generator.commit}/${file}`,response=await fetch(url);
  if(!response.ok)throw Error(`Download failed (${response.status}): ${url}`);
  buffer=Buffer.from(await response.arrayBuffer());origin=url;
 }
 if(!matches(buffer))throw Error(`${file} from ${origin} does not match selection.json.`);
 fs.mkdirSync(path.dirname(local),{recursive:true});fs.writeFileSync(local,buffer);
}

async function main(){
 const args=parseArgs(process.argv.slice(2));
 const selection=JSON.parse(fs.readFileSync(path.join(here,'selection.json'),'utf8'));
 const problems=selectionProblems(selection);
 if(problems.length)throw Error(`selection.json is not valid:\n${problems.join('\n')}`);
 const g=selection.generator,target=path.join(args.data,'build',selection.id);
 if(fs.existsSync(target))throw Error(`${target} already exists; delete it to build again.`);
 const generatorDir=path.join(args.data,'cache',`lean_documents-${g.commit}`);
 for(const [file,entry] of Object.entries(g.files))await generatorFile(g,file,entry,generatorDir,args);

 // Write into a fresh folder beside the target and move it into place only after every hash has matched.
 const staging=path.join(args.data,'build',`.${selection.id}-${crypto.randomBytes(6).toString('hex')}`);
 fs.mkdirSync(path.dirname(staging),{recursive:true});
 const command=['-I','-B',g.script,'--fixtures',path.join(staging,'fixtures'),'--keys',path.join(staging,'keys'),...g.arguments];
 console.log(`Generating ${Object.keys(selection.dossiers).length} dossiers with ${args.python} ${g.script} (${g.repository} at ${g.commit.slice(0,12)}).`);
 const run=spawnSync(args.python,command,{cwd:generatorDir,env:{PATH:process.env.PATH||'/usr/bin:/bin',...g.environment},encoding:'utf8',maxBuffer:64*1024*1024});
 if(run.error)throw Error(`Could not start ${args.python}: ${run.error.message}`);
 if(run.status!==0)throw Error(`The generator failed (exit ${run.status}):\n${(run.stderr||'').trim().split('\n').slice(-20).join('\n')}`);
 const mismatches=buildProblems(staging,selection);
 if(mismatches.length)throw Error(`The build differs from selection.json; nothing was moved into place. Inspect ${staging}, then delete it.\n${mismatches.slice(0,40).join('\n')}`);
 fs.renameSync(staging,target);
 for(const [id,d] of Object.entries(selection.dossiers))console.log(`ok ${id} (${Object.keys(d.files).length} files and the answer key match)`);
 console.log(`OK ${Object.keys(selection.dossiers).length} dossiers in ${path.join(target,'fixtures')}`);
 console.log(`Answer keys in ${path.join(target,'keys')}: never give them, this repository or ${args.data} to a reviewer.`);
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
