// Runs benchmark dossiers through review "arms" and keeps one record per (arm, case, repeat), so that a plain
// coding agent and Deep Proof's Check Report can be compared on the same cases, model and time limit.
// Arm kinds: "agent" (the coding agent through ALA with a short prompt and no Deep Proof skills or validators),
// "check" (Check Report on a private in-process Deep Proof instance) and "constant" (a fixed answer, the floor).
// Importing this file starts nothing. Model usage happens only when run.mjs is started with --launch.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256} from './lib.mjs';
import {alaArguments} from '../../../src/ala.mjs';
import {resolveALA,alaUnavailable} from '../../../src/ala-location.mjs';
import {CHECK_MINUTES} from '../../../src/run-limits.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
export const appRoot=path.resolve(here,'..','..','..');
export const RUNNER_VERSION=3;
export const VERDICTS=['problem','no_problem'];
// After this many attempts that ended in an error, a unit waits for an operator decision instead of running again.
export const MAX_ERROR_ATTEMPTS=3;
const CATEGORY=/^F(0[1-9]|1[0-2])$/;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const unitId=(arm,caseId,repeat)=>`${arm}__${caseId}__r${repeat}`;

// ---------- arms ----------

// An arm's fingerprint covers its settings, its prompt text and, for Check Report, the hash of the verification
// skill. Records made under a different fingerprint are never pooled. The campaign file additionally freezes a
// hash of the application and runner code (see run.mjs), because behaviour also lives outside these inputs.
export async function loadArms(file=path.join(here,'arms.json')){
 const specs=JSON.parse(await fs.readFile(file,'utf8')),arms={};
 for(const [id,spec] of Object.entries(specs)){
  if(!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id))throw Error(`Arm "${id}": use lower-case letters, digits and hyphens.`);
  const arm={id,...spec};
  if(spec.kind==='agent'){
   if(typeof spec.prompt!=='string')throw Error(`Arm "${id}": an agent arm needs a prompt file.`);
   arm.promptText=await fs.readFile(path.resolve(path.dirname(file),spec.prompt),'utf8');
   if(!arm.promptText.includes('prediction.json'))throw Error(`Arm "${id}": the prompt must tell the agent to write prediction.json.`);
  }else if(spec.kind==='check'){
   if(!['deep','triage'].includes(spec.depth))throw Error(`Arm "${id}": depth must be deep or triage.`);
   if(spec.flagCategories!=='all'&&!(Array.isArray(spec.flagCategories)&&spec.flagCategories.length&&spec.flagCategories.every(c=>CATEGORY.test(c))))throw Error(`Arm "${id}": flagCategories must be "all" or a list of F01–F12 codes.`);
   arm.methodology=(await import('../../../src/report-quality.mjs')).reportQualitySkill().methodology_revision;
  }else if(spec.kind==='constant'){
   if(!VERDICTS.includes(spec.verdict))throw Error(`Arm "${id}": a constant arm needs the verdict problem or no_problem.`);
  }else throw Error(`Arm "${id}": kind must be agent, check or constant.`);
  arm.fingerprint=sha256(JSON.stringify(canonical({runner:RUNNER_VERSION,id,spec,promptText:arm.promptText??null,methodology:arm.methodology??null})));
  arms[id]=arm;
 }
 return arms;
}

// Units run in an order fixed by the seed, so arms and repeats interleave instead of running in blocks
// (a block per arm would confound the comparison with service drift over the campaign).
export function planUnits({caseIds,armIds,repeats,seed=1}){
 const units=[];
 for(const caseId of caseIds)for(const arm of armIds)for(let repeat=1;repeat<=repeats;repeat++)units.push({unit:unitId(arm,caseId,repeat),arm,caseId,repeat});
 const key=u=>sha256(`order:${seed}:${u.unit}`);
 return units.sort((a,b)=>key(a).localeCompare(key(b)));
}

// ---------- blindness ----------

