import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {invokeALA} from '../src/ala.mjs';
import {publishTimeLimited,progressNotes} from '../src/partial-result.mjs';
import {createRunTrace,traceFolder,validateTraceRecord} from '../src/trace.mjs';

// No model is started here. The stand-in for ALA below is a test fixture passed as settings.alaPath, never a
// simulated agent in application execution. An exported ALA_CLI would outrank it and reach the real ALA.
assert.equal(process.env.ALA_CLI,undefined,'unset ALA_CLI before running the trace run tests');
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
