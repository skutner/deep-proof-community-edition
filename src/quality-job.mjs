import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {readArtifact,writeArtifact} from './safe-files.mjs';
import {readValidatedOutput} from './output-validation.mjs';
import {readSkillFiles} from './skill-bundle.mjs';
import {typeSkillFolder} from './type-skills.mjs';

// Only input originals enter the disposable agent workspace. It never serves as report storage.
export async function withQualityWorkspace(folder,input,task){
 const workspace=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'deep-proof-verification-'));
 try{
  for(const d of input.documents){for(const ext of [d.file_type,['doc','docx','ppt','pptx'].includes(d.file_type)?'preview.pdf':null].filter(Boolean)){
   if(ext==='md')continue;const name=`sources/${d.id}.${ext}`;try{writeArtifact(workspace,name,readArtifact(folder,name,30*1024*1024));}catch(error){if(error.code!=='ENOENT')throw error;}
  }}
  return await task(workspace);
 }finally{await fs.rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
export async function publishQualityOutput(workspace,folder,input,artifactDir){
 const result=await readValidatedOutput(workspace,input,'analysis');
 const files=new Set(['report.md','quality-input/manifest.json','quality-input/segments.jsonl','quality-input/options.json',...result.quality.files]);
 const checks=JSON.parse('['+readArtifact(workspace,'quality/checks.jsonl').toString().split(/\r?\n/).filter(x=>x.trim()).join(',')+']');
 for(const check of checks)for(const file of check.artifactPaths)files.add(file);
 for(const name of result.chartFiles){files.add('charts/'+name);files.add('charts/'+name.replace(/\.(svg|png)$/,'.csv'));}
 for(const d of input.documents){files.add(`sources/${d.id}.md`);if(d.original_available&&d.originalFile)files.add(d.originalFile);}
 writeArtifact(folder,'input.json',JSON.stringify(input,null,2));
 const index=[];for(const name of files){const bytes=readArtifact(workspace,name,30*1024*1024);writeArtifact(folder,name,bytes);if(name!=='input.json')index.push({name,sha256:createHash('sha256').update(bytes).digest('hex')});}
 for(const name of ['progress.md','validation-result.json'])try{writeArtifact(folder,name,readArtifact(workspace,name));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(artifactDir&&input.type.skill_revision){const bundle=readSkillFiles(typeSkillFolder(artifactDir,input.type.id,input.type.skill_revision));for(const [name,content] of Object.entries(bundle)){const file='verification-skill/'+name;writeArtifact(folder,file,content);index.push({name:file,sha256:createHash('sha256').update(content).digest('hex')});}}
 writeArtifact(folder,'verification-index.json',JSON.stringify({schemaVersion:1,files:index}));
 return {format:'markdown',quality:{completion:result.quality.completion,confirmedFindings:result.quality.confirmedFindings,findings:result.quality.findings,counts:result.quality.coverage.counts,limitations:result.quality.coverage.limitations}};
}