const WORK_FOLDER=/^run-[0-9a-f]{16}$/;
// Between reviews the arena is empty (finished work folders are moved out), so anything found in it is a hazard:
// a gold folder, or a link, which could lead a reviewer to answer keys or to another review.
function arenaHazards(root,depth=4){
 const found=[];
 const visit=(dir,level)=>{let entries=[];try{entries=fsSync.readdirSync(dir,{withFileTypes:true});}catch{return;}
  for(const entry of entries){
   if(found.length>=20)return;const full=path.join(dir,entry.name);
   // The runner's own work folders are moved out before any review starts (run.mjs), so they are not examined here.
   if(level===1&&WORK_FOLDER.test(entry.name)&&entry.isDirectory())continue;
   if(entry.isSymbolicLink())found.push(`${full} (a link under the arena)`);
   else if(entry.isDirectory()){if(entry.name==='gold')found.push(`${full} (a gold folder under the arena)`);else if(level<depth)visit(full,level+1);}
  }};
 visit(root,1);return found;
}
// The runner needs dossiers only, never answer keys. It checks the folder layout; it cannot observe what the
// agent sandbox mounts, so the best status is "isolated_as_attested" (the term used by lean_documents/evalsuite).
// arena is null when no agent arm runs (Check Report works in an operating-system temporary folder).
export function blindness({dossiers,arena=null,out,agentHome=null,allowVisibleKeys=false,repository=appRoot}){
 const real=target=>{let current=path.resolve(target);const tail=[];while(!fsSync.existsSync(current)){tail.unshift(path.basename(current));current=path.dirname(current);}return path.join(fsSync.realpathSync(current),...tail);};
 const inside=(child,parent)=>{const relative=path.relative(parent,child);return relative===''||(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative));};
 const overlap=(a,b)=>inside(a,b)||inside(b,a);
 const d=real(dossiers),a=arena?real(arena):null,o=real(out),repo=real(repository),problems=[];
 if(a&&overlap(a,o))problems.push('The arena and the output folder must not contain each other: agents work in the arena, and records of other runs are kept outside it.');
 if(a&&overlap(a,d))problems.push('The arena and the dossier folder must not contain each other.');
 if(overlap(o,d))problems.push('The output folder and the dossier folder must not contain each other.');
 const h=agentHome?real(agentHome):null;
 if(h&&(overlap(h,o)||overlap(h,d)||(a&&overlap(h,a))))problems.push('The --agent-home folder must not contain, or lie inside, the arena, the output folder or the dossier folder: it holds a login.');
 if(problems.length)throw Error(problems.join(' '));
 const visibleKeys=[];
 const beside=path.join(path.dirname(d),'gold');if(fsSync.existsSync(beside))visibleKeys.push(`${beside} (answer keys next to the dossiers)`);
 if(a&&overlap(a,repo))visibleKeys.push(`${a} (the arena is inside or around the repository, which holds the builder, the selection and usually the answer keys)`);
 if(a)visibleKeys.push(...arenaHazards(a));
 if(visibleKeys.length&&!allowVisibleKeys)throw Error(`Answer keys may be readable by the reviewing agent: ${visibleKeys.join('; ')}. Copy the dossiers folder to a location without gold/ and use an empty arena outside the repository, or pass --allow-visible-keys for an exploratory run that is recorded as exposed.`);
 return {status:visibleKeys.length?'exposed':'isolated_as_attested',visibleKeys,note:'Folder layout only. What the agent sandbox mounts is not observed.'};
}

// ---------- dossiers ----------

export function dossierRoles(names){
 const request='review-request.md',targets=names.filter(n=>['ai-summary.txt','ai-answer.txt'].includes(n));
 if(!names.includes(request))throw Error('review-request.md is missing from the dossier.');
 if(targets.length!==1)throw Error('A dossier needs exactly one of ai-summary.txt and ai-answer.txt.');
 const evidence=names.filter(n=>n!==request&&n!==targets[0]);
 if(!evidence.length)throw Error('The dossier has no source document.');
 return {request,target:targets[0],evidence};
}
// One reader for every arm. Only regular files are accepted, so a link cannot pull anything else into a review.
export async function readDossier(dossierDir){
 const files={};
 for(const entry of (await fs.readdir(dossierDir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(!entry.isFile())throw Error(`${entry.name} in ${dossierDir} is not a regular file.`);
  files[entry.name]=await fs.readFile(path.join(dossierDir,entry.name));
 }
 return {files,roles:dossierRoles(Object.keys(files)),hash:dossierHash(files)};
}
export const dossierHash=files=>sha256(JSON.stringify(Object.keys(files).sort().map(name=>[name,sha256(files[name])])));
// Copies one dossier into a fresh folder with a random name.
export async function stageDossier(dossier,arena){
 await fs.mkdir(arena,{recursive:true});
 const workDir=path.join(arena,'run-'+randomBytes(8).toString('hex'));await fs.mkdir(workDir);
 const staged={};
 for(const [name,bytes] of Object.entries(dossier.files)){await fs.writeFile(path.join(workDir,name),bytes);staged[name]=sha256(bytes);}
 return {workDir,staged};
}

// ---------- outcomes ----------
// A unit ends as "completed" (a verdict), "failed" (the reviewer's own failure, scored as a wrong answer) or
// "error" (never scored). The state comes only from signals this harness controls: whether the engine could be
// located and started, whether it stopped at the time limit, its exit status, HTTP status codes and the files it
// left. Error text is kept for the operator and never decides the state, because it can quote the documents and
// the reviewer's own prose. Every engine-reported failure is therefore "failed". Those that could also be an
// infrastructure problem (a non-zero exit, a failure Deep Proof did not attribute to time or validation) carry
// suspect:true: they stop the run when they come in a row, and only an operator can clear one for a rerun, on
// the record (run.mjs resolve). An error with attempted:false means no review was started.
const notStarted=(reason,detail,details)=>({status:'error',reason,detail,attempted:false,...(details?{details}:{})});

// ---------- agent arm ----------

export function agentTask({request,promptText,minutes,extracted=[]}){
 const notes=extracted.filter(e=>e.text).map(e=>`\`${e.text}\` holds the text of \`${e.pdf}\`, extracted page by page; each \`## Page N\` heading gives the PDF page number.`);
 return [request.trim(),...notes,promptText.trim().replaceAll('{{minutes}}',String(minutes))].join('\n\n')+'\n';
}

export function parsePrediction(text){
 const candidates=[text.trim()];
 for(const block of text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g))candidates.push(block[1].trim());
 const first=text.indexOf('{'),last=text.lastIndexOf('}');if(first>=0&&last>first)candidates.push(text.slice(first,last+1));
 let reason='it is not valid JSON';
 for(const candidate of candidates){
  let value;try{value=JSON.parse(candidate);}catch{continue;}
  if(!value||typeof value!=='object'||Array.isArray(value)){reason='it must be one JSON object';continue;}
  if(!VERDICTS.includes(value.verdict)){reason='the verdict must be "problem" or "no_problem"';continue;}
  const quotes=value.quotes??[];
  if(!Array.isArray(quotes)||quotes.some(q=>typeof q!=='string')){reason='quotes must be a list of strings';continue;}
  return {ok:true,prediction:{verdict:value.verdict,quotes:quotes.filter(q=>q.trim()).slice(0,200)},notes:typeof value.notes==='string'?value.notes.slice(0,4000):''};
 }
 return {ok:false,reason};
}
async function readAgentPrediction(workDir){
 let last='prediction.json was not written';
 for(const name of ['prediction.json','response-1.txt']){
  let text;try{text=await fs.readFile(path.join(workDir,name),'utf8');}catch{continue;}
  const parsed=parsePrediction(text);if(parsed.ok)return {...parsed,source:name};
  if(name==='prediction.json')last=`prediction.json was written, but ${parsed.reason}`;
 }
 return {ok:false,reason:last};
}

// Engines run in their own process groups, here and inside Deep Proof (src/ala.mjs), so stopping the runner does
// not stop them. This kills the group of every direct child of this process: the plain agent's engine and the
// engine of a check running in the in-process Deep Proof instance.
const listProcesses=()=>spawnSync('ps',['-A','-o','pid=,ppid='],{encoding:'utf8'});
// Without a process listing the runner could not stop a check's engine, so a campaign must not start.
export const canListProcesses=()=>{const listed=listProcesses();return listed.status===0&&listed.stdout.split('\n').some(line=>Number(line.trim().split(/\s+/)[0])===process.pid)&&commandsListed();};
// The second listing the runner depends on: command lines, to see whether a sandbox still uses a review's home.
const commandsListed=()=>spawnSync('ps',['-A','-ww','-o','args='],{encoding:'utf8',maxBuffer:64*1024*1024}).status===0;
export function stopEngines(){
 const listed=listProcesses();if(listed.status!==0)return 0;
 let stopped=0;
 for(const line of listed.stdout.split('\n')){const [pid,parent]=line.trim().split(/\s+/).map(Number);if(parent===process.pid&&pid>1){try{process.kill(-pid,'SIGKILL');stopped++;}catch{}}}
 return stopped;
}
// Same process handling as executeTurn in src/ala.mjs: no Ploinky router variables, own process group, hard stop at the limit.
export function launchProcess({args,cwd,timeoutMs}){
 return new Promise(resolve=>{
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PLOINKY_')));
  const child=spawn(process.execPath,args,{env,cwd,stdio:['ignore','ignore','pipe'],detached:true});
  let stderr='',ended=false;
  const finish=result=>{if(ended)return;ended=true;clearTimeout(timer);resolve({...result,stderr:stderr.slice(-3000)});};
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}finish({timedOut:true,code:null});},timeoutMs);
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-12000);});
  child.on('error',error=>finish({startError:error.message,code:null}));
  child.on('close',code=>finish({code}));
 });
}
// The same extraction Deep Proof applies to an uploaded PDF, so both arms read identical text.
async function extractWithDeepProof(bytes,name){const {processUpload}=await import('../../../src/documents.mjs');return (await processUpload({name,data:bytes.toString('base64')},name)).markdown;}

