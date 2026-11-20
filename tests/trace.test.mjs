import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRunTrace,traceEnabled,traceFolder,validateTraceRecord,TRACE_LIMITS,KEEP_EXCLUDED,TRACE_VERSION} from '../src/trace.mjs';
import {withQualityWorkspace} from '../src/quality-job.mjs';

// These tests never start ALA or a model. An exported ALA_CLI would not be used here, but fail loudly anyway.
assert.equal(process.env.ALA_CLI,undefined,'unset ALA_CLI before running the trace tests');
const ON={DEEP_PROOF_TRACE:'1'};
const temporary=(t,prefix)=>{const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),prefix));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
// Every record read back must pass the version 1 validator, with seq counting from 1 without a gap.
function readTrace(file){
 const text=fs.readFileSync(file,'utf8');assert.ok(text.endsWith('\n'),'every record ends with a newline');
 const records=text.slice(0,-1).split('\n').map(line=>validateTraceRecord(JSON.parse(line)));
 records.forEach((record,i)=>assert.equal(record.seq,i+1,'seq counts from 1 without a gap'));
 return records;
}
const traceFile=(dir,pid,rid)=>path.join(traceFolder(dir,pid,rid),'trace.jsonl');
const tree=(root,rel='')=>fs.readdirSync(path.join(root,rel),{withFileTypes:true}).flatMap(e=>{const name=rel?rel+'/'+e.name:e.name;return e.isDirectory()?[name+'/',...tree(root,name)]:[name];}).sort();

test('trace is off unless DEEP_PROOF_TRACE is exactly 1, and then nothing is created',t=>{
 const dir=temporary(t,'trace-off-'),lines=[];
 for(const env of [{},{DEEP_PROOF_TRACE:''},{DEEP_PROOF_TRACE:'0'},{DEEP_PROOF_TRACE:'true'},{DEEP_PROOF_TRACE:' 1'},{DEEP_PROOF_TRACE:'1 '},{DEEP_PROOF_TRACE:'yes'}]){
  assert.equal(traceEnabled(env),false,JSON.stringify(env));
  assert.equal(createRunTrace({dir,pid:'p1',rid:'r1',env,log:line=>lines.push(line)}),null,JSON.stringify(env));
 }
 assert.deepEqual(fs.readdirSync(dir),[],'no folder and no file is created while the trace is off');assert.deepEqual(lines,[],'nothing is printed while the trace is off');
 assert.equal(traceEnabled(ON),true);
 const trace=createRunTrace({dir,pid:'p1',rid:'r1',env:ON});assert.ok(trace);trace.runEnd({status:'completed',result:{format:'markdown'}});
 assert.deepEqual(tree(dir),['projects/','projects/p1/','projects/p1/traces/','projects/p1/traces/r1/','projects/p1/traces/r1/trace.jsonl']);
 assert.equal(fs.statSync(traceFolder(dir,'p1','r1')).mode&0o777,0o700);assert.equal(fs.statSync(traceFile(dir,'p1','r1')).mode&0o777,0o600);
 assert.throws(()=>traceFolder(dir,'p1','../r1'),/Invalid artifact identifier/);assert.throws(()=>traceFolder(dir,'p/1','r1'),/Invalid artifact identifier/);
});

