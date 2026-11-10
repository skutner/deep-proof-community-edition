#!/usr/bin/env node
// Builds the third-party benchmark evaluation set into tests/evaluation/benchmarks/.data/ (ignored by Git).
// Usage: node tests/evaluation/benchmarks/build.mjs [--profile core|full] [--offline] [--allow-large-download] [--write-selection]
// Downloads only pinned upstream files, verifies their hashes, and never calls a model.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256,gitBlobSha,MAX_TEXT_CHARS,TARGET_MODELS,FINANCEBENCH_SETTING,PROFILES,faithbenchCases,ragtruthCases,financebenchCases,selectCases,selectionEntry,renderDossier,authoredLeaks,goldRecord} from './lib.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const LARGE_DOWNLOAD_BYTES=100*1024*1024;
const mb=bytes=>(bytes/1e6).toFixed(1)+' MB';

function parseArgs(argv){
 const args={profile:'core',offline:false,allowLarge:false,writeSelection:false,data:path.join(here,'.data')};
 for(let i=0;i<argv.length;i++){
  const a=argv[i];
  if(a==='--profile')args.profile=argv[++i];else if(a==='--offline')args.offline=true;else if(a==='--allow-large-download')args.allowLarge=true;
  else if(a==='--write-selection')args.writeSelection=true;else if(a==='--data')args.data=path.resolve(argv[++i]);
  else throw Error(`Unknown argument: ${a}`);
 }
 if(!Object.hasOwn(PROFILES,args.profile))throw Error(`Unknown profile: ${args.profile}. Use core or full.`);
 if(args.writeSelection&&args.profile!=='core')throw Error('--write-selection applies to the core profile only.');
 return args;
}

async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
async function fetchPinned(repo,commit,file,{offline}){
 if(offline)throw Error(`${repo}/${file} is not cached and --offline was given.`);
 const url=`https://raw.githubusercontent.com/${repo}/${commit}/${file}`,response=await fetch(url);
 if(!response.ok)throw Error(`Download failed (${response.status}): ${url}`);
 return Buffer.from(await response.arrayBuffer());
}
// Each cached file is checked against sources.json on every build; a mismatch stops the build.
async function cachedFile(dataset,source,entry,args,verify){
 const local=path.join(args.data,'cache',dataset,entry.path);
 if(await exists(local)){const buffer=await fs.readFile(local);if(verify(buffer))return {local,buffer};throw Error(`${local} does not match sources.json; delete it to download it again.`);}
 const buffer=await fetchPinned(source.repo,source.commit,entry.path,args);
 if(!verify(buffer))throw Error(`${source.repo}/${entry.path} at ${source.commit} does not match sources.json.`);
 await fs.mkdir(path.dirname(local),{recursive:true});await fs.writeFile(local,buffer);
 return {local,buffer};
}
const jsonl=buffer=>buffer.toString('utf8').split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line));

async function loadCases(sources,args){
 const files={};
 for(const [dataset,source] of Object.entries(sources.datasets))for(const entry of source.files)
  files[`${dataset}:${entry.path}`]=(await cachedFile(dataset,source,entry,args,b=>b.length===entry.size&&sha256(b)===entry.sha256)).buffer;
 const fb=sources.datasets.faithbench.files.map(f=>({batch:Number(f.path.match(/batch_(\d+)\.json$/)[1]),samples:JSON.parse(files[`faithbench:${f.path}`].toString('utf8')).samples}));
 const rt=ragtruthCases(jsonl(files['ragtruth:dataset/source_info.jsonl']),jsonl(files['ragtruth:dataset/response.jsonl']));
 const results={};
 for(const model of TARGET_MODELS.financebench){
  const rows=jsonl(files[`financebench:results/${model}_${FINANCEBENCH_SETTING}.jsonl`]);
  for(const r of rows)if(r.model_name!==model||r.eval_mode!==FINANCEBENCH_SETTING)throw Error(`FinanceBench results for ${model}: unexpected model ${r.model_name} or setting ${r.eval_mode}.`);
  results[model]=new Map(rows.map(r=>[r.financebench_id,r]));
 }
 const fn=financebenchCases(jsonl(files['financebench:data/financebench_open_source.jsonl']),jsonl(files['financebench:data/financebench_document_information.jsonl']),results,sources.datasets.financebench.pdfs);
 return [...faithbenchCases(fb),...rt,...fn];
}

// Mirrors src/documents.mjs: pdftotext -layout -enc UTF-8, pages split on form feeds, the 2,000,000-character limit.
const squash=s=>s.toLowerCase().replace(/\s+/g,'');
function extractPdf(pdfFile){
 const run=spawnSync('pdftotext',['-layout','-enc','UTF-8',pdfFile,'-'],{encoding:'utf8',maxBuffer:64*1024*1024});
 if(run.error)return {extractor:null,note:'pdftotext was not found, so text extraction, the size limit and evidence location were not checked.'};
 if(run.status!==0)return {extractor:'pdftotext',error:(run.stderr||'').trim()||`exit ${run.status}`};
 const pages=run.stdout.split('\f');
 return {extractor:'pdftotext',textChars:run.stdout.length,withinTextLimit:run.stdout.length<=MAX_TEXT_CHARS,pages:pages.length,squashedPages:pages.map(squash)};
}
// Evidence for a case may sit in the case's own filing only; FinanceBench records evidence per question.
function pdfChecks(extracted,c){
 if(!extracted.squashedPages){const {squashedPages,...rest}=extracted;return rest;}
 const {squashedPages,...summary}=extracted,all=squashedPages.join('');
 return {...summary,evidence:c.reference.evidence.map(e=>({pdfPage:e.pdfPage,locatedInDocument:!!e.text&&all.includes(squash(e.text)),locatedOnStatedPage:!!e.text&&(squashedPages[e.pageIndex]??'').includes(squash(e.text))}))};
}

