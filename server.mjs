import {createALACatalog} from './src/ala-catalog.mjs';
import {migrateAccess,accessLevels,userAccess,canAccessProject,validateUserAccess,saveUserAccess,projectAccess,saveProjectAccess,deleteAccessLevel} from './src/access.mjs';
import {skillReportTemplate} from './src/type-skills.mjs';
import {criteriaChapter,reportTemplate} from './src/report-template.mjs';
import {reportLanguage,runReportLanguage} from './web/report-languages.js';
import {parseCriteria} from './src/criteria.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { openStore,id,hashPassword,verifyPassword,transaction } from './src/store.mjs';
import { invokeALA } from './src/ala.mjs';
import { reviewPrompt } from './src/reports.mjs';
import {withQualityWorkspace,publishQualityOutput} from './src/quality-job.mjs';
import {analysisFailure} from './src/analysis-failure.mjs';
import {readConsole} from './src/console-feed.mjs';
import {createRunTrace} from './src/trace.mjs';
import {publishTimeLimited,progressNotes,wrappedUp,convertTimedOutRuns} from './src/partial-result.mjs';
import {CHECK_MINUTES,ANALYSIS_MINUTES,DEFAULT_ANALYSIS_MINUTES,chooseMinutes,defaultCheckMinutes} from './src/run-limits.mjs';
import {QUALITY_SKILL_ID,reportQualitySkill,reportQualityFiles,normalizeOptions,importedReport,qualityDocuments,qualityPrompt} from './src/report-quality.mjs';
import { designInput,designPrompt } from './src/review-design.mjs';
import {migrateArtifacts,writeProjectFiles,writeAnalysisSources,projectFolder,analysisFolder} from './src/artifacts.mjs';
import {parseMarkdownReport,renderReportFragment,legacyReportToMarkdown} from './src/markdown-report.mjs';
import {readValidatedOutput} from './src/output-validation.mjs';
import {processUpload,mimeFor} from './src/documents.mjs';
import {createPDF} from './src/pdf.mjs';
import {readArtifact,writeArtifact,safeDirectory} from './src/safe-files.mjs';
import {typeFolder,attachmentFolder,typeSkillFolder,typeReferences,sourceReferences,saveTypeAttachment,prepareReferenceFiles,saveSkillRevision,ensureTypeSkill,migrateTypeSkills,compatibilitySkill} from './src/type-skills.mjs';
import {importSkillArchive} from './src/skill-import.mjs';
import {readSkillFiles,validSkillFile} from './src/skill-bundle.mjs';
import {safeSVG} from './src/charts-validation.mjs';
import {CERTIFICATE_FILE,skillVerification,runVerification,edition,COMMERCIAL_LICENSE} from './src/verification.mjs';
import {resolveALA,validateALALocation,alaUnavailable,autoConfigureALA} from './src/ala-location.mjs';
import { renderMarkdown } from './src/markdown.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const str=(v,max=100000)=>{if(typeof v!=='string'||!v.trim()||v.length>max)fail(400,'Invalid or missing text.');return v.trim();};
const password=v=>{if(typeof v!=='string'||v.length<8||v.length>256)fail(400,'New passwords need 8–256 characters.');return v;};
export function createApp({dir=process.env.ANALYST_DATA_DIR||path.join(root,'.runtime'),catalog,appRoot=root,env=process.env}={}) {
 dir=path.resolve(dir);
 const db=openStore(dir),attempts=new Map(),deletingProjects=new Set(),liveWork=new Map(); let jobs=0;
 migrateAccess(db);migrateArtifacts(db,dir);migrateTypeSkills(db,dir);convertTimedOutRuns({db,dir});
 const one=(sql,...args)=>db.prepare(sql).get(...args), all=(sql,...args)=>db.prepare(sql).all(...args), run=(sql,...args)=>db.prepare(sql).run(...args);
 const settings=()=>JSON.parse(one('SELECT value FROM settings WHERE id=1')?.value||'{"agent":"codex","models":{"codex":"gpt-6-luna"},"efforts":{}}');
 const saveSettings=value=>run('INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',JSON.stringify(value));
 {const current=settings(),found=autoConfigureALA(root,current);if(found)saveSettings({...current,alaPath:found});}
 catalog??=createALACatalog(()=>resolveALA(root,settings()));
 const skillInfo=({report_language,...skill})=>({...skill,verification:skillVerification(dir,skill)});
 const ala=()=>resolveALA(root,settings());
 const requireALA=()=>{if(!ala().found)fail(503,alaUnavailable);};
 const alaStatus=()=>{const {found,source,entry,dependencies,configured,checked}=ala();return {found,source:source||null,entry:entry||null,dependencies:!!dependencies,configured,checked:checked.map(({source,location,reason})=>({source,location,reason}))};};
 const userInfo=u=>({id:u.id,username:u.username,role:u.role,active:!!u.active,...userAccess(db,u.id),typeIds:all('SELECT type_id FROM grants WHERE user_id=?',u.id).map(g=>g.type_id)});
 const can=(u,type)=>u.role==='admin'||!!one('SELECT 1 FROM grants WHERE user_id=? AND type_id=?',u.id,type);
 const canProject=(u,p)=>canAccessProject(db,u,p);
 const getProject=(u,pid)=>{if(deletingProjects.has(pid))fail(409,'Project deletion is in progress.');const p=one('SELECT * FROM projects WHERE id=?',pid);if(!p)fail(404,'Project not found.');if(!canProject(u,p))fail(403,'This project is not assigned to you.');return p;};
 const getRun=(pid,rid)=>{
  const r=one('SELECT * FROM runs WHERE id=? AND project_id=?',rid,pid);if(!r)fail(404,'Analysis not found.');
  const snapshot=JSON.parse(r.snapshot),stored=r.result?JSON.parse(r.result):null;let result=null;
  if(r.status==='completed'){
   const file=path.join(analysisFolder(dir,pid,rid),'report.md');
   const markdown=fsSync.existsSync(file)?readArtifact(analysisFolder(dir,pid,rid),'report.md').toString('utf8'):stored?.sections?legacyReportToMarkdown(stored):null;
   if(!markdown)fail(500,'The saved report file is unavailable.');
   result=snapshot.kind==='imported'||stored?.partial?importedReport(stored?.partial?markdown.replace(/^# .+\r?\n+/,''):markdown,snapshot.title||/^# (.+)$/m.exec(markdown)?.[1]):parseMarkdownReport(markdown);
   if(snapshot.kind!=='imported'&&!stored?.partial)result.sections=result.sections.map(section=>({...section,html:renderReportFragment(section.markdown,{criteria:section.title===criteriaChapter(snapshot)?snapshot.type.criteria:undefined,language:runReportLanguage(snapshot).code,imageURL:name=>`/api/projects/${pid}/analyses/${rid}/charts/${name}`})}));
  }
  if(result&&stored?.partial)result.partial=stored.partial;
  if(result&&stored?.timeLimited)result.timeLimited=true;
  if(result&&stored?.quality&&!stored.partial){result.quality=stored.quality;for(const section of result.sections)section.html=section.html.replace(/href="(quality\/[^"]+)"/g,(_,file)=>`href="/api/projects/${pid}/analyses/${rid}/verification?file=${encodeURIComponent(file)}"`);}
  if(result){for(const c of Object.values(result.citations))c.html=renderMarkdown(c.quote);for(const d of snapshot.documents)d.html=renderMarkdown(d.markdown);}
  delete snapshot.settings;if(snapshot.type){delete snapshot.type.generation_input;delete snapshot.type.generation_error;}
  return {id:r.id,project_id:r.project_id,created_at:r.created_at,status:r.status,snapshot,result,...(r.status==='failed'?{failure:analysisFailure(r.error)}:{}),...(r.status==='running'?{console:settings().showConsole===true}:{})};
 };
 const syncProject=pid=>writeProjectFiles(dir,one('SELECT * FROM projects WHERE id=?',pid),all('SELECT * FROM documents WHERE project_id=?',pid));

 async function readBody(req,limit=600000){
  const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>limit)fail(413,'The request is too large.');chunks.push(chunk);}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail(400,'Invalid JSON.');}
  if(!value||Array.isArray(value)||typeof value!=='object')fail(400,'Expected a JSON object.');return value;
 }

 const server=http.createServer(async(req,res)=>{
  const send=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
  try {
   const url=new URL(req.url,'http://localhost'),p=url.pathname,method=req.method;
   res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
   if(!p.startsWith('/api/')) {
    if(p==='/docs/skill-verification.md'){res.setHeader('content-type','text/markdown; charset=utf-8');res.setHeader('cache-control','no-store');return res.end(await fs.readFile(path.join(root,'docs/skill-verification.md')));}
    const files={'/':'index.html','/web/app.js':'app.js','/web/access.js':'access.js','/web/configuration.js':'configuration.js','/web/report-languages.js':'report-languages.js','/web/markdown.js':'markdown.js','/web/markdown.css':'markdown.css','/web/review-rules.js':'review-rules.js','/web/caution.js':'caution.js','/web/styles.css':'styles.css','/web/logo.svg':'logo.svg','/web/theme.js':'theme.js','/web/i18n.js':'i18n.js','/web/i18n/en.js':'i18n/en.js','/web/i18n/de.js':'i18n/de.js','/web/i18n/fr.js':'i18n/fr.js','/web/i18n/it.js':'i18n/it.js','/web/i18n/rm.js':'i18n/rm.js','/web/i18n/es.js':'i18n/es.js','/web/i18n/nl.js':'i18n/nl.js','/web/i18n/pl.js':'i18n/pl.js','/web/i18n/pt.js':'i18n/pt.js','/web/i18n/ro.js':'i18n/ro.js'};
    if(!Object.hasOwn(files,p))fail(404,'Not found.');res.setHeader('cache-control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('content-type',{'html':'text/html','js':'text/javascript','css':'text/css','svg':'image/svg+xml'}[files[p].split('.').pop()]);const content=await fs.readFile(path.join(root,'web',files[p]));
    // The edition badge reflects the license folder at request time; no restart is needed.
    if(files[p]==='index.html')return res.end(content.toString('utf8').replace('<!--edition-->',edition(appRoot)==='community'?'<span class="edition-badge">Community Edition</span>':''));
    return res.end(content);
   }
   if(!['GET','HEAD'].includes(method)) {
    if(req.headers['sec-fetch-site']==='cross-site')fail(403,'Cross-origin request refused.');
    if(req.headers.origin){let origin;try{origin=new URL(req.headers.origin);}catch{fail(403,'Cross-origin request refused.');}if(origin.host!==req.headers.host||!['http:','https:'].includes(origin.protocol))fail(403,'Cross-origin request refused.');}
    if(!req.headers['content-type']?.startsWith('application/json'))fail(415,'JSON required.');
   }
   const token=/analyst_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1];
   const digest=token?createHash('sha256').update(token).digest('hex'):'';
   const sessionUser=()=>one('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND active=1',digest,Date.now());
   const u=sessionUser();
   const requireSession=()=>{const current=sessionUser();if(!current||current.id!==u?.id||current.role!==u?.role)fail(401,'Your session has expired. Please sign in again.');return current;};
   const body=async(request,limit)=>{const value=await readBody(request,limit);if(p!=='/api/login')requireSession();return value;};
   const cookie=value=>res.setHeader('Set-Cookie',`analyst_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value?28800:0}${process.env.ANALYST_SECURE_COOKIE==='1'?'; Secure':''}`);
   if(p==='/api/login'&&method==='POST') {
    for(const [address,entry] of attempts)if(entry.until<Date.now())attempts.delete(address);
    const key=req.socket.remoteAddress, a=attempts.get(key)||{count:0,until:Date.now()+600000};if(a.until<Date.now()){a.count=0;a.until=Date.now()+600000;}if(a.count>=10)fail(429,'Too many login attempts. Try again in 10 minutes.');a.count++;attempts.set(key,a);
    const b=await body(req),name=str(b.username,80),pw=b.password,found=one('SELECT * FROM users WHERE username=? AND active=1',name);
    if(typeof pw!=='string'||pw.length>256||!found||!verifyPassword(pw,found.password))fail(401,'Invalid username or password.');attempts.delete(key);
    const t=randomBytes(32).toString('hex');run('DELETE FROM sessions WHERE expires<?',Date.now());run('INSERT INTO sessions VALUES(?,?,?)',createHash('sha256').update(t).digest('hex'),found.id,Date.now()+28800000);cookie(t);return send(userInfo(found));
   }
   if(p==='/api/me'&&method==='GET')return send(u?userInfo(u):null);
   if(p==='/api/system'&&method==='GET'){if(!u)fail(401,'Your session has expired. Please sign in again.');return send({edition:edition(appRoot),ala:u.role==='admin'?{found:ala().found}:undefined});}
   if(!u)fail(401,'Your session has expired. Please sign in again.');
   if(p==='/api/logout'&&method==='POST'){run('DELETE FROM sessions WHERE token=?',digest);cookie('');return send({ok:true});}
   if(p==='/api/password'&&method==='POST'){const b=await body(req);if(!verifyPassword(typeof b.current==='string'&&b.current.length<=256?b.current:'',u.password))fail(400,'Current password is incorrect.');run('UPDATE users SET password=? WHERE id=?',hashPassword(password(b.password)),u.id);run('DELETE FROM sessions WHERE user_id=? AND token<>?',u.id,digest);return send({ok:true});}
   if(p.startsWith('/api/admin/')) {
    if(u.role!=='admin')fail(403,'Administrator access required.');
    if(p==='/api/admin/skill-import-contract'&&method==='GET'){res.setHeader('content-type','text/markdown; charset=utf-8');res.setHeader('content-disposition','attachment; filename=analyst-skill-import-contract.md');res.setHeader('cache-control','no-store');return res.end(await fs.readFile(path.join(root,'skills/review-design/references/import-contract.md')));}
    if(p==='/api/admin/access-levels'&&method==='GET')return send(accessLevels(db));
    if(p==='/api/admin/access-levels'&&method==='POST'){
     const b=await body(req),name=str(b.name,80).trim();if(!name)fail(400,'Access Level Name is required.');
     if(b.id&&!one('SELECT id FROM access_levels WHERE id=?',b.id))fail(404,'Access Level not found.');
     const levelId=b.id||id();if(one('SELECT id FROM access_levels WHERE name=? COLLATE NOCASE AND id<>?',name,levelId))fail(409,'An Access Level with this name already exists.');
     run('INSERT INTO access_levels(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',levelId,name);return send({id:levelId});
    }
    const removeLevel=/^\/api\/admin\/access-levels\/([^/]+)$/.exec(p);
    if(removeLevel&&method==='DELETE'){if(!one('SELECT id FROM access_levels WHERE id=?',removeLevel[1]))fail(404,'Access Level not found.');deleteAccessLevel(db,removeLevel[1]);return send({deleted:true});}
    let removal;
    if(method==='DELETE'&&(removal=/^\/api\/admin\/(users|types)\/([^/]+)$/.exec(p))){
     const target=one(`SELECT * FROM ${removal[1]} WHERE id=?`,removal[2]);if(!target)fail(404,'Item not found.');
     if(removal[1]==='users'){
      if(target.role==='admin'&&target.active&&one("SELECT count(*) AS n FROM users WHERE role='admin' AND active=1").n===1)fail(400,'Keep at least one active administrator.');
      if(one('SELECT id FROM projects WHERE owner_id=?',target.id))fail(409,'This user owns projects. Disable the account or delete its projects before deleting the user.');
      transaction(db,()=>{run('DELETE FROM sessions WHERE user_id=?',target.id);run('DELETE FROM grants WHERE user_id=?',target.id);run('DELETE FROM users WHERE id=?',target.id);});
     }else{
      if(target.status==='generating')fail(409,'Wait for generation to finish before deleting this Analyst Skill.');
      if(all("SELECT snapshot FROM runs WHERE status='running'").some(r=>JSON.parse(r.snapshot).type?.id===target.id))fail(409,'Wait for reviews using this Analyst Skill to finish.');
      const count=one('SELECT count(*) AS n FROM projects WHERE type_id=?',target.id).n;if(count)fail(409,`This Analyst Skill is used by ${count} active or archived project(s). Delete those projects before deleting the Analyst Skill.`);
      transaction(db,()=>{run('DELETE FROM grants WHERE type_id=?',target.id);run('DELETE FROM type_attachments WHERE type_id=?',target.id);run('DELETE FROM types WHERE id=?',target.id);});
      await fs.rm(typeFolder(dir,target.id),{recursive:true,force:true});await fs.rm(path.join(dir,'analysis-skills',target.id),{recursive:true,force:true});
     }
     return send({deleted:true,id:target.id});
    }
    if(p==='/api/admin/users'&&method==='GET')return send(all('SELECT * FROM users').map(userInfo));
    if(p==='/api/admin/users'&&method==='POST') {
     const b=await body(req),uid=b.id||id(),old=one('SELECT * FROM users WHERE id=?',uid);if(b.id&&!old)fail(404,'User not found.');
     if(typeof b.username!=='string'||!b.username.trim()||b.username.length>80)fail(400,'Username is required and must be at most 80 characters.');
     const username=str(b.username,80),role=b.role,active=b.active!==false?1:0;
     if(!['admin','user'].includes(role))fail(400,'Invalid role.');
     if(!Array.isArray(b.typeIds)||b.typeIds.some(t=>!one('SELECT id FROM types WHERE id=?',t)))fail(400,'Unknown Analyst Skill.');
     if(old?.role==='admin'&&old.active&&(!active||role!=='admin')&&one("SELECT count(*) AS n FROM users WHERE role='admin' AND active=1").n===1)fail(400,'Keep at least one active administrator.');
     if(one('SELECT id FROM users WHERE username=? AND id<>?',username,uid))fail(409,'Username already exists.');
     const hash=b.password?hashPassword(password(b.password)):old?.password;if(!hash)fail(400,'Password is required.');
     const access=validateUserAccess(db,b,old?userAccess(db,uid):null);
     transaction(db,()=>{run('INSERT INTO users VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password=excluded.password,role=excluded.role,active=excluded.active',uid,username,hash,role,active);run('DELETE FROM grants WHERE user_id=?',uid);for(const t of new Set(b.typeIds))run('INSERT INTO grants VALUES(?,?)',uid,t);saveUserAccess(db,uid,access);if(old)run('DELETE FROM sessions WHERE user_id=?',uid);});return send({id:uid});
    }
    if(p==='/api/admin/import-skill'&&method==='POST'){
     const b=await body(req,30*1024*1024),tid=id(),name=str(b.name,120),imported=await importSkillArchive(b.file,tid);requireSession();
     const revision=saveSkillRevision(dir,{id:tid,name,criteria:imported.criteria,playbook:imported.playbook},imported.files,[],{keepCertificate:true});
     run("INSERT INTO types(id,name,criteria,playbook,status,skill_revision,skill_reference_version,generation_input) VALUES(?,?,?,?,'ready',?,0,?)",tid,name,imported.criteria,imported.playbook,revision,JSON.stringify({name,brief:'Apply the imported methodology to the project dossier.'}));return send({id:tid,status:'ready',verification:skillVerification(dir,{id:tid,skill_revision:revision})},201);
    }
    if(p==='/api/admin/type-drafts'&&method==='POST'){
     const b=await body(req),name=str(b.name,120),brief=str(b.brief,40000),tid=id();run("INSERT INTO types(id,name,criteria,playbook,status,generation_input) VALUES(?,?,'','','draft',?)",tid,name,JSON.stringify({name,brief}));return send({id:tid},201);
    }
    const typeRoute=/^\/api\/admin\/types\/([^/]+)(?:\/(files|skill)(?:\/([^/]+)(?:\/(preview|original))?)?)?$/.exec(p);
    if(typeRoute){
     const tid=typeRoute[1],getType=()=>{const t=one('SELECT * FROM types WHERE id=?',tid);if(!t)fail(404,'Analyst Skill not found.');return t;},type=getType();
     const editable=()=>{const t=getType();if(t.status==='generating')fail(409,'Review rules are being generated. Wait before changing their reference files.');return t;};
     if(!typeRoute[2]&&method==='GET'){let brief='';try{brief=JSON.parse(type.generation_input||'{}').brief||'';}catch{}return send({...skillInfo(type),report_template:skillReportTemplate(dir,type),brief,referenceFiles:typeReferences(db,tid)});}
     if(typeRoute[2]==='skill'&&method==='GET'){
      if(!type.skill_revision)return send({files:[],revision:null});const folder=typeSkillFolder(dir,tid,type.skill_revision),files=readSkillFiles(folder),filename=url.searchParams.get('file');
      if(filename){if(!validSkillFile(filename)||!Object.hasOwn(files,filename))fail(404,'Skill file not found.');return send({name:filename,text:files[filename],html:filename.endsWith('.md')?renderMarkdown(files[filename]):null});}
      return send({revision:type.skill_revision,files:Object.entries(files).map(([name,text])=>({name,size:Buffer.byteLength(text)}))});
     }
     if(typeRoute[2]==='files'){
      const aid=typeRoute[3],reference=aid?one('SELECT * FROM type_attachments WHERE type_id=? AND id=?',tid,aid):null;if(aid&&!reference)fail(404,'Reference file not found.');
      if(method==='GET'){
       if(!aid)return send(typeReferences(db,tid));
       if(!typeRoute[4])return send({...reference,html:renderMarkdown(reference.markdown)});
       const preview=typeRoute[4]==='preview';if(preview&&reference.file_type!=='pdf'&&!reference.has_preview)fail(404,'No document preview is available.');
       const filename=preview?(reference.file_type==='pdf'?'original.pdf':'preview.pdf'):'original.'+reference.file_type;
       const bytes=readArtifact(attachmentFolder(dir,tid,aid),filename,30*1024*1024);res.setHeader('content-type',preview?'application/pdf':mimeFor(reference.file_type));res.setHeader('content-disposition',preview?'inline':`attachment; filename="reference.${reference.file_type}"`);res.setHeader('cache-control','private, no-store');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',"frame-ancestors 'self'");return res.end(bytes);
      }
      if(method==='POST'&&!typeRoute[4]){
       editable();const b=await body(req,30*1024*1024),upload=await processUpload(b.file,b.file?.name||'Reference',{allowVisualOnly:true});requireSession();editable();if(aid&&!one('SELECT id FROM type_attachments WHERE type_id=? AND id=?',tid,aid))fail(409,'This reference file has changed. Refresh and try again.');const created=saveTypeAttachment(db,dir,tid,upload,aid);return send({id:created},201);
      }
      if(method==='DELETE'&&aid&&!typeRoute[4]){
       editable();transaction(db,()=>{run('DELETE FROM type_attachments WHERE type_id=? AND id=?',tid,aid);run("UPDATE types SET reference_version=reference_version+1,status=CASE WHEN skill_revision IS NULL THEN 'draft' ELSE 'outdated' END WHERE id=?",tid);});await fs.rm(attachmentFolder(dir,tid,aid),{recursive:true,force:true});return send({deleted:true});
      }
     }
    }
    if(p==='/api/admin/types'&&method==='POST'){
     const b=await body(req),tid=b.id||id();let old=one('SELECT * FROM types WHERE id=?',tid);if(b.id&&!old)fail(404,'Type not found.');if(old?.status==='generating')fail(409,'Review rules are still being generated.');
     if(old)old=ensureTypeSkill(db,dir,old);const name=str(b.name,120),criteria=str(b.criteria),playbook=str(b.playbook),status=old&&old.skill_reference_version!==old.reference_version?'outdated':'ready';
     try{if(!parseCriteria(criteria).length)fail(400,'Add at least one assessable review criterion.');}catch(e){fail(400,e.message);}
     const files=old?.skill_revision?readSkillFiles(typeSkillFolder(dir,tid,old.skill_revision)):compatibilitySkill({id:tid,name,criteria,playbook});
     if(b.report_template!==undefined){try{reportTemplate(b.report_template);}catch(e){fail(400,e.message);}files['references/report-template.md']=b.report_template;}
     // Renaming keeps verification; any change to criteria, playbook or report template voids it.
     const unchanged=!!old?.skill_revision&&criteria===old.criteria.trim()&&playbook===old.playbook.trim()&&(b.report_template===undefined||b.report_template===readSkillFiles(typeSkillFolder(dir,tid,old.skill_revision))['references/report-template.md']);
     const revision=saveSkillRevision(dir,{id:tid,name,criteria,playbook},files,sourceReferences(db,tid),{keepCertificate:unchanged});
     run("INSERT INTO types(id,name,criteria,playbook,status,skill_revision,skill_reference_version) VALUES(?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,criteria=excluded.criteria,playbook=excluded.playbook,status=excluded.status,skill_revision=excluded.skill_revision,generation_error=NULL",tid,name,criteria,playbook,status,revision);return send({id:tid});
    }
    if(p==='/api/admin/coding-agents'&&method==='GET'){const result=await catalog.agents({refresh:url.searchParams.get('refresh')==='1'});requireSession();return send(result);}
    const modelCatalog=/^\/api\/admin\/coding-agents\/([^/]+)\/models$/.exec(p);
    if(modelCatalog&&method==='GET'){const result=await catalog.models(decodeURIComponent(modelCatalog[1]),{refresh:url.searchParams.get('refresh')==='1'});requireSession();return send(result);}
    if(p==='/api/admin/settings'&&method==='GET'){const current=settings();return send({agent:current.agent,model:current.models?.[current.agent]||'',effort:current.efforts?.[current.agent]||'',console:current.showConsole===true,analysisLimit:current.analysisLimitMinutes||DEFAULT_ANALYSIS_MINUTES});}
    if(p==='/api/admin/settings'&&method==='POST'){const b=await body(req),selection=await catalog.validate(b);requireSession();const {alaPath,showConsole,analysisLimitMinutes}=settings();saveSettings({...selection,...(alaPath?{alaPath}:{}),...(showConsole?{showConsole:true}:{}),...(analysisLimitMinutes?{analysisLimitMinutes}:{})});return send({ok:true});}
    if(p==='/api/admin/analysis-limit'&&method==='POST'){const b=await body(req);let minutes;try{minutes=chooseMinutes(b.minutes,ANALYSIS_MINUTES,null);if(minutes===null)throw Error('Choose one of the offered time limits.');}catch(error){fail(400,error.message);}requireSession();saveSettings({...settings(),analysisLimitMinutes:minutes});return send({analysisLimit:minutes});}
    if(p==='/api/admin/console'&&method==='POST'){const b=await body(req);if(typeof b.enabled!=='boolean')fail(400,'Choose on or off.');requireSession();const {showConsole,...current}=settings();saveSettings(b.enabled?{...current,showConsole:true}:current);return send({console:b.enabled});}
    if(p==='/api/admin/ala'&&method==='GET')return send(alaStatus());
    if(p==='/api/admin/ala'&&method==='POST'){const b=await body(req),location=b.path===null||b.path===''?null:validateALALocation(b.path),{alaPath,...current}=settings();saveSettings(location?{...current,alaPath:location}:current);catalog.clear?.();return send(alaStatus());}
    if(p==='/api/admin/generate'&&method==='POST'){
     const b=await body(req),base=designInput(b),tid=b.id||id(),name=str(b.name,120),old=one('SELECT * FROM types WHERE id=?',tid);
     requireALA();if(jobs>=2)fail(429,'Two AI tasks are already running.');if(b.id&&!old)fail(404,'Type not found.');if(old?.status==='generating')fail(409,'Review rules are already being generated.');
     const references=sourceReferences(db,tid),referenceVersion=old?.reference_version||0,input={...base,name,typeId:tid,references:references.map(r=>({id:r.id,name:r.name,fileType:r.file_type,lineCount:r.markdown.split(/\r?\n/).length,textFile:`reference-files/${r.id}/content.md`,originalFile:`reference-files/${r.id}/original.${r.file_type}`,previewFile:r.has_preview?`reference-files/${r.id}/preview.pdf`:null}))};
     run("INSERT INTO types(id,name,criteria,playbook,status,generation_input) VALUES(?,?,?,?,'generating',?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,status='generating',generation_input=excluded.generation_input,generation_error=NULL",tid,name,old?.criteria||'',old?.playbook||'',JSON.stringify({name,brief:base.brief}));
     const jobSettings=settings(),job=path.join(dir,'designs',id());jobs++;
     Promise.resolve().then(()=>{prepareReferenceFiles(dir,job,tid,references);return invokeALA({root,dir:job,settings:jobSettings,input,prompt:designPrompt});}).then(result=>{
      const current=one('SELECT * FROM types WHERE id=?',tid);if(!current||current.reference_version!==referenceVersion||current.status!=='generating')return;
      // Generated skills are never self-certified: saveSkillRevision drops any certificate the agent wrote.
      const revision=saveSkillRevision(dir,{...current,criteria:str(result.criteria),playbook:str(result.playbook)},result.files,references);
      run("UPDATE types SET criteria=?,playbook=?,status='ready',generation_error=NULL,skill_revision=?,skill_reference_version=? WHERE id=?",result.criteria,result.playbook,revision,referenceVersion,tid);
     }).catch(error=>{console.error('Type generation failed:',error.message);run("UPDATE types SET status='failed',generation_error='The review methodology could not be completed. Review your reference files and retry.' WHERE id=? AND status='generating'",tid);}).finally(()=>jobs--);
     return send({id:tid,status:'generating'},202);
    }


    fail(404,'Unknown administration endpoint.');
   }
   if(p==='/api/types'&&method==='GET')return send(all('SELECT * FROM types').filter(t=>can(u,t.id)).map(t=>u.role==='admin'?skillInfo(t):({id:t.id,name:t.name,criteria:t.criteria,playbook:t.playbook,status:t.status,verification:skillVerification(dir,t)})));
   if(p==='/api/projects'&&method==='GET')return send(all(`SELECT * FROM projects WHERE archived_at IS ${url.searchParams.get('archived')==='1'?'NOT ':''}NULL`).filter(p=>canProject(u,p)).map(p=>({...p,documents:all('SELECT id,title FROM documents WHERE project_id=?',p.id)})));
   if(p==='/api/projects'&&method==='POST'){const b=await body(req);if(typeof b.company!=='string'||!b.company.trim()||b.company.length>120)fail(400,'Project name is required and must be at most 120 characters.');const pid=id();run('INSERT INTO projects(id,company,sector,type_id,owner_id) VALUES(?,?,?,?,?)',pid,b.company.trim(),'',null,u.id);const primary=userAccess(db,u.id).primaryAccessLevelId;if(primary)run('INSERT INTO project_access_levels VALUES(?,?)',pid,primary);syncProject(pid);return send({id:pid},201);}
   const documentFile=/^\/api\/projects\/([^/]+)\/documents\/([^/]+)\/(preview|original)$/.exec(p);
   if(documentFile&&method==='GET'){
    const project=getProject(u,documentFile[1]),doc=one('SELECT * FROM documents WHERE project_id=? AND id=?',project.id,documentFile[2]);if(!doc)fail(404,'Document not found.');
    const preview=documentFile[3]==='preview',folder=path.join(projectFolder(dir,project.id),'documents');
    if(preview&&!['pdf','doc','docx','ppt','pptx'].includes(doc.file_type))fail(404,'Preview not available.');
    const extension=preview?(doc.file_type!=='pdf'?'preview.pdf':'pdf'):doc.file_type;
    let bytes;try{bytes=readArtifact(folder,doc.id+'.'+extension,30*1024*1024);}catch{fail(404,'Original file is unavailable.');}
    res.setHeader('content-type',preview?'application/pdf':mimeFor(doc.file_type));res.setHeader('content-disposition',preview?'inline':`attachment; filename="document.${doc.file_type}"`);res.setHeader('cache-control','private, no-store');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Content-Security-Policy',"frame-ancestors 'self'");return res.end(bytes);
   }
   const events=/^\/api\/projects\/([^/]+)\/analyses\/([^/]+)\/events$/.exec(p);
   if(events&&method==='GET'){
    getProject(u,events[1]);if(!one('SELECT id FROM runs WHERE id=? AND project_id=?',events[2],events[1]))fail(404,'Analysis not found.');
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    let previous='',closed=false,busy=false;const emit=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const tick=async()=>{if(closed||busy)return;busy=true;try{
     const current=one('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND active=1',digest,Date.now());
     if(!current){emit('revoked',{});return stop();}try{getProject(current,events[1]);}catch{emit('revoked',{});return stop();}
     const run=one('SELECT status FROM runs WHERE id=? AND project_id=?',events[2],events[1]);if(!run){emit('revoked',{});return stop();}
     const file=path.join(analysisFolder(dir,events[1],events[2]),'progress.md');let text='';try{text=readArtifact(analysisFolder(dir,events[1],events[2]),'progress.md',100000).toString('utf8');}catch{}
     if(closed)return;const blocks=text.split(/\n---\s*\n/).map(x=>x.trim()).filter(Boolean);const latest=blocks.slice(-1).join('\n').slice(0,1800);
     if(latest&&latest!==previous){previous=latest;emit('progress',{html:renderMarkdown(latest)});}emit('status',{status:run.status});if(run.status!=='running')stop();
    }catch{stop();}finally{busy=false;}};
    const interval=setInterval(tick,1500);const stop=()=>{closed=true;clearInterval(interval);res.end();};res.on('close',()=>{closed=true;clearInterval(interval);});void tick();return;
   }
   const consoleFeed=/^\/api\/projects\/([^/]+)\/analyses\/([^/]+)\/console$/.exec(p);
   if(consoleFeed&&method==='GET'){
    getProject(u,consoleFeed[1]);if(settings().showConsole!==true)fail(404,'The live console is turned off.');if(!one('SELECT id FROM runs WHERE id=? AND project_id=?',consoleFeed[2],consoleFeed[1]))fail(404,'Analysis not found.');
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    let sent=0,closed=false,busy=false,announced=false;const emit=(event,data)=>res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const tick=async()=>{if(closed||busy)return;busy=true;try{
     const current=one('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND active=1',digest,Date.now());
     if(!current||settings().showConsole!==true){emit('revoked',{});return stop();}try{getProject(current,consoleFeed[1]);}catch{emit('revoked',{});return stop();}
     const run=one('SELECT status FROM runs WHERE id=? AND project_id=?',consoleFeed[2],consoleFeed[1]);if(!run){emit('revoked',{});return stop();}
     const feed=readConsole(liveWork.get(consoleFeed[2])||analysisFolder(dir,consoleFeed[1],consoleFeed[2]),sent);
     if(closed)return;sent=feed.total;if(!feed.available&&!announced){announced=true;emit('unavailable',{});}if(feed.lines.length)emit('lines',{lines:feed.lines});
     emit('status',{status:run.status});if(run.status!=='running')stop();
    }catch{stop();}finally{busy=false;}};
    const interval=setInterval(tick,1500);const stop=()=>{closed=true;clearInterval(interval);res.end();};res.on('close',()=>{closed=true;clearInterval(interval);});void tick();return;
   }
   const verificationFiles=/^\/api\/projects\/([^/]+)\/analyses\/([^/]+)\/verification$/.exec(p);
   if(verificationFiles&&method==='GET'){
    getProject(u,verificationFiles[1]);const report=getRun(verificationFiles[1],verificationFiles[2]);if(report.status!=='completed'||!report.result.quality)fail(404,'Verification records are not available.');
    const folder=analysisFolder(dir,verificationFiles[1],verificationFiles[2]),index=JSON.parse(readArtifact(folder,'verification-index.json'));
    const requested=url.searchParams.get('file');if(requested&&!index.files.some(file=>file.name===requested))fail(404,'Verification artifact not found.');
    const files=index.files.filter(file=>!requested||file.name===requested).map(file=>{const bytes=readArtifact(folder,file.name,30*1024*1024);if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)fail(409,'A verification artifact has changed since publication.');const encoding=/\.(pdf|docx?|pptx?|png)$/.test(file.name)?'base64':'utf8';return {...file,encoding,content:bytes.toString(encoding)};});
    res.setHeader('cache-control','private, no-store');res.setHeader('content-type',requested?.endsWith('.md')?'text/markdown; charset=utf-8':'application/json; charset=utf-8');res.setHeader('content-disposition',`attachment; filename="verification-${verificationFiles[2]}.json"`);return res.end(requested?Buffer.from(files[0].content,files[0].encoding):JSON.stringify({schemaVersion:1,runId:report.id,methodologyRevision:report.snapshot.type.methodology_revision,files}));
   }
   const originalReport=/^\/api\/projects\/([^/]+)\/analyses\/([^/]+)\/original$/.exec(p);
   if(originalReport&&method==='GET'){
    getProject(u,originalReport[1]);const report=getRun(originalReport[1],originalReport[2]),original=report.snapshot.original;
    if(!original)fail(404,'Original report file not found.');
    const bytes=readArtifact(analysisFolder(dir,originalReport[1],originalReport[2]),'original.'+original.type,30*1024*1024);
    res.setHeader('content-type',mimeFor(original.type));res.setHeader('content-disposition',`attachment; filename="report.${original.type}"`);res.setHeader('cache-control','private, no-store');return res.end(bytes);
   }
   const asset=/^\/api\/projects\/([^/]+)\/analyses\/([^/]+)\/(pdf|charts\/([a-zA-Z0-9_-]+\.(?:svg|png)))$/.exec(p);
   if(asset&&method==='GET'){
    getProject(u,asset[1]);const report=getRun(asset[1],asset[2]);if(report.status!=='completed')fail(409,'The report is not ready yet.');
    const folder=analysisFolder(dir,asset[1],asset[2]);let file;
    if(asset[3]==='pdf'){file=await createPDF(report,folder);res.setHeader('content-type','application/pdf');res.setHeader('content-disposition',`attachment; filename="Deep-Proof-${runVerification(report.snapshot).status==='verified'?'':'USE-WITH-CAUTION-'}${asset[2]}.pdf"`);}
    else{if(!report.result.chartFiles.includes(asset[4]))fail(404,'Chart not found.');file=path.join(folder,'charts',asset[4]);res.setHeader('content-type',asset[4].endsWith('.svg')?'image/svg+xml':'image/png');res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");}
    const current=requireSession();getProject(current,asset[1]);const bytes=readArtifact(folder,path.relative(folder,file),30*1024*1024);if(asset[4]?.endsWith('.svg'))safeSVG(bytes.toString('utf8'));res.setHeader('cache-control','private, no-store');return res.end(bytes);
   }
   const m=/^\/api\/projects\/([^/]+)(?:\/(documents|analyses|report-imports|archive|access)(?:\/([^/]+))?)?$/.exec(p);
   if(m){const project=getProject(u,m[1]),pid=project.id;
    if(m[2]==='access'&&!m[3]){
     if(u.role!=='admin'&&project.owner_id!==u.id)fail(403,'Only the project owner or an administrator can manage Project Access.');
     if(method==='GET')return send({...projectAccess(db,pid),ownerId:project.owner_id,levels:accessLevels(db),users:all('SELECT id,username,active FROM users ORDER BY username')});
     if(method==='POST'){const b=await body(req);saveProjectAccess(db,pid,b);return send(projectAccess(db,pid));}
    }
    if(m[2]==='archive'&&!m[3]&&method==='POST'){
     if(u.role!=='admin')fail(403,'Only administrators can archive or restore projects.');
     const b=await body(req);if(typeof b.archived!=='boolean')fail(400,'Specify whether to archive or restore the project.');
     if(b.archived&&one("SELECT id FROM runs WHERE project_id=? AND status='running'",pid))fail(409,'An analysis is running. Wait for it to finish before archiving this project.');
     const archivedAt=b.archived?(project.archived_at||new Date().toISOString()):null;
     run('UPDATE projects SET archived_at=? WHERE id=?',archivedAt,pid);syncProject(pid);return send({id:pid,archived_at:archivedAt});
    }
    if(project.archived_at&&method==='POST'&&['documents','analyses','report-imports'].includes(m[2]))fail(409,'This project is archived. Restore it before making changes.');

    if(!m[2]&&method==='DELETE'){
     if(u.role!=='admin')fail(403,'Only administrators can delete projects.');
     if(one("SELECT id FROM runs WHERE project_id=? AND status='running'",pid))fail(409,'An analysis is running. Wait for it to finish before deleting this project.');
     deletingProjects.add(pid);
     try{
      const runs=all('SELECT id FROM runs WHERE project_id=?',pid);
      for(const r of runs){if(!/^[a-zA-Z0-9_-]+$/.test(r.id))throw Error('Invalid analysis directory identifier.');await fs.rm(path.join(dir,'jobs',r.id),{recursive:true,force:true});}
      await fs.rm(projectFolder(dir,pid),{recursive:true,force:true});
      transaction(db,()=>{run('DELETE FROM runs WHERE project_id=?',pid);run('DELETE FROM documents WHERE project_id=?',pid);run('DELETE FROM projects WHERE id=?',pid);});
      return send({deleted:true,id:pid});
     }finally{deletingProjects.delete(pid);}
    }

    if(m[2]==='documents'&&method==='GET'){if(m[3]){const d=one('SELECT * FROM documents WHERE project_id=? AND id=?',pid,m[3]);if(!d)fail(404,'Document not found.');return send({...d,html:renderMarkdown(d.markdown)});}return send(all('SELECT id,title FROM documents WHERE project_id=?',pid));}
    if(m[2]==='documents'&&method==='POST'&&!m[3]){
     const b=await body(req,30*1024*1024),did=id(),title=str(b.title,160),uploaded=b.file?await processUpload(b.file,title):null;
     // Conversion can take time: check access and archive state again before writing.
     const currentUser=requireSession();
     const current=getProject(currentUser,pid);if(current.archived_at)fail(409,'This project is archived. Restore it before making changes.');
     const markdown=uploaded?.markdown||str(b.markdown,2000000),folder=path.join(projectFolder(dir,pid),'documents');safeDirectory(folder);
     if(uploaded){writeArtifact(folder,did+'.'+uploaded.type,uploaded.buffer);if(uploaded.preview)writeArtifact(folder,did+'.preview.pdf',uploaded.preview);}
     run('INSERT INTO documents(id,project_id,title,markdown,file_type,original_name) VALUES(?,?,?,?,?,?)',did,pid,title,markdown,uploaded?.type||'md',uploaded?.name||null);syncProject(pid);return send({id:did},201);
    }
    if(m[2]==='report-imports'&&method==='POST'&&!m[3]){
     const b=await body(req,30*1024*1024),title=str(b.title,160),language=reportLanguage(b.report_language).code,upload=await processUpload(b.file,title);
     const current=getProject(requireSession(),pid);if(current.archived_at)fail(409,'This project is archived. Restore it before making changes.');
     const rid=id(),created=new Date().toISOString(),snapshot={kind:'imported',title,project:current,report_language:language,type:{id:'external-report',name:'Imported Report',criteria:'',playbook:''},verification:{status:'demo'},documents:[],original:{name:upload.name,type:upload.type,sha256:createHash('sha256').update(upload.buffer).digest('hex')},imported_by:u.id};
     const folder=analysisFolder(dir,pid,rid);writeAnalysisSources(folder,snapshot);writeArtifact(folder,'report.md',upload.markdown);writeArtifact(folder,'original.'+upload.type,upload.buffer);if(upload.preview)writeArtifact(folder,'original.preview.pdf',upload.preview);
     run('INSERT INTO runs VALUES(?,?,?,?,?,?,?)',rid,pid,created,'completed',JSON.stringify(snapshot),JSON.stringify({format:'markdown'}),null);
     return send({id:rid,status:'completed'},201);
    }
    if(m[2]==='analyses'&&method==='GET'){if(m[3])return send(getRun(pid,m[3]));return send(all('SELECT id,created_at,status,snapshot,result,error FROM runs WHERE project_id=? ORDER BY created_at DESC',pid).map(({snapshot,result,error,...r})=>{const s=JSON.parse(snapshot);let quality,cut=false;if(r.status==='completed'){try{const stored=JSON.parse(result);cut=!!(stored?.partial||stored?.timeLimited);const q=s.kind==='quality'?stored?.quality:null;if(q)quality={completion:q.completion,confirmedFindings:q.confirmedFindings,...(q.timeLimited?{timeLimited:true}:{}),...(Array.isArray(q.findings)?{findings:q.findings}:{})};}catch{}}return {...r,kind:s.kind||'analysis',title:s.title,sourceReport:s.sourceReport,report_language:runReportLanguage(s).code,skill:{id:s.type.id,name:s.type.name,revision:s.type.skill_revision},verification:runVerification(s),...(s.kind==='quality'?{options:{depth:s.qualityOptions?.depth||'deep',researchMode:s.qualityOptions?.researchMode||'closed',...(s.timeLimitMinutes?{timeLimitMinutes:s.timeLimitMinutes}:{})}}:{}),...(quality?{quality}:{}),...(cut?{timeLimited:true}:{}),...(r.status==='failed'?{failure:analysisFailure(error)}:{})};}));}
    if(m[2]==='analyses'&&method==='POST'&&!m[3]){
     const request=await body(req),currentProject=getProject(requireSession(),pid);if(currentProject.archived_at)fail(409,'This project is archived. Restore it before making changes.');
     if(jobs>=2||one("SELECT id FROM runs WHERE project_id=? AND status='running'",pid))fail(409,'Analysis is already running.');
     const quality=request.sourceReportId!==undefined;
     if(quality&&(typeof request.sourceReportId!=='string'||!request.sourceReportId))fail(400,'Choose a report to check.');
     const source=quality?getRun(pid,request.sourceReportId):null;if(source&&source.status!=='completed')fail(409,'The report is not ready yet.');
     // A report check always uses the built-in adversarial verification skill; it is never chosen per run.
     if(quality&&(request.skillId||request.typeId)&&(request.skillId||request.typeId)!==QUALITY_SKILL_ID)fail(400,'Reports are checked with the built-in verification skill.');
     const skillId=quality?QUALITY_SKILL_ID:(request.skillId||request.typeId);if(typeof skillId!=='string'||!skillId)fail(400,'Choose an Analyst Skill.');
     const builtin=quality&&skillId===QUALITY_SKILL_ID;
     if(!builtin&&!can(u,skillId))fail(403,'Analyst Skill not allowed.');
     const selectedSkill=builtin?reportQualitySkill():one('SELECT * FROM types WHERE id=?',skillId);if(!selectedSkill)fail(404,'Analyst Skill not found.');
     if(selectedSkill.status!=='ready')fail(409,'The Analyst Skill review rules are not ready yet.');
     const language=reportLanguage(request.report_language).code;
     const projectDocuments=all('SELECT id,title,markdown,file_type,original_name FROM documents WHERE project_id=?',pid);
     const qualityInput=quality?qualityDocuments(source,source.result.markdown,projectDocuments):null;
     const documents=qualityInput?.documents||projectDocuments;if(!documents.length)fail(400,'Add documents before starting a review.');
     if(builtin)for(const document of documents){
      document.originalFile=`sources/${document.id}.${document.file_type||'md'}`;
      if((document.file_type||'md')==='md'){document.original_available=true;document.original_sha256=createHash('sha256').update(document.markdown).digest('hex');continue;}
      const target=document.id===qualityInput.sourceReport.documentId,sourceFolder=target&&source.snapshot.original?analysisFolder(dir,pid,source.id):source.snapshot.kind!=='imported'?analysisFolder(dir,pid,source.id):projectFolder(dir,pid);
      const name=target&&source.snapshot.original?'original.'+document.file_type:source.snapshot.kind!=='imported'?`sources/${document.id}.${document.file_type}`:`documents/${document.id}.${document.file_type}`;
      try{const bytes=readArtifact(sourceFolder,name,30*1024*1024);document.original_available=true;document.original_sha256=createHash('sha256').update(bytes).digest('hex');}catch(error){if(error.code!=='ENOENT')throw error;document.original_available=false;}
     }
     let qualityOptions,timeLimitMinutes;try{if(builtin){qualityOptions=normalizeOptions(request.qualityOptions);timeLimitMinutes=chooseMinutes(request.timeLimitMinutes,CHECK_MINUTES,defaultCheckMinutes(qualityOptions.depth));}}catch(error){fail(400,error.message);}
     // Analyses use the administrator's limit (frozen with the run); checks use the minutes chosen in the dialog.
     if(timeLimitMinutes===undefined)timeLimitMinutes=settings().analysisLimitMinutes||DEFAULT_ANALYSIS_MINUTES;
     requireALA();
     const ensured=builtin?{...selectedSkill,skill_revision:saveSkillRevision(dir,selectedSkill,reportQualityFiles())}:ensureTypeSkill(db,dir,selectedSkill);
     // The unvalidated / verified state is fixed when the run is created and travels with the report.
     const rid=id(),snapshot={project:currentProject,report_language:language,type:skillInfo(ensured),verification:skillVerification(dir,ensured),reportTemplate:skillReportTemplate(dir,ensured),documents,settings:settings(),timeLimitMinutes,...(quality?{kind:'quality',sourceReport:qualityInput.sourceReport,...(builtin?{qualityOptions}: {})}:{})},created=new Date().toISOString();
     run('INSERT INTO runs VALUES(?,?,?,?,?,?,?)',rid,pid,created,'running',JSON.stringify(snapshot),null,null);writeAnalysisSources(analysisFolder(dir,pid,rid),snapshot);
     const evidenceFolder=quality&&source.snapshot.kind!=='imported'?path.join(analysisFolder(dir,pid,source.id),'sources'):path.join(projectFolder(dir,pid),'documents');
     for(const document of documents){for(const ext of [document.file_type,['doc','docx','ppt','pptx'].includes(document.file_type)?'preview.pdf':null].filter(Boolean)){if(ext==='md')continue;const file=path.join(evidenceFolder,document.id+'.'+ext);if(fsSync.existsSync(file))fsSync.copyFileSync(file,path.join(analysisFolder(dir,pid,rid),'sources',document.id+'.'+ext));}}
     if(quality&&source.snapshot.original){
      const sourceFolder=analysisFolder(dir,pid,source.id),targetFolder=analysisFolder(dir,pid,rid),targetId=qualityInput.sourceReport.documentId;
      for(const [from,to] of [['original.'+source.snapshot.original.type,`sources/${targetId}.${source.snapshot.original.type}`],['original.preview.pdf',`sources/${targetId}.preview.pdf`]])try{writeArtifact(targetFolder,to,readArtifact(sourceFolder,from,30*1024*1024));}catch(error){if(error.code!=='ENOENT')throw error;}
     }
     // The opt-in process trace (DEEP_PROOF_TRACE=1): null when off; its calls never throw and never change the run.
     const trace=createRunTrace({dir,pid,rid,env});trace?.runStart({snapshot,createdAt:created});let outcome=null;
     jobs++;
     const folder=analysisFolder(dir,pid,rid),prompt=(quality?qualityPrompt(snapshot):'')+reviewPrompt(snapshot).replace('Do not browse.',builtin&&qualityOptions.researchMode==='external'?'Public external research is explicitly authorized for this run. Do not transmit confidential source text or personal data. Retain dated public sources under quality/external-sources.jsonl and use the rigorous skill evidence rules.':'Do not browse.');
     Promise.resolve().then(async()=>{
      if(builtin)return withQualityWorkspace(folder,snapshot,async workspace=>{trace?.record('workspace-created',{path:workspace});liveWork.set(rid,workspace);let cut=false;try{await invokeALA({root,dir:workspace,settings:snapshot.settings,input:snapshot,prompt,artifactDir:dir,progressDir:folder,trace});cut=wrappedUp(workspace);}catch(error){if(error.code!=='TIME_LIMIT')throw error;let partial=null;try{partial=await readValidatedOutput(workspace,snapshot,'analysis');}catch{}if(!['incomplete','triage'].includes(partial?.quality?.completion)){const notes=publishTimeLimited({folder,snapshot,progress:progressNotes(workspace)||progressNotes(folder)});trace?.record('published',{what:'time-limit-notes',timeLimited:true});return notes;}cut=true;}const published=await publishQualityOutput(workspace,folder,snapshot,dir);trace?.record('published',{what:'check-report',timeLimited:cut});return cut?{...published,timeLimited:true}:published;},{beforeRemove:trace?workspace=>trace.keepWorkspace(workspace):undefined});
      liveWork.set(rid,folder);
      try{await invokeALA({root,dir:folder,settings:snapshot.settings,input:snapshot,prompt,artifactDir:dir,trace});await readValidatedOutput(folder,snapshot,'analysis');const cut=wrappedUp(folder);trace?.record('published',{what:'report',timeLimited:cut});return {format:'markdown',...(cut?{timeLimited:true}:{})};}
      catch(error){if(error.code==='TIME_LIMIT'){const notes=publishTimeLimited({folder,snapshot,progress:progressNotes(folder)});trace?.record('published',{what:'time-limit-notes',timeLimited:true});return notes;}throw error;}
     }).then(result=>{run("UPDATE runs SET status='completed',result=? WHERE id=?",JSON.stringify(result),rid);outcome={status:'completed',result};}).catch(e=>{run("UPDATE runs SET status='failed',error=? WHERE id=?",e.message,rid);outcome={status:'failed',error:e};}).finally(()=>{jobs--;liveWork.delete(rid);try{trace?.runEnd(outcome);}catch{}});
     return send({id:rid,status:'running'},202);
    }
   }
   fail(404,'Not found.');
  }catch(e){if(res.headersSent){res.end();return;}if(e.status)send({error:e.message},e.status);else{const reference=randomBytes(6).toString('hex');console.error(`[Deep Proof ${reference}]`,e.stack||e.message);send({error:`The operation could not be completed. Please try again. Reference: ${reference}`},500);}}
 });
 return {server,db};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){const {server,db}=createApp();server.listen(Number(process.env.PORT||8000),process.env.HOST||'127.0.0.1',()=>{
 console.log(`Deep Proof ${edition(root)==='community'?'Community Edition':'(commercial license)'}: http://${process.env.HOST||'127.0.0.1'}:${server.address().port}`);
 const status=resolveALA(root,JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get()?.value||'{}'));
 console.log(status.found?`ALA: ${status.entry}${status.dependencies?'':' (dependencies missing: run npm install in the ALA folder)'}`:`ALA not found. Checked: ${status.checked.map(c=>c.location).join(', ')}. Set its location in Administration → Deep Proof Configuration.`);
});}
