import {runReportLanguage} from '../web/report-languages.js';
import {reportLabels} from './report-labels.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {readArtifact,writeArtifact,safePath} from './safe-files.mjs';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {renderReportFragment,escapeHTML as esc} from './markdown-report.mjs';
import {validateChartFiles} from './charts-validation.mjs';
import {runVerification} from './verification.mjs';
import {renderMarkdown} from './markdown.mjs';
const pending=new Map();
export async function reportHTML(run,folder){
 const sharedCSS=await fs.readFile(new URL('../web/markdown.css',import.meta.url),'utf8');
 const language=runReportLanguage(run.snapshot).code,[evidenceTitle,sourcesLabel,linesLabel,sourceNote]=reportLabels(language);
 const report=run.result,images={};await validateChartFiles(folder,report);
 for(const name of report.chartFiles){images[name]=`data:${name.endsWith('.svg')?'image/svg+xml':'image/png'};base64,`+readArtifact(folder,'charts/'+name).toString('base64');}
 const imported=run.snapshot.kind==='imported';
 const sections=report.sections.map(s=>`<section><h2>${esc(s.displayTitle||s.title)}</h2>${imported?renderMarkdown(s.markdown):renderReportFragment(s.markdown,{imageURL:name=>images[name],print:true,language:runReportLanguage(run.snapshot).code})}</section>`).join('\n');
 const evidence=Object.values(report.citations).map(c=>`<div class="evidence-entry" id="evidence-${c.label}"><h3>[${esc(c.label)}] ${esc(c.title)} · ${esc(linesLabel)} ${c.startLine}–${c.endLine}</h3><blockquote>${esc(c.quote).replace(/\n/g,'<br>')}</blockquote></div>`).join('');
 // Use With Caution reports carry the label on every page so excerpts cannot be passed off as verified work.
 const verification=runVerification(run.snapshot),demo=verification.status!=='verified';
 const trust=imported?'<div class="trust demo"><strong>IMPORTED REPORT</strong><span>Imported from an external tool. Deep Proof has not validated this report. The original file is preserved separately.</span></div>':demo?'<div class="trust demo"><strong>USE WITH CAUTION</strong><span>Produced with an unverified Analyst Skill that has not been scientifically evaluated. Not safe for real-world problems without rigorous validation.</span></div>'
  :`<div class="trust verified"><strong>VERIFIED SKILL</strong><span>Certified by ${esc(verification.verifiedBy)} on ${esc(verification.verifiedOn)} · ${Number(verification.evaluationCases)} evaluation cases.</span></div>`;
 const trustCSS=demo?'@page{@top-center{content:"USE WITH CAUTION · NOT VALIDATED";font-size:8pt;font-weight:700;letter-spacing:.12em;color:#b45309}}.watermark{position:fixed;top:45%;left:0;right:0;text-align:center;transform:rotate(-30deg);font-size:52pt;font-weight:800;letter-spacing:.06em;color:#b4530912;white-space:nowrap;z-index:-1;pointer-events:none}':'';
 return `<!doctype html><html lang="${esc(runReportLanguage(run.snapshot).code)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${esc(run.snapshot.project.company)} · Deep Proof${demo?' · USE WITH CAUTION':''}</title><style>
 @page{size:A4;margin:18mm 17mm 20mm;@bottom-left{content:"Deep Proof";font-size:8pt;color:#667777}@bottom-right{content:counter(page) " / " counter(pages);font-size:8pt;color:#667777}}
 *{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#0b1a22;font-size:10.5pt;line-height:1.6;margin:0;print-color-adjust:exact;-webkit-print-color-adjust:exact}header{border-bottom:2px solid #07151d;padding:0 0 9mm;margin-bottom:9mm}.brand{font-size:11pt;letter-spacing:.12em;color:#4a7300;font-weight:700;text-transform:uppercase}h1{font-size:27pt;line-height:1.2;letter-spacing:-.04em;margin:6mm 0 3mm}.meta{font-size:9pt;color:#5f7070}h2{font-size:17pt;line-height:1.25;margin:9mm 0 4mm;border-bottom:1px solid #dce1d9;padding-bottom:2mm;break-after:avoid}h3{font-size:11pt;line-height:1.45;margin:5mm 0 2mm;break-after:avoid}p{margin:0 0 3mm;orphans:3;widows:3}ul{padding-left:5mm}li{margin-bottom:2mm}table{border-collapse:collapse;width:100%;font-size:9pt;margin:4mm 0;table-layout:auto}th,td{padding:2.2mm;border:1px solid #dce1d9;text-align:left;overflow-wrap:normal;word-break:normal}th{background:#eef1eb}thead{display:table-header-group}tr{break-inside:avoid}img.report-chart{max-width:100%;max-height:220mm;object-fit:contain;display:block;margin:5mm auto;break-inside:avoid}.evidence-ref{font-size:8pt;color:#4a7300;text-decoration:none;vertical-align:super;white-space:nowrap}blockquote{margin:2mm 0 4mm;border-left:2px solid #9fbf5c;padding-left:3mm;color:#3d5054;font-size:9pt;overflow-wrap:normal;word-break:normal}.evidence-entry{break-inside:avoid}.evidence-entry h3{font-size:9pt}.evidence-appendix{break-before:page}.report-note{padding:3mm;background:#f3f5f0;color:#5f7070;font-size:9pt}.trust{display:flex;gap:4mm;align-items:baseline;margin:0 0 8mm;padding:3mm 4mm;border-radius:2mm;font-size:9pt;line-height:1.45}.trust strong{letter-spacing:.1em;white-space:nowrap}.trust.demo{background:#fff7ed;border:1px solid #f5c48a;color:#7c3d0a}.trust.demo strong{color:#b45309}.trust.verified{background:#ecfdf5;border:1px solid #a7e3c6;color:#14532d}.trust.verified strong{color:#047857}
 ${trustCSS}
 ${sharedCSS}
 </style></head><body>${demo?'<div class="watermark" aria-hidden="true">USE WITH CAUTION</div>':''}<header><div class="brand">Deep Proof</div><h1>${esc(run.snapshot.project.company)}</h1><div class="meta">${esc(new Date(run.created_at).toLocaleDateString(language))} · ${run.snapshot.documents.length} ${esc(sourcesLabel)} · ${esc(run.snapshot.type.name||'Saved Skill')}</div></header>${trust}${sections}<section class="evidence-appendix"><h2>${esc(evidenceTitle)}</h2><p class="report-note">${esc(sourceNote)}</p>${evidence}</section></body></html>`;
}
export async function createPDF(run,folder){
 if(pending.has(folder))return pending.get(folder);
 if(pending.size>=2)throw Object.assign(Error('Two PDF exports are in progress. Please try again shortly.'),{status:429});
 const promise=(async()=>{
  safePath(folder);const content=await reportHTML(run,folder),fingerprint=createHash('sha256').update(content).digest('hex');
  try{if(readArtifact(folder,'report.pdf.sha256',128).toString()===fingerprint&&readArtifact(folder,'report.pdf',30*1024*1024).subarray(0,5).toString()==='%PDF-')return path.join(folder,'report.pdf');}catch{}
  // Render in a private server-owned directory, never an agent-controlled output path.
  const temporary=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'analyst-pdf-')),output=path.join(temporary,'report.pdf'),html=path.join(temporary,'report.html');
  try{
   await fs.writeFile(html,content,{mode:0o600});
   await new Promise((resolve,reject)=>{
    const child=spawn(process.env.CHROMIUM||'/usr/bin/chromium-browser',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-pdf-header-footer',`--user-data-dir=${path.join(temporary,'browser')}`,`--print-to-pdf=${output}`,pathToFileURL(html).href],{stdio:['ignore','ignore','pipe'],detached:true});let stderr='';
    const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}reject(Error('PDF export timed out.'));},60000);
    child.stderr.on('data',b=>stderr=(stderr+b).slice(-2000));child.on('error',()=>{clearTimeout(timer);reject(Error('PDF export requires Chromium on the server.'));});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('PDF export failed. '+stderr));});
   });
   const pdf=readArtifact(temporary,'report.pdf',30*1024*1024);if(pdf.subarray(0,5).toString()!=='%PDF-')throw Error('PDF export did not produce a valid document.');
   safePath(folder);writeArtifact(folder,'report.html',content);writeArtifact(folder,'report.pdf',pdf);writeArtifact(folder,'report.pdf.sha256',fingerprint);return path.join(folder,'report.pdf');
  }finally{await fs.rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
 })();pending.set(folder,promise);try{return await promise;}finally{pending.delete(folder);}
}
