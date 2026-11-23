// Shared helpers for the minute-book recipe: the selection's shape, the hashes of a built tree, and the check
// that a build is exactly the recorded one. Nothing here calls a model or the network.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const HEX64=/^[0-9a-f]{64}$/,HEX40=/^[0-9a-f]{40}$/;
const safeRelative=p=>typeof p==='string'&&p.length>0&&!path.isAbsolute(p)&&!p.split('/').some(part=>part===''||part==='.'||part==='..')&&!p.includes('\\');

// Returns a list of problems; an empty list means the selection can drive a build.
export function selectionProblems(selection){
 const problems=[],g=selection?.generator;
 if(!selection||typeof selection!=='object')return ['The selection is not an object.'];
 if(!/^[a-z0-9-]+$/.test(selection.id||''))problems.push('id must be lowercase letters, digits and hyphens.');
 if(!g||typeof g!=='object')return [...problems,'generator is missing.'];
 if(!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(g.repository||''))problems.push('generator.repository must be owner/name.');
 if(!HEX40.test(g.commit||''))problems.push('generator.commit must be a full 40-character commit.');
 const files=Object.entries(g.files||{});
 if(!files.length)problems.push('generator.files is empty.');
 for(const [file,entry] of files){
  if(!safeRelative(file))problems.push(`generator file ${file} is not a plain relative path.`);
  if(!HEX64.test(entry?.sha256||'')||!Number.isInteger(entry?.size)||entry.size<1)problems.push(`generator file ${file} needs sha256 and size.`);
 }
 if(!Array.isArray(g.arguments)||!g.arguments.every(a=>typeof a==='string'))problems.push('generator.arguments must be a list of strings.');
 else if(!Object.hasOwn(g.files||{},g.script))problems.push('generator.script must be one of generator.files.');
 if(g.environment&&!Object.entries(g.environment).every(([k,v])=>/^[A-Z][A-Z0-9_]*$/.test(k)&&typeof v==='string'))problems.push('generator.environment must map NAMES to strings.');
 const dossiers=Object.entries(selection.dossiers||{});
 if(!dossiers.length)problems.push('dossiers is empty.');
 for(const [id,d] of dossiers){
  if(!/^[A-Za-z0-9-]+$/.test(id))problems.push(`dossier ${id} has an unsafe name.`);
  if(!HEX64.test(d?.key_sha256||''))problems.push(`dossier ${id} needs key_sha256.`);
  const entries=Object.entries(d?.files||{});
  if(!entries.length)problems.push(`dossier ${id} lists no files.`);
  for(const [file,hash] of entries)if(!safeRelative(file)||!HEX64.test(hash))problems.push(`dossier ${id} file ${file} needs a relative path and a sha256.`);
 }
 return problems;
}

// Every regular file under root, as {relative/path: sha256}. Links and other special files are refused.
export function treeHashes(root){
 const out={};
 const walk=dir=>{
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const full=path.join(dir,entry.name);
   if(entry.isDirectory())walk(full);
   else if(entry.isFile())out[path.relative(root,full).split(path.sep).join('/')]=sha256(fs.readFileSync(full));
   else throw Error(`${full} is not a regular file or folder.`);
  }
 };
 walk(root);
 return out;
}

// Compares a build (fixtures/<dossier>/..., keys/<dossier>.json, keys.generation.json) with the selection.
// Returns a list of problems. The generation summary is allowed but not compared: it records the Python version.
export const BUILD_ROOT_ENTRIES=['fixtures','keys','keys.generation.json'];
export function buildProblems(buildRoot,selection){
 const problems=[],fixtures=path.join(buildRoot,'fixtures'),keys=path.join(buildRoot,'keys');
 const want=selection.dossiers;
 for(const name of fs.existsSync(buildRoot)?fs.readdirSync(buildRoot):[])if(!BUILD_ROOT_ENTRIES.includes(name))problems.push(`unexpected ${name} in the build root`);
 const have=fs.existsSync(fixtures)?fs.readdirSync(fixtures,{withFileTypes:true}):[];
 for(const e of have){
  if(!Object.hasOwn(want,e.name))problems.push(`unexpected dossier ${e.name}`);
  else if(!e.isDirectory())problems.push(`dossier ${e.name} is not a folder`);
 }
 for(const [id,d] of Object.entries(want)){
  const dir=path.join(fixtures,id);
  if(!fs.existsSync(dir)){problems.push(`missing dossier ${id}`);continue;}
  if(!fs.lstatSync(dir).isDirectory())continue;
  const got=treeHashes(dir);
  for(const [file,hash] of Object.entries(d.files)){
   if(!Object.hasOwn(got,file))problems.push(`${id}: missing ${file}`);
   else if(got[file]!==hash)problems.push(`${id}: ${file} differs from the selection`);
  }
  for(const file of Object.keys(got))if(!Object.hasOwn(d.files,file))problems.push(`${id}: unexpected ${file}`);
  const key=path.join(keys,`${id}.json`);
  if(!fs.existsSync(key))problems.push(`${id}: missing answer key`);
  else if(!fs.lstatSync(key).isFile())problems.push(`${id}: answer key is not a regular file`);
  else if(sha256(fs.readFileSync(key))!==d.key_sha256)problems.push(`${id}: answer key differs from the selection`);
 }
 const keyFiles=fs.existsSync(keys)?fs.readdirSync(keys):[];
 for(const name of keyFiles)if(!name.endsWith('.json')||!Object.hasOwn(want,name.slice(0,-5)))problems.push(`unexpected key ${name}`);
 return problems;
}
