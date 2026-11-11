import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {score} from './evaluation/benchmarks/lib.mjs';
import {loadArms,planUnits,blindness,dossierRoles,readDossier,stageDossier,parsePrediction,runAgentUnit,launchProcess,stopEngines,recordFindings,flagFromFindings,runCheckUnit,startDeepProof,collect,unitId,MAX_ERROR_ATTEMPTS} from './evaluation/benchmarks/runner.mjs';
import {main,parseArgs,codeHash,processStart,acquireLock,lockNamespace} from './evaluation/benchmarks/run.mjs';
import {compareArms,mcnemarExact,mulberry32} from './evaluation/benchmarks/stats.mjs';
import {warnings} from './evaluation/benchmarks/compare.mjs';

// Everything below is hand-authored: dossiers, reviewer outputs, findings registers and answer keys. No upstream
// dataset text, no model output and no model call. The "launch" stand-ins write files a reviewer could have written.
const benchmarks=fileURLToPath(new URL('./evaluation/benchmarks/',import.meta.url));
const REQUEST='# Review Request\n\nCase: case-000000000001\n\nAn AI system was given the text in `source.txt` and asked to summarize it. Its output is `ai-summary.txt`. Check every statement in the summary against the source.\n';
const SOURCE='The bridge closed on Monday after the storm.\n',SUMMARY='The bridge closed on Tuesday after the storm.\n';
async function temp(t,prefix='benchmark-runner-'){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function dossier(root,caseId,files={'review-request.md':REQUEST,'source.txt':SOURCE,'ai-summary.txt':SUMMARY}){
 const dir=path.join(root,caseId);await fs.mkdir(dir,{recursive:true});for(const [name,content] of Object.entries(files))await fs.writeFile(path.join(dir,name),content);return dir;
}
const settings={agent:'codex',models:{codex:'test-codex-model'},efforts:{}};
const found=()=>({found:true,entry:'/opt/ala/bin/ala.mjs',root:'/opt/ala'});
const writes=(name,content,result={code:0})=>async({cwd})=>{await fs.writeFile(path.join(cwd,name),content);return result;};
const noALA=async t=>{const saved=process.env.ALA_CLI;process.env.ALA_CLI=path.join(await temp(t,'no-ala-'),'missing');t.after(()=>{if(saved===undefined)delete process.env.ALA_CLI;else process.env.ALA_CLI=saved;});};
const state=o=>[o.status,o.reason];
// A process that was killed but not yet collected by its parent still answers a signal; on Linux its state is Z.
const gone=pid=>{try{process.kill(pid,0);}catch{return true;}try{return readFileSync(`/proc/${pid}/stat`,'utf8').split(') ').pop().startsWith('Z');}catch{return false;}};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('the scorer counts failed reviews instead of dropping them',()=>{
 const g=(caseId,verdict)=>({caseId,dataset:'d',model:'m',partition:'final',expected:{verdict},aiOutput:'x',spans:[]});
 const gold=[g('a','problem'),g('b','problem'),g('c','no_problem'),g('d','no_problem'),g('e','problem')];
 const all=score(gold,{a:{verdict:'problem'},b:{failed:true,reason:'timeout'},c:{verdict:'no_problem'},d:{failed:true}}).groups.all;
 assert.deepEqual([all.counts.tp,all.counts.fn,all.counts.tn,all.counts.failed,all.counts.failedProblem,all.counts.failedClean,all.counts.missing],[1,0,1,2,1,1,1]);
 assert.equal(all.recall.value,1);assert.equal(all.recallCountingFailures.value,0.5);
 assert.equal(all.cleanControlPassRateCountingFailures.value,0.5);assert.equal(all.failureRate.value,0.5);
 assert.throws(()=>score(gold,{a:{failed:true,verdict:'problem'}}),/must not carry a verdict/);
 for(const entry of [{failed:'yes'},{verdict:'problem',failed:1},{failed:false},{verdict:'maybe'}])assert.throws(()=>score(gold,{a:entry}),/verdict/);
 assert.equal(score(gold,{a:{verdict:'problem',failed:false}}).groups.all.counts.tp,1,'an explicit failed:false stays an ordinary verdict');
});

test('arms carry a fingerprint that changes with their prompt or settings',async t=>{
 const arms=await loadArms();
 assert.deepEqual(Object.keys(arms).sort(),['always-clear','always-problem','deep-proof-check','deep-proof-triage','plain','plain-careful']);
 for(const arm of Object.values(arms))assert.match(arm.fingerprint,/^[0-9a-f]{64}$/);
 assert.equal(new Set(Object.values(arms).map(a=>a.fingerprint)).size,6);
 assert.match(arms['deep-proof-check'].methodology,/^[0-9a-f]{64}$/);
 // The baseline prompts name the output file and the time limit, and carry none of Deep Proof's method.
 for(const id of ['plain','plain-careful']){assert.match(arms[id].promptText,/prediction\.json/);assert.match(arms[id].promptText,/\{\{minutes\}\}/);assert.doesNotMatch(arms[id].promptText,/skill|validat|quality\/|register|F0\d/i);}
 const dir=await temp(t),file=path.join(dir,'arms.json');
 const write=async(spec,prompt='Write prediction.json.')=>{await fs.writeFile(path.join(dir,'p.md'),prompt);await fs.writeFile(file,JSON.stringify(spec));return loadArms(file);};
 const first=(await write({plain:{kind:'agent',prompt:'p.md'}})).plain.fingerprint;
 assert.equal((await write({plain:{kind:'agent',prompt:'p.md'}})).plain.fingerprint,first);
 assert.notEqual((await write({plain:{kind:'agent',prompt:'p.md'}},'Think harder. Write prediction.json.')).plain.fingerprint,first);
 assert.notEqual((await write({plain:{kind:'agent',prompt:'p.md',pdfText:false}})).plain.fingerprint,first);
 await assert.rejects(write({plain:{kind:'agent',prompt:'p.md'}},'No output file named.'),/prediction\.json/);
 await assert.rejects(write({x:{kind:'check',depth:'deep',flagCategories:['F13']}}),/F01–F12/);
 await assert.rejects(write({x:{kind:'check',depth:'thorough',flagCategories:'all'}}),/deep or triage/);
 await assert.rejects(write({x:{kind:'constant',verdict:'maybe'}}),/problem or no_problem/);
 await assert.rejects(write({'Bad Name':{kind:'constant',verdict:'problem'}}),/lower-case/);
});

test('units cover every arm, case and repeat in a seeded, interleaved order',()=>{
 const plan=seed=>planUnits({caseIds:['case-a','case-b','case-c','case-d'],armIds:['plain','deep-proof-check'],repeats:3,seed});
 const units=plan(1);
 assert.equal(units.length,24);assert.equal(new Set(units.map(u=>u.unit)).size,24);
 assert.deepEqual(plan(1).map(u=>u.unit),units.map(u=>u.unit));
 assert.notDeepEqual(plan(2).map(u=>u.unit),units.map(u=>u.unit));
 assert.ok(new Set(units.slice(0,12).map(u=>u.arm)).size===2,'arms must not run as two blocks');
 assert.equal(unitId('plain','case-a',2),'plain__case-a__r2');
});

test('the runner refuses folder layouts that put answer keys or other runs within reach of the agent',async t=>{
 const root=await temp(t),repository=path.join(root,'work','repo'),build=path.join(repository,'build'),clean=path.join(root,'host');
 for(const dir of [path.join(build,'dossiers'),path.join(build,'gold'),path.join(clean,'dossiers'),path.join(root,'arena'),path.join(root,'out'),path.join(root,'srv','builds','core','gold')])await fs.mkdir(dir,{recursive:true});
 const check=options=>blindness({repository,dossiers:path.join(clean,'dossiers'),arena:path.join(root,'arena'),out:path.join(root,'out'),...options});
 assert.deepEqual(check({}),{status:'isolated_as_attested',visibleKeys:[],note:'Folder layout only. What the agent sandbox mounts is not observed.'});
 assert.throws(()=>check({dossiers:path.join(build,'dossiers')}),/Answer keys may be readable/);
 assert.equal(check({dossiers:path.join(build,'dossiers'),allowVisibleKeys:true}).status,'exposed');
 assert.throws(()=>check({arena:path.join(repository,'arena')}),/inside or around the repository/);
 assert.throws(()=>check({arena:path.join(root,'work')}),/inside or around the repository/,'an arena that contains the repository');
 assert.throws(()=>check({arena:path.join(root,'srv')}),/a gold folder under the arena/,'answer keys somewhere below the arena');
 assert.throws(()=>check({arena:path.join(root,'out','arena')}),/must not contain each other/);
 assert.throws(()=>check({out:path.join(root,'arena','..records')}),/must not contain each other/,'a child folder whose name starts with two dots is still inside');
 assert.throws(()=>check({out:path.join(clean,'dossiers','out')}),/output folder and the dossier folder/);
 assert.throws(()=>check({arena:path.join(clean,'dossiers')}),/arena and the dossier folder/);
 assert.equal(check({arena:null}).status,'isolated_as_attested');
 await fs.mkdir(path.join(root,'linked'));await fs.symlink(path.join(build,'gold'),path.join(root,'linked','keys'));
 assert.throws(()=>check({arena:path.join(root,'linked')}),/a link under the arena/);
 // A work folder of the runner itself is not examined here: run.mjs moves it out, or refuses, before any review.
 const left=path.join(root,'used','run-0123456789abcdef');await fs.mkdir(left,{recursive:true});await fs.symlink(path.join(build,'gold'),path.join(left,'venv'));
 assert.equal(check({arena:path.join(root,'used')}).status,'isolated_as_attested');
});

test('every arm reads a dossier through one reader that refuses links, and staging makes plain copies',async t=>{
 const root=await temp(t),dir=await dossier(path.join(root,'dossiers'),'case-000000000001');
 const read=await readDossier(dir);
 assert.deepEqual(read.roles,{request:'review-request.md',target:'ai-summary.txt',evidence:['source.txt']});assert.match(read.hash,/^[0-9a-f]{64}$/);
 const {workDir,staged}=await stageDossier(read,path.join(root,'arena'));
 assert.match(path.basename(workDir),/^run-[0-9a-f]{16}$/);
 assert.deepEqual(Object.keys(staged).sort(),['ai-summary.txt','review-request.md','source.txt']);
 assert.equal(await fs.readFile(path.join(workDir,'source.txt'),'utf8'),SOURCE);
 assert.notEqual((await stageDossier(read,path.join(root,'arena'))).workDir,workDir);
 assert.throws(()=>dossierRoles(['review-request.md','ai-summary.txt']),/no source document/);
 assert.throws(()=>dossierRoles(['review-request.md','ai-summary.txt','ai-answer.txt','x.pdf']),/exactly one/);
 await fs.writeFile(path.join(dir,'source.txt'),'The bridge closed on Sunday.\n');
 assert.notEqual((await readDossier(dir)).hash,read.hash);
 await fs.writeFile(path.join(root,'answer-key.json'),'{}');await fs.symlink(path.join(root,'answer-key.json'),path.join(dir,'extra.json'));
 await assert.rejects(readDossier(dir),/not a regular file/);
});

test('reviewer output is read strictly: one object, a known verdict, quotes as strings',()=>{
 assert.deepEqual(parsePrediction('{"verdict":"problem","quotes":["on Tuesday"," "],"notes":"Monday in the source."}'),{ok:true,prediction:{verdict:'problem',quotes:['on Tuesday']},notes:'Monday in the source.'});
 assert.deepEqual(parsePrediction('Here is my result:\n```json\n{"verdict":"no_problem"}\n```\n').prediction,{verdict:'no_problem',quotes:[]});
 assert.equal(parsePrediction('The answer is {"verdict":"problem","quotes":[]} as requested.').prediction.verdict,'problem');
 assert.deepEqual(parsePrediction('I found nothing wrong.'),{ok:false,reason:'it is not valid JSON'});
 assert.match(parsePrediction('{"verdict":"unsure"}').reason,/verdict must be/);
 assert.match(parsePrediction('{"verdict":"problem","quotes":"on Tuesday"}').reason,/list of strings/);
 assert.match(parsePrediction('["problem"]').reason,/one JSON object/);
});

test('the plain agent arm gets the dossier and a short task, and its outcome is recorded honestly',async t=>{
 const root=await temp(t),dir=await dossier(path.join(root,'dossiers'),'case-000000000001'),arena=path.join(root,'arena');
 const arm=(await loadArms()).plain,base={arm,dossier:await readDossier(dir),arena,settings,minutes:35,locate:found};
 let seen;
 const done=await runAgentUnit({...base,launch:async call=>{seen=call;return writes('prediction.json','{"verdict":"problem","quotes":["on Tuesday"],"notes":"The source says Monday."}')(call);}});
 assert.equal(done.status,'completed');assert.deepEqual(done.prediction,{verdict:'problem',quotes:['on Tuesday']});
 assert.equal(done.details.predictionSource,'prediction.json');assert.deepEqual(done.details.inputsModified,[]);assert.equal(done.details.timeLimited,false);
 const work=done.details.workDir;
 assert.deepEqual((await fs.readdir(work)).sort(),['ai-summary.txt','config.json','prediction.json','review-request.md','source.txt','task.txt']);
 const task=await fs.readFile(path.join(work,'task.txt'),'utf8');
 assert.ok(task.startsWith(REQUEST.trim()));assert.match(task,/You have 35 minutes in total/);assert.doesNotMatch(task,/\{\{minutes\}\}/);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(work,'config.json'),'utf8')),{codingAgent:'codex',models:{codex:'test-codex-model'},efforts:{}});
 assert.deepEqual(seen.args,['/opt/ala/bin/ala.mjs','--ca','codex','--cwd',work,'--config',path.join(work,'config.json'),'--taskFile',path.join(work,'task.txt'),'--output',path.join(work,'response-1.txt')]);
 assert.equal(seen.cwd,work);assert.equal(seen.timeoutMs,35*60000);

 const fromChat=await runAgentUnit({...base,launch:writes('response-1.txt','```json\n{"verdict":"no_problem","quotes":[]}\n```')});
 assert.equal(fromChat.status,'completed');assert.equal(fromChat.details.predictionSource,'response-1.txt');
 const invalid=await runAgentUnit({...base,launch:writes('prediction.json','The summary looks wrong to me.')});
 assert.deepEqual(state(invalid),['failed','invalid_output']);assert.match(invalid.detail,/was written, but it is not valid JSON/);
 const silent=await runAgentUnit({...base,launch:async()=>({code:0})});
 assert.deepEqual([...state(silent),silent.detail],['failed','invalid_output','prediction.json was not written']);
 assert.deepEqual(state(await runAgentUnit({...base,launch:async()=>({timedOut:true,code:null})})),['failed','timeout']);
 const inTime=await runAgentUnit({...base,launch:writes('prediction.json','{"verdict":"problem","quotes":[]}',{timedOut:true,code:null})});
 assert.deepEqual([inTime.status,inTime.details.timeLimited],['completed',true]);
 const tampered=await runAgentUnit({...base,launch:async({cwd})=>{await fs.writeFile(path.join(cwd,'source.txt'),'The bridge closed on Tuesday.');await fs.writeFile(path.join(cwd,'prediction.json'),'{"verdict":"no_problem"}');return {code:0};}});
 assert.deepEqual(tampered.details.inputsModified,['source.txt']);

 // A finished review leaves the arena, so a later review of the same case cannot read its verdict.
 const kept=await runAgentUnit({...base,archive:path.join(root,'out','work'),launch:writes('prediction.json','{"verdict":"no_problem"}')});
 assert.equal(path.dirname(kept.details.workDir),path.join(root,'out','work'));assert.ok((await fs.readdir(kept.details.workDir)).includes('prediction.json'));
 assert.ok(!(await fs.readdir(arena)).includes(path.basename(kept.details.workDir)));
 // If the folder cannot be moved, the review still counts: a completed review is never turned into a rerun.
 await fs.writeFile(path.join(root,'not-a-folder'),'x');
 const stuckFolder=await runAgentUnit({...base,archive:path.join(root,'not-a-folder'),launch:writes('prediction.json','{"verdict":"problem"}')});
 assert.deepEqual([stuckFolder.status,stuckFolder.prediction.verdict,typeof stuckFolder.details.archiveError],['completed','problem','string']);
 await fs.rm(stuckFolder.details.workDir,{recursive:true});

 // The engine could not be started at all: no review happened, so nothing is scored and nothing counts as an attempt.
 const notStarted=await runAgentUnit({...base,launch:async()=>({startError:'spawn ENOENT',code:null})});
 assert.deepEqual([...state(notStarted),notStarted.attempted],['error','engine_start',false]);
 const before=(await fs.readdir(arena)).length;
 const missing=await runAgentUnit({...base,locate:()=>({found:false}),launch:async()=>{throw Error('must not launch');}});
 assert.deepEqual([...state(missing),missing.attempted],['error','engine_missing',false]);assert.equal((await fs.readdir(arena)).length,before,'nothing is staged when the engine is missing');
});

