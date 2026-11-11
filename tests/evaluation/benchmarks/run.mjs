#!/usr/bin/env node
// Plans and runs a comparison campaign: the same benchmark dossiers reviewed by several arms (a plain coding
// agent, Deep Proof's Check Report, constant answers) with one agent, model and time limit.
// Usage:
//   node tests/evaluation/benchmarks/run.mjs --dossiers DIR --out DIR --arms plain,deep-proof-check --agent codex --model ID
//        [--arena DIR] [--effort ID] [--repeats 3] [--minutes 35] [--seed 1]
//        [--cases-file cases.json] [--partition final] [--dataset ragtruth] [--case case-…] [--limit N]
//        [--arms-file arms.json] [--allow-visible-keys] [--launch]
//   node tests/evaluation/benchmarks/run.mjs collect --out DIR [--predictions DIR] [--flag-categories all|F01,F02]
//   node tests/evaluation/benchmarks/run.mjs resolve --out DIR --unit UNIT [--unit UNIT] --as rerun|failed --reason TEXT
// Without --launch the command prints the plan and runs nothing. With --launch it starts the coding agent
// through ALA and CONSUMES MODEL USAGE: up to (units × minutes) of agent time. Run it only on purpose.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256} from './lib.mjs';
import {appRoot,RUNNER_VERSION,CHECK_MINUTES,MAX_ERROR_ATTEMPTS,loadArms,planUnits,blindness,readDossier,runUnit,startedRecord,interruptedRecord,readRecords,writeRecord,isFinal,isStuck,collect,resolveUnits,startDeepProof,stopEngines,canListProcesses,clearArena,arenaWorkFolders} from './runner.mjs';
import {resolveALA} from '../../../src/ala-location.mjs';

const CASE=/^case-[0-9a-f]{12}$/;
const readJSON=file=>{try{return JSON.parse(fsSync.readFileSync(file,'utf8'));}catch{return null;}};
// An arm that ends this many runs in a row in an error or a suspect failure stops the campaign for a look.
const MAX_TROUBLE_IN_A_ROW=3;
export function parseArgs(argv){
 const args={command:'run',dossiers:null,out:null,arena:null,arms:[],armsFile:null,agent:null,model:'',effort:'',repeats:1,minutes:35,seed:1,casesFile:null,partition:null,dataset:null,cases:[],limit:null,allowVisibleKeys:false,launch:false,predictions:null,flagCategories:null,units:[],as:null,reason:null};
 const rest=[...argv];if(['collect','resolve'].includes(rest[0]))args.command=rest.shift();
 const integer=(name,value,min)=>{const n=Number(value);if(!Number.isInteger(n)||n<min)throw Error(`${name} needs a whole number of at least ${min}.`);return n;};
 for(let i=0;i<rest.length;i++){
  const a=rest[i],value=()=>{if(i+1>=rest.length)throw Error(`${a} needs a value.`);return rest[++i];};
  if(a==='--dossiers')args.dossiers=path.resolve(value());else if(a==='--out')args.out=path.resolve(value());else if(a==='--arena')args.arena=path.resolve(value());
  else if(a==='--arms')args.arms=value().split(',').map(s=>s.trim()).filter(Boolean);else if(a==='--arms-file')args.armsFile=path.resolve(value());
  else if(a==='--agent')args.agent=value();else if(a==='--model')args.model=value();else if(a==='--effort')args.effort=value();
  else if(a==='--repeats')args.repeats=integer(a,value(),1);else if(a==='--minutes')args.minutes=integer(a,value(),1);else if(a==='--seed')args.seed=integer(a,value(),0);
  else if(a==='--cases-file')args.casesFile=path.resolve(value());else if(a==='--partition')args.partition=value();else if(a==='--dataset')args.dataset=value();
  else if(a==='--case')args.cases.push(value());else if(a==='--limit')args.limit=integer(a,value(),1);
  else if(a==='--allow-visible-keys')args.allowVisibleKeys=true;else if(a==='--launch')args.launch=true;
  else if(a==='--predictions')args.predictions=path.resolve(value());else if(a==='--flag-categories'){const v=value();args.flagCategories=v==='all'?'all':v.split(',').map(s=>s.trim()).filter(Boolean);}
  else if(a==='--unit')args.units.push(value());else if(a==='--as')args.as=value();else if(a==='--reason')args.reason=value();
  else throw Error(`Unknown argument: ${a}`);
 }
 if(!args.out)throw Error('Pass --out <folder> for the campaign records.');
 if(args.command!=='run')return args;
 if(!args.dossiers)throw Error('Pass --dossiers <folder> holding the case-… dossier folders.');
 if(!args.arms.length)throw Error('Pass --arms with one or more arm names from arms.json, separated by commas.');
 if(!CHECK_MINUTES.includes(args.minutes))throw Error(`--minutes must be one of ${CHECK_MINUTES.join(', ')}, the limits Check Report offers, so every arm gets the same time.`);
 return args;
}

