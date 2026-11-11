import {seededStore} from './support/seed.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApp} from '../server.mjs';
import {readArtifact,writeArtifact,openInside} from '../src/safe-files.mjs';
import {closeSync} from 'node:fs';
import {validateChartFiles,safeSVG} from '../src/charts-validation.mjs';
import {parseMarkdownReport,validateMarkdownReport} from '../src/markdown-report.mjs';

test('artifact reads and writes reject traversal, symlink parents, hard links and linked chart data',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'analyst-security-'));
 try{
  const root=path.join(dir,'job'),outside=path.join(dir,'private');await fs.mkdir(root);await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret'),'private');
  assert.throws(()=>readArtifact(root,'../private/secret'),/escapes/);
  await fs.symlink(outside,path.join(root,'charts'));assert.throws(()=>readArtifact(root,'charts/secret'),/symbolic/);assert.throws(()=>writeArtifact(root,'charts/secret','overwritten'),/symbolic/);assert.equal(await fs.readFile(path.join(outside,'secret'),'utf8'),'private');
  await fs.unlink(path.join(root,'charts'));await fs.mkdir(path.join(root,'charts'));await fs.link(path.join(outside,'secret'),path.join(root,'hard-link'));assert.throws(()=>readArtifact(root,'hard-link'),/hard links/);
  await fs.writeFile(path.join(root,'charts','chart.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');await fs.symlink(path.join(outside,'secret'),path.join(root,'charts','chart.csv'));
  await assert.rejects(validateChartFiles(root,{chartFiles:['chart.svg'],citations:{e1:{}}}),/regular CSV/);
  await fs.symlink(path.join(outside,'secret'),path.join(root,'report.md'));assert.throws(()=>writeArtifact(root,'report.md','overwrite'),/symbolic/);
  writeArtifact(root,'safe.md','safe text');assert.equal(readArtifact(root,'safe.md').toString(),'safe text');assert.throws(()=>readArtifact(root,'safe.md',3),/size limit/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('the open of an artifact refuses a folder that became a link after the path was checked, and any path outside the folder',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'analyst-open-')));
 try{
  const root=path.join(dir,'job'),outside=path.join(dir,'private');await fs.mkdir(path.join(root,'charts'),{recursive:true});await fs.mkdir(outside);
  await fs.writeFile(path.join(outside,'data.csv'),'private');await fs.writeFile(path.join(root,'charts','data.csv'),'public');
  // The state after the path check passed and the folder was then swapped: the checked path now leads outside.
  await fs.rename(path.join(root,'charts'),path.join(root,'charts-moved'));await fs.symlink(outside,path.join(root,'charts'));
  assert.throws(()=>openInside(path.join(root,'charts','data.csv'),root),/resolved outside its folder|must not contain symbolic links/);
  await fs.unlink(path.join(root,'charts'));await fs.symlink(path.join(outside,'data.csv'),path.join(root,'last-is-link.csv'));
  assert.throws(()=>openInside(path.join(root,'last-is-link.csv'),root),/ELOOP|must not contain symbolic links/);
  // Without a link, a path that leaves the folder is refused by the open itself as well, on both systems.
  assert.throws(()=>openInside(path.join(root,'..','private','data.csv'),root),/resolved outside its folder/);
  assert.throws(()=>openInside(path.join(outside,'data.csv'),root),/resolved outside its folder/);
  const fd=openInside(path.join(root,'charts-moved','data.csv'),root);closeSync(fd);
  assert.equal(readArtifact(root,'charts-moved/data.csv').toString(),'public');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('prototype-shaped footnotes are not inherited citations and active SVG is rejected',async()=>{
 const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/revenue-review.json',import.meta.url),'utf8'));const markdown=await fs.readFile(new URL('./fixtures/revenue-review.md',import.meta.url),'utf8');
 assert.throws(()=>validateMarkdownReport(markdown.replace('## Findings\n','## Findings\n\nUnsupported [^constructor]\n'),fixture.snapshot),/not defined/);
 const report=parseMarkdownReport('[^__proto__]: [Evidence](sources/management.md#L2-L2)\n    > Revenue.');assert.equal(Object.getPrototypeOf(report.citations),null);assert.ok(Object.hasOwn(report.citations,'__proto__'));
 for(const svg of ['<svg><s:script>run()</s:script></svg>','<svg><rect fill="url(https://outside.test/image)"/></svg>','<svg><style>@import "http://outside.test";</style></svg>','<svg><rect onclick="run()"/></svg>'])assert.throws(()=>safeSVG(svg));
});
test('API validates bodies, preserves split UTF-8, rechecks revoked sessions, and hides engine metadata',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'analyst-api-security-'));const {server,db}=(await seededStore(dir),createApp)({dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));db.close();await fs.rm(dir,{recursive:true,force:true});});const base=`http://127.0.0.1:${server.address().port}/api`;
 const login=await fetch(base+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'admin'})});const cookie=login.headers.get('set-cookie').split(';')[0];
 for(const body of ['null','[]','"bad"'])assert.equal((await fetch(base+'/projects',{method:'POST',headers:{'content-type':'application/json',cookie},body})).status,400);
 assert.equal((await fetch(base+'/projects',{method:'POST',headers:{'content-type':'application/json',cookie,origin:'https://unrelated.test'},body:'{}'})).status,403);
 const partial=(body,split,revoke=false)=>new Promise((resolve,reject)=>{const bytes=Buffer.from(body);const req=http.request(base+'/projects',{method:'POST',headers:{'content-type':'application/json',cookie,'content-length':bytes.length}},res=>{let raw='';res.on('data',c=>raw+=c);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw)}));});req.on('error',reject);req.write(bytes.subarray(0,split));setTimeout(()=>{if(revoke)db.prepare('DELETE FROM sessions').run();req.end(bytes.subarray(split));},20);});
 const body=JSON.stringify({company:'Research 🔬 review',typeId:'investment'}),split=Buffer.from(body).indexOf(Buffer.from('🔬'))+1;const created=await partial(body,split);assert.equal(created.status,201);assert.equal(db.prepare('SELECT company FROM projects WHERE id=?').get(created.data.id).company,'Research 🔬 review');
 const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/revenue-review.json',import.meta.url),'utf8'));db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?)').run('privacy-review','nexora-software',new Date().toISOString(),'completed',JSON.stringify({...fixture.snapshot,settings:{agent:'codex',models:{codex:'private-model'}}}),JSON.stringify(fixture.report),'private error');
 const result=await (await fetch(base+'/projects/nexora-software/analyses/privacy-review',{headers:{cookie}})).json();assert.equal(result.snapshot.settings,undefined);assert.equal(result.error,undefined);assert.ok(result.result.sections.length);
 assert.equal((await partial(body,split,true)).status,401);
});