// The golden version 1 sample, tests/fixtures/trace-v1-sample.jsonl, is exactly what this fixed script of tracer calls
// writes: a hand-scripted Check Report (no model output) with a clock that starts at 2026-01-01T00:00:00.000Z and
// advances 1,000 ms per record, server pid 4242, and every duration given as an input. Readers of the trace (the
// lean_documents process viewer) keep a byte-identical copy. Do not regenerate the sample automatically.
const SAMPLE_START=Date.parse('2026-01-01T00:00:00.000Z'),event=fields=>'@@ALA_EVENT@@'+JSON.stringify(fields);
function writeSampleTrace(dir){
 let tick=0;const trace=createRunTrace({dir,pid:'project-sample',rid:'run-sample',env:ON,now:()=>SAMPLE_START+1000*tick++,serverPid:4242,serverStartedAt:'2025-12-31T23:00:00.000Z'});
 const report='# Quarterly Revenue Report\n\nRevenue in 2025 was EUR 12 million.\n',minutes='# Board Minutes, 12 March 2025\n\nThe board noted revenue of EUR 10 million for 2025.\n',session='9b2f6a3e-0c4d-4e8f-9a51-2d7c8e6b1f30',prompt='Check the report under review.';
 trace.runStart({createdAt:'2026-01-01T00:00:00.000Z',snapshot:{kind:'quality',project:{id:'project-sample',company:'Sample Holding'},report_language:'en',type:{id:'report-quality',name:'Rigorous Report Verification',skill_revision:'skill-revision-sample',methodology_revision:'1.0'},verification:{status:'demo'},settings:{agent:'codex',models:{codex:'gpt-6-luna'},efforts:{codex:'high'}},timeLimitMinutes:10,qualityOptions:{depth:'deep',researchMode:'closed'},sourceReport:{id:'report-source-sample',kind:'imported',title:'Quarterly Revenue Report',documentId:'report-under-review',criteria:null},documents:[{id:'report-under-review',title:'Quarterly Revenue Report',markdown:report,file_type:'md',original_name:'report-7d1c2b9e4a10.md'},{id:'board-minutes',title:'Board Minutes, 12 March 2025',markdown:minutes,file_type:'md',original_name:'board-minutes.md'}]}});
 trace.record('workspace-created',{path:'/tmp/deep-proof-verification-sample'});
 trace.turnStart({turn:1,resume:false,sessionId:session,prompt,remainingMs:480000});
 trace.alaLine(1,event({type:'coding-agent-selected',agent:'codex',permissionMode:'full-access',model:'gpt-6-luna'}));
 trace.alaLine(1,'ala: sandbox ready');
 trace.alaLine(1,event({type:'coding-agent-message',agent:'codex',message:'I will read the report under review ',outputKind:'assistant',outputComplete:false,outputId:'msg-1'}));
 trace.alaLine(1,event({type:'coding-agent-message',agent:'codex',message:'and the board minutes first. Notă: raportul afirmă „EUR 12 milioane”, iar procesul-verbal spune 10; 𝔼 <script>alert(1)</script>',outputKind:'assistant',outputComplete:true,outputId:'msg-1'}));
 trace.alaLine(1,event({type:'coding-agent-message',agent:'codex',message:'sources/report-under-review.md\nsources/board-minutes.md\n',outputKind:'output',outputComplete:false}));
 trace.progress(1,'Read the report and the minutes. The revenue figures differ: EUR 12 million against EUR 10 million.');
 trace.record('reminder-sent',{turn:'1',id:'progress-1'});
 trace.alaLine(1,event({type:'message-accepted',id:'progress-1',delivery:'delivered'}));
 trace.turnEnd({turn:1,outcome:'exited',exitCode:1,signal:null,durationMs:95000,error:'Deep Proof engine exited with code 1. ala: Codex completed without a final response.\n'});
 trace.record('continuation',{attempt:1,reason:'empty_response',used:1});
 trace.turnStart({turn:'1-continue1',resume:true,sessionId:session,prompt:prompt+'\nThe previous turn ended without any output.',remainingMs:385000});
 trace.alaLine('1-continue1',event({type:'coding-agent-final',agent:'codex',message:'report.md is written; the validator reported two problems.'}));
 trace.turnEnd({turn:'1-continue1',outcome:'exited',exitCode:0,signal:null,durationMs:120000});
 trace.record('validation',{attempt:1,valid:false,errors:['Finding F1 cites sources/board-minutes.md lines 3-3, but its quote is not on those lines.','quality/coverage.json must set completion.']});
 trace.turnStart({turn:2,resume:true,sessionId:session,prompt:prompt+'\nThe previous attempt did not pass the application validator.',remainingMs:262000});
 trace.alaLine(2,event({type:'coding-agent-message',agent:'codex',message:'Repairing the quote of F1.',outputKind:'assistant',outputComplete:true,outputId:'msg-2'}));
 trace.progress(2,'Read the report and the minutes. The revenue figures differ: EUR 12 million against EUR 10 million.\n\n---\n\nRepairing the citation of finding F1 against the minutes, line 3.');
 trace.record('reminder-sent',{turn:'2',id:'progress-2'});
 trace.alaLine(2,event({type:'message-rejected',id:'progress-2',error:'Execution is no longer accepting messages.'}));
 trace.turnEnd({turn:2,outcome:'time_limit',exitCode:null,signal:'SIGKILL',durationMs:262000,error:'Deep Proof reached its review time limit. No validated report was produced.'});
 trace.record('time-limit',{elapsedMs:480000,workMs:480000});
 trace.record('wrap-up',{phase:'start',remainingMs:120000});
 trace.turnStart({turn:'wrapup',resume:true,sessionId:session,prompt:prompt+'\nTHE TIME LIMIT HAS BEEN REACHED.',remainingMs:120000});
 trace.alaLine('wrapup',event({type:'coding-agent-final',agent:'codex',message:'The wrap-up report is written and validated.'}));
 trace.turnEnd({turn:'wrapup',outcome:'exited',exitCode:0,signal:null,durationMs:70000});
 trace.record('validation',{attempt:'wrapup',valid:true,errors:[]});
 trace.record('wrap-up',{phase:'validated'});
 trace.record('published',{what:'check-report',timeLimited:true});
 trace.record('workspace-kept',{files:14,bytes:48213,skippedCount:0,skipped:[],excluded:['evidence-lines.json','input.json','skills','sources','validation'],complete:true,durationMs:42});
 trace.runEnd({status:'completed',result:{format:'markdown',timeLimited:true,quality:{completion:'incomplete',confirmedFindings:1,findings:[]}}});
 return traceFile(dir,'project-sample','run-sample');
}

