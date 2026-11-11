import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
// Agent-writable artifacts must never redirect server reads or writes outside their tree.
export function safePath(root,name='',{missing=false}={}){
 const base=path.resolve(root),target=path.resolve(base,name);
 if(target!==base&&!target.startsWith(base+path.sep))throw Error('Artifact path escapes its folder.');
 let current=path.parse(target).root;const parts=target.slice(current.length).split(path.sep).filter(Boolean);
 for(let i=0;i<parts.length;i++){
  current=path.join(current,parts[i]);let stat;try{stat=fs.lstatSync(current);}catch(error){if(missing&&error.code==='ENOENT')continue;throw error;}
  if(stat.isSymbolicLink()||(i<parts.length-1&&!stat.isDirectory()))throw Error('Artifact paths must not contain symbolic links.');
  if(stat.isFile()&&stat.nlink!==1)throw Error('Artifact files must not use hard links.');
 }
 return target;
}
export function safeDirectory(root,name=''){
 const folder=safePath(root,name,{missing:true});fs.mkdirSync(folder,{recursive:true,mode:0o700});safePath(root,name);return folder;
}
// A read must not be redirected by a folder that is swapped for a link between the path check and the open, so
// the open itself is checked by the kernel.
// Linux: open, then ask /proc where the descriptor really is.
// macOS: there is no /proc, but open can refuse a symbolic link in any component of the path (O_NOFOLLOW_ANY,
// macOS 11 and later, absent from fs.constants, and not combinable with O_NOFOLLOW). The path is first confined
// to the folder as text, by safePath and again in openInside, so a file opened this way is inside it. The option
// is checked once against a real link before it is trusted, because a system that ignored the bit would open
// the file without complaint.
const O_NOFOLLOW_ANY=0x20000000;
let linkRefusalChecked=false;
function checkLinkRefusal(){
 if(linkRefusalChecked)return;
 const unsupported=()=>Error('This system cannot refuse symbolic links while opening a file, so artifacts cannot be read safely here.');
 const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'deep-proof-open-check-'));
 try{
  fs.mkdirSync(path.join(dir,'real'));fs.writeFileSync(path.join(dir,'real','file'),'x');fs.symlinkSync(path.join(dir,'real'),path.join(dir,'link'));
  const flags=fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|O_NOFOLLOW_ANY;
  // EINVAL is how a system that does not know the option answers; any other failure is reported as it is.
  try{fs.closeSync(fs.openSync(path.join(dir,'real','file'),flags));}catch(error){throw error.code==='EINVAL'?unsupported():error;}
  let followed=false;try{fs.closeSync(fs.openSync(path.join(dir,'link','file'),flags));followed=true;}catch(error){if(error.code!=='ELOOP')throw error.code==='EINVAL'?unsupported():error;}
  if(followed)throw unsupported();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 linkRefusalChecked=true;
}
// Exported for the test that opens through a link directly, as a folder swapped after the path check would.
// It refuses a path outside base on its own on both systems, so it is safe even without safePath() before it.
export function openInside(file,base){
 if(process.platform==='darwin'){
  const target=path.resolve(file);if(target!==base&&!target.startsWith(base+path.sep))throw Error('Artifact resolved outside its folder.');
  checkLinkRefusal();
  try{return fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK|O_NOFOLLOW_ANY);}catch(error){if(error.code==='ELOOP')throw Error('Artifact paths must not contain symbolic links.');throw error;}
 }
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const resolved=fs.realpathSync(`/proc/self/fd/${fd}`);if(resolved!==base&&!resolved.startsWith(base+path.sep))throw Error('Artifact resolved outside its folder.');return fd;}
 catch(error){fs.closeSync(fd);throw error;}
}
export function readArtifact(root,name,maxBytes=10000000){
 const file=safePath(root,name),fd=openInside(file,path.resolve(root));
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>maxBytes)throw Error('Artifact must be a regular file within the size limit.');const buffer=Buffer.alloc(stat.size+1);let bytes=0,n;while(bytes<buffer.length&&(n=fs.readSync(fd,buffer,bytes,buffer.length-bytes,null)))bytes+=n;if(bytes>stat.size)throw Error('Artifact changed while being read.');return buffer.subarray(0,bytes);}finally{fs.closeSync(fd);}
}
export function writeArtifact(root,name,data){
 const target=safePath(root,name,{missing:true});safeDirectory(root,path.dirname(name));
 const temporary=path.join(path.dirname(target),'.write-'+randomUUID());
 try{fs.writeFileSync(temporary,data,{flag:'wx',mode:0o600});safePath(root,name,{missing:true});fs.renameSync(temporary,target);}finally{fs.rmSync(temporary,{force:true});}
}