// A hand-written stand-in for the Deep Proof HTTP interface, so the polling and mapping logic can be checked offline.
function standIn({upload=201,run,register='',start=202,alwaysRunning=false}){
 const calls=[];let polls=0,stops=0;
 const post=async(route,body)=>{calls.push(['POST',route,body]);
  if(route==='/projects')return {status:201,data:{id:'p1'}};
  if(route.endsWith('/documents'))return {status:upload,data:upload===201?{id:'d1'}:{error:upload>=500?'The operation could not be completed.':upload===401?'Your session has expired.':'This document contains too much text.'}};
  if(route.endsWith('/report-imports'))return {status:201,data:{id:'r1',status:'completed'}};
  return {status:start,data:start===202?{id:'q1',status:'running'}:{error:start===503?'ALA was not found.':'Analysis is already running.'}};};
 const get=async route=>{calls.push(['GET',route]);
  if(route.includes('/verification'))return {status:200,text:register,data:null};
  return {status:200,data:alwaysRunning||polls++<1?{status:'running'}:run};};
 return {client:{get,post},calls,stopEngines:()=>{stops++;},stops:()=>stops};
}

test('error text never decides whether a review is scored: an engine that ran and failed is a failed review',async t=>{
 const root=await temp(t),dir=await dossier(path.join(root,'dossiers'),'case-000000000001'),arms=await loadArms(),read=await readDossier(dir);
 // Text that the product's own classifier reads as sign-in, quota, interruption or a missing engine, including
 // words a reviewer could have written in its report and digits from a stack trace.
 const texts=['401 Unauthorized: please sign in','quota exceeded, billing required (429)','the broadcast was interrupted and the plant restarted production','at run (file:///app/run.mjs:1403:7)','ENOENT: ALA was not found','segmentation fault'];
 for(const stderr of texts){
  const crashed=await runAgentUnit({arm:arms.plain,dossier:read,arena:path.join(root,'arena'),settings,minutes:35,locate:found,launch:writes('prediction.json','{"verdict":"problem"}',{code:1,stderr})});
  assert.deepEqual([...state(crashed),crashed.suspect,crashed.attempted,crashed.detail],['failed','engine_exit',true,undefined,stderr],stderr);
 }
 // The same holds for Check Report: whatever Deep Proof reports for a failed run, the unit is failed, never re-run.
 const report=code=>runCheckUnit({arm:arms['deep-proof-check'],dossier:read,deepProof:standIn({run:{status:'failed',failure:{code}}}),minutes:35,label:'case-000000000001',pollMs:1});
 for(const code of ['timeout','validation','empty_response']){const o=await report(code);assert.deepEqual([...state(o),o.suspect,o.attempted],['failed',code,undefined,undefined]);}
 for(const code of ['access','engine','interrupted','unexpected']){const o=await report(code);assert.deepEqual([...state(o),o.suspect,o.attempted,o.detail],['failed','engine_failure',true,undefined,`Deep Proof reported: ${code}`]);}
});