test('trace records match the version 1 sample byte for byte (injected clock and pid)',t=>{
 const dir=temporary(t,'trace-sample-'),file=writeSampleTrace(dir);
 const expected=fs.readFileSync(new URL('./fixtures/trace-v1-sample.jsonl',import.meta.url));
 assert.ok(fs.readFileSync(file).equals(expected),'the scripted trace equals tests/fixtures/trace-v1-sample.jsonl byte for byte');
 const records=readTrace(file);
 assert.equal(records[0].type,'run-start');assert.equal(records[0].at,'2026-01-01T00:00:00.000Z');assert.equal(records.at(-1).at,new Date(SAMPLE_START+1000*(records.length-1)).toISOString());
 assert.equal(records[0].server.pid,4242);assert.equal(records[0].workMs,480000);assert.equal(records[0].wrapUpMs,120000);assert.equal(records.at(-1).durationMs,1000*(records.length-1));
 assert.ok(!expected.toString().includes('/Users/'),'the sample holds no private path');
});

test('oversized records are clipped and the size limit stops ALA lines but not host steps',t=>{
 const dir=temporary(t,'trace-limits-'),trace=createRunTrace({dir,pid:'p1',rid:'r1',env:ON}),file=traceFile(dir,'p1','r1');
 // A 300 KiB event line is parsed and its long field clipped; a 2 MiB line is not parsed and is stored clipped.
 const message='m'.repeat(300*1024);trace.alaLine('1','@@ALA_EVENT@@'+JSON.stringify({type:'coding-agent-message',agent:'codex',message,outputKind:'output',outputComplete:true}));
 trace.alaLine('1','@@ALA_EVENT@@'+JSON.stringify({type:'coding-agent-message',message:'n'.repeat(2*1024*1024)}));
 trace.alaLine('1','ș'.repeat(150*1024+1));trace.alaLine('1','@@ALA_EVENT@@{not json');trace.alaLine('1','   ');
 let records=readTrace(file);
 assert.equal(records[0].type,'ala-event');assert.equal(records[0].event.message.length,TRACE_LIMITS.recordBytes);assert.deepEqual(records[0].truncated,{field:'message',originalBytes:300*1024});assert.equal(records[0].event.outputKind,'output');
 assert.equal(records[1].type,'ala-stderr');assert.equal(Buffer.byteLength(records[1].text),TRACE_LIMITS.recordBytes);assert.ok(records[1].text.startsWith('@@ALA_EVENT@@'));assert.ok(records[1].truncated.originalBytes>2*1024*1024);
 assert.equal(records[2].type,'ala-stderr');assert.ok(Buffer.byteLength(records[2].text)<=TRACE_LIMITS.recordBytes);assert.match(records[2].text,/^ș+$/,'a character is never split');assert.equal(records[2].truncated.originalBytes,(150*1024+1)*2);
 assert.deepEqual([records[3].type,records[3].text],['ala-stderr','@@ALA_EVENT@@{not json']);assert.equal(records.length,4,'a blank line is not recorded');
 // Fill the trace past its limit with lines just under the parse bound.
 const line='z'.repeat(1000000);let sent=0;
 while(fs.statSync(file).size<TRACE_LIMITS.traceBytes&&sent<400){trace.alaLine('1',line);sent++;}
 for(let i=0;i<5;i++){trace.alaLine('1',line);sent++;}
 trace.record('published',{what:'report',timeLimited:false});trace.alaLine('1','late line');sent++;
 trace.runEnd({status:'completed',result:{format:'markdown'}});
 records=readTrace(file);
 const limit=records.filter(r=>r.type==='trace-limit');assert.equal(limit.length,1,'one trace-limit record');assert.equal(limit[0].traceBytes,TRACE_LIMITS.traceBytes);
 const after=records.slice(records.indexOf(limit[0])+1);assert.deepEqual(after.map(r=>r.type),['published','run-end'],'host steps are still written after the limit, ALA lines are not');
 const kept=records.filter(r=>r.type==='ala-stderr'&&r.text.startsWith('zzz')).length;
 assert.equal(records.at(-1).droppedAlaLines,sent-kept,'every line not written is counted');assert.ok(records.at(-1).droppedAlaLines>=7);
 assert.ok(fs.statSync(file).size<=TRACE_LIMITS.traceBytes+4096,'only host-step records pass the limit');
});

