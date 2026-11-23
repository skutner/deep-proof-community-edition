import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256,selectionProblems,treeHashes,buildProblems} from './evaluation/minute-books/lib.mjs';

// Offline checks of the minute-book recipe. No generator run, no download and no model call: the build itself is
// checked by running build.mjs, which refuses any result that differs from selection.json.
const folder=path.join(path.dirname(fileURLToPath(import.meta.url)),'evaluation','minute-books');
const selection=JSON.parse(fs.readFileSync(path.join(folder,'selection.json'),'utf8'));
const h=text=>sha256(Buffer.from(text));

test('The selection pins the public generator, the seed and every file of the six recorded books',()=>{
 assert.deepEqual(selectionProblems(selection),[]);
 assert.equal(selection.generator.repository,'skutner/lean_documents');
 assert.equal(selection.generator.commit,'e36c1d7b16dc39d073a399eef7806c14e0b228c8');
 assert.deepEqual(selection.generator.environment,{BIG_MINUTES_EDITION:'8'});
 const ids=Object.keys(selection.dossiers);
 assert.deepEqual(ids,[1,2,3,4,5,6].map(n=>`g82829258-00${n}-minutes`));
 const seed=selection.generator.arguments[selection.generator.arguments.indexOf('--seed')+1];
 assert.equal(seed,'82829258');
 for(const d of Object.values(selection.dossiers)){
  assert.ok(['report-correct.md','report-mixed.md','sources/procedure.md','sources/minute-book-1.md'].every(f=>Object.hasOwn(d.files,f)));
  assert.ok(Object.keys(d.files).every(f=>/^(report-(correct|mixed)\.md|sources\/(procedure|minute-book-\d)\.md)$/.test(f)));
 }
});

test('Selection problems name a short commit, a missing hash and an unsafe path',()=>{
 const bad=structuredClone(selection);
 bad.generator.commit='e36c1d7b';
 bad.dossiers['g82829258-001-minutes'].key_sha256='';
 bad.dossiers['g82829258-002-minutes'].files['../escape.md']=h('x');
 const problems=selectionProblems(bad).join('\n');
 assert.match(problems,/full 40-character commit/);
 assert.match(problems,/g82829258-001-minutes needs key_sha256/);
 assert.match(problems,/escape\.md needs a relative path/);
 assert.match(selectionProblems({...selection,generator:{...selection.generator,script:'evalsuite/other.py'}}).join('\n'),/script must be one of/);
});

test('A build is accepted only when every file and key matches, with nothing missing or extra',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'minute-books-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=(rel,text)=>{fs.mkdirSync(path.dirname(path.join(root,rel)),{recursive:true});fs.writeFileSync(path.join(root,rel),text);};
 const small={dossiers:{'g1-001-minutes':{files:{'report-correct.md':h('A'),'sources/minute-book-1.md':h('B')},key_sha256:h('K')}}};
 write('fixtures/g1-001-minutes/report-correct.md','A');write('fixtures/g1-001-minutes/sources/minute-book-1.md','B');write('keys/g1-001-minutes.json','K');
 assert.deepEqual(treeHashes(path.join(root,'fixtures','g1-001-minutes')),small.dossiers['g1-001-minutes'].files);
 assert.deepEqual(buildProblems(root,small),[]);
 write('fixtures/g1-001-minutes/sources/minute-book-1.md','B changed');
 write('fixtures/g1-001-minutes/sources/extra.md','E');
 write('keys/g1-001-minutes.json','K changed');
 write('keys/g9-001-minutes.json','{}');
 write('fixtures/g9-001-minutes/report-correct.md','A');
 fs.rmSync(path.join(root,'fixtures','g1-001-minutes','report-correct.md'));
 assert.deepEqual(buildProblems(root,small).sort(),[
  'g1-001-minutes: answer key differs from the selection',
  'g1-001-minutes: missing report-correct.md',
  'g1-001-minutes: sources/minute-book-1.md differs from the selection',
  'g1-001-minutes: unexpected sources/extra.md',
  'unexpected dossier g9-001-minutes',
  'unexpected key g9-001-minutes.json'
 ]);
 fs.rmSync(path.join(root,'keys'),{recursive:true});
 assert.ok(buildProblems(root,small).includes('g1-001-minutes: missing answer key'));
});

test('The recipe folder ships no books, keys or private material, and its build output is ignored by Git',()=>{
 const shipped=[];
 const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){
  const full=path.join(dir,e.name),rel=path.relative(folder,full).split(path.sep).join('/');
  if(rel==='.data'){shipped.push('.data/.gitignore');continue;}
  if(e.isDirectory())walk(full);else shipped.push(rel);
 }};
 walk(folder);
 assert.deepEqual(shipped.sort(),['.data/.gitignore','README.md','build.mjs','lib.mjs','selection.json']);
 assert.equal(fs.readFileSync(path.join(folder,'.data','.gitignore'),'utf8'),'*\n!.gitignore\n');
 for(const file of shipped){
  const text=fs.readFileSync(path.join(folder,file),'utf8');
  assert.doesNotMatch(text,/\/Users\/|\/home\/|EVALSUITE-KEY-CANARY-|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,`${file} holds a private path, a key canary or an email address`);
 }
});