test('a filing is given to the plain agent with the same extracted text Deep Proof would read',async t=>{
 const root=await temp(t),arena=path.join(root,'arena'),arm=(await loadArms()).plain;
 const dir=await dossier(path.join(root,'dossiers'),'case-000000000002',{'review-request.md':REQUEST,'ACME_2022_10K.pdf':'%PDF-1.4 hand-authored placeholder','ai-answer.txt':'Question:\nWhat was revenue?\n\nAI answer:\nRevenue was $12.\n'});
 const base={arm,dossier:await readDossier(dir),arena,settings,minutes:20,locate:found,launch:writes('prediction.json','{"verdict":"problem","quotes":["Revenue was $12."]}')};
 const withText=await runAgentUnit({...base,extractPdf:async(_,name)=>`# ${name}\n\n## Page 1\n\nRevenue 10\n`});
 assert.deepEqual(withText.details.extracted,[{pdf:'ACME_2022_10K.pdf',text:'ACME_2022_10K.pdf.extracted.md'}]);
 assert.match(await fs.readFile(path.join(withText.details.workDir,'task.txt'),'utf8'),/`ACME_2022_10K\.pdf\.extracted\.md` holds the text of `ACME_2022_10K\.pdf`/);
 assert.equal(await fs.readFile(path.join(withText.details.workDir,'ACME_2022_10K.pdf.extracted.md'),'utf8'),'# ACME_2022_10K.pdf\n\n## Page 1\n\nRevenue 10\n');
 const unreadable=await runAgentUnit({...base,extractPdf:async()=>{throw Object.assign(Error('This document has no extractable text.'),{status:400});}});
 assert.equal(unreadable.status,'completed');assert.equal(unreadable.details.extracted[0].text,null);
 const noConverter=await runAgentUnit({...base,extractPdf:async()=>{throw Error('Document processing could not start its isolated converter.');}});
 assert.deepEqual([...state(noConverter),noConverter.attempted],['error','converter',false]);
 const rawOnly=await runAgentUnit({...base,arm:{...arm,pdfText:false},extractPdf:async()=>{throw Error('must not extract');}});
 assert.deepEqual(rawOnly.details.extracted,[]);
});

test('the engine is stopped at the time limit with everything it started, and on request',async t=>{
 const dir=await temp(t);
 const grandchild="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync('grandchild.pid',String(c.pid));setInterval(()=>{},1000)";
 const late=await launchProcess({args:['-e',grandchild],cwd:dir,timeoutMs:1500});
 assert.deepEqual([late.timedOut,late.code],[true,null]);
 const pid=Number(await fs.readFile(path.join(dir,'grandchild.pid'),'utf8'));
 for(let i=0;i<50&&!gone(pid);i++)await wait(100);
 assert.ok(gone(pid),'a process started by the engine must not outlive the time limit');
 const exited=await launchProcess({args:['-e','console.error("no credit left");process.exit(3)'],cwd:dir,timeoutMs:20000});
 assert.deepEqual([exited.code,exited.timedOut,exited.stderr.trim()],[3,undefined,'no credit left']);
 // An engine in its own process group, as Deep Proof starts it for a check, is found and stopped on interrupt.
 const engine=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
 await wait(200);assert.equal(gone(engine.pid),false);
 assert.ok(stopEngines()>=1);
 for(let i=0;i<50&&!gone(engine.pid);i++)await wait(100);
 assert.ok(gone(engine.pid));
});

test('Check Report findings become a verdict only for confirmed defects of the report under review',()=>{
 const finding=(id,verdict,categories,level,documentId,quote)=>({id,verdict,categories,level,severity:'major',object:{text:quote,locator:{documentId,quote,startLine:1,endLine:1}}});
 const register=[
  finding('F-1','confirmed',['F01'],'target','report-under-review','on Tuesday'),
  finding('F-2','narrowed',['F04','F02'],'target','report-under-review','after the storm'),
  finding('F-3','confirmed',['F04'],'target','source-1','The bridge closed on Monday'),
  finding('F-4','rejected',['F01'],'target','report-under-review','The bridge'),
  finding('F-5','clarification',['F10'],'target','report-under-review','closed'),
  finding('F-6','confirmed',['F06'],'original','source-1','Monday'),
  finding('F-7','confirmed',['F01'],'target','report-under-review','on Tuesday')];
 const recorded=recordFindings(register,'report-under-review');
 assert.deepEqual(recorded.map(f=>f.id),['F-1','F-2','F-3','F-6','F-7']);
 assert.equal(recorded.find(f=>f.id==='F-3').quote,null,'a quotation from a source document is not AI-output text');
 assert.deepEqual(flagFromFindings(recorded,['F01','F02','F03','F06']),{verdict:'problem',quotes:['on Tuesday','after the storm']});
 assert.deepEqual(flagFromFindings(recorded,['F06']),{verdict:'no_problem',quotes:[]},'a defect of the evidence document does not flag the AI output');
 assert.deepEqual(flagFromFindings(recorded.filter(f=>f.id==='F-3'),['F01','F02','F03','F06']),{verdict:'no_problem',quotes:[]},'an omission alone is outside the labelled defect');
 assert.equal(flagFromFindings(recorded.filter(f=>f.id==='F-3'),'all').verdict,'problem');
 assert.deepEqual(flagFromFindings([],'all'),{verdict:'no_problem',quotes:[]});
});

