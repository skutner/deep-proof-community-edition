import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {invokeALA} from '../src/ala.mjs';
import {publishTimeLimited,progressNotes} from '../src/partial-result.mjs';
import {createRunTrace,traceFolder,validateTraceRecord,KEEP_EXCLUDED} from '../src/trace.mjs';
import {createHash} from 'node:crypto';
import {createApp} from '../server.mjs';
import {openStore} from '../src/store.mjs';
import {analysisFolder,projectFolder,writeAnalysisSources} from '../src/artifacts.mjs';
import {writeArtifact} from '../src/safe-files.mjs';
import {analysisFailure} from '../src/analysis-failure.mjs';
import {QUALITY_SKILL_ID} from '../src/report-quality.mjs';
import {testCatalog} from './support/catalog.mjs';

// No model is started here. The stand-in for ALA below is a test fixture passed as settings.alaPath, never a
// simulated agent in application execution. An ALA_CLI set while a test runs would outrank it and reach the real
// ALA, so every test checks first (inside the test: other files in the same process may set and restore it).
const noALA=()=>assert.equal(process.env.ALA_CLI,undefined,'unset ALA_CLI before running the trace run tests');
const root=path.resolve(import.meta.dirname,'..'),ON={DEEP_PROOF_TRACE:'1'};
const fixture=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/revenue-review.json'),'utf8'));
const temporary=(t,prefix)=>{const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),prefix));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
// A minimal stand-in for ALA: a folder that ALA's location check accepts, whose bin/ala.mjs is the given script.
function fakeALA(dir,script){
 const ala=path.join(dir,'fake-ala');fs.mkdirSync(path.join(ala,'bin'),{recursive:true});fs.mkdirSync(path.join(ala,'src/coding-agents'),{recursive:true});
 fs.writeFileSync(path.join(ala,'package.json'),JSON.stringify({name:'advanced-language-agent'}));fs.writeFileSync(path.join(ala,'src/coding-agents/discovery.mjs'),'');
 fs.writeFileSync(path.join(ala,'bin/ala.mjs'),`import fs from 'node:fs';const a=process.argv.slice(2),val=f=>a[a.indexOf(f)+1],cwd=val('--cwd'),resume=a.includes('--resume-session');\n${script}`);
 return ala;
}
// Every record must pass the version 1 validator, with seq counting from 1 without a gap.
function readTrace(file){
 const text=fs.readFileSync(file,'utf8');assert.ok(text.endsWith('\n'));
 const records=text.slice(0,-1).split('\n').map(line=>validateTraceRecord(JSON.parse(line)));
 records.forEach((record,i)=>assert.equal(record.seq,i+1));
 return records;
}
const hostSteps=records=>records.filter(r=>!r.type.startsWith('ala-'));
async function tracedInvoke(t,prefix,script,{env={}}={}){
 const dir=temporary(t,prefix),ala=fakeALA(dir,script),job=path.join(dir,'job'),snapshot={...fixture.snapshot,report_language:'ro'};
 const trace=createRunTrace({dir,pid:'p1',rid:'r1',env:ON});trace.runStart({snapshot,createdAt:new Date().toISOString()});
 const saved={...process.env};Object.assign(process.env,env);let result,failure;
 try{result=await invokeALA({root,dir:job,settings:{agent:'codex',models:{},efforts:{},alaPath:ala},input:snapshot,prompt:'Review the dossier.',artifactDir:dir,trace});}catch(error){failure=error;}
 finally{for(const key of Object.keys(env))if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
 return {dir,job,snapshot,trace,result,failure,file:path.join(traceFolder(dir,'p1','r1'),'trace.jsonl')};
}

test('time limit: turn, kill, wrap-up and notes are traced in order (fake ALA, no model)',async t=>{
 noALA();
 // The first turn records a note and hangs until the limit kills it; the resumed wrap-up turn exits without a report.
 const run=await tracedInvoke(t,'trace-time-limit-',`fs.appendFileSync(cwd+'/fake-ala-calls.log',JSON.stringify({resume})+'\\n');
if(!resume){fs.writeFileSync(cwd+'/progress.md','Prima observație preliminară.\\n');setInterval(()=>{},1000);}`,{env:{DEEP_PROOF_WORK_MS:'2500',DEEP_PROOF_WRAPUP_MS:'4000'}});
 assert.equal(run.failure?.code,'TIME_LIMIT','the run ends at the limit without a validated report');
 // As the server does after the time limit: publish the notes, then end the run.
 const result=publishTimeLimited({folder:run.job,snapshot:run.snapshot,progress:progressNotes(run.job)});run.trace.record('published',{what:'time-limit-notes',timeLimited:true});run.trace.runEnd({status:'completed',result});
 const records=readTrace(run.file),steps=hostSteps(records);
 assert.deepEqual(steps.map(r=>r.type),['run-start','turn-start','progress-note','turn-end','time-limit','wrap-up','turn-start','turn-end','validation','wrap-up','published','run-end']);
 const [,first,note,killed,limit,wrapStart,wrapTurn,wrapEnd,validation,wrapResult,,end]=steps;
 assert.deepEqual([first.turn,first.attempt,first.repair,first.resume,first.taskFile],['1',1,false,false,'task-1.txt']);assert.ok(first.remainingMs<=2500&&first.remainingMs>0);
 assert.equal(note.text,'Prima observație preliminară.');assert.equal(note.turn,'1');
 assert.deepEqual([killed.turn,killed.outcome,killed.exitCode,killed.signal],['1','time_limit',null,'SIGKILL']);assert.match(killed.error,/time limit/);
 assert.equal(limit.workMs,2500);assert.ok(limit.elapsedMs>=2500);
 assert.deepEqual([wrapStart.phase,wrapStart.remainingMs],['start',4000]);
 assert.deepEqual([wrapTurn.turn,wrapTurn.attempt,wrapTurn.resume,wrapTurn.taskFile],['wrapup','wrapup',true,'task-wrapup.txt']);
 assert.equal(wrapTurn.promptSha256,(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(run.job,'task-wrapup.txt'))).digest('hex'),'the prompt hash is that of the task file');
 assert.deepEqual([wrapEnd.outcome,wrapEnd.exitCode],['exited',0]);assert.equal(wrapEnd.error,undefined);
 assert.deepEqual([validation.attempt,validation.valid],['wrapup',false]);assert.match(validation.errors[0],/report\.md is missing/);assert.equal(wrapResult.phase,'not-validated');
 assert.deepEqual([end.status,end.timeLimited,end.partial,end.failureCode],['completed',true,true,null]);
});

