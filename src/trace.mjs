// Opt-in process trace: a JSON Lines journal of the host's steps and of every event ALA reports for one run, plus a
// kept copy of a Check Report's disposable work folder. It is on only when DEEP_PROOF_TRACE is exactly '1' when the
// run is created. It is a convenience record for a human reader: not evidence, not tamper-proof, never served over
// HTTP. No tracer method throws and none can change a run: the first failure disables the trace for that run.
// The contract (version 1) is docs/process-trace.md.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {safeDirectory,safePath,readArtifact} from './safe-files.mjs';
import {projectFolder} from './artifacts.mjs';
import {runLimits} from './run-limits.mjs';
import {analysisFailure} from './analysis-failure.mjs';
import {MAX_ATTEMPTS} from './ala.mjs';
import {runReportLanguage} from '../web/report-languages.js';
export const TRACE_VERSION=1;
export const TRACE_LIMITS=Object.freeze({recordBytes:262144,parseBytes:1048576,eventDepth:64,eventValues:100000,traceBytes:67108864,keptFileBytes:8388608,keptBytes:67108864,keptFiles:2000,keptDepth:8,keptMs:10000,keptBoundMs:12000});
// Top-level entries of the work folder left out of the kept copy: bulky or derivable elsewhere.
export const KEEP_EXCLUDED=Object.freeze(['skills','validation','sources','input.json','evidence-lines.json']);
const EVENT_PREFIX='@@ALA_EVENT@@';
const PROCESS_STARTED=new Date(Math.round(performance.timeOrigin)).toISOString();
// macOS: refuse a symbolic link in any component of the opened path (see safe-files.mjs).
const O_NOFOLLOW_ANY=0x20000000;
const ID=/^[a-zA-Z0-9_-]+$/;
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const traceEnabled=(env=process.env)=>env?.DEEP_PROOF_TRACE==='1';
export function traceFolder(dir,pid,rid){
 if(typeof rid!=='string'||!ID.test(rid))throw Error('Invalid artifact identifier.');
 return path.join(projectFolder(path.resolve(dir),pid),'traces',rid);
}
// Clips text to a byte bound without splitting a character; null when nothing is cut.
function clip(text,limit){
 const bytes=Buffer.byteLength(text);if(bytes<=limit)return null;
 const buffer=Buffer.from(text);let end=limit;while(end>0&&(buffer[end]&0xc0)===0x80)end--;
 return {text:buffer.subarray(0,end).toString('utf8'),originalBytes:bytes};
}
// Clips every string at any depth of a value. A value with nothing to cut is returned as it is, so its record keeps
// its exact shape and key order. Copies keep every key as an ordinary own property, __proto__ included. Past the
// depth or value bound the walk stops with TOO_COMPLEX, so a hostile event cannot make it expensive.
const TOO_COMPLEX=Symbol('too complex');
function clipDeep(value,cuts,trail,budget){
 if(++budget.values>budget.limit||trail.length>TRACE_LIMITS.eventDepth)throw TOO_COMPLEX;
 if(typeof value==='string'){const cut=clip(value,TRACE_LIMITS.recordBytes);if(!cut)return value;cuts.push({path:[...trail],originalBytes:cut.originalBytes});return cut.text;}
 if(!value||typeof value!=='object')return value;
 const list=Array.isArray(value),keys=list?value.map((_,i)=>i):Object.keys(value),kept=[];let changed=false;
 for(const key of keys){trail.push(key);const item=value[key],next=clipDeep(item,cuts,trail,budget);trail.pop();kept.push(next);if(next!==item)changed=true;}
 if(!changed)return value;if(list)return kept;
 const out={};keys.forEach((key,i)=>Object.defineProperty(out,key,{value:kept[i],enumerable:true,writable:true,configurable:true}));return out;
}
const clipStrings=fields=>clipDeep(fields||{},[],[],{values:0,limit:Infinity});
// Text of a value that is not a string: JSON where possible.
const asText=value=>{if(typeof value==='string')return value;try{const text=JSON.stringify(value);if(typeof text==='string')return text;}catch{}try{return String(value);}catch{return 'Unprintable value';}};
function openTraceFile(folder){
 const file=path.join(folder,'trace.jsonl'),darwin=process.platform==='darwin';
 const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_APPEND|(darwin?O_NOFOLLOW_ANY:fs.constants.O_NOFOLLOW),0o600);
 try{
  if(process.platform==='linux'&&fs.realpathSync(`/proc/self/fd/${fd}`)!==file)throw Error('The trace file resolved outside its folder.');
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw Error('The trace file must be a new regular file.');
  return fd;
 }catch(error){fs.closeSync(fd);throw error;}
}
// Returns null when the trace is off or cannot be opened; never throws.
// keepBoundMs and io (file-system calls of the copy) are injected by tests only.
export function createRunTrace({dir,pid,rid,env=process.env,now=Date.now,serverPid=process.pid,serverStartedAt=PROCESS_STARTED,log=line=>console.error(line),keepBoundMs=TRACE_LIMITS.keptBoundMs,io={}}={}){
 const report=error=>{try{log(`[Deep Proof] Process trace disabled for run ${rid}: ${error?.message||error}`);}catch{}};
 try{
  if(!traceEnabled(env))return null;
  const folder=traceFolder(dir,pid,rid);
  safeDirectory(projectFolder(path.resolve(dir),pid),path.join('traces',rid));
  return tracer({folder,fd:openTraceFile(folder),pid,rid,env,now,serverPid,serverStartedAt,report,keepBoundMs,io:{readdir:fsp.readdir,lstat:fsp.lstat,mkdir:fsp.mkdir,writeFile:fsp.writeFile,...io}});
 }catch(error){report(error);return null;}
}
function tracer({folder,fd,pid,rid,env,now,serverPid,serverStartedAt,report,keepBoundMs,io}){
 let seq=0,size=0,closed=false,disabled=false,ended=false,limitReached=false,dropped=0,createdAt=null,lastProgress=null;
 function fail(error){
  if(closed)return;closed=true;disabled=true;
  try{fs.closeSync(fd);}catch{}
  report(error);
 }
 // One record, one write call. fields may be a function of the record's time, read once per record.
 function write(type,fields,{ala=false}={}){
  if(closed)return;
  if(ala&&limitReached){dropped++;return;}
  try{
   const at=now(),body=typeof fields==='function'?fields(at):fields;
   const line=Buffer.from(JSON.stringify({seq:seq+1,at:new Date(at).toISOString(),type,...body})+'\n');
   if(ala&&size+line.length>TRACE_LIMITS.traceBytes){limitReached=true;dropped++;write('trace-limit',{traceBytes:TRACE_LIMITS.traceBytes});return;}
   if(fs.writeSync(fd,line)!==line.length)throw Error('A trace record was written only in part.');
   seq++;size+=line.length;
  }catch(error){fail(error);}
 }
 const guard=fn=>{try{if(!closed)fn();}catch(error){fail(error);}};
 function shape(type,fields){
  if(type!=='validation')return clipStrings(fields);
  const errors=Array.isArray(fields?.errors)?fields.errors:[];
  return {attempt:fields?.attempt,valid:!!fields?.valid,errorCount:errors.length,errors:errors.slice(0,100).map(error=>asText(error).slice(0,2000))};
 }
 // run is shared with keepWorkspace: once it is abandoned at the hard bound, the copy stops at its next step and
 // writes nothing more (live() throws ABANDONED after every wait). It only ever creates files below the trace folder.
 const ABANDONED=Symbol('abandoned');
 async function copyWorkspace(workspace,run){
  const started=run.started=now(),base=path.resolve(workspace),target=path.join(folder,'workspace');
  const state=run.state={files:0,bytes:0,skippedCount:0,skipped:[],excluded:[],complete:true,stopped:false};
  const live=()=>{if(run.abandoned)throw ABANDONED;};
  const skip=(name,reason)=>{state.skippedCount++;if(state.skipped.length<50)state.skipped.push({name,reason});};
  const stop=(name,reason)=>{state.complete=false;state.stopped=true;skip(name,reason);};
  // Agent-writable tree: links, second names and anything but a regular file are never read; the read itself
  // refuses a link in any component. The deadline is checked between files, so the copy yields and stays bounded.
  async function visit(rel,depth){
   const entries=(await io.readdir(rel?path.join(base,rel):base,{withFileTypes:true})).map(entry=>entry.name).sort();live();
   for(const entry of entries){
    if(state.stopped)return;
    const name=run.current=rel?rel+'/'+entry:entry;
    if(!rel&&KEEP_EXCLUDED.includes(entry)){state.excluded.push(entry);continue;}
    if(now()-started>TRACE_LIMITS.keptMs)return stop(name,'time');
    let stat;try{stat=await io.lstat(path.join(base,name));}catch{live();skip(name,'unreadable');continue;}live();
    if(stat.isSymbolicLink()){skip(name,'link');continue;}
    if(stat.isDirectory()){
     if(depth>=TRACE_LIMITS.keptDepth){state.complete=false;skip(name,'depth');continue;}
     await io.mkdir(path.join(target,name),{mode:0o700});live();await visit(name,depth+1);continue;
    }
    if(!stat.isFile()){skip(name,'not-regular');continue;}
    if(stat.nlink!==1){skip(name,'hard-link');continue;}
    if(stat.size>TRACE_LIMITS.keptFileBytes){skip(name,'too-large');continue;}
    if(state.files>=TRACE_LIMITS.keptFiles)return stop(name,'file-limit');
    if(state.bytes+stat.size>TRACE_LIMITS.keptBytes)return stop(name,'byte-limit');
    let bytes;try{bytes=readArtifact(base,name,TRACE_LIMITS.keptFileBytes);}catch{skip(name,'unreadable');continue;}
    if(state.bytes+bytes.length>TRACE_LIMITS.keptBytes)return stop(name,'byte-limit');
    await io.writeFile(path.join(target,name),bytes,{flag:'wx',mode:0o600});live();
    state.files++;state.bytes+=bytes.length;
   }
  }
  try{
   safePath(folder,'workspace',{missing:true});await io.mkdir(target,{mode:0o700});live();safePath(folder,'workspace');
   await visit('',1);live();
  }catch(error){if(error===ABANDONED||run.abandoned)return;return write('workspace-keep-failed',{message:String(error?.message||error).slice(0,2000)});}
  write('workspace-kept',{files:state.files,bytes:state.bytes,skippedCount:state.skippedCount,skipped:state.skipped,excluded:state.excluded,complete:state.complete,durationMs:now()-started});
 }
 return {
  get disabled(){return disabled;},
  runStart({snapshot,createdAt:created}={}){guard(()=>{
   const s=snapshot||{},type=s.type||{},settings=s.settings||{},agent=settings.agent??null,kind=s.kind==='quality'?'quality':'analysis',limits=runLimits('analysis',s,env);
   createdAt=created??null;
   write('run-start',clipStrings({schema:'deep-proof-trace',version:TRACE_VERSION,runId:rid,projectId:pid,projectName:s.project?.company??null,kind,createdAt,
    title:kind==='quality'?s.sourceReport?.title??null:null,
    sourceReport:s.sourceReport?{id:s.sourceReport.id??null,kind:s.sourceReport.kind??null,title:s.sourceReport.title??null,documentId:s.sourceReport.documentId??null}:null,
    skill:{id:type.id??null,name:type.name??null,revision:type.skill_revision??null,methodologyRevision:type.methodology_revision??null,verification:s.verification?.status??null},
    agent,model:settings.models?.[agent]??null,effort:settings.efforts?.[agent]??null,reportLanguage:runReportLanguage(s).code,
    timeLimitMinutes:s.timeLimitMinutes??null,workMs:limits.workMs,wrapUpMs:limits.wrapUpMs,maxAttempts:MAX_ATTEMPTS,
    qualityOptions:s.qualityOptions?{depth:s.qualityOptions.depth??null,researchMode:s.qualityOptions.researchMode??null}:null,
    documents:(s.documents||[]).map(d=>{const bytes=Buffer.from(String(d.markdown??''),'utf8');return {id:d.id,title:d.title??null,fileType:d.file_type||'md',originalName:d.original_name??null,bytes:bytes.length,sha256:sha256(bytes)};}),
    runFolder:`projects/${pid}/analyses/${rid}`,server:{pid:serverPid,startedAt:serverStartedAt},limits:{recordBytes:TRACE_LIMITS.recordBytes,traceBytes:TRACE_LIMITS.traceBytes}}));
  });},
  record(type,fields){guard(()=>write(String(type),shape(type,fields)));},
  turnStart({turn,resume,sessionId,prompt,remainingMs}={}){guard(()=>{
   const label=String(turn),match=/^(\d+)(-continue\d+)?$/.exec(label),attempt=match?Number(match[1]):label,bytes=Buffer.from(String(prompt??''),'utf8');
   write('turn-start',{turn:label,attempt,repair:typeof attempt==='number'&&attempt>1,continuation:!!match?.[2],resume:!!resume,sessionId:sessionId??null,taskFile:`task-${label}.txt`,promptBytes:bytes.length,promptSha256:sha256(bytes),remainingMs});
  });},
  alaLine(turn,line){guard(()=>{
   if(typeof line!=='string'||!line.trim())return;
   const label=String(turn),bytes=Buffer.byteLength(line);
   if(bytes>TRACE_LIMITS.parseBytes)return write('ala-stderr',{turn:label,text:clip(line,TRACE_LIMITS.recordBytes).text,truncated:{originalBytes:bytes}},{ala:true});
   if(line.startsWith(EVENT_PREFIX)){
    let event;try{event=JSON.parse(line.slice(EVENT_PREFIX.length));}catch{}
    if(event&&typeof event==='object'&&!Array.isArray(event)){
     // Strings are clipped at any depth. truncated names the largest cut: field is its top-level key; path (only
     // for a nested string) leads to it from the event; clippedStrings (only when more than one) counts the cuts.
     // An event too deep or too large to walk is stored as text below.
     const cuts=[];let kept=null;try{kept=clipDeep(event,cuts,[],{values:0,limit:TRACE_LIMITS.eventValues});}catch(error){if(error!==TOO_COMPLEX)throw error;}
     if(kept){
      let truncated=null;
      if(cuts.length){const largest=cuts.reduce((a,b)=>b.originalBytes>a.originalBytes?b:a);truncated={field:String(largest.path[0]),originalBytes:largest.originalBytes,...(largest.path.length>1?{path:largest.path}:{}),...(cuts.length>1?{clippedStrings:cuts.length}:{})};}
      return write('ala-event',{turn:label,event:kept,...(truncated?{truncated}:{})},{ala:true});
     }
    }
   }
   const cut=clip(line,TRACE_LIMITS.recordBytes);
   write('ala-stderr',{turn:label,text:cut?cut.text:line,...(cut?{truncated:{originalBytes:cut.originalBytes}}:{})},{ala:true});
  });},
  // Called with the current progress.md text on every look; only a change is recorded.
  progress(turn,text){guard(()=>{
   const value=String(text??'').trim();if(!value||value===lastProgress)return;lastProgress=value;
   const blocks=value.split(/\n---\s*\n/).map(block=>block.trim()).filter(Boolean);
   write('progress-note',{turn:String(turn),text:(blocks.at(-1)||'').slice(0,1800),blocks:blocks.length});
  });},
  turnEnd({turn,outcome,exitCode,signal,durationMs,error}={}){guard(()=>{
   const message=error?String(error):'';
   write('turn-end',{turn:String(turn),outcome,exitCode:Number.isInteger(exitCode)?exitCode:null,signal:signal??null,durationMs,...(message?{error:message.length>3000?message.slice(-3000):message}:{})});
  });},
  // Written once, after the database update; closes the trace. A null outcome means the final state could not be stored.
  runEnd(outcome){guard(()=>{
   if(ended)return;ended=true;
   const completed=outcome?.status==='completed',result=completed?outcome.result||{}:null;
   const message=completed?null:outcome?.status==='failed'?String(outcome.error?.message??outcome.error??''):'Deep Proof could not store the final state of this run.';
   write('run-end',at=>({status:completed?'completed':'failed',timeLimited:!!(result?.timeLimited||result?.partial),partial:!!result?.partial,
    failureCode:completed?null:analysisFailure(message).code,error:completed?null:message.slice(0,12000),
    quality:result?.quality?{completion:result.quality.completion??null,confirmedFindings:result.quality.confirmedFindings??null}:null,
    droppedAlaLines:dropped,durationMs:createdAt&&Number.isFinite(Date.parse(createdAt))?at-Date.parse(createdAt):null}));
   if(!closed){closed=true;try{fs.closeSync(fd);}catch{}}
  });},
  // Copies the work folder into traces/<rid>/workspace/ before it is removed. Never rejects, and settles by the hard
  // bound whatever the copy is doing: a file-system call that never returns cannot hold up the removal or the run.
  keepWorkspace(workspace){
   if(closed)return Promise.resolve();
   const run={abandoned:false,started:null,state:null,current:null};
   return new Promise(resolve=>{
    const timer=setTimeout(()=>{
     run.abandoned=true;
     try{
      const s=run.state;
      if(!s)write('workspace-keep-failed',{message:`The copy did not finish within ${keepBoundMs} ms.`});
      else write('workspace-kept',{files:s.files,bytes:s.bytes,skippedCount:s.skippedCount+1,skipped:s.skipped.length<50?[...s.skipped,{name:run.current??'.',reason:'time'}]:s.skipped,excluded:s.excluded,complete:false,durationMs:now()-run.started});
     }catch{}
     resolve();
    },keepBoundMs);
    copyWorkspace(workspace,run).catch(error=>{if(!run.abandoned)write('workspace-keep-failed',{message:String(error?.message||error).slice(0,2000)});}).catch(()=>{}).then(()=>{if(!run.abandoned){clearTimeout(timer);resolve();}});
   });
  }
 };
}
const isString=v=>typeof v==='string',isInteger=Number.isInteger,isNumber=v=>typeof v==='number'&&Number.isFinite(v),isBoolean=v=>typeof v==='boolean';
const isObject=v=>!!v&&typeof v==='object'&&!Array.isArray(v),orNull=check=>v=>v===null||check(v),oneOf=(...values)=>v=>values.includes(v);
const RECORDS={
 'run-start':{schema:oneOf('deep-proof-trace'),version:oneOf(TRACE_VERSION),runId:isString,projectId:isString,projectName:orNull(isString),kind:oneOf('analysis','quality'),createdAt:orNull(isString),title:orNull(isString),sourceReport:orNull(isObject),skill:isObject,agent:orNull(isString),model:orNull(isString),effort:orNull(isString),reportLanguage:isString,timeLimitMinutes:orNull(isNumber),workMs:isInteger,wrapUpMs:isInteger,maxAttempts:isInteger,qualityOptions:orNull(isObject),documents:v=>Array.isArray(v)&&v.every(d=>isObject(d)&&isInteger(d.bytes)&&/^[0-9a-f]{64}$/.test(d.sha256)),runFolder:isString,server:isObject,limits:isObject},
 'workspace-created':{path:isString},
 'turn-start':{turn:isString,attempt:v=>isInteger(v)||v==='wrapup',repair:isBoolean,continuation:isBoolean,resume:isBoolean,sessionId:orNull(isString),taskFile:isString,promptBytes:isInteger,promptSha256:v=>/^[0-9a-f]{64}$/.test(v),remainingMs:isNumber},
 'ala-event':{turn:isString,event:isObject,'truncated?':v=>isObject(v)&&isString(v.field)&&isInteger(v.originalBytes)&&(v.path===undefined||Array.isArray(v.path)&&v.path.length>1&&String(v.path[0])===v.field&&v.path.every(p=>isString(p)||isInteger(p)))&&(v.clippedStrings===undefined||isInteger(v.clippedStrings)&&v.clippedStrings>1)},
 'ala-stderr':{turn:isString,text:isString,'truncated?':v=>isObject(v)&&isInteger(v.originalBytes)},
 'reminder-sent':{turn:isString,id:isString},
 'progress-note':{turn:isString,text:v=>isString(v)&&v.length<=1800,blocks:isInteger},
 'turn-end':{turn:isString,outcome:oneOf('exited','time_limit','spawn_error'),exitCode:orNull(isInteger),signal:orNull(isString),durationMs:isNumber,'error?':v=>isString(v)&&v.length<=3000},
 'continuation':{attempt:isInteger,reason:oneOf('empty_response'),used:isInteger},
 'validation':{attempt:v=>isInteger(v)||v==='wrapup',valid:isBoolean,errorCount:isInteger,errors:v=>Array.isArray(v)&&v.length<=100&&v.every(e=>isString(e)&&e.length<=2000)},
 'time-limit':{elapsedMs:isNumber,workMs:isNumber},
 'wrap-up':{phase:oneOf('start','validated','not-validated'),'remainingMs?':isNumber},
 'published':{what:oneOf('report','check-report','time-limit-notes'),timeLimited:isBoolean},
 'workspace-kept':{files:isInteger,bytes:isInteger,skippedCount:isInteger,skipped:v=>Array.isArray(v)&&v.length<=50&&v.every(s=>isObject(s)&&isString(s.name)&&isString(s.reason)),excluded:v=>Array.isArray(v)&&v.every(isString),complete:isBoolean,durationMs:isNumber},
 'workspace-keep-failed':{message:isString},
 'trace-limit':{traceBytes:isInteger},
 'run-end':{status:oneOf('completed','failed'),timeLimited:isBoolean,partial:isBoolean,failureCode:orNull(oneOf('empty_response','interrupted','timeout','validation','access','engine','unexpected')),error:orNull(v=>isString(v)&&v.length<=12000),quality:orNull(isObject),droppedAlaLines:isInteger,durationMs:orNull(isNumber)}
};
// Checks one parsed record against version 1. Returns the record or throws with the reason. Used by tests.
export function validateTraceRecord(record){
 const bad=reason=>{throw Error(`Invalid trace record${isInteger(record?.seq)?' '+record.seq:''}: ${reason}`);};
 if(!isObject(record))bad('not an object');
 if(!isInteger(record.seq)||record.seq<1)bad('seq must be an integer from 1');
 if(!isString(record.at)||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.at)||new Date(record.at).toISOString()!==record.at)bad('at must be an ISO 8601 UTC time with milliseconds');
 const fields=RECORDS[record.type];if(!fields)bad(`unknown type ${JSON.stringify(record.type)}`);
 if(record.type==='run-start'&&record.seq!==1)bad('run-start must be record 1');
 const known=new Set(['seq','at','type']);
 for(const [spec,check] of Object.entries(fields)){
  const optional=spec.endsWith('?'),name=optional?spec.slice(0,-1):spec;known.add(name);
  if(!(name in record)){if(optional)continue;bad(`${record.type} needs ${name}`);}
  if(!check(record[name]))bad(`${record.type} has an invalid ${name}`);
 }
 for(const name of Object.keys(record))if(!known.has(name))bad(`${record.type} has an unknown field ${name}`);
 // Every string at any depth stays within the record bound.
 const pending=[record];let values=0;
 while(pending.length){
  const value=pending.pop();if(++values>10*TRACE_LIMITS.eventValues)bad('too many values');
  if(isString(value)){if(Buffer.byteLength(value)>TRACE_LIMITS.recordBytes)bad('a string exceeds the record bound');}
  else if(value&&typeof value==='object')for(const key of Object.keys(value))pending.push(value[key]);
 }
 return record;
}