test('a trace that cannot be written disables itself and never throws',async t=>{
 const dir=temporary(t,'trace-unwritable-');
 // The file of the run exists already: create-exclusive refuses it, and it is left as it was.
 fs.mkdirSync(traceFolder(dir,'p1','r1'),{recursive:true});fs.writeFileSync(traceFile(dir,'p1','r1'),'earlier\n');
 let lines=[];assert.equal(createRunTrace({dir,pid:'p1',rid:'r1',env:ON,log:line=>lines.push(line)}),null);
 assert.equal(lines.length,1);assert.match(lines[0],/Process trace disabled for run r1/);assert.equal(fs.readFileSync(traceFile(dir,'p1','r1'),'utf8'),'earlier\n');
 // A regular file named traces stops the folder for every user, root included.
 fs.mkdirSync(path.join(dir,'projects/p2'),{recursive:true});fs.writeFileSync(path.join(dir,'projects/p2/traces'),'');
 lines=[];assert.equal(createRunTrace({dir,pid:'p2',rid:'r1',env:ON,log:line=>lines.push(line)}),null);assert.equal(lines.length,1);
 assert.equal(createRunTrace({dir,pid:'p2',rid:'bad/id',env:ON,log:()=>{}}),null,'an invalid id disables the trace instead of throwing');
 // An unwritable traces folder (not a barrier for root, so checked only for other users).
 if(process.getuid?.()!==0){fs.mkdirSync(path.join(dir,'projects/p3/traces'),{recursive:true});fs.chmodSync(path.join(dir,'projects/p3/traces'),0o500);try{assert.equal(createRunTrace({dir,pid:'p3',rid:'r1',env:ON,log:()=>{}}),null);}finally{fs.chmodSync(path.join(dir,'projects/p3/traces'),0o700);}}
 // A failure while writing (here the clock) disables the trace after the records already written; nothing throws.
 let calls=0;lines=[];const trace=createRunTrace({dir,pid:'p4',rid:'r1',env:ON,now:()=>{if(++calls>2)throw Error('clock failed');return Date.UTC(2026,0,1);},log:line=>lines.push(line)});
 trace.record('workspace-created',{path:'/tmp/deep-proof-verification-abcdef'});trace.turnStart({turn:1,prompt:'p',remainingMs:1});assert.equal(trace.disabled,false);
 trace.alaLine(1,'x');assert.equal(trace.disabled,true);
 trace.runStart({snapshot:null});trace.record('time-limit',{elapsedMs:1,workMs:1});trace.progress(1,'note');trace.turnEnd({turn:1,outcome:'exited',exitCode:0});trace.runEnd(null);trace.runEnd(undefined);
 const workspace=fs.mkdtempSync(path.join(dir,'deep-proof-verification-'));fs.writeFileSync(path.join(workspace,'report.md'),'draft');
 assert.equal(await trace.keepWorkspace(workspace),undefined);assert.equal(fs.existsSync(path.join(traceFolder(dir,'p4','r1'),'workspace')),false,'a disabled trace copies nothing');
 assert.equal(lines.length,1,'one line on the error output');assert.deepEqual(readTrace(traceFile(dir,'p4','r1')).map(r=>r.type),['workspace-created','turn-start']);
 // A snapshot that cannot be read does not throw either.
 const odd=createRunTrace({dir,pid:'p5',rid:'r1',env:ON,log:()=>{}});odd.runStart({snapshot:{get documents(){throw Error('unreadable snapshot');}},createdAt:'x'});assert.equal(odd.disabled,true);
});