test('three failed validations are traced with their errors (fake ALA, no model)',async t=>{
 noALA();
 const run=await tracedInvoke(t,'trace-three-failures-',`process.stderr.write('stand-in: no report written\\n');`);
 assert.match(run.failure?.message||'',/could not validate the review after 3 attempts/);
 run.trace.runEnd({status:'failed',error:run.failure});
 const records=readTrace(run.file),steps=hostSteps(records);
 assert.deepEqual(steps.map(r=>r.type),['run-start',...Array(3).fill(['turn-start','turn-end','validation']).flat(),'run-end']);
 const turns=steps.filter(r=>r.type==='turn-start'),validations=steps.filter(r=>r.type==='validation');
 assert.deepEqual(turns.map(r=>[r.turn,r.attempt,r.repair,r.resume]),[['1',1,false,false],['2',2,true,true],['3',3,true,true]]);
 assert.deepEqual(validations.map(r=>[r.attempt,r.valid,r.errorCount]),[[1,false,1],[2,false,1],[3,false,1]]);
 for(const v of validations)assert.match(v.errors[0],/report\.md is missing/);
 assert.deepEqual(records.filter(r=>r.type==='ala-stderr').map(r=>[r.turn,r.text]),[['1','stand-in: no report written'],['2','stand-in: no report written'],['3','stand-in: no report written']]);
 assert.ok(steps.filter(r=>r.type==='turn-end').every(r=>r.outcome==='exited'&&r.exitCode===0&&r.signal===null));
 assert.deepEqual([steps.at(-1).status,steps.at(-1).failureCode],['failed','validation']);assert.match(steps.at(-1).error,/after 3 attempts/);
});