test('the Check Report arm follows the product path and maps each end state',async t=>{
 const root=await temp(t),dir=await dossier(path.join(root,'dossiers'),'case-000000000001'),arm=(await loadArms())['deep-proof-check'],read=await readDossier(dir);
 const go=(deepProof,more={})=>runCheckUnit({arm,dossier:read,deepProof,minutes:35,label:'case-000000000001',pollMs:1,retry:{tries:2,waitMs:1},...more});
 const register=[{id:'F-1',verdict:'confirmed',categories:['F01'],level:'target',severity:'major',object:{locator:{documentId:'report-under-review',quote:'on Tuesday'}}},{id:'F-2',verdict:'rejected',categories:['F02'],level:'target',object:{locator:{documentId:'report-under-review',quote:'storm'}}}].map(f=>JSON.stringify(f)).join('\n')+'\n';
 const completed={status:'completed',snapshot:{sourceReport:{documentId:'report-under-review'}},result:{quality:{completion:'complete',confirmedFindings:1}}};
 const ok=standIn({run:completed,register}),done=await go(ok);
 assert.equal(done.status,'completed');assert.deepEqual(done.prediction,{verdict:'problem',quotes:['on Tuesday']});
 assert.deepEqual([done.details.completion,done.details.confirmedFindings,done.details.timeLimited,done.details.findings.length],['complete',1,false,1]);
 const posts=ok.calls.filter(c=>c[0]==='POST');
 assert.deepEqual(posts.map(c=>c[1]),['/projects','/projects/p1/documents','/projects/p1/report-imports','/projects/p1/analyses']);
 assert.deepEqual(posts[0][2],{company:'case-000000000001'},'the project name tells the reviewer nothing the request does not');
 assert.deepEqual([posts[1][2].title,Buffer.from(posts[1][2].file.data,'base64').toString()],['source.txt',SOURCE]);
 assert.equal(Buffer.from(posts[2][2].file.data,'base64').toString(),SUMMARY,'the AI output is imported as the report, never uploaded as evidence');
 assert.deepEqual(posts[3][2],{sourceReportId:'r1',qualityOptions:{depth:'deep',researchMode:'closed',scope:REQUEST.trim()},timeLimitMinutes:35,report_language:'en'});
 assert.ok(!JSON.stringify(posts).includes('review-request.md'),'the request is the scope of the check, not a source document');

 assert.deepEqual((await go(standIn({run:{...completed,result:{quality:{completion:'complete',confirmedFindings:0}}},register:''}))).prediction,{verdict:'no_problem',quotes:[]});
 const cut=await go(standIn({run:{...completed,result:{quality:{completion:'incomplete',confirmedFindings:1},timeLimited:true}},register}));
 assert.deepEqual([cut.status,cut.details.timeLimited,cut.prediction.verdict],['completed',true,'problem']);
 assert.deepEqual(state(await go(standIn({run:{...completed,result:{partial:{notes:true}}}}))),['failed','timeout']);
 // A check still running long after its limit is the reviewer's failure, and its engine is stopped: never a free rerun.
 const hung=standIn({alwaysRunning:true}),abandoned=await go(hung,{graceMs:-36*60000});
 assert.deepEqual([...state(abandoned),hung.stops()],['failed','timeout',1]);
 // Deep Proof declining the document fails the check; anything else at upload or start needs the operator and is not an attempt.
 assert.deepEqual(state(await go(standIn({upload:400}))),['failed','ingestion']);
 for(const [options,reason] of [[{upload:500},'converter'],[{upload:401},'session'],[{start:503},'engine_missing'],[{start:409},'server']]){const o=await go(standIn(options));assert.deepEqual([...state(o),o.attempted],['error',reason,false]);}
});

test('against a real private Deep Proof instance without ALA, the check is prepared and then refused, not run',async t=>{
 await noALA(t);
 const root=await temp(t),dir=await dossier(path.join(root,'dossiers'),'case-000000000001'),arm=(await loadArms())['deep-proof-check'];
 const deepProof=await startDeepProof({dataDir:path.join(root,'out','deep-proof-data')});t.after(()=>deepProof.stop());
 assert.equal(typeof deepProof.settings.agent,'string');
 const outcome=await runCheckUnit({arm,dossier:await readDossier(dir),deepProof,minutes:35,label:'case-000000000001',pollMs:1,retry:{tries:1,waitMs:1}});
 assert.deepEqual([...state(outcome),outcome.attempted],['error','engine_missing',false]);assert.match(outcome.detail,/ALA was not found/);
 const route=`/projects/${outcome.details.projectId}`;
 assert.deepEqual((await deepProof.client.get(route+'/documents')).data.map(d=>d.title),['source.txt']);
 const reports=(await deepProof.client.get(route+'/analyses')).data;
 assert.deepEqual(reports.map(r=>[r.kind,r.status,r.title]),[['imported','completed','ai-summary.txt']]);
 // A session ends after eight hours and a campaign runs longer: the client signs in again instead of failing.
 assert.equal((await deepProof.client.post('/logout',{})).status,200);
 assert.equal((await deepProof.client.get(route+'/documents')).status,200);
 // Choosing an agent needs ALA's catalog, so without ALA the instance refuses to start for a campaign.
 await assert.rejects(startDeepProof({dataDir:path.join(root,'other','deep-proof-data'),settings}),/did not accept the agent and model/);
});