test('a link in the trace path disables the trace and nothing is written through it',t=>{
 const dir=temporary(t,'trace-links-'),outside=temporary(t,'trace-outside-');fs.writeFileSync(path.join(outside,'target.txt'),'outside\n');
 fs.mkdirSync(path.join(dir,'projects/p1'),{recursive:true});fs.symlinkSync(outside,path.join(dir,'projects/p1/traces'));
 fs.mkdirSync(path.join(dir,'projects/p2/traces'),{recursive:true});fs.symlinkSync(outside,path.join(dir,'projects/p2/traces/r1'));
 fs.mkdirSync(path.join(dir,'projects/p3/traces/r1'),{recursive:true});fs.symlinkSync(path.join(outside,'target.txt'),path.join(dir,'projects/p3/traces/r1/trace.jsonl'));
 fs.mkdirSync(path.join(dir,'projects/p3/traces/r2'),{recursive:true});fs.symlinkSync(path.join(outside,'created.txt'),path.join(dir,'projects/p3/traces/r2/trace.jsonl'));
 fs.mkdirSync(path.join(dir,'projects'),{recursive:true});fs.symlinkSync(outside,path.join(dir,'projects/p4'));
 for(const [pid,rid] of [['p1','r1'],['p2','r1'],['p3','r1'],['p3','r2'],['p4','r1']]){
  const lines=[];assert.equal(createRunTrace({dir,pid,rid,env:ON,log:line=>lines.push(line)}),null,`${pid}/${rid}`);assert.equal(lines.length,1);
 }
 assert.deepEqual(fs.readdirSync(outside),['target.txt'],'nothing is created through a link');assert.equal(fs.readFileSync(path.join(outside,'target.txt'),'utf8'),'outside\n');
});