async function moveFolder(from,toDir){
 await fs.mkdir(toDir,{recursive:true});const to=path.join(toDir,path.basename(from));
 try{await fs.rename(from,to);}catch(error){if(error.code!=='EXDEV')throw error;await fs.cp(from,to,{recursive:true});await fs.rm(from,{recursive:true,force:true});}
 return to;
}
// A runner that died leaves its work folder behind. It is moved out before the next review starts.
export function arenaWorkFolders(arena){let entries=[];try{entries=fsSync.readdirSync(arena,{withFileTypes:true});}catch{}return entries.filter(e=>e.isDirectory()&&WORK_FOLDER.test(e.name)).map(e=>e.name);}
export async function clearArena(arena,archive){
 const left=arenaWorkFolders(arena);for(const name of left)await moveFolder(path.join(arena,name),archive);
 return left.length;
}

// ---------- a private agent home for each review ----------
// ALA mounts the saved state of the coding agent (for Codex, ~/.codex) into its sandbox unless it is given a home.
// Deep Proof gives it one for every analysis: the home folder of the user who runs it (src/ala.mjs), all of it.
// Either way a review could read what an earlier review left, and Check Report could read anything kept under
// that home folder, such as answer keys or this campaign's records. For a campaign every review therefore gets
// a home of its own, copied from a folder that holds only a login, and nothing is copied back.
const HOME_FOLDER=/^home-[0-9a-f]{16}$/;
export const HOME_LIMITS={files:200,bytes:20_000_000};
// Homes live in one folder of the campaign, whatever arms run, so that a later invocation finds and removes what
// a stopped runner left. ALA binds a single home into a sandbox, never this folder, so one review cannot reach
// the home of another or the records beside it.
export const homesRoot=out=>path.join(out,'agent-homes');
// -ww: without it some ps versions cut each line to the terminal width, and a cut line would hide the home.
const listCommands=()=>spawnSync('ps',['-A','-ww','-o','args='],{encoding:'utf8',maxBuffer:64*1024*1024});
// The sandbox of a review carries the review's home on its command line (bwrap ... --bind <home> /home/ala). While
// any process does, something may still be writing there, and the home must be neither removed nor examined.
export async function sandboxGone(home,{tries=60,waitMs=250}={}){
 // A home's own name is unique, so it is found however the path to the campaign folder was spelled.
 const name=path.basename(home),wanted=HOME_FOLDER.test(name)?name:home;
 for(let i=0;i<tries;i++){const listed=listCommands();if(listed.status===0&&!listed.stdout.includes(wanted)){await sleep(waitMs);return true;}await sleep(waitMs);}
 return false;
}
// The template must be small and free of links: a used home holds the history of earlier sessions.
export function checkHomeTemplate(template){
 let info=null;try{info=fsSync.lstatSync(template);}catch{}
 if(!info?.isDirectory())throw Error(`--agent-home must be an existing folder: ${template}`);
 const found=[];let bytes=0;
 const visit=dir=>{for(const entry of fsSync.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const full=path.join(dir,entry.name);
  if(entry.isSymbolicLink())throw Error(`--agent-home holds a link (${full}). It must hold only a login made for this campaign.`);
  if(entry.isDirectory())visit(full);else if(entry.isFile()){found.push(full);bytes+=fsSync.statSync(full).size;}
 }};
 visit(template);
 if(!found.length)throw Error(`--agent-home is empty. Sign the coding agent in there first: ${template}`);
 if(found.length>HOME_LIMITS.files||bytes>HOME_LIMITS.bytes)throw Error(`--agent-home holds ${found.length} files and ${bytes} bytes. It should hold only a login, not the history or caches of earlier sessions.`);
 return Object.fromEntries(found.map(full=>[path.relative(template,full).split(path.sep).join('/'),sha256(fsSync.readFileSync(full))]));
}
export async function openHome(template,root){
 const listed=checkHomeTemplate(template);
 await fs.mkdir(root,{recursive:true});
 const home=path.join(root,'home-'+randomBytes(8).toString('hex'));
 // A copy that stopped halfway already holds part of the login, so it is removed before the error is reported.
 try{await fs.cp(template,home,{recursive:true,errorOnExist:true});}catch(error){await fs.rm(home,{recursive:true,force:true});throw error;}
 return {home,listed};
}
// An agent can take permissions away from what it wrote. Links are neither followed nor changed.
function reclaim(root){
 const pending=[root];
 while(pending.length){const dir=pending.pop();
  try{const info=fsSync.lstatSync(dir);if(!info.isDirectory())continue;fsSync.chmodSync(dir,(info.mode&0o7777)|0o700);
   for(const entry of fsSync.readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory())pending.push(path.join(dir,entry.name));
  }catch{}
 }
}
// Removes a used home with everything in it, the copied login included. Returns the login files the agent's
// client changed: a real token refresh among them can make later sign-ins fail, which then shows as an outage.
export async function closeHome(home,listed){
 reclaim(home);const changed=[];
 for(const [name,hash] of Object.entries(listed)){
  let same=false;
  try{
   // Every step must be a real folder and the last a real file: a link the agent left is never followed.
   let current=home,real=true;const parts=name.split('/');
   for(const [i,part] of parts.entries()){current=path.join(current,part);const info=fsSync.lstatSync(current);if(i<parts.length-1?!info.isDirectory():!info.isFile()||info.size>HOME_LIMITS.bytes){real=false;break;}}
   same=real&&sha256(fsSync.readFileSync(current))===hash;
  }catch{}
  if(!same)changed.push(name);
 }
 await fs.rm(home,{recursive:true,force:true});
 return changed;
}
// Homes a stopped runner left behind each hold a copy of the login, so none is kept. One that a sandbox still
// uses means an engine of the earlier run is alive: that has to be stopped by hand before anything else runs.
export async function clearStaleHomes(root,{gone=sandboxGone}={}){
 let entries=[];try{entries=fsSync.readdirSync(root,{withFileTypes:true});}catch{}
 const stale=entries.filter(e=>e.isDirectory()&&HOME_FOLDER.test(e.name)).map(e=>path.join(root,e.name));
 for(const home of stale){
  if(!await gone(home,{tries:8}))throw Error(`An engine of an earlier run is still using ${home}. Stop it, then run the same command again.`);
  reclaim(home);await fs.rm(home,{recursive:true,force:true});
 }
 return stale.length;
}