// The case list comes from the dossier folders. Partition and dataset filters need the blind case list (cases.json).
export async function selectCases(args){
 let ids=(await fs.readdir(args.dossiers,{withFileTypes:true})).filter(e=>e.isDirectory()&&CASE.test(e.name)).map(e=>e.name).sort();
 if(!ids.length)throw Error(`No case-… folders found in ${args.dossiers}. Build the set with build.mjs and copy its dossiers folder.`);
 if(args.partition||args.dataset){
  const file=args.casesFile??[path.join(args.dossiers,'cases.json'),path.join(path.dirname(args.dossiers),'cases.json')].find(f=>fsSync.existsSync(f));
  if(!file)throw Error('--partition and --dataset need the blind case list: pass --cases-file <cases.json>.');
  const listed=new Map(JSON.parse(await fs.readFile(file,'utf8')).cases.map(c=>[c.caseId,c]));
  ids=ids.filter(id=>{const c=listed.get(id);return c&&(!args.partition||c.partition===args.partition)&&(!args.dataset||c.dataset===args.dataset);});
 }
 if(args.cases.length){const missing=args.cases.filter(id=>!ids.includes(id));if(missing.length)throw Error(`Not among the selected dossiers: ${missing.join(', ')}`);ids=ids.filter(id=>args.cases.includes(id));}
 if(args.limit)ids=ids.slice(0,args.limit);
 if(!ids.length)throw Error('The filters leave no case to run.');
 return ids;
}