async function main(){
 const args=parseArgs(process.argv.slice(2));
 const sources=JSON.parse(await fs.readFile(path.join(here,'sources.json'),'utf8'));
 const all=await loadCases(sources,args),selected=selectCases(all,args.profile);
 const selectionFile=path.join(here,'selection.json'),entries=selected.map(selectionEntry);
 if(args.writeSelection){await fs.writeFile(selectionFile,JSON.stringify({profile:'core',generatedFrom:'sources.json pinned commits',cases:entries},null,1)+'\n');console.log(`Wrote ${entries.length} case IDs to ${selectionFile}.`);}
 else if(args.profile==='core'){
  const committed=JSON.parse(await fs.readFile(selectionFile,'utf8')).cases;
  if(JSON.stringify(committed)!==JSON.stringify(entries))throw Error('The computed core selection differs from selection.json. Review the change, then rerun with --write-selection.');
 }

 const fb=sources.datasets.financebench,docs=[...new Map(selected.filter(c=>c.document).map(c=>[c.document.name,c.document])).values()];
 const missing=[];for(const d of docs)if(!await exists(path.join(args.data,'cache','financebench',d.path)))missing.push(d);
 const pending=missing.reduce((n,d)=>n+d.size,0);
 if(pending>LARGE_DOWNLOAD_BYTES&&!args.allowLarge)throw Error(`This build needs ${missing.length} filing PDFs (${mb(pending)}). Rerun with --allow-large-download to fetch them.`);
 if(missing.length)console.log(`Downloading ${missing.length} filing PDFs (${mb(pending)}) from ${fb.repo} at ${fb.commit.slice(0,12)}.`);
 const pdfFiles={};
 for(const d of docs)pdfFiles[d.name]=(await cachedFile('financebench',fb,d,args,b=>b.length===d.size&&gitBlobSha(b)===d.gitBlobSha)).local;

 const out=path.join(args.data,'build',args.profile);
 if(path.relative(args.data,out)!==path.join('build',args.profile))throw Error(`Refusing to replace unexpected output path ${out}.`);
 await fs.rm(out,{recursive:true,force:true});
 await fs.mkdir(path.join(out,'gold'),{recursive:true});
 const checks=new Map(),index=[];
 for(const c of selected){
  if(c.document){if(!checks.has(c.document.name))checks.set(c.document.name,extractPdf(pdfFiles[c.document.name]));c.checks=pdfChecks(checks.get(c.document.name),c);}
  const dir=path.join(out,'dossiers',c.caseId),files=renderDossier(c,sources.datasets[c.dataset]);
  const leaks=authoredLeaks(files['review-request.md']);if(leaks.length)throw Error(`${c.caseId}: review request reveals ${leaks.join(', ')}.`);
  await fs.mkdir(dir,{recursive:true});
  for(const [name,text] of Object.entries(files))await fs.writeFile(path.join(dir,name),text);
  if(c.document)await fs.copyFile(pdfFiles[c.document.name],path.join(dir,c.document.file));
  if(c.task==='summary'&&(await fs.readFile(path.join(dir,'ai-summary.txt'),'utf8'))!==c.aiOutput)throw Error(`${c.caseId}: AI summary was not written byte-exact.`);
  await fs.writeFile(path.join(out,'gold',`${c.caseId}.json`),JSON.stringify(goldRecord(c,sources.datasets[c.dataset]),null,1)+'\n');
  index.push({caseId:c.caseId,dataset:c.dataset,partition:c.partition,dossier:`dossiers/${c.caseId}`});
 }
 await fs.writeFile(path.join(out,'cases.json'),JSON.stringify({profile:args.profile,note:'Blind case list: no models or labels. Answer keys are in gold/, which must never be given to the reviewing agent.',cases:index},null,1)+'\n');

 const table=new Map();for(const c of selected){const key=[c.dataset,c.model,c.verdict,c.partition].join('\t');table.set(key,(table.get(key)??0)+1);}
 console.log(`Built ${selected.length} cases (${args.profile}) in ${out}`);
 console.log('dataset\tmodel\texpected verdict\tpartition\tcases');
 for(const [key,n] of [...table].sort())console.log(`${key}\t${n}`);
 const pdf=[...checks.values()],evidence=selected.filter(c=>c.checks?.evidence).flatMap(c=>c.checks.evidence);
 if(pdf.length)console.log(pdf[0].extractor?`pdftotext checks: ${pdf.filter(x=>x.withinTextLimit).length}/${pdf.length} filings within the text limit; evidence located in the filing for ${evidence.filter(e=>e.locatedInDocument).length}/${evidence.length} case evidence items, on the stated page for ${evidence.filter(e=>e.locatedOnStatedPage).length}.`:pdf[0].note);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