// archive: where a finished work folder is moved, outside the arena, so that no review can read another one's
// folder (a second arm reviewing the same case would otherwise sit next to the first one's verdict).
export async function runAgentUnit({arm,dossier,arena,settings,minutes,home=null,archive=null,launch=launchProcess,locate=()=>resolveALA(appRoot,{}),extractPdf=extractWithDeepProof}){
 const ala=locate();if(!ala.found)return notStarted('engine_missing',alaUnavailable);
 const {workDir,staged}=await stageDossier(dossier,arena);let outcome;
 try{outcome=await reviewInFolder({arm,dossier,settings,minutes,home,launch,extractPdf,ala,workDir,staged});return outcome;}
 // A review that finished keeps its outcome even when its folder cannot be moved; the runner then stops (run.mjs).
 finally{if(archive){try{const kept=await moveFolder(workDir,archive);if(outcome?.details)outcome.details.workDir=kept;}catch(error){if(outcome)outcome.details={...(outcome.details||{}),archiveError:error.message};}}}
}
async function reviewInFolder({arm,dossier,settings,minutes,home,launch,extractPdf,ala,workDir,staged}){
 const {roles}=dossier,extracted=[];
 if(arm.pdfText!==false)for(const pdf of roles.evidence.filter(name=>/\.pdf$/i.test(name))){
  try{const text=await extractPdf(dossier.files[pdf],pdf),name=pdf+'.extracted.md';await fs.writeFile(path.join(workDir,name),text);staged[name]=sha256(text);extracted.push({pdf,text:name});}
  // A 400 means Deep Proof cannot read this document either; the agent still gets the PDF itself.
  catch(error){if(error.status!==400)return notStarted('converter',error.message,{workDir});extracted.push({pdf,text:null,detail:error.message});}
 }
 const task=path.join(workDir,'task.txt');
 await fs.writeFile(task,agentTask({request:dossier.files[roles.request].toString('utf8'),promptText:arm.promptText,minutes,extracted}));
 await fs.writeFile(path.join(workDir,'config.json'),JSON.stringify({codingAgent:settings.agent,models:settings.models||{},efforts:settings.efforts||{}}));
 // With a home, ALA binds it as the whole sandbox home and does not mount the user's own agent state.
 const args=[...alaArguments({entry:ala.entry,settings,dir:workDir,task,attempt:1,kind:'review'}),...(home?['--home',home]:[])];
 const started=Date.now(),run=await launch({args,cwd:workDir,timeoutMs:minutes*60000});
 const inputsModified=[];
 for(const [name,hash] of Object.entries(staged)){let now=null;try{now=sha256(await fs.readFile(path.join(workDir,name)));}catch{}if(now!==hash)inputsModified.push(name);}
 const details={workDir,extracted,inputsModified,exitCode:run.code??null,timeLimited:!!run.timedOut,engineMs:Date.now()-started};
 if(run.startError)return notStarted('engine_start',`Could not start the engine: ${run.startError}`,details);
 // A non-zero exit fails the review whatever it left behind, as it fails a Deep Proof run. The text is kept for the operator only.
 if(!run.timedOut&&run.code!==0)return {status:'failed',reason:'engine_exit',suspect:true,detail:String(run.stderr||'').slice(-500),details};
 // A verdict written before the time limit counts, as a validated incomplete check does for Deep Proof.
 const parsed=await readAgentPrediction(workDir);
 if(parsed.ok)return {status:'completed',prediction:parsed.prediction,details:{...details,predictionSource:parsed.source,notes:parsed.notes}};
 return {status:'failed',reason:run.timedOut?'timeout':'invalid_output',detail:parsed.reason,details};
}