test('a campaign plans without running, freezes its inputs, and only an operator decision re-runs a failed review',async t=>{
 const root=await temp(t),dossiers=path.join(root,'host','dossiers'),out=path.join(root,'out'),arena=path.join(root,'arena'),lines=[];
 for(const id of ['case-000000000001','case-000000000002','case-000000000003'])await dossier(dossiers,id);
 await fs.writeFile(path.join(root,'host','cases.json'),JSON.stringify({cases:[{caseId:'case-000000000001',dataset:'ragtruth',partition:'final'},{caseId:'case-000000000002',dataset:'ragtruth',partition:'final'},{caseId:'case-000000000003',dataset:'faithbench',partition:'development'}]}));
 const base=['--dossiers',dossiers,'--out',out,'--arena',arena,'--partition','final','--repeats','2','--minutes','10','--agent','codex','--model','test-codex-model'];
 const log=line=>lines.push(line);
 const planned=await main([...base,'--arms','always-problem,plain'],{log});
 assert.equal(planned.pending.length,8);assert.match(lines.join('\n'),/Nothing was run/);assert.match(lines.join('\n'),/Agent runs to start: 4, each up to 10 minutes with codex \/ test-codex-model: at most 0\.7 hours/);
 await assert.rejects(fs.access(out),'planning must not create the campaign');

 // First launch: the engine is missing. Nothing is scored, and the run stops after three such errors in a row.
 const missing={agentOptions:{locate:()=>({found:false}),launch:async()=>{throw Error('must not launch');}}};
 const first=await main([...base,'--arms','plain','--launch'],{log,context:missing});
 assert.deepEqual([first.stopped,first.index.arms.plain.completed,first.index.arms.plain.failed,first.index.arms.plain.errorsRecorded,first.index.incomplete.length,first.index.waitingForDecision.length],[true,0,0,3,4,0]);
 assert.equal((await fs.readdir(path.join(out,'records'))).length,3);assert.match(lines.join('\n'),/Stopped: arm "plain" ended 3 runs in a row/);
 assert.equal(first.campaign.blind.status,'isolated_as_attested');assert.deepEqual(first.campaign.cases,['case-000000000001','case-000000000002']);
 assert.match(first.campaign.codeHash,/^[0-9a-f]{64}$/);assert.deepEqual(Object.keys(first.campaign.dossierHashes),first.campaign.cases);
 // Second launch adds an arm. All four agent units run; one hits the time limit, which is the reviewer's own failure.
 let launches=0,timeOutOn=2;const startedSeen=[];
 const statuses=async()=>Promise.all((await fs.readdir(path.join(out,'records'))).map(async f=>JSON.parse(await fs.readFile(path.join(out,'records',f),'utf8')).status));
 const working={agentOptions:{locate:found,launch:async({cwd})=>{launches++;startedSeen.push((await statuses()).filter(x=>x==='started').length);if(launches===timeOutOn)return {timedOut:true,code:null};await fs.writeFile(path.join(cwd,'prediction.json'),'{"verdict":"problem","quotes":["on Tuesday"]}');return {code:0};}}};
 const second=await main([...base,'--arms','always-problem,plain','--launch'],{log,context:working});
 assert.deepEqual(startedSeen,[1,1,1,1],'a unit is marked as started before its engine runs');
 assert.deepEqual(await fs.readdir(arena),[],'between reviews the arena is empty');assert.equal((await fs.readdir(path.join(out,'work'))).length,4);
 assert.equal(launches,4);assert.deepEqual([second.stopped,second.index.arms['always-problem'].completed,second.index.arms.plain.completed,second.index.arms.plain.failed,second.index.arms.plain.failureReasons,second.index.incomplete],[false,4,3,1,{timeout:1},[]]);
 // Running the same command again never re-runs a final unit, failed or completed.
 const third=await main([...base,'--arms','always-problem,plain','--launch'],{log,context:working});
 assert.equal(launches,4);assert.equal(third.index.arms.plain.failed,1);
 assert.deepEqual((await fs.readdir(path.join(out,'predictions'))).sort(),['always-problem.r1.json','always-problem.r2.json','index.json','plain.r1.json','plain.r2.json']);
 const runs=await Promise.all(['plain.r1.json','plain.r2.json'].map(async f=>JSON.parse(await fs.readFile(path.join(out,'predictions',f),'utf8'))));
 assert.deepEqual(runs.flatMap(r=>Object.values(r)).filter(p=>p.failed),[{failed:true,reason:'timeout'}]);
 const attempts=(await fs.readFile(path.join(out,'attempts.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
 assert.deepEqual([attempts.length,attempts.filter(r=>r.status==='started').length,attempts.filter(r=>r.status==='error').length],[18,7,3],'every state a unit ever had is kept');

 // Only a recorded operator decision clears a failed review to run again, and a completed one is never discarded.
 const records=(await Promise.all((await fs.readdir(path.join(out,'records'))).map(async f=>JSON.parse(await fs.readFile(path.join(out,'records',f),'utf8'))))).filter(r=>r.arm==='plain');
 const failedUnit=records.find(r=>r.status==='failed').unit,completedUnit=records.find(r=>r.status==='completed').unit;
 await assert.rejects(main(['resolve','--out',out,'--unit',completedUnit,'--as','rerun','--reason','I would like another try'],{log}),/never discarded/);
 await assert.rejects(main(['resolve','--out',out,'--unit',failedUnit,'--as','rerun'],{log}),/Give --reason/);
 await assert.rejects(main(['resolve','--out',out,'--unit',failedUnit,'--as','failed','--reason','x'],{log}),/only a unit stopped by an error/);
 await assert.rejects(main(['resolve','--out',out,'--unit',failedUnit,'--as','retry','--reason','x'],{log}),/--as rerun or --as failed/);
 await assert.rejects(main(['resolve','--out',out,'--unit','plain__case-ffffffffffff__r1','--as','rerun','--reason','x'],{log}),/no record/);
 const decided=await main(['resolve','--out',out,'--unit',failedUnit,'--as','rerun','--reason','Provider outage 14:00 to 14:20 UTC, confirmed on its status page'],{log});
 assert.deepEqual([decided.decided.length,decided.decided[0].previous],[1,{status:'failed',reason:'timeout'}]);
 await assert.rejects(main(['resolve','--out',out,'--unit',failedUnit,'--as','rerun','--reason','again'],{log}),/already cleared/);
 timeOutOn=0;
 const fourth=await main([...base,'--arms','always-problem,plain','--launch'],{log,context:working});
 assert.equal(launches,5);assert.deepEqual([fourth.index.arms.plain.completed,fourth.index.arms.plain.failed,fourth.index.arms.plain.rerunsGranted,fourth.index.incomplete],[4,0,1,[]]);
 // The strict reading keeps the cleared review as a failure, whatever its rerun gave.
 assert.deepEqual(fourth.index.arms.plain.strictRepeats,['plain.r1.strict.json','plain.r2.strict.json']);assert.equal(fourth.index.arms['always-problem'].strictRepeats,null);
 const strictRuns=await Promise.all(fourth.index.arms.plain.strictRepeats.map(async f=>JSON.parse(await fs.readFile(path.join(out,'predictions',f),'utf8'))));
 assert.deepEqual(strictRuns.flatMap(r=>Object.values(r)).filter(p=>p.failed),[{failed:true,reason:'cleared_by_operator'}]);
 const saved=JSON.parse(await fs.readFile(path.join(out,'campaign.json'),'utf8'));
 assert.deepEqual(saved.operatorDecisions.map(d=>[d.unit,d.as,d.reason]),[[failedUnit,'rerun','Provider outage 14:00 to 14:20 UTC, confirmed on its status page']]);
 assert.equal(JSON.parse(await fs.readFile(path.join(out,'records',failedUnit+'.json'),'utf8')).attempt,2);

 // Settings, cases, dossier bytes, code and arm definitions are frozen for the life of the campaign.
 const again=change=>main([...change(base),'--arms','plain','--launch'],{log,context:working});
 await assert.rejects(again(b=>b.map(v=>v==='2'?'3':v)),/started with repeats = 2/);
 await assert.rejects(again(b=>b.map(v=>v==='test-codex-model'?'other-model':v)),/started with model/);
 await assert.rejects(again(b=>b.filter(v=>v!=='--partition'&&v!=='final')),/different case list/);
 await fs.writeFile(path.join(dossiers,'case-000000000002','source.txt'),'The bridge closed on Sunday.\n');
 await assert.rejects(again(b=>b),/1 dossier\(s\) changed since this campaign started \(case-000000000002\)/);
 await fs.writeFile(path.join(dossiers,'case-000000000002','source.txt'),SOURCE);
 const tamper=async change=>{const c=JSON.parse(await fs.readFile(path.join(out,'campaign.json'),'utf8'));change(c);await fs.writeFile(path.join(out,'campaign.json'),JSON.stringify(c));};
 await tamper(c=>{c.realCodeHash=c.codeHash;c.codeHash='0'.repeat(64);});
 await assert.rejects(again(b=>b),/code changed since this campaign started/);
 await tamper(c=>{c.codeHash=c.realCodeHash;});
 assert.equal((await again(b=>b)).index.incomplete.length,0);
 await tamper(c=>{c.arms.plain.fingerprint='0'.repeat(64);});
 await assert.rejects(again(b=>b),/Arm "plain" changed/);

 const fresh=extra=>main(['--dossiers',dossiers,'--out',path.join(root,'out2'),...extra],{log});
 await assert.rejects(fresh(['--arms','plain','--arena',arena]),/Pass --agent/);
 await assert.rejects(fresh(['--arms','plain','--arena',arena,'--agent','codex']),/Pass --model/);
 await assert.rejects(fresh(['--arms','plain','--agent','codex','--model','m']),/Pass --arena/);
 await assert.rejects(fresh(['--arms','nonexistent','--agent','codex','--model','m']),/Unknown arm/);
 const savedLimit=process.env.DEEP_PROOF_WORK_MS;process.env.DEEP_PROOF_WORK_MS='1000';
 try{await assert.rejects(fresh(['--arms','plain,deep-proof-check','--arena',arena,'--agent','codex','--model','m']),/DEEP_PROOF_WORK_MS is set/);}
 finally{if(savedLimit===undefined)delete process.env.DEEP_PROOF_WORK_MS;else process.env.DEEP_PROOF_WORK_MS=savedLimit;}
 assert.throws(()=>parseArgs(['--dossiers',dossiers,'--out',out,'--arms','plain','--minutes','25']),/--minutes must be one of 10, 15, 20, 35, 60, 90/);
 assert.throws(()=>parseArgs(['--dossiers',dossiers,'--out',out,'--arms','plain','--repeats','0']),/whole number/);
 assert.throws(()=>parseArgs(['--dossiers',dossiers,'--out',out,'--arms','plain','--launch-now']),/Unknown argument/);
});

test('a unit that keeps ending in an error stops being retried and waits for a decision',async t=>{
 const root=await temp(t),dossiers=path.join(root,'host','dossiers'),out=path.join(root,'out'),lines=[],log=line=>lines.push(line);
 await dossier(dossiers,'case-000000000001');
 const command=['--dossiers',dossiers,'--out',out,'--arena',path.join(root,'arena'),'--agent','codex','--model','test-codex-model','--arms','plain','--launch'];
 let launches=0;const broken={agentOptions:{locate:found,launch:async()=>{launches++;throw Error('the runner lost its connection');}}};
 for(let attempt=1;attempt<=MAX_ERROR_ATTEMPTS;attempt++){
  const result=await main(command,{log,context:broken});
  assert.deepEqual([launches,result.index.incomplete.length,result.index.waitingForDecision.length,result.index.arms.plain.errorsRecorded],[attempt,1,attempt===MAX_ERROR_ATTEMPTS?1:0,attempt]);
 }
 const waiting=await main(command,{log,context:broken});
 assert.equal(launches,MAX_ERROR_ATTEMPTS,'it is not started a fourth time');assert.equal(waiting.index.waitingForDecision.length,1);assert.match(lines.join('\n'),/wait for a decision: run\.mjs resolve --unit plain__case-000000000001__r1/);
 await main(['resolve','--out',out,'--unit','plain__case-000000000001__r1','--as','failed','--reason','Three attempts lost the connection on this case only'],{log});
 const settled=await main(command,{log,context:broken});
 assert.equal(launches,MAX_ERROR_ATTEMPTS);assert.deepEqual([settled.index.arms.plain.failed,settled.index.arms.plain.failureReasons,settled.index.arms.plain.markedFailed,settled.index.incomplete],[1,{operator:1},1,[]]);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'predictions','plain.r1.json'),'utf8')),{'case-000000000001':{failed:true,reason:'operator'}});
});

