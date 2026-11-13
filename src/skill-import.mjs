import {reportTemplate} from './report-template.mjs';
import {parseCriteria} from './criteria.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {executeDocumentTool,MAX_UPLOAD_BYTES,removeWorkspace} from './documents.mjs';
import {readSkillFiles,skillIdentity} from './skill-bundle.mjs';
import {CERTIFICATE_FILE,parseCertificate} from './verification.mjs';
const invalid=message=>{throw Object.assign(Error(message),{status:400});};
let imports=0;
export async function importSkillArchive(file,typeId){
 if(!file||typeof file.name!=='string'||!file.name.toLowerCase().endsWith('.zip')||typeof file.data!=='string'||file.data.length>Math.ceil(MAX_UPLOAD_BYTES/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))invalid('Choose an Analyst Skill archive up to 20 MB.');
 const bytes=Buffer.from(file.data,'base64');if(bytes.subarray(0,2).toString()!=='PK')invalid('This file is not a ZIP archive.');
 if(imports>=2)throw Object.assign(Error('Two imports are in progress. Please try again shortly.'),{status:429});imports++;
 let temporary;
 try{
  temporary=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'analyst-skill-import-'));const archive=path.join(temporary,'skill.zip'),script=path.join(temporary,'skill-archive.py'),output=path.join(temporary,'unpacked');await fs.writeFile(archive,bytes);await fs.copyFile(new URL('./skill-archive.py',import.meta.url),script);
  try{await executeDocumentTool('python3',[script,archive,output],temporary);}catch{invalid('The ZIP could not be imported. Use a valid Analyst Skill package with readable supporting files. Unsafe or oversized archives cannot be imported.');}
  let files;try{files=readSkillFiles(output);}catch(error){invalid(error.message);}
  const entry=files['SKILL.md'];try{skillIdentity(entry);}catch(error){invalid(error.message);}
  const body=entry.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').trim();if(!body)invalid('The imported Analyst Skill has no instructions.');
  for(const name of ['references/review-criteria.md','references/review-playbook.md','references/methodology.md','references/report-template.md'])if(!files[name]?.trim())invalid('Missing required skill file: '+name);
  try{reportTemplate(files['references/report-template.md']);if(!parseCriteria(files['references/review-criteria.md']).length)throw Error('Include at least one assessable criterion.');}catch(error){invalid(error.message);}
  // A certificate that is present but malformed is rejected rather than silently downgraded.
  if(files[CERTIFICATE_FILE]!==undefined){try{parseCertificate(files[CERTIFICATE_FILE]);}catch(error){invalid(error.message);}}
  files['SKILL.md']=entry.replace(/^name:.*$/m,'name: analysis-type-'+typeId)+'\n\n## Deep Proof integration\n\nApply the imported methodology with the standard evidence-review and review-progress skills. The administrator can edit [Review Criteria](references/review-criteria.md) and [Review Playbook](references/review-playbook.md); these files override older supporting examples. Source guides explain methods, not facts about the current dossier. Read [Methodology](references/methodology.md) and [Report Template](references/report-template.md). Follow this template’s chapter order and guidance, with the standard evidence citations and table/chart requirements. Inspect helper scripts before using them inside the analysis sandbox.\n';
  const criteria=files['references/review-criteria.md']||'Imported methodology coverage — Assess every applicable requirement in the imported skill against supplied dossier evidence, recording omissions, conflicts and uncertainty.';
  const playbook=files['references/review-playbook.md']||body;
  if(criteria.length>100000||playbook.length>100000)invalid('Review Criteria and Review Playbook must each fit within 100,000 characters.');
  files['references/review-criteria.md']=criteria;files['references/review-playbook.md']=playbook;
  return {files,criteria,playbook};
 }finally{imports--;if(temporary)await removeWorkspace(temporary);}
}