// ---------- Check Report arm ----------

// Keeps what is needed to recompute the verdict under another category rule without running the check again.
export function recordFindings(findings,targetDocumentId){
 return findings.filter(f=>['confirmed','narrowed'].includes(f.verdict)).map(f=>{
  const locator=f.object?.locator,inTarget=locator?.documentId===targetDocumentId&&typeof locator.quote==='string'&&!!locator.quote.trim();
  return {id:f.id,verdict:f.verdict,level:f.level??'target',categories:Array.isArray(f.categories)?f.categories:[],severity:f.severity??null,quote:inTarget?locator.quote:null};
 });
}
// The check flags a case when it confirmed at least one defect of the report under review in a counted category.
// Findings about the evidence documents or about an earlier reviewer are not statements about the AI output.
export function flagFromFindings(recorded,categories){
 const counted=recorded.filter(f=>f.level==='target'&&(categories==='all'||f.categories.some(c=>categories.includes(c))));
 return {verdict:counted.length?'problem':'no_problem',quotes:[...new Set(counted.map(f=>f.quote).filter(Boolean))]};
}

export function deepProofClient(base){
 let cookie='';
 const send=async(method,route,body)=>{
  const response=await fetch(base+'/api'+route,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await response.text();let data=null;try{data=JSON.parse(text);}catch{}
  const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
  return {status:response.status,data,text};
 };
 const login=async()=>{cookie='';return (await send('POST','/login',{username:'admin',password:'admin'})).status===200;};
 // A session lasts eight hours and is not renewed, and a campaign runs far longer: sign in again when it has ended.
 const call=async(method,route,body)=>{let response=await send(method,route,body);if(response.status===401&&await login())response=await send(method,route,body);return response;};
 return {login,get:route=>call('GET',route),post:(route,body)=>call('POST',route,body)};
}
// A private Deep Proof instance in this process, with its own data folder: the development server and its
// database are never touched. A new data folder starts with the documented initial administrator account.
export async function startDeepProof({dataDir,settings}){
 const {createApp}=await import('../../../server.mjs');
 await fs.mkdir(dataDir,{recursive:true});
 const {server,db}=createApp({dir:dataDir});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const client=deepProofClient(`http://127.0.0.1:${server.address().port}`);
 const running=()=>db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'").get().n;
 // Stop any engine first and let its job settle, so nothing writes to the database after it is closed.
 // A check the runner gave up on keeps running inside this instance and would start its next turn with whatever
 // home the process has by then. Stopping its engine makes that job fail; this repeats until no run is left.
 const settle=async({tries=300}={})=>{for(let i=0;i<tries&&running();i++){stopEngines();await sleep(100);}return !running();};
 // Let every job settle first, so nothing writes to the database after it is closed. Returns whether they did.
 const stop=async()=>{const settled=await settle();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();return settled;};
 try{
  if(!await client.login())throw Error('Could not sign in to the private Deep Proof instance in the output folder. Use a new output folder.');
  if(settings?.agent){
   const saved=await client.post('/admin/settings',{agent:settings.agent,model:settings.models?.[settings.agent]||'',effort:settings.efforts?.[settings.agent]||''});
   if(saved.status!==200)throw Error(`Deep Proof did not accept the agent and model: ${saved.data?.error||saved.status}`);
  }
  const current=(await client.get('/admin/settings')).data;
  return {client,stop,settle,stopEngines,settings:{agent:current.agent,model:current.model,effort:current.effort}};
 }catch(error){await stop();throw error;}
}
async function retrying(send,busy,{tries=30,waitMs=2000}={}){
 for(let attempt=1;;attempt++){const response=await send();if(!busy(response)||attempt>=tries)return response;await sleep(waitMs);}
}
const said=response=>String(response.data?.error||response.status);
// Deep Proof declining the document (bad or oversized file, too much or no text) is its own failure for this case.
// Everything else at upload time (the server hides the cause of a 5xx, a session problem) needs the operator.
const uploadOutcome=(response,details)=>[400,413,415].includes(response.status)?{status:'failed',reason:'ingestion',detail:said(response),details}:notStarted([401,403].includes(response.status)?'session':response.status>=500?'converter':'server',said(response),details);
// What Deep Proof reported for a failed run. Time and validation are the reviewer's own; anything else is
// still scored as failed, and is marked suspect because the report is derived from error text.
const REPORTED={timeout:'timeout',validation:'validation',empty_response:'empty_response'};

// Drives the product path a user follows: project, source documents, Import Report, Check Report in closed
// research mode. The review request travels as the documented scope option, so both arms get the same task text.
export async function runCheckUnit({arm,dossier,deepProof,minutes,label,pollMs=5000,graceMs=10*60*1000,retry={}}){
 const {roles,files}=dossier,{client}=deepProof;
 const file=name=>({name,data:files[name].toString('base64')});
 const project=await client.post('/projects',{company:label.slice(0,120)});
 if(project.status!==201)return notStarted([401,403].includes(project.status)?'session':'server',`Project not created: ${said(project)}`);
 const projectId=project.data.id,route=`/projects/${projectId}`;
 for(const name of roles.evidence){
  const sent=await retrying(()=>client.post(route+'/documents',{title:name,file:file(name)}),r=>r.status===429,retry);
  if(sent.status!==201)return uploadOutcome(sent,{projectId,document:name});
 }
 const imported=await retrying(()=>client.post(route+'/report-imports',{title:roles.target,report_language:'en',file:file(roles.target)}),r=>r.status===429,retry);
 if(imported.status!==201)return uploadOutcome(imported,{projectId,document:roles.target});
 const options={sourceReportId:imported.data.id,qualityOptions:{depth:arm.depth,researchMode:'closed',scope:files[roles.request].toString('utf8').trim()},timeLimitMinutes:minutes,report_language:'en'};
 const started=await retrying(()=>client.post(route+'/analyses',options),r=>r.status===409,retry);
 if(started.status===503)return notStarted('engine_missing',said(started),{projectId});
 if(started.status!==202)return notStarted([401,403].includes(started.status)?'session':'server',`Check not started: ${said(started)}`,{projectId});
 const analysisId=started.data.id,details={projectId,analysisId},deadline=Date.now()+minutes*60000+graceMs;
 let run;
 for(;;){
  run=await client.get(`${route}/analyses/${analysisId}`);
  if(run.status!==200)return {status:'error',reason:[401,403].includes(run.status)?'session':'server',detail:`Check status unavailable: ${said(run)}`,details};
  if(run.data.status!=='running')break;
  // Deep Proof stops its engine at the limit. A check still running well past it did not deliver: that is the
  // reviewer's failure, not a reason to run the case again. Stop whatever engine is left before moving on.
  if(Date.now()>deadline){deepProof.stopEngines?.();return {status:'failed',reason:'timeout',detail:'The check was still running long after its time limit.',details};}
  await sleep(pollMs);
 }
 if(run.data.status==='failed'){const reported=run.data.failure?.code||'unexpected',reason=REPORTED[reported];return reason?{status:'failed',reason,details}:{status:'failed',reason:'engine_failure',suspect:true,detail:`Deep Proof reported: ${reported}`,details};}
 const result=run.data.result;
 // Time Limit Reached with notes only: Deep Proof itself says this is not a validated report and has no findings.
 if(!result?.quality||result.partial)return {status:'failed',reason:'timeout',detail:'The time limit was reached before a validated check existed.',details};
 const register=await client.get(`${route}/analyses/${analysisId}/verification?file=${encodeURIComponent('quality/findings.jsonl')}`);
 if(register.status!==200)return {status:'error',reason:[401,403].includes(register.status)?'session':'server',detail:'The findings register could not be read.',details};
 const findings=recordFindings(register.text.split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line)),run.data.snapshot.sourceReport.documentId);
 return {status:'completed',prediction:flagFromFindings(findings,arm.flagCategories),details:{...details,completion:result.quality.completion,timeLimited:!!result.timeLimited,confirmedFindings:result.quality.confirmedFindings,findings}};
}