test('the kept copy skips links, second names, excluded entries and oversized files',async t=>{
 const dir=temporary(t,'trace-keep-'),outside=temporary(t,'trace-keep-outside-'),workspace=fs.mkdtempSync(path.join(dir,'deep-proof-verification-'));
 fs.writeFileSync(path.join(outside,'secret.txt'),'outside');
 const files={'report.md':'# Draft\n','task-1.txt':'Review the report.','response-1.txt':'Done.','validation-errors-1.json':'{"errors":["x"]}','progress.md':'Prima notă.','config.json':'{}','quality/findings.jsonl':'{"id":"F1"}\n','quality/inner/input.json':'{"nested":true}','.ala/sessions/s1.jsonl':'{"type":"session"}\n','charts/c.csv':'a,b\n'};
 for(const [name,content] of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(workspace,name)),{recursive:true});fs.writeFileSync(path.join(workspace,name),content);}
 for(const name of ['skills/report-quality/SKILL.md','validation/validate.mjs','sources/target.md','input.json','evidence-lines.json']){fs.mkdirSync(path.dirname(path.join(workspace,name)),{recursive:true});fs.writeFileSync(path.join(workspace,name),'excluded');}
 fs.symlinkSync(path.join(outside,'secret.txt'),path.join(workspace,'link.md'));fs.symlinkSync(outside,path.join(workspace,'linked-folder'));
 fs.writeFileSync(path.join(workspace,'hard.md'),'two names');fs.linkSync(path.join(workspace,'hard.md'),path.join(workspace,'hard-second.md'));
 fs.writeFileSync(path.join(workspace,'big.bin'),'');fs.truncateSync(path.join(workspace,'big.bin'),TRACE_LIMITS.keptFileBytes+1);
 fs.writeFileSync(path.join(workspace,'exact.bin'),'');fs.truncateSync(path.join(workspace,'exact.bin'),TRACE_LIMITS.keptFileBytes);
 const fifo=spawnSync('mkfifo',[path.join(workspace,'pipe')]).status===0;
 const before=tree(workspace),trace=createRunTrace({dir,pid:'p1',rid:'r1',env:ON});
 await trace.keepWorkspace(workspace);trace.runEnd({status:'failed',error:Error('Deep Proof engine exited with code 3. ')});
 const records=readTrace(traceFile(dir,'p1','r1')),kept=records.find(r=>r.type==='workspace-kept'),copy=path.join(traceFolder(dir,'p1','r1'),'workspace');
 assert.deepEqual(records.map(r=>r.type),['workspace-kept','run-end']);
 assert.deepEqual(kept.excluded,[...KEEP_EXCLUDED].sort());assert.equal(kept.complete,true);
 const skipped=Object.fromEntries(kept.skipped.map(s=>[s.name,s.reason]));
 assert.deepEqual(skipped,{'big.bin':'too-large','hard-second.md':'hard-link','hard.md':'hard-link','link.md':'link','linked-folder':'link',...(fifo?{pipe:'not-regular'}:{})});assert.equal(kept.skippedCount,kept.skipped.length);
 assert.deepEqual(tree(copy),['.ala/','.ala/sessions/','.ala/sessions/s1.jsonl','charts/','charts/c.csv','config.json','exact.bin','progress.md','quality/','quality/findings.jsonl','quality/inner/','quality/inner/input.json','report.md','response-1.txt','task-1.txt','validation-errors-1.json']);
 for(const [name,content] of Object.entries(files))assert.equal(fs.readFileSync(path.join(copy,name),'utf8'),content,name);
 assert.equal(kept.files,11);assert.equal(kept.bytes,Object.values(files).reduce((n,c)=>n+Buffer.byteLength(c),0)+TRACE_LIMITS.keptFileBytes);
 assert.equal(fs.statSync(copy).mode&0o777,0o700);assert.equal(fs.statSync(path.join(copy,'quality')).mode&0o777,0o700);assert.equal(fs.statSync(path.join(copy,'report.md')).mode&0o777,0o600);
 assert.deepEqual(tree(workspace),before,'the copy changes nothing in the work folder');assert.deepEqual(fs.readdirSync(outside),['secret.txt']);
 assert.ok(!JSON.stringify(records).includes('outside'),'nothing behind a link is read');
});

