import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRunTrace,traceEnabled,traceFolder,validateTraceRecord,TRACE_LIMITS,KEEP_EXCLUDED,TRACE_VERSION} from '../src/trace.mjs';

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
