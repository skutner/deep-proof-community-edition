import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {executeDocumentTool,processUpload,removeWorkspace} from '../src/documents.mjs';
import {importSkillArchive} from '../src/skill-import.mjs';
import {withQualityWorkspace} from '../src/quality-job.mjs';
import {createPDF} from '../src/pdf.mjs';
import {validateMarkdownReport} from '../src/markdown-report.mjs';
// Gives every real folder under dir mode 0o700 without following a link, so that a folder a tool locked cannot stop a
// clean-up. It does not use removeWorkspace, which one test checks.
function unlock(dir){
 let stat;try{stat=fs.lstatSync(dir);}catch{return;}
 if(!stat.isDirectory())return;
 fs.chmodSync(dir,0o700);for(const entry of fs.readdirSync(dir,{withFileTypes:true}))if(entry.isDirectory())unlock(path.join(dir,entry.name));
}
// A parent folder under the resolved temporary folder with a stand-in for Deep Proof's data folder. One clean-up,
// registered before anything else, removes it (also folders a tool locked) and puts TMPDIR back (a test may point TMPDIR at a link).
function arena(t){
 const before=process.env.TMPDIR,parent=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'dp-out-')),data=path.join(parent,'data');
 t.after(()=>{if(before===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=before;unlock(parent);fs.rmSync(parent,{recursive:true,force:true});});
 fs.mkdirSync(data);fs.writeFileSync(path.join(data,'analyst.sqlite'),'DATA-SENTINEL');
 return {parent,data};
}
// TMPDIR on a link the test made, as the system's own /var is on macOS.
function linkedTemporaryFolder(parent){
 const real=path.join(parent,'tmp-real'),link=path.join(parent,'tmp-link');
 fs.mkdirSync(real);fs.symlinkSync(real,link);process.env.TMPDIR=link;assert.equal(os.tmpdir(),link);assert.notEqual(fs.realpathSync(os.tmpdir()),os.tmpdir());
 return real;
}
const hostPython=(code,input)=>{const r=spawnSync('python3',['-c',code],{input,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
const uploads={pdf:{name:'evidence.pdf',data:Buffer.from('%PDF-1.4\nstand-in').toString('base64')},docx:{name:'evidence.docx',data:Buffer.from('PK\u0003\u0004stand-in').toString('base64')},doc:{name:'evidence.doc',data:Buffer.concat([Buffer.from('d0cf11e0a1b11ae1','hex'),Buffer.from('stand-in')]).toString('base64')}};
// A stand-in for a compromised converter. Each step of a conversion runs python3 inside the real sandbox, in the
// conversion's own workspace, with the code planned for that step; a step without a plan writes a plausible output.
// Every call is recorded with the fourth argument it received, which the stand-in hands on to the real tool.
const STEPS={'office:docx':"open('document.docx','wb').write(b'PK stand-in')",'office:pptx':"open('document.pptx','wb').write(b'PK stand-in')",extract:"open('office.txt','w').write('Office text')",'office:pdf':"open('document.pdf','wb').write(b'%PDF-1.4 stand-in')",pdftotext:"open('extracted.txt','w').write('Extracted text')"};
function compromised(plan,seen={},calls=[]){
 return async(binary,args,ws,options)=>{
  const step=binary==='pdftotext'?'pdftotext':binary==='python3'?'extract':'office:'+args[args.indexOf('--convert-to')+1];
  calls.push({step,ws,options});
  await executeDocumentTool('python3',['-c',plan[step]??STEPS[step]],ws,options);
  if(plan[step])seen[step]=plan.observe?.(ws)??true;
 };
}
const kindOf=file=>{const s=fs.lstatSync(file);return s.isSymbolicLink()?'link':s.isFIFO()?'pipe':s.isDirectory()?'folder':s.nlink>1?'second name':'file';};

test('with the temporary folder behind a link, skill import and the Check Report workspace still work',async t=>{
 const {parent}=arena(t),real=linkedTemporaryFolder(parent);
 const entry='---\nname: supplier-review\ndescription: Review supplied supplier evidence.\n---\n\n# Supplier review\n\nCompare contractual duties and delivery records.\n';
 const files={'references/review-criteria.md':'## C01 — Contractual Duties\nAssess supplied contracts.','references/review-playbook.md':'Compare contractual duties and delivery records.','references/methodology.md':'Compare duties with deliveries.','references/report-template.md':'<!-- role: criteria -->\n## Contractual Duties\nAssess each criterion.','SKILL.md':entry};
 const zip=hostPython("import sys,json,io,zipfile,base64\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n for name,text in json.load(sys.stdin).items(): z.writestr(name,text)\nprint(base64.b64encode(b.getvalue()).decode())",JSON.stringify(files));
 const imported=await importSkillArchive({name:'skill.zip',data:zip},'behind-link');assert.match(imported.files['SKILL.md'],/name: analysis-type-behind-link/);
 const folder=path.join(parent,'analysis');fs.mkdirSync(path.join(folder,'sources'),{recursive:true});fs.writeFileSync(path.join(folder,'sources','d1.pdf'),'%PDF-1.4 stand-in');
 assert.deepEqual(await withQualityWorkspace(folder,{documents:[{id:'d1',file_type:'pdf'}]},async ws=>{assert.equal(fs.realpathSync(ws),ws,'the workspace is a real folder');assert.equal(path.dirname(ws),real,'the workspace was made in the real temporary folder');return fs.readdirSync(path.join(ws,'sources'));}),['d1.pdf']);
 assert.deepEqual(fs.readdirSync(real),[],'both temporary folders were made in the real folder and removed');
});

test('plain outputs are still read, also with the temporary folder behind a link',async t=>{
 const {parent}=arena(t);
 // Control for the tests below: the stand-in steps alone give a complete conversion.
 for(const linked of [false,true]){
  const real=linked?linkedTemporaryFolder(parent):null,calls=[];
  const office=await processUpload(uploads.docx,'Evidence',{runTool:compromised({},{},calls)});assert.match(office.markdown,/## Page 1\n\nExtracted text/);assert.match(office.markdown,/# Original Office content\n\nOffice text/);assert.equal(office.preview.toString(),'%PDF-1.4 stand-in');
  const pdf=await processUpload(uploads.pdf,'Evidence',{runTool:compromised({},{},calls)});assert.match(pdf.markdown,/Extracted text/);assert.equal(pdf.preview,null);
  const legacy=await processUpload(uploads.doc,'Evidence',{runTool:compromised({},{},calls)});assert.match(legacy.markdown,/Office text/);assert.equal(legacy.preview.toString(),'%PDF-1.4 stand-in');
  // Only the LibreOffice call asks for Launch Services (the fourth argument); the python3 and pdftotext calls get nothing.
  assert.deepEqual(calls.map(c=>[c.step,c.options]),[['extract',undefined],['office:pdf',{launchServices:true}],['pdftotext',undefined],['pdftotext',undefined],
   ['office:docx',{launchServices:true}],['extract',undefined],['office:pdf',{launchServices:true}],['pdftotext',undefined]]);
  if(real){assert.deepEqual(fs.readdirSync(real),[],'the temporary folders were made in the real folder and removed');for(const c of calls)assert.equal(path.dirname(c.ws),real,'the conversion folder was made in the resolved folder');}
 }
});

test('a link planted as an output is refused, not followed: extracted text, Office text and preview',async t=>{
 const {data}=arena(t),secret=path.join(data,'analyst.sqlite');
 for(const [upload,step,name] of [['pdf','pdftotext','extracted.txt'],['docx','extract','office.txt'],['docx','office:pdf','document.pdf']]){
  const seen={},plan={[step]:`import os\nos.symlink(${JSON.stringify(secret)},${JSON.stringify(name)})`,observe:ws=>[kindOf(path.join(ws,name)),fs.readFileSync(path.join(ws,name),'utf8')]};
  let result=null,failure=null;try{result=await processUpload(uploads[upload],'Evidence',{runTool:compromised(plan,seen)});}catch(error){failure=error;}
  assert.deepEqual(seen[step],['link','DATA-SENTINEL'],`control: the confined tool planted ${name}, and a plain read of it returns the secret`);
  assert.equal(result,null,`${name}: the upload must not succeed`);assert.ok(failure,`${name}: the upload must fail`);assert.match(failure.message,/Artifact paths must not contain symbolic links/,name);assert.equal(failure.status,undefined);
  assert.ok(!JSON.stringify([failure.message,result]).includes('SENTINEL'));
 }
 // A link to a path that does not exist must end exactly as a link to a path that does, so that the answer tells the uploader nothing about the host.
 const ended={};
 for(const [label,target,exists] of [['existing target',secret,true],['dangling target',path.join(data,'does-not-exist'),false]]){
  const seen={},plan={'office:pdf':`import os\nos.symlink(${JSON.stringify(target)},'document.pdf')`,observe:ws=>[kindOf(path.join(ws,'document.pdf')),fs.existsSync(path.join(ws,'document.pdf'))]};
  let result=null,failure=null;try{result=await processUpload(uploads.docx,'Evidence',{runTool:compromised(plan,seen)});}catch(error){failure=error;}
  assert.deepEqual(seen['office:pdf'],['link',exists],`control: the confined tool planted a link to a path that ${exists?'exists':'does not exist'} (${label})`);
  assert.equal(result,null,`${label}: the upload must not succeed`);assert.ok(failure,`${label}: the upload must fail`);assert.ok(!JSON.stringify([failure.message,result]).includes('SENTINEL'));
  ended[label]={message:failure.message,status:failure.status};
 }
 assert.match(ended['dangling target'].message,/Artifact paths must not contain symbolic links/);assert.equal(ended['dangling target'].status,undefined);
 assert.deepEqual(ended['dangling target'],ended['existing target'],'the same message and status whether or not the link target exists');
});

// The pipe case runs in a child process under a hard bound: a read that blocks on a pipe must fail the test, not hang the suite.
// The child resolves the code under test from this file's own place, and gets a temporary folder inside the arena.
const PIPE_CHILD=`import fs from 'node:fs';import {executeDocumentTool,processUpload} from ${JSON.stringify(new URL('../src/documents.mjs',import.meta.url).href)};
const data=Buffer.from('%PDF-1.4\\nstand-in').toString('base64');let kind=null,message=null,status=null;
try{await processUpload({name:'evidence.pdf',data},'Evidence',{runTool:async(binary,args,ws,options)=>{await executeDocumentTool('python3',['-c',"import os\\nos.mkfifo('extracted.txt')"],ws,options);kind=fs.lstatSync(ws+'/extracted.txt').isFIFO()?'pipe':'other';}});}
catch(error){message=error.message;status=error.status??null;}
process.stdout.write(JSON.stringify({kind,message,status}));`;
test('an output that is not one plain file of a fitting size is refused: a second name, a pipe, a folder, too large',async t=>{
 const {parent}=arena(t);
 for(const [label,upload,step,code,name,kind,expected,status] of [
  ['second name','pdf','pdftotext',"import os\nos.link('document.pdf','extracted.txt')",'extracted.txt','second name',/Artifact files must not use hard links/,undefined],
  ['folder','pdf','pdftotext',"import os\nos.mkdir('extracted.txt')",'extracted.txt','folder',/Artifact must be a regular file/,undefined],
  ['too much text','pdf','pdftotext',"open('extracted.txt','wb').truncate(8000001)",'extracted.txt','file',/This document contains too much text/,400],
  ['too much blank text','pdf','pdftotext',"open('extracted.txt','w').write(' '*8000001)",'extracted.txt','file',/This document contains too much text/,400],
  ['too much Office text','docx','extract',"open('office.txt','wb').truncate(8000001)",'office.txt','file',/This document contains too much text/,400]]){
  const seen={},plan={[step]:code,observe:ws=>kindOf(path.join(ws,name))},started=Date.now();
  await assert.rejects(processUpload(uploads[upload],'Evidence',{runTool:compromised(plan,seen)}),error=>{assert.match(error.message,expected,label);assert.equal(error.status,status,label);return true;});
  assert.equal(seen[step],kind,`control: the confined tool planted it (${label})`);
  assert.ok(Date.now()-started<10000,`${label}: refused without waiting on it`);
 }
 const childTemporary=path.join(parent,'pipe-tmp');fs.mkdirSync(childTemporary);
 const child=spawnSync(process.execPath,['--input-type=module','-e',PIPE_CHILD],{encoding:'utf8',timeout:20000,killSignal:'SIGKILL',env:{...process.env,TMPDIR:childTemporary}});
 assert.ok(!child.error&&child.signal===null,`pipe: the conversion did not finish within 20 seconds and was killed (${child.error?.code??child.signal})`);
 assert.equal(child.status,0,child.stderr);const piped=JSON.parse(child.stdout);
 assert.equal(piped.kind,'pipe','control: the confined tool planted it (pipe)');assert.match(piped.message,/Artifact must be a regular file/,'pipe');assert.equal(piped.status,null,'pipe');
 // A plain preview over the limit is not a reason to refuse the upload: it is accepted without a preview, the text intact.
 const seen={},plan={'office:pdf':`open('document.pdf','wb').truncate(${30*1024*1024+1})`,observe:ws=>kindOf(path.join(ws,'document.pdf'))};
 const result=await processUpload(uploads.docx,'Evidence',{runTool:compromised(plan,seen)});
 assert.equal(seen['office:pdf'],'file','control: the confined tool planted it (preview too large)');assert.equal(result.preview,null);
 assert.match(result.markdown,/## Page 1\n\nExtracted text/);assert.match(result.markdown,/# Original Office content\n\nOffice text/);
});

test('a link planted where the server puts its extraction script is not written through',async t=>{
 const {data}=arena(t),victim=path.join(data,'victim.txt');fs.writeFileSync(victim,'VICTIM');
 const seen={},plan={'office:docx':`import os\nif os.path.lexists('extract-office.py'): os.unlink('extract-office.py')\nos.symlink(${JSON.stringify(victim)},'extract-office.py')\nopen('document.docx','wb').write(b'PK stand-in')`,observe:ws=>kindOf(path.join(ws,'extract-office.py'))};
 await processUpload(uploads.doc,'Evidence',{runTool:compromised(plan,seen)}).catch(()=>{});
 assert.equal(seen['office:docx'],'link','control: the confined tool planted the link');assert.equal(fs.readFileSync(victim,'utf8'),'VICTIM');
});

test('outputs exactly at the limits are accepted: a 30 MiB preview, 2,000,000 euro signs, 1,000,000 four-byte characters',async t=>{
 arena(t);const limit=30*1024*1024;
 // The tool marks both ends of the preview, so that "returned whole" means more than "no error".
 const preview=await processUpload(uploads.docx,'Evidence',{runTool:compromised({'office:pdf':`f=open('document.pdf','wb')\nf.write(b'%PDF-1.4 head')\nf.seek(${limit}-5)\nf.write(b'tail!')\nf.close()`})});
 assert.equal(preview.preview.length,limit);assert.equal(preview.preview.subarray(0,13).toString(),'%PDF-1.4 head');assert.equal(preview.preview.subarray(limit-5).toString(),'tail!');assert.equal(preview.preview[limit-6],0);
 assert.match(preview.markdown,/## Page 1\n\nExtracted text/);
 // 2,000,000 characters of 3 bytes each: 6,000,000 bytes, so a limit counted in bytes at 2,000,000 would refuse it.
 const euros=await processUpload(uploads.pdf,'Evidence',{runTool:compromised({pdftotext:"open('extracted.txt','w',encoding='utf-8').write(chr(0x20ac)*2000000)"})});
 assert.ok(euros.markdown.startsWith('# Evidence\n\n## Page 1\n\n\u20ac'));assert.equal(euros.markdown.split('\u20ac').length-1,2000000);assert.ok(euros.markdown.endsWith('\u20ac'.repeat(2000000)));
 // 1,000,000 characters of 4 bytes and 2 UTF-16 units each: 2,000,000 units (the limit counts the sum with the PDF text, so that stays empty).
 const emoji='\u{1F600}',office=await processUpload(uploads.docx,'Evidence',{runTool:compromised({extract:"open('office.txt','w',encoding='utf-8').write(chr(0x1F600)*1000000)",pdftotext:"open('extracted.txt','w').write('')"})});
 assert.match(office.markdown,/# Original Office content\n\n\u{1F600}/u);assert.equal(office.markdown.split(emoji).length-1,1000000);assert.ok(office.markdown.endsWith(emoji.repeat(1000000)));assert.equal(office.preview.toString(),'%PDF-1.4 stand-in');
});

test('a workspace a tool has locked is still removed, and the upload succeeds',async t=>{
 // arena's clean-up copes with locked folders, so a failing run leaves nothing behind.
 const {parent}=arena(t),temporary=path.join(parent,'tmp-real');fs.mkdirSync(temporary);process.env.TMPDIR=temporary;assert.equal(os.tmpdir(),temporary);
 const locked=ws=>fs.lstatSync(path.join(ws,'sub')).mode&0o777,calls=[],seen={};
 const plan={pdftotext:"import os\nopen('extracted.txt','w').write('Extracted text')\nos.mkdir('sub')\nopen('sub/x','w').write('x')\nos.chmod('sub',0)",observe:locked};
 const result=await processUpload(uploads.pdf,'Evidence',{runTool:compromised(plan,seen,calls)});
 assert.equal(seen.pdftotext,0,'control: the confined tool locked sub (mode 0)');assert.equal(calls.length,1);assert.equal(path.dirname(calls[0].ws),temporary);
 assert.match(result.markdown,/## Page 1\n\nExtracted text/);assert.equal(fs.existsSync(calls[0].ws),false,'the workspace is gone');assert.deepEqual(fs.readdirSync(temporary),[]);
 // removeWorkspace on its own: a locked tree with links to a folder outside it. The outside folder is not entered, nor its mode changed.
 const outside=path.join(parent,'outside'),tree=path.join(parent,'locked-tree'),ownMode=file=>fs.statSync(file).mode&0o777;
 fs.mkdirSync(path.join(outside,'sub'),{recursive:true});fs.writeFileSync(path.join(outside,'keep.txt'),'KEEP');fs.writeFileSync(path.join(outside,'sub','inner.txt'),'INNER');fs.chmodSync(path.join(outside,'sub'),0o751);fs.chmodSync(outside,0o750);
 fs.mkdirSync(path.join(tree,'locked','inner'),{recursive:true});fs.writeFileSync(path.join(tree,'locked','inner','file.txt'),'x');
 fs.symlinkSync(outside,path.join(tree,'top-link'));fs.symlinkSync(outside,path.join(tree,'locked','link-in-locked'));
 fs.chmodSync(path.join(tree,'locked','inner'),0);fs.chmodSync(path.join(tree,'locked'),0);fs.chmodSync(tree,0o500);
 if(process.getuid?.()!==0)assert.throws(()=>fs.readdirSync(path.join(tree,'locked')),{code:'EACCES'},'control: the folder is locked');
 await removeWorkspace(tree);
 assert.equal(fs.existsSync(tree),false,'the tree is gone');assert.equal(ownMode(outside),0o750);assert.equal(ownMode(path.join(outside,'sub')),0o751);
 assert.equal(fs.readFileSync(path.join(outside,'keep.txt'),'utf8'),'KEEP');assert.equal(fs.readFileSync(path.join(outside,'sub','inner.txt'),'utf8'),'INNER');
 await removeWorkspace(path.join(parent,'missing'));
});

test('PDF export works with the temporary folder behind a link',async t=>{
 const chromium=process.env.CHROMIUM;t.after(()=>{if(chromium===undefined)delete process.env.CHROMIUM;else process.env.CHROMIUM=chromium;});
 const {parent}=arena(t),real=linkedTemporaryFolder(parent),folder=path.join(parent,'analysis'),args=path.join(parent,'chromium-args.txt'),standIn=path.join(parent,'chromium-stand-in.sh');
 // A stand-in for the browser: it records its arguments and writes a PDF where --print-to-pdf says.
 fs.writeFileSync(standIn,['#!/bin/sh',`printf '%s\\n' "$@" > "${args}"`,'for a in "$@"; do case "$a" in --print-to-pdf=*) echo \'%PDF-1.4 stand-in\' > "${a#--print-to-pdf=}";; esac; done'].join('\n')+'\n',{mode:0o755});
 process.env.CHROMIUM=standIn;
 const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/revenue-review.json',import.meta.url),'utf8')),markdown=fs.readFileSync(new URL('./fixtures/revenue-review.md',import.meta.url),'utf8');
 fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'report.md'),markdown);fs.cpSync(new URL('./fixtures/charts',import.meta.url),path.join(folder,'charts'),{recursive:true});
 const run={snapshot:fixture.snapshot,result:validateMarkdownReport(markdown,fixture.snapshot),created_at:'2026-10-07T00:00:00.000Z'};
 const output=await createPDF(run,folder);
 assert.equal(output,path.join(folder,'report.pdf'));assert.equal(fs.readFileSync(output,'utf8'),'%PDF-1.4 stand-in\n');
 const given=fs.readFileSync(args,'utf8').split('\n'),printTo=given.find(a=>a.startsWith('--print-to-pdf=')).slice('--print-to-pdf='.length);
 assert.equal(path.dirname(path.dirname(printTo)),real,'the export folder was made in the resolved temporary folder');assert.match(path.basename(path.dirname(printTo)),/^analyst-pdf-/);
 assert.ok(given.find(a=>a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length).startsWith(real+path.sep));
 assert.deepEqual(fs.readdirSync(real),[],'the export folder was removed');
});