test('the kept copy stops at its file, byte, depth and time bounds',async t=>{
 const dir=temporary(t,'trace-bounds-');
 const keep=async(name,fill,options={})=>{const workspace=fs.mkdtempSync(path.join(dir,'deep-proof-verification-'));fill(workspace);const trace=createRunTrace({dir,pid:'p1',rid:name,env:ON,...options});await trace.keepWorkspace(workspace);return {kept:readTrace(traceFile(dir,'p1',name)).find(r=>r.type==='workspace-kept'),copy:path.join(traceFolder(dir,'p1',name),'workspace')};};
 const files=await keep('files',w=>{for(let i=0;i<=TRACE_LIMITS.keptFiles;i++)fs.writeFileSync(path.join(w,`f${String(i).padStart(4,'0')}`),'x');});
 assert.equal(files.kept.files,TRACE_LIMITS.keptFiles);assert.equal(files.kept.complete,false);assert.deepEqual(files.kept.skipped,[{name:'f2000',reason:'file-limit'}]);assert.equal(fs.readdirSync(files.copy).length,TRACE_LIMITS.keptFiles);
 const bytes=await keep('bytes',w=>{for(let i=0;i<9;i++){fs.writeFileSync(path.join(w,`b${i}`),'');fs.truncateSync(path.join(w,`b${i}`),TRACE_LIMITS.keptFileBytes);}});
 assert.equal(bytes.kept.bytes,TRACE_LIMITS.keptBytes);assert.equal(bytes.kept.files,8);assert.equal(bytes.kept.complete,false);assert.deepEqual(bytes.kept.skipped,[{name:'b8',reason:'byte-limit'}]);
 const depth=await keep('depth',w=>{let folder=w;for(let level=1;level<=10;level++){fs.writeFileSync(path.join(folder,`level-${level}.txt`),String(level));folder=path.join(folder,'d');fs.mkdirSync(folder);}});
 const deepest='d/d/d/d/d/d/d/level-8.txt';assert.equal(fs.readFileSync(path.join(depth.copy,deepest),'utf8'),'8','a file eight levels down is kept');
 assert.equal(depth.kept.files,8);assert.equal(depth.kept.complete,false);assert.deepEqual(depth.kept.skipped,[{name:'d/d/d/d/d/d/d/d',reason:'depth'}]);
 // The copy's own deadline, on the injected clock: the sixth look at the clock is 11 seconds later.
 let reads=0;const start=Date.UTC(2026,0,1),slow=await keep('time',w=>{for(let i=0;i<10;i++)fs.writeFileSync(path.join(w,`t${i}`),'x');},{now:()=>start+(++reads>5?11000:0)});
 assert.equal(slow.kept.complete,false);assert.equal(slow.kept.skipped.at(-1).reason,'time');assert.ok(slow.kept.files<10);assert.equal(fs.readdirSync(slow.copy).length,slow.kept.files);assert.ok(slow.kept.durationMs>=TRACE_LIMITS.keptMs);
});

test('the hook runs before removal; a throwing hook still removes the folder and keeps the original error',async t=>{
 const dir=temporary(t,'trace-hook-'),input={documents:[{id:'target',file_type:'md'}]};let workspace,seen;
 // The hook sees the work folder as the task left it, and the folder is removed afterwards.
 const result=await withQualityWorkspace(dir,input,async folder=>{workspace=folder;fs.writeFileSync(path.join(folder,'report.md'),'draft');return 'published';},{beforeRemove:async folder=>{seen=fs.readFileSync(path.join(folder,'report.md'),'utf8');}});
 assert.equal(result,'published');assert.equal(seen,'draft');assert.equal(fs.existsSync(workspace),false);
 // A throwing hook changes neither the result nor the error, and the folder is still removed.
 assert.equal(await withQualityWorkspace(dir,input,async folder=>{workspace=folder;return 'kept';},{beforeRemove:async()=>{throw Error('hook failed');}}),'kept');assert.equal(fs.existsSync(workspace),false);
 await assert.rejects(withQualityWorkspace(dir,input,async folder=>{workspace=folder;throw Error('Execution failed');},{beforeRemove:()=>{throw Error('hook failed');}}),/Execution failed/);assert.equal(fs.existsSync(workspace),false);
 // Without a hook the lifecycle is today's.
 assert.equal(await withQualityWorkspace(dir,input,async folder=>{workspace=folder;return 'plain';}),'plain');assert.equal(fs.existsSync(workspace),false);
 // The real hook: the tracer copies on failure, then the folder goes; a copy past its deadline still lets it go.
 const trace=createRunTrace({dir,pid:'p1',rid:'r1',env:ON});
 await assert.rejects(withQualityWorkspace(dir,input,async folder=>{workspace=folder;fs.writeFileSync(path.join(folder,'task-1.txt'),'prompt');throw Error('Deep Proof engine exited with code 3. ');},{beforeRemove:w=>trace.keepWorkspace(w)}),/exited with code 3/);
 assert.equal(fs.existsSync(workspace),false);assert.equal(fs.readFileSync(path.join(traceFolder(dir,'p1','r1'),'workspace/task-1.txt'),'utf8'),'prompt');
 let reads=0;const slow=createRunTrace({dir,pid:'p1',rid:'r2',env:ON,now:()=>Date.UTC(2026,0,1)+(++reads>2?60000:0)});
 assert.equal(await withQualityWorkspace(dir,input,async folder=>{workspace=folder;for(let i=0;i<5;i++)fs.writeFileSync(path.join(folder,`f${i}`),'x');return 'late';},{beforeRemove:w=>slow.keepWorkspace(w)}),'late');
 assert.equal(fs.existsSync(workspace),false);const kept=readTrace(traceFile(dir,'p1','r2')).find(r=>r.type==='workspace-kept');assert.equal(kept.complete,false);assert.equal(kept.skipped.at(-1).reason,'time');
});