// Everything that shapes a review besides the arm definitions: the application with its prompts, skills and
// validators, and this runner. A campaign refuses to continue when any of it changed. Of web/, only the two
// files the server and the engine path load are included, so interface and translation edits do not block a resume.
const CODE=['server.mjs','package.json','src','skills','web/markdown.js','web/report-languages.js','tests/evaluation/benchmarks/runner.mjs','tests/evaluation/benchmarks/run.mjs','tests/evaluation/benchmarks/lib.mjs'];
// One runner per campaign folder. The lock names its holder by process id, process start time and process
// namespace, and the holder refreshes it every few seconds.
// - A holder in this namespace is looked up directly: a lock left by a runner that died is stale at once, also
//   when a new process got the same id.
// - A holder in another container or on another host cannot be looked up from here, so its lock counts for as
//   long as it is being refreshed. After such a runner is killed outright, the next one waits out STALE_AFTER_MS.
const HEARTBEAT_MS=15000,STALE_AFTER_MS=90000;
const lockFile=out=>path.join(out,'runner.lock');
const readLock=file=>{try{return JSON.parse(fsSync.readFileSync(file,'utf8'));}catch{return null;}};
// A token for when a process started, the same from every environment: clock ticks since boot from /proc on
// Linux, otherwise ps with a fixed time zone and locale (ps prints local time). null: there is no such process.
// undefined: it could not be determined, which must never be read as "gone".
export function processStart(pid){
 // Where /proc exists it is the only source: a failure other than "no such process" (for example a permission
 // error for another user's process) is unknown, and falling back to ps would give a token of another kind.
 if(fsSync.existsSync('/proc/self/stat')){
  try{return 'ticks:'+fsSync.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').pop().split(' ')[19];}
  catch(error){return error.code==='ENOENT'?null:undefined;}
 }
 const listed=spawnSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',env:{...process.env,TZ:'UTC',LC_ALL:'C'}});
 if(listed.error||listed.status===null||(listed.status!==0&&String(listed.stderr||'').trim()))return undefined;
 return listed.stdout.trim()||null;
}
export function lockNamespace(){
 try{return `${fsSync.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()}:${fsSync.readlinkSync('/proc/self/ns/pid')}`;}catch{return `host:${os.hostname()}`;}
}
// Who holds the lock, as words for a message, or null when nobody does.
function holder(lock,now=Date.now()){
 if(!Number.isInteger(lock?.pid))return null;
 if(lock.namespace&&lock.namespace===lockNamespace()){
  if(lock.pid===process.pid)return null;   // this process, or an earlier one that had its id
  const start=processStart(lock.pid);
  if(start===undefined)return `process ${lock.pid}, which could not be checked`;
  return start&&(!lock.startedAt||lock.startedAt===start)?`process ${lock.pid}`:null;
 }
 const age=now-Date.parse(lock.at);
 return age<STALE_AFTER_MS?`process ${lock.pid} in another container or host, active ${Math.max(0,Math.round(age/1000))} seconds ago`:null;
}
export const liveRunner=out=>holder(readLock(lockFile(out)));
// Creates the lock exclusively. A stale lock is first moved aside and checked, so two runners starting together
// cannot both take over. Only the holder refreshes or removes the lock, and it notices when it has lost it.
export function acquireLock(out,{heartbeatMs=HEARTBEAT_MS}={}){
 fsSync.mkdirSync(out,{recursive:true});
 const file=lockFile(out),identity={pid:process.pid,startedAt:processStart(process.pid),namespace:lockNamespace()},stamp=()=>JSON.stringify({...identity,at:new Date().toISOString()});
 const mine=lock=>!!lock&&lock.pid===identity.pid&&lock.startedAt===identity.startedAt&&lock.namespace===identity.namespace;
 const taken=who=>Error(`Another runner (${who}) is working on this campaign folder.`);
 const seen=readLock(file);
 if(fsSync.existsSync(file)){
  const who=holder(seen);if(who)throw taken(who);
  const aside=`${file}.stale-${process.pid}-${Date.now()}`;let moved=false;
  try{fsSync.renameSync(file,aside);moved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(moved){if(JSON.stringify(readLock(aside))!==JSON.stringify(seen)){try{fsSync.renameSync(aside,file);}catch{}throw taken('just started');}fsSync.rmSync(aside,{force:true});}
 }
 try{fsSync.writeFileSync(file,stamp(),{flag:'wx'});}catch(error){if(error.code==='EEXIST')throw taken('just started');throw error;}
 let lost=false;
 const beat=setInterval(()=>{
  if(!mine(readLock(file))){lost=true;return;}
  try{fsSync.writeFileSync(file+'.beat',stamp());fsSync.renameSync(file+'.beat',file);}catch{}
 },heartbeatMs);beat.unref();
 return {lost:()=>lost||!mine(readLock(file)),release:()=>{clearInterval(beat);if(mine(readLock(file)))fsSync.rmSync(file,{force:true});}};
}
export function codeHash(root=appRoot,entries=CODE){
 const lines=[];
 const visit=relative=>{
  const full=path.join(root,relative),stat=fsSync.statSync(full);
  if(stat.isDirectory()){for(const name of fsSync.readdirSync(full).sort())if(name!=='.DS_Store'&&name!=='node_modules')visit(path.join(relative,name));}
  else if(stat.isFile())lines.push(`${sha256(fsSync.readFileSync(full))}  ${relative}`);
 };
 for(const entry of entries)visit(entry);
 return sha256(lines.join('\n'));
}
function versions(){
 const git=(root,...a)=>{const r=spawnSync('git',['-C',root,...a],{encoding:'utf8'});return r.status===0?r.stdout.trim():null;};
 const ala=resolveALA(appRoot,{});let version=null;
 if(ala.found)try{version=JSON.parse(fsSync.readFileSync(path.join(ala.root,'package.json'),'utf8')).version??null;}catch{}
 return {app:{commit:git(appRoot,'rev-parse','HEAD'),dirty:(git(appRoot,'status','--porcelain')??'')!==''},ala:ala.found?{entry:ala.entry,version,commit:git(ala.root,'rev-parse','HEAD')}:null};
}

// The campaign file freezes what must not change between invocations: agent, model, effort, time limit, repeats,
// seed, the case list, the bytes of every dossier, the code and the ALA installation. An arm keeps its
// fingerprint; new arms may be added. Exposure of answer keys is sticky.
// A plan-only invocation checks the same rules but writes nothing, so planning never locks a campaign.
export async function openCampaign(out,wanted,{persist=true}={}){
 const file=path.join(out,'campaign.json');let campaign=null;
 try{campaign=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(campaign){
  for(const key of ['agent','model','effort','minutes','repeats','seed'])if(campaign[key]!==wanted[key])throw Error(`This campaign was started with ${key} = ${JSON.stringify(campaign[key])}; the command asks for ${JSON.stringify(wanted[key])}. Use a new --out folder for different settings.`);
  if(JSON.stringify(campaign.cases)!==JSON.stringify(wanted.cases))throw Error('This campaign was started with a different case list. Use a new --out folder, or repeat the original case filters.');
  const changed=wanted.cases.filter(id=>campaign.dossierHashes[id]!==wanted.dossierHashes[id]);
  if(changed.length)throw Error(`${changed.length} dossier(s) changed since this campaign started (${changed.slice(0,3).join(', ')}${changed.length>3?', …':''}). Use a new --out folder.`);
  if(campaign.codeHash!==wanted.codeHash)throw Error('The Deep Proof or runner code changed since this campaign started. Reviews made by different code are not pooled: restore the code, or use a new --out folder.');
  const ala=wanted.invocation.ala;
  if(campaign.ala&&ala&&JSON.stringify(campaign.ala)!==JSON.stringify(ala))throw Error('The ALA installation changed since this campaign started (location, version or commit). Use a new --out folder.');
  campaign.ala??=ala;
  for(const [id,arm] of Object.entries(wanted.arms))if(campaign.arms[id]&&campaign.arms[id].fingerprint!==arm.fingerprint)throw Error(`Arm "${id}" changed since this campaign started (its settings, prompt or verification skill). Use a new --out folder.`);
  campaign.arms={...campaign.arms,...wanted.arms};
  if(wanted.blind.status==='exposed')campaign.blind=wanted.blind;
  campaign.invocations.push(wanted.invocation);
 }else campaign={schemaVersion:1,runner:RUNNER_VERSION,createdAt:new Date().toISOString(),...wanted,ala:wanted.invocation.ala,operatorDecisions:[],invocations:[wanted.invocation]};
 delete campaign.invocation;
 if(persist){await fs.mkdir(out,{recursive:true});await fs.writeFile(file,JSON.stringify(campaign,null,1)+'\n');}
 return campaign;
}

function printIndex(index,log){
 for(const [id,arm] of Object.entries(index.arms)){
  const reasons=Object.entries(arm.failureReasons).map(([reason,n])=>`${reason} ${n}`).join(', ');
  log(`  ${id}: completed ${arm.completed}, failed ${arm.failed}${reasons?` (${reasons})`:''}, errors recorded ${arm.errorsRecorded} (${arm.attemptsLost} after a review had started), about ${arm.engineMinutes} minutes of run time`
   +(arm.rerunsGranted||arm.markedFailed?`; operator decisions: ${arm.rerunsGranted} cleared to run again, ${arm.markedFailed} marked failed`:''));
 }
 if(index.incomplete.length)log(`  ${index.incomplete.length} unit(s) have no final record yet (not run, cleared to run again, or stopped by an error).`);
 if(index.waitingForDecision.length)log(`  ${index.waitingForDecision.length} of them ended in an error ${MAX_ERROR_ATTEMPTS} times and will not run again until you decide: run.mjs resolve --unit ${index.waitingForDecision[0]} --as rerun|failed --reason "…"`);
}

export async function main(argv,{log=console.log,context={}}={}){
 const args=parseArgs(argv);
 if(args.command==='collect'){
  const index=await collect(args.out,{...(args.predictions?{predictions:args.predictions}:{}),flagCategories:args.flagCategories});
  log(`Prediction files written to ${args.predictions??path.join(args.out,'predictions')}.`);printIndex(index,log);return {index};
 }
 if(args.command==='resolve'){
  const busy=liveRunner(args.out);if(busy)throw Error(`A runner (${busy}) is working on this campaign. Decide once it has stopped.`);
  const decided=await resolveUnits(args.out,{units:args.units,as:args.as,reason:args.reason});
  for(const d of decided)log(`${d.unit}: was ${d.previous.status}${d.previous.reason?` (${d.previous.reason})`:''}, now ${d.as==='rerun'?'cleared to run again':'marked as failed'}.`);
  log('Recorded in campaign.json. Every comparison of this campaign will show these decisions.');return {decided};
 }
 const all=await loadArms(args.armsFile??undefined),unknown=args.arms.filter(id=>!all[id]);
 if(unknown.length)throw Error(`Unknown arm(s): ${unknown.join(', ')}. Available: ${Object.keys(all).join(', ')}.`);
 const arms=Object.fromEntries(args.arms.map(id=>[id,all[id]])),kinds=new Set(Object.values(arms).map(a=>a.kind)),engine=kinds.has('agent')||kinds.has('check');
 if(engine&&!args.agent)throw Error('Pass --agent and --model (and optionally --effort): every arm must use the same coding agent and model.');
 if(engine&&!args.model)throw Error('Pass --model: with the agent\'s default model the campaign would not record which model reviewed the cases.');
 if(kinds.has('agent')&&!args.arena)throw Error('Pass --arena <folder>: agent arms work in fresh folders there. Keep it outside this repository and outside --out.');
 // These variables shorten Check Report's limit only, so the arms would silently get different amounts of time.
 if(kinds.has('check'))for(const name of ['DEEP_PROOF_WORK_MS','DEEP_PROOF_WRAPUP_MS'])if(process.env[name])throw Error(`${name} is set. It changes the time limit of Check Report but not of the plain agent. Unset it for a campaign.`);
 const cases=await selectCases(args),dossierHashes={};
 for(const id of cases)dossierHashes[id]=(await readDossier(path.join(args.dossiers,id))).hash;
 const arena=kinds.has('agent')?args.arena:null,layout={dossiers:args.dossiers,arena,out:args.out},archive=path.join(args.out,'work');
 // Folders that contain each other are refused before anything is created or moved.
 blindness({...layout,allowVisibleKeys:true});
 const busy=liveRunner(args.out);
 if(busy&&args.launch)throw Error(`Another runner (${busy}) is working on this campaign folder.`);
 if(args.launch&&engine&&!canListProcesses())throw Error('The runner could not list processes with "ps -A -o pid=,ppid=". Without it an engine cannot be stopped at an interrupt or when a check overruns, so the campaign is not started.');
 const lock=args.launch?acquireLock(args.out,context.lockOptions):null,release=()=>lock?.release();
 try{
  // Work folders a dead runner left in this campaign's arena are moved out before the arena is examined and
  // before any review starts. Work folders in an arena this campaign has not used belong to something else.
  const known=readJSON(path.join(args.out,'campaign.json'));
  if(known&&arena&&known.arena&&known.arena!==arena)throw Error(`This campaign uses the arena ${known.arena}. Use the same arena, or a new --out folder.`);
  if(args.launch&&arena){
   if(known?.arena===arena){const left=await clearArena(arena,archive);if(left)log(`Moved ${left} work folder(s) left in the arena by an interrupted run to ${archive}.`);}
   else if(arenaWorkFolders(arena).length)throw Error(`The arena ${arena} holds work folders of another run. Use a new, empty arena for this campaign.`);
  }
  const blind=blindness({...layout,allowVisibleKeys:args.allowVisibleKeys||!engine});
  const campaign=await openCampaign(args.out,{agent:engine?args.agent:null,model:engine?args.model:'',effort:engine?args.effort:'',minutes:args.minutes,repeats:args.repeats,seed:args.seed,cases,dossierHashes,codeHash:codeHash(),
   arms:Object.fromEntries(Object.values(arms).map(({promptText,...arm})=>[arm.id,arm])),dossiers:args.dossiers,arena:known?.arena??arena,blind,invocation:{at:new Date().toISOString(),arms:args.arms,...versions()}},{persist:args.launch});
  const records=await readRecords(args.out),units=planUnits({caseIds:cases,armIds:args.arms,repeats:args.repeats,seed:args.seed});
  // A unit left in the started state was cut short by an interrupt or a crash: an attempt that ended in an error.
  if(!busy)for(const [unit,record] of records)if(record.status==='started'){const settled=interruptedRecord(record);records.set(unit,settled);if(args.launch)await writeRecord(args.out,settled);}
  const open=units.filter(u=>!isFinal(records.get(u.unit),arms[u.arm])),waiting=open.filter(u=>isStuck(records.get(u.unit),arms[u.arm])),pending=open.filter(u=>!waiting.includes(u));
  const billable=pending.filter(u=>arms[u.arm].kind!=='constant').length;
  log(`Campaign ${args.out}: ${cases.length} case(s) × ${args.arms.length} arm(s) × ${args.repeats} repeat(s) = ${units.length} unit(s); ${units.length-open.length} already final, ${pending.length} to run.`);
  if(waiting.length)log(`${waiting.length} unit(s) ended in an error ${MAX_ERROR_ATTEMPTS} times and wait for a decision: run.mjs resolve --unit ${waiting[0].unit} --as rerun|failed --reason "…"`);
  log(`Answer keys: ${campaign.blind.status}${campaign.blind.visibleKeys.length?` (${campaign.blind.visibleKeys.join('; ')})`:''}.`);
  if(billable)log(`Agent runs to start: ${billable}, each up to ${args.minutes} minutes with ${args.agent} / ${args.model}${args.effort?' / '+args.effort:''}: at most ${Math.round(billable*args.minutes/6)/10} hours of model usage.`);
  if(busy)log(`A runner (${busy}) is working on this campaign now; units it has started are shown as pending.`);
  if(!args.launch){log('Nothing was run. Add --launch to start these runs; agent and Check Report arms consume model usage.');return {campaign,pending,waiting};}
  const settings={agent:args.agent,models:args.model?{[args.agent]:args.model}:{},efforts:args.model&&args.effort?{[args.agent]:args.effort}:{}};
  let deepProof=null;
  // Finished work folders leave the arena, so a later review of the same case cannot read an earlier one's verdict.
  const run={arms,dossiers:args.dossiers,dossierHashes,arena:args.arena,minutes:args.minutes,settings,deepProof:async()=>deepProof??=await startDeepProof({dataDir:path.join(args.out,'deep-proof-data'),settings}),...context,
   agentOptions:{archive,...(context.agentOptions||{})}};
  // Engines run in their own process groups, so an interrupted runner has to stop them itself. The unit in
  // progress keeps its started record and is settled as an interrupted attempt by the next invocation.
  const interrupt=()=>{stopEngines();release();process.exit(130);};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const trouble={};let stopped=false;
  try{
   for(const [i,unit] of pending.entries()){
    // Another runner takes the lock only when this one looked dead for a long time (a suspended machine, for example).
    if(lock.lost()){stopped=true;log('Stopped: another runner has taken over this campaign folder. This one starts no further review.');break;}
    const previous=records.get(unit.unit)??null;
    if(arms[unit.arm].kind!=='constant')await writeRecord(args.out,startedRecord(unit,arms[unit.arm],previous));
    const record=await runUnit(unit,run,previous);await writeRecord(args.out,record);records.set(unit.unit,record);
    log(`[${i+1}/${pending.length}] ${unit.unit}: ${record.status}${record.reason?` (${record.reason})`:''}${record.prediction?` → ${record.prediction.verdict}`:''}`);
    if(arms[unit.arm].kind==='constant')continue;
    // The outcome is kept, but with a work folder still in the arena the next review would not be isolated.
    if(record.details?.archiveError){stopped=true;log(`Stopped: the work folder of ${unit.unit} could not be moved out of the arena (${record.details.archiveError}). Free the space or fix the folder, then run the same command again.`);break;}
    // Counted per arm: a missing engine, an expired sign-in or an exhausted quota would otherwise be met again on
    // every remaining unit, and the other arm's successes must not hide one arm's trouble.
    trouble[unit.arm]=record.status==='error'||record.suspect===true?(trouble[unit.arm]||0)+1:0;
    if(trouble[unit.arm]>=MAX_TROUBLE_IN_A_ROW&&i+1<pending.length){
     stopped=true;log(`Stopped: arm "${unit.arm}" ended ${MAX_TROUBLE_IN_A_ROW} runs in a row in an error or in a failure that may be an infrastructure problem (last: ${record.status} ${record.reason}${record.detail?`: ${String(record.detail).slice(0,300)}`:''}). Check the engine, the sign-in and the quota, then run the same command again. Failures already recorded stay scored as wrong answers unless you clear them with run.mjs resolve.`);break;
    }
   }
  }finally{process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);if(deepProof)await deepProof.stop();}
  const index=await collect(args.out);log(`Prediction files written to ${path.join(args.out,'predictions')}.`);printIndex(index,log);
  return {campaign,index,stopped};
 }finally{release();}
}

// Exit status: 0 when every planned unit is final (or nothing was launched), 2 when units still lack a final record, 1 on a usage error.
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).then(result=>{if(result?.index?.incomplete?.length)process.exitCode=2;}).catch(error=>{console.error(error.message);process.exitCode=1;});