test('a repaired report is traced: validation failed, repair prompt, validation passed (fake ALA, no model)',async t=>{
 noALA();
 // The first turn reports its agent and writes nothing; the resumed repair turn copies the recorded report (as E29 does).
 const report=JSON.stringify(path.join(root,'tests/fixtures/revenue-review.md')),charts=JSON.stringify(path.join(root,'tests/fixtures/charts'));
 const run=await tracedInvoke(t,'trace-repaired-',`const event=e=>process.stderr.write('@@ALA_EVENT@@'+JSON.stringify(e)+'\\n');
if(!resume){event({type:'coding-agent-selected',agent:'codex',permissionMode:'full-access'});process.stderr.write('stand-in diagnostic\\n');}
else{fs.copyFileSync(${report},cwd+'/report.md');fs.cpSync(${charts},cwd+'/charts',{recursive:true});event({type:'coding-agent-final',agent:'codex',message:'Repaired.'});}`);
 assert.equal(run.failure,undefined,run.failure?.message);assert.equal(run.result.sections.length,9);
 run.trace.runEnd({status:'completed',result:{format:'markdown'}});
 const records=readTrace(run.file);
 assert.deepEqual(records.map(r=>r.type),['run-start','turn-start','ala-event','ala-stderr','turn-end','validation','turn-start','ala-event','turn-end','validation','run-end']);
 assert.deepEqual([records[2].turn,records[2].event],['1',{type:'coding-agent-selected',agent:'codex',permissionMode:'full-access'}]);assert.deepEqual([records[3].turn,records[3].text],['1','stand-in diagnostic']);
 assert.deepEqual([records[5].attempt,records[5].valid],[1,false]);assert.ok(records[5].errorCount>=1);
 assert.deepEqual([records[6].turn,records[6].repair,records[6].resume],['2',true,true]);assert.ok(fs.readFileSync(path.join(run.job,'task-2.txt'),'utf8').includes('did not pass the application validator'));
 assert.deepEqual([records[7].turn,records[7].event.type],['2','coding-agent-final']);
 assert.deepEqual([records[9].attempt,records[9].valid,records[9].errorCount,records[9].errors],[2,true,0,[]]);
 assert.deepEqual([records[10].status,records[10].timeLimited,records[10].failureCode],['completed',false,null]);
});