// ---------- one unit, records, operator decisions ----------

const counted=(previous,arm)=>previous&&previous.armFingerprint===arm.fingerprint?previous:null;
// Written before an engine is started. A unit found in this state later was cut short (an interrupt, a crash):
// that is an attempt which ended in an error and counts as one, never a free second try.
export const startedRecord=(unit,arm,previous=null)=>({schemaVersion:1,unit:unit.unit,arm:arm.id,armFingerprint:arm.fingerprint,caseId:unit.caseId,repeat:unit.repeat,startedAt:new Date().toISOString(),status:'started',attempt:counted(previous,arm)?.attempt??0,errorAttempts:counted(previous,arm)?.errorAttempts??0});
export const interruptedRecord=record=>({...record,status:'error',reason:'interrupted',attempted:true,detail:'The runner stopped while this review was running.',attempt:(record.attempt??0)+1,errorAttempts:(record.errorAttempts??0)+1});
// previous is the unit's last record under the same fingerprint, so attempts are counted across invocations.
export async function runUnit(unit,context,previous=null){
 const arm=context.arms[unit.arm],startedAt=new Date().toISOString(),started=Date.now();
 let outcome,dossierSha=null,opened=null,instance=null,loginChanged=null,cleanupError=null;
 try{
  if(arm.kind==='constant')outcome={status:'completed',prediction:{verdict:arm.verdict,quotes:[]}};
  else{
   let dossier=null;
   try{dossier=await readDossier(path.join(context.dossiers,unit.caseId));dossierSha=dossier.hash;}catch(error){outcome=notStarted('dossier',error.message);}
   if(dossier&&context.dossierHashes&&context.dossierHashes[unit.caseId]!==dossier.hash){outcome=notStarted('dossier','The dossier changed since this campaign started.');dossier=null;}
   // Both arms get their home the same way. HOME points at it while the review runs, because Deep Proof hands ALA
   // the home of the process it runs in. Afterwards HOME goes back to what the campaign set (run.mjs: an empty
   // folder, never the user's own home).
   const homeBefore=process.env.HOME;
   if(dossier&&context.agentHome){try{opened=await openHome(context.agentHome,context.homes);}catch(error){outcome=notStarted('agent_home',error.message);dossier=null;}}
   try{
    if(opened)process.env.HOME=opened.home;
    if(dossier&&arm.kind==='agent')outcome=await runAgentUnit({arm,dossier,arena:context.arena,settings:context.settings,minutes:context.minutes,home:opened?.home??null,...context.agentOptions});
    else if(dossier){
     try{instance=await context.deepProof();}catch(error){outcome=notStarted('instance',error.message);}
     if(instance)outcome=await runCheckUnit({arm,dossier,deepProof:instance,minutes:context.minutes,label:unit.caseId,...context.checkOptions});
    }
   }finally{
    // The order matters. A check that was given up (an unreadable status, an overrun, an exception) is still
    // running inside the instance and would start its next turn with whatever HOME is by then. So first no check
    // may be left running, then no sandbox may be left on this home, and only then does HOME change and the home go.
    try{
     if(instance?.settle&&!await instance.settle())cleanupError='Deep Proof still had a check running after its review ended, and its engine could not be stopped.';
     else if(opened&&!await (context.sandboxGone??sandboxGone)(opened.home))cleanupError='A sandbox that uses the home of this review was still running.';
    }catch(error){cleanupError=error.message;}
    // After a failed clean-up HOME stays on this review's own home, which is kept: whatever is still running then
    // reaches nothing else. The run stops, and run.mjs restores HOME once the instance has settled.
    if(opened&&!cleanupError){
     if(homeBefore===undefined)delete process.env.HOME;else process.env.HOME=homeBefore;
     try{loginChanged=await closeHome(opened.home,opened.listed);}catch(error){cleanupError=`The agent home of this review could not be removed: ${error.message}`;}
    }
   }
  }
 }catch(error){outcome={status:'error',reason:'runner',detail:error.message};}
 // A review keeps its outcome when the clean-up after it failed; the runner then stops (run.mjs), because the next
 // review would not be alone.
 if(opened||cleanupError)outcome.details={...(outcome.details||{}),...(opened?{privateHome:true,loginChanged}:{}),...(cleanupError?{cleanupError}:{})};
 const {attempted=true,...rest}=outcome,before=counted(previous,arm);
 return {schemaVersion:1,unit:unit.unit,arm:arm.id,armFingerprint:arm.fingerprint,caseId:unit.caseId,repeat:unit.repeat,dossierSha,startedAt,durationMs:Date.now()-started,
  attempt:(before?.attempt??0)+(attempted?1:0),errorAttempts:(before?.errorAttempts??0)+(rest.status==='error'&&attempted?1:0),...rest,...(rest.status==='error'?{attempted}:{})};
}