test('two traces written at the same time keep their own sequence, and runEnd writes one record',t=>{
 const dir=temporary(t,'trace-concurrent-'),a=createRunTrace({dir,pid:'p1',rid:'a',env:ON}),b=createRunTrace({dir,pid:'p1',rid:'b',env:ON});
 for(let i=0;i<20;i++){(i%2?a:b).alaLine('1',`line ${i}`);(i%3?b:a).record('wrap-up',{phase:'start',remainingMs:i});}
 a.runEnd({status:'completed',result:{format:'markdown',partial:{reason:'time_limit'}}});a.runEnd({status:'failed',error:Error('second')});b.runEnd({status:'failed',error:Error('Deep Proof engine exited with code 3. ')});
 const ra=readTrace(traceFile(dir,'p1','a')),rb=readTrace(traceFile(dir,'p1','b'));
 assert.equal(ra.filter(r=>r.type==='run-end').length,1);assert.equal(ra.at(-1).status,'completed');assert.equal(ra.at(-1).timeLimited,true);assert.equal(ra.at(-1).partial,true);
 assert.equal(rb.at(-1).failureCode,'unexpected');assert.equal(ra.length+rb.length,42);
 a.alaLine('1','after the end');assert.equal(readTrace(traceFile(dir,'p1','a')).length,ra.length,'nothing is written after run-end');
});

test('the validator accepts the records the tracer writes and refuses malformed ones',()=>{
 const at='2026-01-01T00:00:00.000Z';
 assert.equal(validateTraceRecord({seq:2,at,type:'time-limit',elapsedMs:1,workMs:1}).type,'time-limit');
 for(const [record,reason] of [[{seq:1,at,type:'other'},/unknown type/],[{seq:0,at,type:'time-limit',elapsedMs:1,workMs:1},/seq/],[{seq:1,at:'2026-01-01',type:'time-limit',elapsedMs:1,workMs:1},/ISO/],[{seq:1,at,type:'time-limit',elapsedMs:1},/needs workMs/],[{seq:1,at,type:'time-limit',elapsedMs:1,workMs:1,extra:1},/unknown field/],[{seq:2,at,type:'run-start'},/record 1/],[{seq:1,at,type:'ala-stderr',turn:'1',text:'x'.repeat(TRACE_LIMITS.recordBytes+1)},/record bound|invalid/],[{seq:1,at,type:'turn-end',turn:'1',outcome:'killed',exitCode:null,signal:null,durationMs:1},/invalid outcome/]])assert.throws(()=>validateTraceRecord(record),reason);
 assert.equal(TRACE_VERSION,1);
});