test('a run cut short leaves a trace and counts as an attempt, and a campaign has one runner at a time',async t=>{
 const root=await temp(t),dossiers=path.join(root,'host','dossiers'),out=path.join(root,'out'),arena=path.join(root,'arena'),log=()=>{};
 await dossier(dossiers,'case-000000000001');
 const command=['--dossiers',dossiers,'--out',out,'--arena',arena,'--agent','codex','--model','test-codex-model','--arms','plain','--launch'];
 // A separate process runs the campaign and dies in the middle of the review, as after a crash or a kill.
 const script=`import {main} from ${JSON.stringify(new URL('./evaluation/benchmarks/run.mjs',import.meta.url).href)};await main(${JSON.stringify(command)},{log(){},context:{agentOptions:{locate:()=>({found:true,entry:'/opt/ala/bin/ala.mjs',root:'/opt/ala'}),launch:async()=>process.exit(7)}}});`;
 const crashed=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
 assert.equal(crashed.status,7,crashed.stderr);
 const unit='plain__case-000000000001__r1',read=async()=>JSON.parse(await fs.readFile(path.join(out,'records',unit+'.json'),'utf8'));
 assert.equal((await read()).status,'started');assert.equal((await fs.readdir(arena)).length,1);
 // The dead runner's lock does not block the next one. The cut run is settled as an attempt lost to an error
 // before the unit runs again, and the folder it left is moved out of the arena.
 const resumed=await main(command,{log,context:{agentOptions:{locate:found,launch:writes('prediction.json','{"verdict":"problem"}')}}});
 const plain=resumed.index.arms.plain;
 assert.deepEqual([plain.completed,plain.errorsRecorded,plain.attemptsLost,plain.errorsBeforeStart],[1,1,1,0]);
 const record=await read();assert.deepEqual([record.status,record.attempt,record.errorAttempts],['completed',2,1]);
 const history=(await fs.readFile(path.join(out,'attempts.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l)).map(r=>r.status+(r.reason?':'+r.reason:''));
 assert.deepEqual(history,['started','error:interrupted','started','completed']);
 assert.deepEqual(await fs.readdir(arena),[]);assert.equal((await fs.readdir(path.join(out,'work'))).length,2);
 // A second try after a cut is still a second try: the strict reading counts the unit as failed.
 assert.deepEqual([plain.interruptedUnits,plain.strictRepeats],[1,['plain.r1.strict.json']]);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'predictions','plain.r1.strict.json'),'utf8')),{'case-000000000001':{failed:true,reason:'interrupted_run'}});

 // While a live runner holds the campaign, a second one and an operator decision are refused.
 const working={log,context:{agentOptions:{locate:found,launch:writes('prediction.json','{"verdict":"problem"}')}}},lock=path.join(out,'runner.lock');
 const other=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});t.after(()=>other.kill('SIGKILL'));await wait(300);
 const namespace=lockNamespace(),held={pid:other.pid,startedAt:processStart(other.pid),namespace,at:new Date().toISOString()};assert.equal(typeof held.startedAt,'string');
 await fs.writeFile(lock,JSON.stringify(held));
 await assert.rejects(main(command,working),/Another runner \(process \d+\) is working on this campaign folder/);
 await assert.rejects(main(['resolve','--out',out,'--unit',unit,'--as','rerun','--reason','x'],{log}),/A runner \(process \d+\) is working on this campaign/);
 assert.deepEqual(JSON.parse(await fs.readFile(lock,'utf8')),held,'a refused runner leaves the holder\'s lock alone');
 // A runner in another container or on another host cannot be looked up, so its lock counts while it is being
 // refreshed, whatever process id it names, and stops counting once the refreshing has stopped for a while.
 const elsewhere=at=>({pid:process.pid,startedAt:'Thu Jan  1 00:00:00 1970',namespace:'another-container',at});
 await fs.writeFile(lock,JSON.stringify(elsewhere(new Date().toISOString())));
 await assert.rejects(main(command,working),/Another runner \(process \d+ in another container or host, active \d+ seconds ago\) is working on this campaign folder/);
 await assert.rejects(main(['resolve','--out',out,'--unit',unit,'--as','rerun','--reason','x'],{log}),/in another container or host/);
 await fs.writeFile(lock,JSON.stringify(elsewhere(new Date(Date.now()-10*60000).toISOString())));
 assert.equal((await main(command,working)).index.incomplete.length,0);assert.equal(existsSync(lock),false);
 // In this namespace a lock does not block when its process id now belongs to a later process, when it names
 // this process, or when its process is gone.
 for(const stale of [{pid:other.pid,startedAt:'Thu Jan  1 00:00:00 1970',namespace,at:new Date().toISOString()},{pid:process.pid,startedAt:'Thu Jan  1 00:00:00 1970',namespace,at:new Date().toISOString()}]){
  await fs.writeFile(lock,JSON.stringify(stale));assert.equal((await main(command,working)).index.incomplete.length,0);assert.equal(existsSync(lock),false);
 }
 other.kill('SIGKILL');for(let i=0;i<50&&!gone(other.pid);i++)await wait(100);
 await fs.writeFile(lock,JSON.stringify(held));assert.equal((await main(command,working)).index.incomplete.length,0);assert.equal(existsSync(lock),false);
 // An arena belongs to one campaign: its work folders are never moved by another one.
 await assert.rejects(main(command.map(v=>v===arena?path.join(root,'arena2'):v),working),/This campaign uses the arena/);
 await fs.mkdir(path.join(arena,'run-0123456789abcdef'));
 await assert.rejects(main(command.map(v=>v===out?path.join(root,'out2'):v),working),/holds work folders of another run/);
 assert.deepEqual(await fs.readdir(arena),['run-0123456789abcdef']);assert.equal(existsSync(path.join(root,'out2','runner.lock')),false);
});

test('the campaign lock is refreshed by its holder, and a runner that lost it starts nothing more',async t=>{
 const root=await temp(t),out=path.join(root,'out'),file=path.join(out,'runner.lock'),read=async()=>JSON.parse(await fs.readFile(file,'utf8'));
 const lock=acquireLock(out,{heartbeatMs:40});t.after(()=>lock.release());
 const first=await read();assert.deepEqual([first.pid,first.namespace,typeof first.startedAt],[process.pid,lockNamespace(),'string']);
 await wait(300);assert.ok(Date.parse((await read()).at)>Date.parse(first.at),'the holder refreshes its lock');assert.equal(lock.lost(),false);
 // The start time that identifies the holder reads the same from an environment with another time zone, and a
 // process that does not exist is told apart from one that could not be checked.
 const savedZone=process.env.TZ;try{process.env.TZ='Asia/Tokyo';assert.equal(processStart(process.pid),first.startedAt);}finally{if(savedZone===undefined)delete process.env.TZ;else process.env.TZ=savedZone;}
 const ended=spawnSync(process.execPath,['-e','']);assert.equal(processStart(ended.pid),null,'a process that has ended');
 // Another runner takes over, as it may after this one looked dead for a long time. This one notices and leaves the lock alone.
 // Written in one synchronous step: an asynchronous write from this same process could land in the middle of the
 // holder's own refresh, which no other process can do to it.
 const theirs={pid:1,startedAt:'x',namespace:'another-container',at:new Date().toISOString()};writeFileSync(file,JSON.stringify(theirs));
 await wait(150);assert.equal(lock.lost(),true);lock.release();assert.deepEqual(await read(),theirs);
 await fs.rm(file);
 // In a campaign: the lock is lost during the first review, so the second one is not started.
 const dossiers=path.join(root,'host','dossiers'),lines=[];await dossier(dossiers,'case-000000000001');
 const command=['--dossiers',dossiers,'--out',out,'--arena',path.join(root,'arena'),'--agent','codex','--model','test-codex-model','--arms','plain','--repeats','2','--launch'];
 let launches=0;
 const result=await main(command,{log:line=>lines.push(line),context:{agentOptions:{locate:found,launch:async({cwd})=>{launches++;writeFileSync(file,JSON.stringify({...theirs,at:new Date().toISOString()}));await fs.writeFile(path.join(cwd,'prediction.json'),'{"verdict":"problem"}');return {code:0};}}}});
 assert.deepEqual([launches,result.stopped,result.index.arms.plain.completed,result.index.incomplete.length],[1,true,1,1]);
 assert.match(lines.join('\n'),/Stopped: another runner has taken over this campaign folder/);assert.equal((await read()).namespace,'another-container');
});

test('when a finished work folder cannot leave the arena, the review is kept and the run stops',async t=>{
 const root=await temp(t),dossiers=path.join(root,'host','dossiers'),out=path.join(root,'out'),lines=[];
 await dossier(dossiers,'case-000000000001');await fs.writeFile(path.join(root,'not-a-folder'),'x');
 const command=['--dossiers',dossiers,'--out',out,'--arena',path.join(root,'arena'),'--agent','codex','--model','test-codex-model','--arms','plain','--repeats','2','--launch'];
 const result=await main(command,{log:line=>lines.push(line),context:{agentOptions:{archive:path.join(root,'not-a-folder'),locate:found,launch:writes('prediction.json','{"verdict":"problem"}')}}});
 assert.deepEqual([result.stopped,result.index.arms.plain.completed,result.index.arms.plain.errorsRecorded,result.index.incomplete.length],[true,1,0,1]);
 assert.match(lines.join('\n'),/Stopped: the work folder of plain__case-000000000001__r\d could not be moved out of the arena/);
});