export async function readRecords(out){
 const records=new Map();let names=[];try{names=await fs.readdir(path.join(out,'records'));}catch{}
 for(const name of names.filter(n=>n.endsWith('.json')).sort()){const record=JSON.parse(await fs.readFile(path.join(out,'records',name),'utf8'));records.set(record.unit,record);}
 return records;
}
// The record file holds a unit's current state. attempts.jsonl keeps every state it ever had, so the number of
// attempts behind a result and every discarded one stay visible.
export async function writeRecord(out,record){
 const dir=path.join(out,'records');await fs.mkdir(dir,{recursive:true});
 await fs.appendFile(path.join(out,'attempts.jsonl'),JSON.stringify(record)+'\n');
 const file=path.join(dir,record.unit+'.json');await fs.writeFile(file+'.tmp',JSON.stringify(record,null,1)+'\n');await fs.rename(file+'.tmp',file);
}
// A unit is final once it completed or failed under the arm's current fingerprint. Errors run again, up to a limit.
export const isFinal=(record,arm)=>!!record&&record.armFingerprint===arm.fingerprint&&['completed','failed'].includes(record.status);
export const isStuck=(record,arm)=>!!record&&record.armFingerprint===arm.fingerprint&&record.status==='error'&&(record.errorAttempts??0)>=MAX_ERROR_ATTEMPTS;