// Server level. The stand-in only notes its work folder (outside the run) and exits non-zero, so the check fails.
const failingALA=dir=>fakeALA(dir,`fs.appendFileSync(${JSON.stringify(path.join(dir,'work-folders.log'))},cwd+'\\n');process.exitCode=3;`);
const workFolders=dir=>fs.readFileSync(path.join(dir,'work-folders.log'),'utf8').trim().split('\n');
const tree=(root,rel='')=>fs.readdirSync(path.join(root,rel),{withFileTypes:true}).flatMap(e=>{const name=rel?rel+'/'+e.name:e.name;return e.isDirectory()?[name+'/',...tree(root,name)]:[name];}).sort();
async function startApp(t,dir,env,ala){
 // A saved ALA location is required: without one, an ALA checkout beside the application would be adopted.
 if(ala){const store=openStore(dir);store.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({agent:'codex',models:{codex:'gpt-6-luna'},efforts:{},alaPath:ala}));store.close();}
 const app=createApp({dir,catalog:testCatalog(),env});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 let closed=false;const close=async()=>{if(closed)return;closed=true;app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.db.close();};t.after(close);
 const base=`http://127.0.0.1:${app.server.address().port}/api`;
 const call=async(url,data,cookie='')=>{const response=await fetch(base+url,{method:data?'POST':'GET',headers:{'content-type':'application/json',cookie},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const admin=(await call('/login',{username:'admin',password:'admin'})).cookie;
 return {...app,base,call,admin,close};
}
const REPORT='# Outside Report\n\nRevenue in 2025 was EUR 12 million.\n';
async function importReport(app,pid){const imported=await app.call(`/projects/${pid}/report-imports`,{title:'Outside Report',file:{name:'outside.md',data:Buffer.from(REPORT).toString('base64')},report_language:'en'},app.admin);assert.equal(imported.status,201);return imported.data.id;}
async function startCheck(app,pid,source){const check=await app.call(`/projects/${pid}/analyses`,{sourceReportId:source},app.admin);assert.equal(check.status,202,JSON.stringify(check.data));return check.data.id;}
// Waits until the run row is no longer running and, with a trace, until run-end (written after the update) is there.
async function settle(app,rid,file){
 const until=Date.now()+30000;
 while(Date.now()<until){const row=app.db.prepare('SELECT status FROM runs WHERE id=?').get(rid);if(row.status!=='running'&&(!file||(fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes('"type":"run-end"'))))break;await new Promise(r=>setTimeout(r,50));}
 await new Promise(r=>setTimeout(r,100));
 assert.notEqual(app.db.prepare('SELECT status FROM runs WHERE id=?').get(rid).status,'running','the run must end');
}
async function runState(app,dir,pid,rid){
 const row=app.db.prepare('SELECT status,result,error,snapshot FROM runs WHERE id=?').get(rid),folder=analysisFolder(dir,pid,rid);
 const files=Object.fromEntries(tree(folder).map(name=>[name,name.endsWith('/')?null:fs.readFileSync(path.join(folder,name),'utf8')]));
 const omit=({id,created_at,...rest})=>rest;
 const detail=await app.call(`/projects/${pid}/analyses/${rid}`,null,app.admin),list=await app.call(`/projects/${pid}/analyses`,null,app.admin);
 return {row,files,detail:{status:detail.status,data:omit(detail.data)},entry:omit(list.data.find(r=>r.id===rid))};
}

test('a failing Check Report records its work folder, keeps a copy and removes the folder (fake ALA, no model)',async t=>{
 noALA();
 const dir=temporary(t,'trace-check-'),app=await startApp(t,dir,ON,failingALA(dir));
 const pid=(await app.call('/projects',{company:'Traced Check'},app.admin)).data.id,source=await importReport(app,pid),rid=await startCheck(app,pid,source);
 const file=path.join(traceFolder(dir,pid,rid),'trace.jsonl');await settle(app,rid,file);
 const row=app.db.prepare('SELECT status,error FROM runs WHERE id=?').get(rid);assert.equal(row.status,'failed');assert.match(row.error,/exited with code 3/);
 const records=readTrace(file),steps=hostSteps(records);
 assert.deepEqual(steps.map(r=>r.type),['run-start','workspace-created','turn-start','turn-end','workspace-kept','run-end']);
 const [start,created,turn,ended,kept,end]=steps;
 assert.deepEqual([start.runId,start.projectId,start.projectName,start.kind,start.title,start.sourceReport.id,start.skill.id,start.runFolder],[rid,pid,'Traced Check','quality','Outside Report',source,QUALITY_SKILL_ID,`projects/${pid}/analyses/${rid}`]);
 assert.equal(start.documents[0].sha256,createHash('sha256').update(REPORT).digest('hex'),'documents are hashed as their Markdown bytes');assert.equal(start.server.pid,process.pid);
 // The work folder: the one the stand-in ran in, made by mkdtemp in the real temporary folder, now removed.
 assert.match(created.path,/\/deep-proof-verification-[A-Za-z0-9]{6}$/);assert.equal(path.dirname(created.path),fs.realpathSync(os.tmpdir()));
 assert.deepEqual(workFolders(dir),[created.path]);assert.equal(fs.existsSync(created.path),false,'the work folder is removed as before');
 assert.deepEqual([turn.turn,turn.resume,ended.outcome,ended.exitCode],['1',false,'exited',3]);
 assert.equal(kept.complete,true);assert.deepEqual(kept.excluded,[...KEEP_EXCLUDED].sort());
 const copy=tree(path.join(traceFolder(dir,pid,rid),'workspace'));
 for(const name of ['task.txt','task-1.txt','config.json','output-contract.json','quality-input/'])assert.ok(copy.includes(name),name);
 for(const name of KEEP_EXCLUDED)assert.ok(!copy.includes(name)&&!copy.includes(name+'/'),name);assert.equal(kept.files,copy.filter(name=>!name.endsWith('/')).length);
 assert.deepEqual([end.status,end.error,end.failureCode,end.timeLimited],['failed',row.error,analysisFailure(row.error).code,false]);
 // Nothing of the trace reaches the run's API answer.
 const answer=JSON.stringify((await app.call(`/projects/${pid}/analyses/${rid}`,null,app.admin)).data);for(const text of ['trace.jsonl','traces/','"seq":','workspace-kept',created.path])assert.ok(!answer.includes(text),text);
 await app.close();
});

test('with the trace off the same failing Check Report leaves no traces folder (fake ALA, no model)',async t=>{
 noALA();
 const dir=temporary(t,'trace-check-off-'),app=await startApp(t,dir,{},failingALA(dir));
 const pid=(await app.call('/projects',{company:'Untraced Check'},app.admin)).data.id,rid=await startCheck(app,pid,await importReport(app,pid));await settle(app,rid);
 const row=app.db.prepare('SELECT status,error FROM runs WHERE id=?').get(rid);assert.equal(row.status,'failed');assert.match(row.error,/exited with code 3/);
 assert.equal(fs.existsSync(path.join(projectFolder(dir,pid),'traces')),false,'no traces folder');
 const [work]=workFolders(dir);assert.match(work,/deep-proof-verification-/);assert.equal(fs.existsSync(work),false,'the work folder is removed');
 await app.close();
});

test('a trace that cannot be written leaves the run unchanged',async t=>{
 noALA();
 const dir=temporary(t,'trace-check-unwritable-'),ala=failingALA(dir);
 // The same failing Check Report twice in one project: first with the trace off, then with it on and its folder blocked.
 const off=await startApp(t,dir,{},ala),pid=(await off.call('/projects',{company:'Blocked Trace'},off.admin)).data.id,source=await importReport(off,pid);
 const first=await startCheck(off,pid,source);await settle(off,first);const before=await runState(off,dir,pid,first);await off.close();
 // A regular file named traces makes the folder impossible to create, for root as well.
 fs.writeFileSync(path.join(projectFolder(dir,pid),'traces'),'');
 const lines=[],error=console.error;console.error=(...parts)=>lines.push(parts.join(' '));
 let second,after;
 try{const on=await startApp(t,dir,ON);second=await startCheck(on,pid,source);await settle(on,second);after=await runState(on,dir,pid,second);await on.close();}finally{console.error=error;}
 // Each run of the built-in check freezes a fresh skill revision id, as it has a fresh run id; both are set aside.
 const revision=state=>JSON.parse(state.row.snapshot).type.skill_revision,same=JSON.parse(JSON.stringify(after).replaceAll(revision(after),revision(before)));
 assert.notEqual(revision(after),revision(before));assert.deepEqual(same,JSON.parse(JSON.stringify(before)),'the run row, the run folder and the API answers are those of the untraced run');
 assert.equal(after.row.status,'failed');assert.ok(fs.statSync(path.join(projectFolder(dir,pid),'traces')).isFile());assert.equal(fs.readFileSync(path.join(projectFolder(dir,pid),'traces'),'utf8'),'');
 assert.deepEqual(lines.filter(line=>line.includes('Process trace')).length,1);assert.match(lines.find(line=>line.includes('Process trace')),new RegExp(`disabled for run ${second}`));
 assert.equal(workFolders(dir).length,2);for(const work of workFolders(dir))assert.equal(fs.existsSync(work),false);
});

test('the verification bundle is the same with and without a traces folder, and a path into it is refused',async t=>{
 noALA();
 // The hand-built saved check of report-quality.test.mjs: recorded report content and hand-authored export metadata.
 const dir=temporary(t,'trace-bundle-'),app=await startApp(t,dir,ON,path.join(dir,'no-ala'));
 const pid=(await app.call('/projects',{company:'Export Transport'},app.admin)).data.id;
 const snapshot={...fixture.snapshot,project:{company:'Export Transport'},kind:'quality'},folder=analysisFolder(dir,pid,'export-test');writeAnalysisSources(folder,snapshot);fs.copyFileSync(path.join(root,'tests/fixtures/revenue-review.md'),path.join(folder,'report.md'));
 const payload=Buffer.from([0,128,255,10]),name='sources/transport.pdf';writeArtifact(folder,name,payload);writeArtifact(folder,'verification-index.json',JSON.stringify({files:[{name,sha256:createHash('sha256').update(payload).digest('hex')}]}));
 app.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run('export-test',pid,'2026-10-29','completed',JSON.stringify(snapshot),JSON.stringify({format:'markdown',quality:{completion:'incomplete',confirmedFindings:0}}),null);
 const url=`${app.base}/projects/${pid}/analyses/export-test/verification`,get=async query=>{const response=await fetch(url+query,{headers:{cookie:app.admin}});return {status:response.status,bytes:Buffer.from(await response.arrayBuffer())};};
 const bundle=await get(''),single=await get('?file='+encodeURIComponent(name));assert.equal(bundle.status,200);assert.deepEqual(single.bytes,payload);
 const traces=traceFolder(dir,pid,'export-test');fs.mkdirSync(path.join(traces,'workspace'),{recursive:true});fs.writeFileSync(path.join(traces,'trace.jsonl'),'{"seq":1}\n');fs.writeFileSync(path.join(traces,'workspace/report.md'),'draft');
 const withTraces=await get('');assert.equal(withTraces.status,200);assert.ok(withTraces.bytes.equals(bundle.bytes),'the bundle bytes do not change');assert.ok(!withTraces.bytes.toString().includes('trace'));
 for(const query of ['?file=../../traces/export-test/trace.jsonl','?file=../../traces/export-test/workspace/report.md','?file='+encodeURIComponent('../../traces/export-test/trace.jsonl')])assert.equal((await get(query)).status,404,query);
 await app.close();
});

// Runs fn with the time limits shortened in this process too: invokeALA reads them from the process environment.
async function withLimits(limits,fn){
 const saved={...process.env};Object.assign(process.env,limits);
 try{return await fn();}finally{for(const key of Object.keys(limits))if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
}
// The run state of two runs of the same request, with the run ids, the per-run skill revision ids and the times set aside.
function sameRun(after,before,ids){
 const revision=state=>JSON.parse(state.row.snapshot).type.skill_revision,times=text=>text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,'<time>');
 const plain=(state,rid)=>JSON.parse(times(JSON.stringify(state).replaceAll(revision(state),'<revision>').replaceAll(rid,'<run>')));
 return [plain(after,ids[1]),plain(before,ids[0])];
}

test('a time-limited Check Report is traced through the server and its run is the same with the trace off (fake ALA, no model)',async t=>{
 noALA();
 // The first turn records a note and hangs until the limit kills it; the resumed wrap-up turn exits without a report.
 const dir=temporary(t,'trace-check-limit-'),log=JSON.stringify(path.join(dir,'work-folders.log')),limits={DEEP_PROOF_WORK_MS:'2500',DEEP_PROOF_WRAPUP_MS:'3000'};
 const ala=fakeALA(dir,`fs.appendFileSync(${log},cwd+'\\n');if(!resume){fs.writeFileSync(cwd+'/progress.md','Prima observație preliminară.\\n');setInterval(()=>{},1000);}`);
 await withLimits(limits,async()=>{
  const off=await startApp(t,dir,{...limits},ala),pid=(await off.call('/projects',{company:'Time-Limited Check'},off.admin)).data.id,source=await importReport(off,pid);
  const first=await startCheck(off,pid,source);await settle(off,first);const before=await runState(off,dir,pid,first);await off.close();
  assert.equal(fs.existsSync(path.join(projectFolder(dir,pid),'traces')),false,'the untraced run writes no trace');
  const on=await startApp(t,dir,{...limits,...ON}),second=await startCheck(on,pid,source),file=path.join(traceFolder(dir,pid,second),'trace.jsonl');
  await settle(on,second,file);const after=await runState(on,dir,pid,second);await on.close();
  const [same,expected]=sameRun(after,before,[first,second]);assert.deepEqual(same,expected,'the run row, the run folder and the API answers are those of the untraced run');
  const result=JSON.parse(after.row.result);assert.equal(after.row.status,'completed');assert.deepEqual(result.partial,{reason:'time_limit'});assert.equal(result.quality.timeLimited,true);
  assert.match(after.files['report.md'],/Prima observație preliminară\./,'the notes are published');
  const records=readTrace(file),steps=hostSteps(records);
  assert.deepEqual(steps.map(r=>r.type),['run-start','workspace-created','turn-start','progress-note','turn-end','time-limit','wrap-up','turn-start','turn-end','validation','wrap-up','published','workspace-kept','run-end']);
  const get=(type,i=0)=>steps.filter(r=>r.type===type)[i];
  assert.deepEqual([get('run-start').workMs,get('run-start').wrapUpMs,get('time-limit').workMs],[2500,3000,2500],'run-start states the limits the run used');
  assert.deepEqual([get('turn-end').outcome,get('turn-end').signal,get('turn-start',1).turn,get('turn-start',1).resume],['time_limit','SIGKILL','wrapup',true]);
  assert.deepEqual([get('wrap-up').phase,get('wrap-up').remainingMs,get('wrap-up',1).phase,get('validation').attempt,get('validation').valid],['start',3000,'not-validated','wrapup',false]);
  assert.deepEqual([get('published').what,get('published').timeLimited],['time-limit-notes',true]);
  const created=get('workspace-created').path;assert.equal(fs.existsSync(created),false,'the work folder is removed');assert.equal(get('workspace-kept').complete,true);
  assert.ok(fs.readFileSync(path.join(traceFolder(dir,pid,second),'workspace/task-wrapup.txt'),'utf8').includes('THE TIME LIMIT HAS BEEN REACHED'),'the kept copy holds the wrap-up prompt');
  const end=get('run-end');assert.deepEqual([end.status,end.timeLimited,end.partial,end.failureCode,end.error,end.quality],['completed',true,true,null,null,{completion:'incomplete',confirmedFindings:0}]);
  for(const work of workFolders(dir))assert.equal(fs.existsSync(work),false);
 });
});

test('a completed analysis is traced through the server and its run is the same with the trace off (fake ALA, no model)',async t=>{
 noALA();
 // Recorded real model output (tests/fixtures/revenue-review.md and charts, as E29) is copied by the stand-in; the
 // Analyst Skill and the documents are the fixture's own, seeded before the server starts.
 const dir=temporary(t,'trace-analysis-'),report=JSON.stringify(path.join(root,'tests/fixtures/revenue-review.md')),charts=JSON.stringify(path.join(root,'tests/fixtures/charts'));
 const ala=fakeALA(dir,`fs.copyFileSync(${report},cwd+'/report.md');fs.cpSync(${charts},cwd+'/charts',{recursive:true});`);
 const store=openStore(dir);store.prepare('INSERT INTO types(id,name,criteria,playbook) VALUES(?,?,?,?)').run('revenue-review','Revenue Review',fixture.snapshot.type.criteria,fixture.snapshot.type.playbook);store.close();
 const analyse=async(app,pid)=>{const started=await app.call(`/projects/${pid}/analyses`,{skillId:'revenue-review'},app.admin);assert.equal(started.status,202,JSON.stringify(started.data));return started.data.id;};
 const off=await startApp(t,dir,{},ala),pid=(await off.call('/projects',{company:'Acceptance review'},off.admin)).data.id;
 for(const d of fixture.snapshot.documents)off.db.prepare('INSERT INTO documents(id,project_id,title,markdown) VALUES(?,?,?,?)').run(d.id,pid,d.title,d.markdown);
 const first=await analyse(off,pid);await settle(off,first);const before=await runState(off,dir,pid,first);await off.close();
 assert.equal(before.row.status,'completed',before.row.error);
 const on=await startApp(t,dir,ON),second=await analyse(on,pid),file=path.join(traceFolder(dir,pid,second),'trace.jsonl');
 await settle(on,second,file);const after=await runState(on,dir,pid,second);await on.close();
 const [same,expected]=sameRun(after,before,[first,second]);assert.deepEqual(same,expected,'the run row, the run folder and the API answers are those of the untraced run');
 assert.ok(!Object.keys(after.files).some(name=>/trace/.test(name)),'nothing of the trace is in the run folder, the agent\'s working folder');
 const records=readTrace(file),steps=hostSteps(records);
 assert.deepEqual(steps.map(r=>r.type),['run-start','turn-start','turn-end','validation','published','run-end']);
 const [start,turn,ended,validation,published,end]=steps;
 assert.deepEqual([start.kind,start.title,start.sourceReport,start.skill.id,start.documents.map(d=>d.id).sort()],['analysis',null,null,'revenue-review',['accounts','management']]);
 assert.deepEqual([turn.turn,turn.repair,ended.outcome,ended.exitCode,validation.attempt,validation.valid],['1',false,'exited',0,1,true]);
 assert.deepEqual([published.what,published.timeLimited],['report',false]);
 assert.deepEqual([end.status,end.timeLimited,end.partial,end.failureCode,end.quality],['completed',false,false,null,null]);
});