test('reviews an operator cleared to run again are shown both ways, and a result that depends on them is exploratory',async t=>{
 const root=await temp(t),out=path.join(root,'out'),gold=path.join(root,'keys');await fs.mkdir(path.join(out,'records'),{recursive:true});await fs.mkdir(gold);
 const cases=[],records=[],decisions=[],fingerprint={plain:'a'.repeat(64),'deep-proof-check':'b'.repeat(64)};
 // Hand-authored campaign: the baseline flags 4 of 12 problem cases. The candidate flags all 12, but 8 of them
 // only on a rerun that an operator granted after a failed review.
 for(let i=0;i<24;i++){
  const caseId='case-'+String(i).padStart(12,'0'),problem=i<12;cases.push(caseId);
  await fs.writeFile(path.join(gold,caseId+'.json'),JSON.stringify({caseId,dataset:'ragtruth',family:`family-${i}`,model:'m',partition:'final',expected:{verdict:problem?'problem':'no_problem'},aiOutput:SUMMARY,spans:[]}));
  const record=(arm,verdict)=>({unit:unitId(arm,caseId,1),arm,armFingerprint:fingerprint[arm],caseId,repeat:1,startedAt:'2026-01-01T00:00:00.000Z',durationMs:60000,status:'completed',prediction:{verdict,quotes:[]},details:{findings:[]}});
  records.push(record('plain',problem&&i<4?'problem':'no_problem'),record('deep-proof-check',problem?'problem':'no_problem'));
  if(problem&&i>=4)decisions.push({at:'2026-01-01T01:00:00.000Z',unit:unitId('deep-proof-check',caseId,1),arm:'deep-proof-check',as:'rerun',reason:'hand-authored example',previous:{status:'failed',reason:'timeout'}});
 }
 for(const r of records)await fs.writeFile(path.join(out,'records',r.unit+'.json'),JSON.stringify(r));
 await fs.writeFile(path.join(out,'campaign.json'),JSON.stringify({agent:'codex',model:'m',effort:'',minutes:35,repeats:1,seed:1,cases,blind:{status:'isolated_as_attested',visibleKeys:[]},arms:{plain:{kind:'agent',fingerprint:fingerprint.plain},'deep-proof-check':{kind:'check',fingerprint:fingerprint['deep-proof-check']}},operatorDecisions:decisions}));
 const index=await collect(out);
 assert.deepEqual([index.arms.plain.strictRepeats,index.arms['deep-proof-check'].strictRepeats,index.arms['deep-proof-check'].rerunsGranted],[null,['deep-proof-check.r1.strict.json'],8]);
 const strict=JSON.parse(await fs.readFile(path.join(out,'predictions','deep-proof-check.r1.strict.json'),'utf8'));
 assert.equal(Object.values(strict).filter(p=>p.failed&&p.reason==='cleared_by_operator').length,8);
 const compared=spawnSync(process.execPath,[path.join(benchmarks,'compare.mjs'),'--gold',gold,'--predictions',path.join(out,'predictions'),'--baseline','plain','--candidate','deep-proof-check','--partition','final','--bootstrap','2000','--output',path.join(root,'comparison.json')],{encoding:'utf8'});
 assert.equal(compared.status,0,compared.stderr);
 assert.match(compared.stdout,/Problem cases flagged\s+33\.3%\s+100\.0%\s+\+66\.7 points/);
 assert.match(compared.stdout,/Exploratory reading, not a campaign result\. The interval for balanced accuracy lies above zero/);
 assert.match(compared.stdout,/Strict reading, with every review that was cleared by an operator or cut short and then run again counted as failed: balanced accuracy 66\.7% against 66\.7%, \+0\.0 points[^\n]*includes zero/);
 assert.match(compared.stdout,/Warning: The two readings disagree/);assert.match(compared.stdout,/Warning: Operator decisions for "deep-proof-check": 8 unit\(s\) cleared to run again/);
 const saved=JSON.parse(await fs.readFile(path.join(root,'comparison.json'),'utf8'));
 assert.deepEqual([saved.exploratory,saved.difference.balancedAccuracy.value,saved.strictReading.difference.balancedAccuracy.value,saved.strictReading.candidate.failed],[true,0.3333,0,8]);
});

test('the code hash that freezes a campaign follows every file under it',async t=>{
 assert.match(codeHash(),/^[0-9a-f]{64}$/);assert.equal(codeHash(),codeHash());
 const root=await temp(t);await fs.mkdir(path.join(root,'src','deep'),{recursive:true});
 await fs.writeFile(path.join(root,'server.mjs'),'a');await fs.writeFile(path.join(root,'src','deep','prompt.mjs'),'b');
 const before=codeHash(root,['server.mjs','src']);
 await fs.writeFile(path.join(root,'src','deep','prompt.mjs'),'c');const edited=codeHash(root,['server.mjs','src']);assert.notEqual(edited,before);
 await fs.writeFile(path.join(root,'src','new.mjs'),'');assert.notEqual(codeHash(root,['server.mjs','src']),edited);
});

test('Check Report records can be re-read under another category rule without running again',async t=>{
 const out=await temp(t),arm=(await loadArms())['deep-proof-check'],{promptText,...saved}=arm;
 await fs.writeFile(path.join(out,'campaign.json'),JSON.stringify({agent:'codex',model:'m',effort:'',minutes:35,repeats:1,seed:1,cases:['case-000000000001'],blind:{status:'isolated_as_attested',visibleKeys:[]},arms:{'deep-proof-check':saved}}));
 await fs.mkdir(path.join(out,'records'));
 const record={unit:unitId('deep-proof-check','case-000000000001',1),arm:'deep-proof-check',armFingerprint:arm.fingerprint,caseId:'case-000000000001',repeat:1,startedAt:'2026-01-01T00:00:00.000Z',durationMs:600000,status:'completed',prediction:{verdict:'no_problem',quotes:[]},details:{findings:[{id:'F-1',verdict:'confirmed',level:'target',categories:['F04'],severity:'minor',quote:null}]}};
 await fs.writeFile(path.join(out,'records',record.unit+'.json'),JSON.stringify(record));
 const frozen=await collect(out);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'predictions','deep-proof-check.r1.json'),'utf8')),{'case-000000000001':{verdict:'no_problem',quotes:[]}});
 assert.deepEqual([frozen.arms['deep-proof-check'].engineMinutes,frozen.flagCategoriesOverride,frozen.arms['deep-proof-check'].meanStartedAt],[10,null,'2026-01-01T00:00:00.000Z']);
 const any=await collect(out,{predictions:path.join(out,'predictions-any'),flagCategories:'all'});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(out,'predictions-any','deep-proof-check.r1.json'),'utf8')),{'case-000000000001':{verdict:'problem',quotes:[]}});
 assert.equal(any.flagCategoriesOverride,'all');
 // A record made under another fingerprint is never pooled with this campaign.
 await fs.writeFile(path.join(out,'records',record.unit+'.json'),JSON.stringify({...record,armFingerprint:'f'.repeat(64)}));
 assert.deepEqual((await collect(out)).incomplete,[record.unit]);
});

test('the paired comparison counts failures as wrong answers and resamples document families',()=>{
 const g=(caseId,verdict,family,partition='final')=>({caseId,dataset:'d',family,partition,expected:{verdict}});
 const gold=[];for(let i=0;i<20;i++)gold.push(g(`p${i}`,'problem',`f${i%10}`),g(`c${i}`,'no_problem',`f${i%10}`));
 gold.push(g('amb','ambiguous','f0'),g('ref','refusal','f1'),g('dev','problem','f2','development'));
 const flag={verdict:'problem'},pass={verdict:'no_problem'},failed={failed:true,reason:'timeout'};
 const run=(hits,fails=[])=>Object.fromEntries(gold.map(x=>[x.caseId,fails.includes(x.caseId)?failed:x.caseId.startsWith('p')?(hits.includes(x.caseId)?flag:pass):pass]));
 const first10=[...Array(10)].map((_,i)=>`p${i}`),first18=[...Array(18)].map((_,i)=>`p${i}`);
 const result=compareArms(gold,[run(first10)],[run(first18)],{partition:'final',bootstrap:2000,seed:7});
 assert.deepEqual(result.cases,{problem:20,clean:20,families:10});assert.deepEqual(result.excluded,{ambiguous:1,refusal:1,otherPartition:1});
 assert.deepEqual([result.baseline.sensitivity,result.candidate.sensitivity,result.baseline.specificity,result.candidate.specificity],[0.5,0.9,1,1]);
 assert.deepEqual([result.difference.sensitivity.value,result.difference.specificity.value,result.difference.balancedAccuracy.value],[0.4,0,0.2]);
 assert.ok(result.difference.sensitivity.ci95[0]>0&&result.difference.sensitivity.ci95[1]<=1);
 assert.deepEqual(result.mcnemar.problemCases,{b:8,c:0,p:0.0078125});assert.deepEqual(result.mcnemar.cleanCases,{b:0,c:0,p:1});
 assert.deepEqual(compareArms(gold,[run(first10)],[run(first18)],{partition:'final',bootstrap:2000,seed:7}).difference,result.difference,'same seed, same interval');
 // A candidate that fails on the cases it would have missed gains nothing.
 const dodging=compareArms(gold,[run(first10)],[run(first18,['p18','p19','c0'])],{partition:'final',bootstrap:1000});
 assert.deepEqual([dodging.candidate.sensitivity,dodging.candidate.specificity,dodging.candidate.failed,dodging.candidate.failureRate],[0.9,0.95,3,0.075]);
 // With repeats a case contributes the share of repeats that were right; the exact test wants every repeat right.
 const repeated=compareArms(gold,[run(first10),run(first10)],[run(first18),run(first10)],{partition:'final',bootstrap:1000});
 assert.deepEqual([repeated.repeats,repeated.candidate.sensitivity,repeated.mcnemar.problemCases.b,repeated.candidate.casesWithSameOutcomeEveryRepeat],[2,0.7,0,0.8]);
 const partial=run(first10);delete partial.p3;
 assert.throws(()=>compareArms(gold,[partial],[run(first18)],{partition:'final'}),/lack a final review/);
 assert.deepEqual(compareArms(gold,[partial],[run(first18)],{partition:'final',bootstrap:1000,allowIncomplete:true}).incomplete,['p3']);
 assert.throws(()=>compareArms(gold,[run(first10)],[run(first18),run(first18)]),/same number of repeats/);
 assert.throws(()=>compareArms(gold,[{...run(first10),p0:{verdict:'problem',failed:1}}],[run(first18)]),/failed review is/);
 assert.equal(compareArms(gold.slice(0,2),[run(first10)],[run(first18)],{bootstrap:1000}).difference.sensitivity.ci95[0],0,'one family: every resample is the same');
});