// The only way a unit that is not completed changes state without a new run: an operator decision, with a
// reason, kept in the campaign file and shown with every comparison. "rerun" clears a failed or stopped unit to
// run again; "failed" settles a unit that keeps ending in an error as a wrong answer. A completed review is never discarded.
export async function resolveUnits(out,{units,as,reason}){
 if(!['rerun','failed'].includes(as))throw Error('Use --as rerun or --as failed.');
 if(typeof reason!=='string'||!reason.trim())throw Error('Give --reason: the decision is kept with the campaign and shown with every comparison.');
 if(!units.length)throw Error('Name at least one --unit.');
 const file=path.join(out,'campaign.json'),campaign=JSON.parse(await fs.readFile(file,'utf8')),records=await readRecords(out),decided=[];
 const next=[];
 for(const unit of units){
  const record=records.get(unit);if(!record)throw Error(`${unit}: there is no record to decide on.`);
  if(record.status==='completed')throw Error(`${unit} completed with a verdict. A completed review is never discarded.`);
  if(record.status==='voided')throw Error(`${unit} is already cleared to run again.`);
  if(as==='failed'&&record.status!=='error')throw Error(`${unit}: only a unit stopped by an error can be marked as failed.`);
  const decision={at:new Date().toISOString(),unit,arm:record.arm,as,reason:reason.trim(),previous:{status:record.status,reason:record.reason??null}};
  const {prediction,suspect,detail,details,...kept}=record;
  next.push(as==='rerun'?{...kept,status:'voided',reason:null,errorAttempts:0,decision}:{...kept,status:'failed',reason:'operator',detail:reason.trim(),decision});decided.push(decision);
 }
 for(const record of next)await writeRecord(out,record);
 campaign.operatorDecisions=[...(campaign.operatorDecisions||[]),...decided];await fs.writeFile(file,JSON.stringify(campaign,null,1)+'\n');
 return decided;
}

// Writes one prediction file per arm and repeat in the format score.mjs reads, plus an index for compare.mjs.
// flagCategories recomputes Check Report verdicts under another category rule, as a sensitivity analysis.
export async function collect(out,{predictions=path.join(out,'predictions'),flagCategories=null}={}){
 const campaign=JSON.parse(await fs.readFile(path.join(out,'campaign.json'),'utf8')),records=await readRecords(out);
 let history=[];try{history=(await fs.readFile(path.join(out,'attempts.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{}
 await fs.mkdir(predictions,{recursive:true});
 const index={schemaVersion:1,setup:{agent:campaign.agent,model:campaign.model,effort:campaign.effort,minutes:campaign.minutes,repeats:campaign.repeats,seed:campaign.seed},blind:campaign.blind,agentState:campaign.agentState??null,flagCategoriesOverride:flagCategories,cases:campaign.cases,arms:{},incomplete:[],waitingForDecision:[]};
 for(const [armId,arm] of Object.entries(campaign.arms)){
  const decisions=(campaign.operatorDecisions||[]).filter(d=>d.arm===armId),past=history.filter(r=>r.arm===armId&&r.armFingerprint===arm.fingerprint),starts=[];
  const summary={kind:arm.kind,fingerprint:arm.fingerprint,repeats:[],completed:0,failed:0,suspectFailures:0,failureReasons:{},
   errorsRecorded:past.filter(r=>r.status==='error').length,errorsBeforeStart:past.filter(r=>r.status==='error'&&r.attempted===false).length,attemptsLost:past.filter(r=>r.status==='error'&&r.attempted!==false).length,
   rerunsGranted:decisions.filter(d=>d.as==='rerun').length,markedFailed:decisions.filter(d=>d.as==='failed').length,strictRepeats:null,
   firstStartedAt:null,lastStartedAt:null,meanStartedAt:null,engineMinutes:0};
  // Strict reading: a unit that an operator cleared to run again, or whose review was cut short and then run
  // again, counts as a failed review whatever the later run gave. Both give a second try at a hard case.
  const cleared=new Map(decisions.filter(d=>d.as==='rerun').map(d=>[d.unit,'cleared_by_operator']));
  for(const r of past)if(r.status==='error'&&r.reason==='interrupted'&&!cleared.has(r.unit))cleared.set(r.unit,'interrupted_run');
  summary.interruptedUnits=[...cleared.values()].filter(v=>v==='interrupted_run').length;if(cleared.size)summary.strictRepeats=[];
  for(let repeat=1;repeat<=campaign.repeats;repeat++){
   const entries={};
   for(const caseId of campaign.cases){
    const unit=unitId(armId,caseId,repeat),record=records.get(unit);
    if(!isFinal(record,arm)){index.incomplete.push(unit);if(isStuck(record,arm))index.waitingForDecision.push(unit);continue;}
    if(record.status==='completed'){
     entries[caseId]=arm.kind==='check'&&flagCategories?flagFromFindings(record.details.findings,flagCategories):record.prediction;summary.completed++;
    }else{entries[caseId]={failed:true,reason:record.reason};summary.failed++;summary.suspectFailures+=record.suspect?1:0;summary.failureReasons[record.reason]=(summary.failureReasons[record.reason]||0)+1;}
    summary.engineMinutes+=record.durationMs/60000;starts.push(Date.parse(record.startedAt));
   }
   const name=`${armId}.r${repeat}.json`;await fs.writeFile(path.join(predictions,name),JSON.stringify(entries,null,1)+'\n');summary.repeats.push(name);
   if(cleared.size){
    const strict={...entries};for(const caseId of campaign.cases){const why=cleared.get(unitId(armId,caseId,repeat));if(why)strict[caseId]={failed:true,reason:why};}
    const strictName=`${armId}.r${repeat}.strict.json`;await fs.writeFile(path.join(predictions,strictName),JSON.stringify(strict,null,1)+'\n');summary.strictRepeats.push(strictName);
   }
  }
  if(starts.length){summary.firstStartedAt=new Date(Math.min(...starts)).toISOString();summary.lastStartedAt=new Date(Math.max(...starts)).toISOString();summary.meanStartedAt=new Date(starts.reduce((s,t)=>s+t,0)/starts.length).toISOString();}
  summary.engineMinutes=Math.round(summary.engineMinutes*10)/10;index.arms[armId]=summary;
 }
 await fs.writeFile(path.join(predictions,'index.json'),JSON.stringify(index,null,1)+'\n');
 return index;
}
export {CHECK_MINUTES};
