import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import fsSync from 'node:fs';
import {readArtifact,safePath} from './safe-files.mjs';
const bad=message=>{throw Object.assign(Error(message),{status:400});};
export const MAX_UPLOAD_BYTES=20*1024*1024;
export function decodeUpload(file){
 if(!file||typeof file.name!=='string'||file.name.length>180||typeof file.data!=='string')bad('Choose a PDF, Word, PowerPoint, text or Markdown file.');
 const type=path.extname(file.name).slice(1).toLowerCase();if(!['pdf','doc','docx','ppt','pptx','txt','md'].includes(type))bad('Supported formats: PDF, DOC, DOCX, PPT, PPTX, TXT and Markdown.');
 if(file.data.length>Math.ceil(MAX_UPLOAD_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))bad('Invalid or oversized file. Maximum upload size is 20 MB.');
 const buffer=Buffer.from(file.data,'base64');if(!buffer.length||buffer.length>MAX_UPLOAD_BYTES)bad('Choose a nonempty file up to 20 MB.');
 if(type==='pdf'&&buffer.subarray(0,5).toString()!=='%PDF-')bad('This file is not a valid PDF.');
 if(['docx','pptx'].includes(type)&&buffer.subarray(0,2).toString()!=='PK')bad('This file is not a valid Office document.');
 if(['doc','ppt'].includes(type)&&buffer.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')bad('This file is not a valid legacy Office document.');
 return {name:path.basename(file.name),type,buffer};
}
// Linux: Bubblewrap. macOS: a deny-by-default Seatbelt profile through /usr/bin/sandbox-exec. Every host path reaches the
// profile as a -D parameter, never as profile text. Seatbelt matches resolved paths, so the workspace must be given resolved.
// The Launch Services lookup is only for LibreOffice; it is a separate constant so that one line is the whole difference.
const SEATBELT_RULES=`(version 1)
(deny default)
(deny process-info*)
(allow process-info* (target same-sandbox))
(allow sysctl-read)
(deny sysctl-read (sysctl-name-regex #"^kern\\.proc"))
(allow file-read-data file-read-metadata (literal "/"))
(allow file-read-metadata (literal "/var") (literal "/tmp") (literal "/Applications") (literal "/opt") (literal "/opt/homebrew"))
(allow file-read* (literal "/dev/urandom"))
(allow file-read* (literal "/private/var/select/developer_dir") (literal "/private/var/db/xcode_select_link"))
(allow file-read* (subpath "/usr/lib") (subpath "/System/Library"))
(allow file-read* (subpath "/usr/bin") (subpath "/bin"))
(allow process-exec* (literal "/usr/bin/python3") (literal "/bin/bash"))
(allow file-read* process-exec* (subpath "/opt/homebrew/bin") (subpath "/opt/homebrew/Cellar") (subpath "/opt/homebrew/opt") (subpath "/opt/homebrew/Caskroom/libreoffice"))
(allow file-read* process-exec* (subpath "/Applications/LibreOffice.app"))
`;
const SEATBELT_LAUNCH_SERVICES=`(allow mach-lookup (global-name "com.apple.coreservices.launchservicesd"))
`;
const SEATBELT_WORKSPACE=`(allow file-read* file-write* (subpath (param "WORKSPACE")))
(allow network-bind (subpath (param "WORKSPACE")))
(deny file-write-unlink (literal (param "WORKSPACE")))
(deny file-write-flags)
(deny file-write-acl)
`;
const ancestors=dir=>{const out=[];for(let current=path.dirname(dir);current!=='/'&&current!==path.dirname(current);current=path.dirname(current))out.unshift(current);return out;};
export function documentToolCommand({platform=process.platform,binary,args,workspace,env=process.env,exists=fsSync.existsSync,developerDir=null,launchServices=false}){
 const stdio=['ignore','ignore','pipe'];
 if(platform==='darwin'){
  const params=['WORKSPACE='+workspace];let profile=SEATBELT_RULES+(launchServices?SEATBELT_LAUNCH_SERVICES:'')+SEATBELT_WORKSPACE;
  if(developerDir){params.push('DEVELOPER_DIR='+developerDir);profile+='(allow file-read* process-exec* (subpath (param "DEVELOPER_DIR")))\n';}
  [...new Set([...ancestors(workspace),...(developerDir?ancestors(developerDir):[])])].forEach((dir,index)=>{params.push(`ANCESTOR_${index}=${dir}`);profile+=`(allow file-read-metadata (literal (param "ANCESTOR_${index}")))\n`;});
  return {command:'/usr/bin/sandbox-exec',args:['-p',profile,...params.flatMap(param=>['-D',param]),binary,...args],options:{stdio,detached:true,cwd:workspace,env:{PATH:env.PATH,LANG:'C.UTF-8',HOME:workspace,TMPDIR:workspace,OSL_SOCKET_PATH:'.'}}};
 }
 const mounts=['--unshare-all','--die-with-parent','--new-session'];
 for(const entry of ['/usr','/bin','/lib','/lib64','/etc/fonts','/etc/ld.so.cache'])if(exists(entry))mounts.push('--ro-bind',entry,entry);
 mounts.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/run','--bind',workspace,workspace,'--chdir',workspace,'--setenv','HOME',workspace,'--setenv','TMPDIR',workspace,'--',binary,...args);
 return {command:'bwrap',args:mounts,options:{stdio,detached:true,env:{PATH:env.PATH,LANG:'C.UTF-8'}}};
}
// The active developer folder, as the python3 shim finds it: the first link that resolves to a folder.
const developerDirectory=()=>{for(const link of ['/var/select/developer_dir','/var/db/xcode_select_link']){try{const dir=fsSync.realpathSync(link);if(fsSync.statSync(dir).isDirectory())return dir;}catch{}}return null;};
export async function executeDocumentTool(binary,args,workspace,{timeoutMs=60000,launchServices=false}={}){
 await new Promise((resolve,reject)=>{
  let launch;
  try{const darwin=process.platform==='darwin';launch=documentToolCommand({binary,args,workspace:darwin?fsSync.realpathSync(workspace):workspace,developerDir:darwin?developerDirectory():null,launchServices});}
  catch{return reject(Error(`Document processing could not start its isolated converter.`));}
  const child=spawn(launch.command,launch.args,launch.options);let error='';
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}reject(Error('Document processing timed out. Please try a smaller document.'));},timeoutMs);
  child.stderr.on('data',b=>error=(error+b).slice(-1500));child.on('error',()=>{clearTimeout(timer);reject(Error(`Document processing could not start its isolated converter.`));});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Could not read this document. It may be encrypted or damaged. '+error));});
 });
}
// A confined tool can lock a folder of its workspace (mode 0), which would stop the server's own removal. Every real folder is
// opened up first, found by directory entries so that no link is followed; fs.rm does not follow a link either.
export async function removeWorkspace(dir){
 const unlock=async folder=>{try{await fs.chmod(folder,0o700);for(const entry of await fs.readdir(folder,{withFileTypes:true}))if(entry.isDirectory())await unlock(path.join(folder,entry.name));}catch{}};
 try{if((await fs.lstat(dir)).isDirectory())await unlock(dir);}catch{}
 await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
// A confined tool can still plant a link, a pipe or a second name in its own workspace, so an output is read only when it
// is one plain file of a fitting size, and never through a link. tooLarge is the existing message for a plain file over the
// limit; null means that file is skipped instead (still refused when it is reached through a link or has a second name).
const TEXT_BYTES=8000000,PREVIEW_BYTES=30*1024*1024;
function readOutput(tmp,name,maxBytes,tooLarge){
 const stat=fsSync.lstatSync(path.join(tmp,name));
 if(stat.isFile()&&stat.size>maxBytes){if(tooLarge!==null)bad(tooLarge);safePath(tmp,name);return null;}
 return readArtifact(tmp,name,maxBytes);
}
let conversions=0;
export async function processUpload(file,title,{allowVisualOnly=false,runTool=executeDocumentTool}={}){
 if(conversions>=2)throw Object.assign(Error('Two documents are being prepared. Please try again shortly.'),{status:429});
 conversions++;try{return await convertUpload(file,title,allowVisualOnly,runTool);}finally{conversions--;}
}
async function convertUpload(file,title,allowVisualOnly,runTool){
 const upload=decodeUpload(file);
 if(['txt','md'].includes(upload.type)){const markdown=upload.buffer.toString('utf8');if(!markdown.trim()||markdown.includes('\0')||markdown.length>2000000)bad('The text file must contain readable text, up to 2 million characters.');return {...upload,markdown};}
 const tmp=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'analyst-document-'));
 try{
  const source=path.join(tmp,'document.'+upload.type);await fs.writeFile(source,upload.buffer);let pdf=source;
  let officeText='';
  if(['doc','docx','ppt','pptx'].includes(upload.type)){
   let packageFile=source;
   await fs.copyFile(new URL('./extract-office.py',import.meta.url),path.join(tmp,'extract-office.py'));
   const office=async(format)=>runTool(process.env.LIBREOFFICE||'soffice',[`-env:UserInstallation=${pathToFileURL(path.join(tmp,'office-profile')).href}`,'--headless','--convert-to',format,'--outdir',tmp,source],tmp,{launchServices:true});
   if(['doc','ppt'].includes(upload.type)){const format=upload.type==='doc'?'docx':'pptx';await office(format);packageFile=path.join(tmp,'document.'+format);}
   await runTool('python3',[path.join(tmp,'extract-office.py'),packageFile,path.join(tmp,'office.txt')],tmp);
   officeText=readOutput(tmp,'office.txt',TEXT_BYTES,'This document contains too much text. Split it into smaller documents.').toString('utf8');
   await office('pdf');pdf=path.join(tmp,'document.pdf');
   try{fsSync.lstatSync(pdf);}catch{bad('Document preview could not be generated. Check that the Office file is valid.');}
  }
  const output=path.join(tmp,'extracted.txt');await runTool('pdftotext',['-layout','-enc','UTF-8',pdf,output],tmp);
  const extracted=readOutput(tmp,'extracted.txt',TEXT_BYTES,'This document contains too much text. Split it into smaller documents.').toString('utf8');if(!extracted.trim()&&!officeText.trim()&&!allowVisualOnly)bad('This document has no extractable text. Please upload a searchable PDF or a text version; scanned pages require OCR.');
  if(extracted.length+officeText.length>2000000)bad('This document contains too much text. Split it into smaller documents.');
  const pages=extracted.split('\f').map((text,index)=>({text,index})).filter(page=>page.text.trim());
  const markdown=`# ${title}\n\n`+pages.map(page=>`## Page ${page.index+1}\n\n${page.text.trim()}`).join('\n\n')+(officeText?'\n\n# Original Office content\n\n'+officeText:'')+(!extracted.trim()&&!officeText.trim()?'\n\nThis reference has no extractable text. Review the original PDF visually; do not treat missing extracted text as missing content.':'');
  return {...upload,markdown,preview:upload.type!=='pdf'?readOutput(tmp,'document.pdf',PREVIEW_BYTES,null):null};
 }finally{await removeWorkspace(tmp);}
}
export const mimeFor=type=>({pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',doc:'application/msword',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',md:'text/markdown; charset=utf-8',txt:'text/plain; charset=utf-8'}[type]||'text/plain; charset=utf-8');