test('exact McNemar values and the seeded generator are stable',()=>{
 assert.deepEqual(mcnemarExact(8,1),{b:8,c:1,p:0.0390625});assert.equal(mcnemarExact(1,8).p,0.0390625);
 assert.equal(mcnemarExact(0,0).p,1);assert.equal(mcnemarExact(5,5).p,1);assert.equal(mcnemarExact(6,0).p,0.03125);
 assert.ok(mcnemarExact(1500,1000).p<1e-20,'large counts must not overflow');assert.ok(Math.abs(mcnemarExact(1200,1200).p-1)<1e-9);
 const a=mulberry32(42),b=mulberry32(42),values=[a(),a(),a()];
 assert.deepEqual(values,[b(),b(),b()]);assert.ok(values.every(v=>v>=0&&v<1));assert.notEqual(mulberry32(43)(),values[0]);
});

test('a comparison states what weakens it, and says when it is only exploratory',()=>{
 const arm=(first,last,more={})=>({kind:'agent',firstStartedAt:first,lastStartedAt:last,meanStartedAt:new Date((Date.parse(first)+Date.parse(last))/2).toISOString(),rerunsGranted:0,markedFailed:0,suspectFailures:0,interruptedUnits:0,...more});
 const sound={setup:{repeats:3},blind:{status:'isolated_as_attested'},flagCategoriesOverride:null,arms:{plain:arm('2026-01-01T00:00:00Z','2026-01-02T00:00:00Z'),check:arm('2026-01-01T01:00:00Z','2026-01-02T01:00:00Z',{kind:'check'})}};
 assert.deepEqual(warnings(sound,'plain','check'),[]);
 const texts=(index,options)=>warnings(index,'plain','check',options).map(n=>`${n.exploratory?'[exploratory] ':''}${n.text}`).join('\n');
 assert.match(texts(sound,{partition:null}),/\[exploratory\] This reading is not restricted to the final partition/);
 assert.match(texts(sound,{partition:'development'}),/\[exploratory\] This reading is on the development partition/);
 assert.match(texts(sound,{incomplete:2}),/\[exploratory\] 2 case\(s\) were left out/);
 const weak={setup:{repeats:1},blind:{status:'exposed'},flagCategoriesOverride:'all',arms:{plain:arm('2026-01-01T00:00:00Z','2026-01-02T00:00:00Z',{kind:'constant'}),check:arm('2026-01-03T00:00:00Z','2026-01-04T00:00:00Z',{kind:'check'})}};
 assert.match(texts(weak),/\[exploratory\] Answer keys were readable[\s\S]*\[exploratory\] Check Report verdicts were recomputed[\s\S]*\[exploratory\] One arm is a constant answer[\s\S]*at least three[\s\S]*did not run over the same period \(on average 48\.0 hours apart\)/);
 // One early run of the other arm must not hide that the arms mostly ran days apart.
 const skewed={...sound,arms:{plain:arm('2026-01-01T00:00:00Z','2026-01-02T00:00:00Z'),check:arm('2026-01-01T00:30:00Z','2026-01-09T00:00:00Z',{kind:'check',meanStartedAt:'2026-01-08T00:00:00Z'})}};
 assert.match(texts(skewed),/did not run over the same period/);
 const decided={...sound,arms:{plain:sound.arms.plain,check:{...sound.arms.check,rerunsGranted:2,markedFailed:1,suspectFailures:4}}};
 assert.match(texts(decided),/Operator decisions for "check": 2 unit\(s\) cleared to run again, 1 marked as failed[\s\S]*4 failed review\(s\) of "check" may be infrastructure problems/);
 assert.ok(warnings(decided,'plain','check').every(n=>!n.exploratory));
 assert.match(texts({...sound,arms:{plain:{...sound.arms.plain,interruptedUnits:3},check:sound.arms.check}}),/3 review\(s\) of "plain" were cut short and run again/);
});

test('the scripts run end to end on a hand-authored campaign with constant arms',async t=>{
 const root=await temp(t),dossiers=path.join(root,'host','dossiers'),out=path.join(root,'out'),gold=path.join(root,'keys');await fs.mkdir(gold);
 for(const [i,verdict] of ['problem','no_problem','problem','no_problem'].entries()){
  const caseId=`case-00000000000${i+1}`;await dossier(dossiers,caseId);
  await fs.writeFile(path.join(gold,caseId+'.json'),JSON.stringify({caseId,dataset:'ragtruth',family:`family-${i}`,model:'m',partition:'final',expected:{verdict},aiOutput:SUMMARY,spans:[]}));
 }
 const node=(script,...args)=>spawnSync(process.execPath,[path.join(benchmarks,script),...args],{encoding:'utf8'});
 const plan=node('run.mjs','--dossiers',dossiers,'--out',out,'--arms','always-problem,always-clear');
 assert.equal(plan.status,0,plan.stderr);assert.match(plan.stdout,/4 case\(s\) × 2 arm\(s\) × 1 repeat\(s\) = 8 unit\(s\)[\s\S]*Nothing was run/);
 const launched=node('run.mjs','--dossiers',dossiers,'--out',out,'--arms','always-problem,always-clear','--launch');
 assert.equal(launched.status,0,launched.stderr);assert.match(launched.stdout,/always-problem: completed 4, failed 0, errors recorded 0/);
 const scored=node('score.mjs','--gold',gold,'--predictions',path.join(out,'predictions','always-problem.r1.json'));
 assert.equal(scored.status,0,scored.stderr);assert.match(scored.stdout,/all: TP 2 FP 2 FN 0 TN 0; missing 0; failed 0/);
 const compare=(...more)=>node('compare.mjs','--gold',gold,'--predictions',path.join(out,'predictions'),'--baseline','always-clear','--candidate','always-problem','--bootstrap','1000',...more);
 const compared=compare('--partition','final','--output',path.join(root,'comparison.json'));
 assert.equal(compared.status,0,compared.stderr);
 assert.match(compared.stdout,/Problem cases flagged\s+0\.0%\s+100\.0%\s+\+100\.0 points/);assert.match(compared.stdout,/Clean cases passed\s+100\.0%\s+0\.0%\s+-100\.0 points/);
 assert.match(compared.stdout,/Balanced accuracy\s+50\.0%\s+50\.0%\s+\+0\.0 points/);assert.match(compared.stdout,/Errors before a review\s+0\s+0/);assert.match(compared.stdout,/Attempts lost to an error\s+0\s+0/);
 assert.match(compared.stdout,/Exploratory reading, not a campaign result\. The interval for balanced accuracy includes zero/);assert.match(compared.stdout,/Warning: One arm is a constant answer/);
 assert.doesNotMatch(compared.stdout,/not restricted to the final partition/);assert.match(compare().stdout,/Warning: This reading is not restricted to the final partition/);
 const saved=JSON.parse(await fs.readFile(path.join(root,'comparison.json'),'utf8'));
 assert.deepEqual([saved.baselineArm,saved.candidateArm,saved.cases.problem,saved.cases.clean,saved.exploratory],['always-clear','always-problem',2,2,true]);
 const missingArm=node('compare.mjs','--gold',gold,'--predictions',path.join(out,'predictions'),'--baseline','plain','--candidate','always-problem');
 assert.equal(missingArm.status,1);assert.match(missingArm.stderr,/Arm "plain" is not in this campaign/);
});
