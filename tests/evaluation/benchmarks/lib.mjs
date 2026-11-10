// Pure helpers for the third-party benchmark evaluation set: case normalization, family selection,
// blind dossier rendering and offline scoring. Nothing here touches the network or calls a model.
import crypto from 'node:crypto';

export const sha256=data=>crypto.createHash('sha256').update(data).digest('hex');
export const gitBlobSha=buffer=>crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buffer.length}\0`),buffer])).digest('hex');
export const MAX_UPLOAD_BYTES=20*1024*1024;
export const MAX_TEXT_CHARS=2000000;

// Only GPT and Claude outputs are selected; other summarizers in the upstream data are ignored.
export const TARGET_MODELS={
 faithbench:['openai/gpt-4o','openai/GPT-3.5-Turbo','Anthropic/claude-3-5-sonnet-20240620'],
 ragtruth:['gpt-4-0613','gpt-3.5-turbo-0613'],
 financebench:['gpt-4-1106-preview','claude-2']
};
export const FINANCEBENCH_SETTING='inContext';
export const PROFILES={
 core:{faithbench:{families:16},ragtruth:{positiveFamilies:12,cleanFamilies:8},financebench:{families:8,questionsPerFamily:2}},
 full:{faithbench:{families:Infinity},ragtruth:{positiveFamilies:Infinity,cleanFamilies:Infinity},financebench:{families:Infinity,questionsPerFamily:Infinity}}
};
export const VERDICTS=['problem','no_problem','refusal','ambiguous'];

// Families keep every output about one source document (FaithBench passage, RAGTruth article,
// FinanceBench company) in a single partition, as tests/evaluation/report-quality/README.md requires.
export function partitionOf(dataset,family){const n=parseInt(sha256(`partition:${dataset}:${family}`).slice(0,8),16)%10;return n<2?'development':n<4?'calibration':'final';}
const order=(dataset,key)=>sha256(`order:${dataset}:${key}`);
export const caseId=(dataset,record,model)=>'case-'+sha256(`case:${dataset}:${record}:${model}`).slice(0,12);

const FAITHBENCH_LABELS=new Set(['Unwanted','Unwanted.Intrinsic','Unwanted.Extrinsic','Questionable','Benign']);
// Own mapping, not upstream scripts/binarize.py, which returns 0 both for unannotated samples and for its hallucinated class.
export function faithbenchCategory(annotations){
 const labels=new Set(annotations.flatMap(a=>a.label));
 for(const label of labels)if(!FAITHBENCH_LABELS.has(label))throw Error(`Unknown FaithBench label: ${label}`);
 if(!labels.size)return 'no_annotation';
 if([...labels].some(label=>label.startsWith('Unwanted')))return 'unwanted';
 return labels.has('Questionable')?'questionable':'benign';
}
const FAITHBENCH_VERDICT={no_annotation:'no_problem',unwanted:'problem',questionable:'ambiguous',benign:'ambiguous'};

function mergeSpans(spans){
 const merged=new Map();
 for(const s of spans){
  const key=`${s.start}:${s.end}`,m=merged.get(key)??{start:s.start,end:s.end,text:s.text,labels:new Set(),notes:new Set(),annotations:0,...s.extra};
  for(const label of s.labels)m.labels.add(label);if(s.note?.trim())m.notes.add(s.note.trim());m.annotations++;merged.set(key,m);
 }
 return [...merged.values()].sort((a,b)=>a.start-b.start||a.end-b.end).map(m=>({...m,labels:[...m.labels],notes:[...m.notes]}));
}
function checkSpan(text,start,end,expected,where){
 if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>text.length||start>=end)throw Error(`${where}: span ${start}-${end} is outside the output.`);
 if(text.slice(start,end)!==expected)throw Error(`${where}: span ${start}-${end} does not match its recorded text.`);
}

export function faithbenchCases(batches){
 const cases=[];
 for(const {batch,samples} of batches)for(const s of samples){
  const model=s.metadata?.summarizer;if(!TARGET_MODELS.faithbench.includes(model))continue;
  const record=`batch_${batch}/sample_${s.sample_id}`,annotations=s.annotations??[],category=faithbenchCategory(annotations);
  for(const a of annotations)checkSpan(s.summary,a.summary_start,a.summary_end,a.summary_span,`FaithBench ${record}`);
  cases.push({dataset:'faithbench',record,model,family:sha256(s.source).slice(0,16),task:'summary',category,verdict:FAITHBENCH_VERDICT[category],
   source:s.source,aiOutput:s.summary,instruction:null,
   spans:mergeSpans(annotations.map(a=>({start:a.summary_start,end:a.summary_end,text:a.summary_span,labels:a.label,note:a.note}))).map(sp=>({...sp,target:sp.labels.some(l=>l.startsWith('Unwanted'))})),
   upstream:{record,rawSampleId:s.metadata.raw_sample_id}});
 }
 return cases;
}

const RAGTRUTH_QUALITY={good:null,incorrect_refusal:'refusal'};
export function ragtruthCases(sources,responses){
 const byId=new Map(sources.map(s=>[String(s.source_id),s])),cases=[];
 for(const r of responses){
  const src=byId.get(String(r.source_id));if(!src||src.task_type!=='Summary'||!TARGET_MODELS.ragtruth.includes(r.model))continue;
  if(typeof src.source_info!=='string')throw Error(`RAGTruth source ${src.source_id}: summary source text must be a string.`);
  if(!Object.hasOwn(RAGTRUTH_QUALITY,r.quality))throw Error(`RAGTruth response ${r.id}: unsupported quality ${r.quality}.`);
  const labels=r.labels??[];for(const l of labels)checkSpan(r.response,l.start,l.end,l.text,`RAGTruth response ${r.id}`);
  const failure=RAGTRUTH_QUALITY[r.quality],category=failure??(labels.length?'hallucinated':'no_annotation');
  const first=String(src.prompt??'').split('\n')[0].trim().replace(/:$/,'');
  cases.push({dataset:'ragtruth',record:`response_${r.id}`,model:r.model,family:String(src.source_id),task:'summary',category,
   verdict:failure==='refusal'?'refusal':category==='no_annotation'?'no_problem':'problem',
   source:src.source_info,aiOutput:r.response,instruction:/^summari[sz]e/i.test(first)?first:null,
   spans:mergeSpans(labels.map(l=>({start:l.start,end:l.end,text:l.text,labels:[l.label_type],note:l.meta,extra:{implicitTrue:!!l.implicit_true,dueToNull:!!l.due_to_null,target:true}}))),
   upstream:{record:String(r.id),sourceId:String(src.source_id),sourceCorpus:src.source,split:r.split,quality:r.quality,temperature:r.temperature}});
 }
 return cases;
}

const FINANCEBENCH_LABELS={'Correct Answer':['correct_answer','no_problem'],'Incorrect Answer':['incorrect_answer','problem'],'Refusal':['refusal','refusal']};
export function financebenchCases(questions,documents,results,pdfs){
 const docs=new Map(documents.map(d=>[d.doc_name,d])),cases=[];
 for(const q of questions){
  const pdf=pdfs[q.doc_name];if(!pdf||pdf.size>MAX_UPLOAD_BYTES)continue;
  for(const model of TARGET_MODELS.financebench){
   const r=results[model]?.get(q.financebench_id);if(!r)continue;
   if(!Object.hasOwn(FINANCEBENCH_LABELS,r.label))throw Error(`FinanceBench ${q.financebench_id} ${model}: unknown label ${r.label}.`);
   if(r.model_answer==null||!String(r.model_answer).trim())throw Error(`FinanceBench ${q.financebench_id} ${model}: empty model answer.`);
   const [category,verdict]=FINANCEBENCH_LABELS[r.label],doc=docs.get(q.doc_name)??{};
   cases.push({dataset:'financebench',record:q.financebench_id,model,family:q.company,task:'question_answering',category,verdict,
    question:q.question,aiOutput:String(r.model_answer),document:{name:q.doc_name,file:`${q.doc_name}.pdf`,...pdf},spans:[],
    reference:{answer:q.answer,justification:q.justification,questionType:q.question_type,questionReasoning:q.question_reasoning,
     evidence:(q.evidence??[]).map(e=>({document:e.doc_name,pageIndex:e.evidence_page_num,pdfPage:e.evidence_page_num+1,text:e.evidence_text}))},
    upstream:{record:q.financebench_id,company:q.company,docName:q.doc_name,docType:doc.doc_type??null,docPeriod:doc.doc_period??null,setting:r.eval_mode,temperature:r.temp,gradedLabel:r.label}});
  }
 }
 return cases;
}

// Selection works on families: chosen families contribute every GPT/Claude output, which gives
// paired same-document controls and keeps near-duplicates within one partition.
export function selectCases(all,profile){
 const limits=typeof profile==='string'?(Object.hasOwn(PROFILES,profile)?PROFILES[profile]:null):profile;if(!limits)throw Error(`Unknown profile: ${profile}`);
 const groups=dataset=>{const g=new Map();for(const c of all.filter(c=>c.dataset===dataset)){if(!g.has(c.family))g.set(c.family,[]);g.get(c.family).push(c);}return [...g.entries()].sort(([a],[b])=>order(dataset,a).localeCompare(order(dataset,b)));};
 const selected=[];
 const fb=groups('faithbench').filter(([,cs])=>TARGET_MODELS.faithbench.every(m=>cs.some(c=>c.model===m)));
 for(const [,cs] of fb.slice(0,limits.faithbench.families))selected.push(...cs);
 const rt=groups('ragtruth').filter(([,cs])=>TARGET_MODELS.ragtruth.every(m=>cs.some(c=>c.model===m)));
 const positive=rt.filter(([,cs])=>cs.some(c=>c.verdict!=='no_problem')),clean=rt.filter(([,cs])=>cs.every(c=>c.verdict==='no_problem'));
 for(const [,cs] of [...positive.slice(0,limits.ragtruth.positiveFamilies),...clean.slice(0,limits.ragtruth.cleanFamilies)])selected.push(...cs);
 let families=0;
 for(const [,cs] of groups('financebench')){
  if(families>=limits.financebench.families)break;
  const questions=[...new Set(cs.map(c=>c.record))].filter(q=>TARGET_MODELS.financebench.every(m=>cs.some(c=>c.record===q&&c.model===m)))
   .sort((a,b)=>order('financebench',a).localeCompare(order('financebench',b))).slice(0,limits.financebench.questionsPerFamily);
  if(!questions.length)continue;families++;
  selected.push(...cs.filter(c=>questions.includes(c.record)));
 }
 return selected.map(c=>({...c,caseId:caseId(c.dataset,c.record,c.model),partition:partitionOf(c.dataset,c.family)}))
  .sort((a,b)=>a.dataset.localeCompare(b.dataset)||a.caseId.localeCompare(b.caseId));
}
export const selectionEntry=c=>({caseId:c.caseId,dataset:c.dataset,family:c.family,partition:c.partition});

const NAMES={faithbench:'FaithBench',ragtruth:'RAGTruth',financebench:'FinanceBench'};
// Authored dossier text never names the model, the label or the upstream record; only the dataset and pinned version.
export function renderDossier(c,source){
 const provenance=`Provenance: ${NAMES[c.dataset]} (${source.repo} at commit ${source.commit.slice(0,12)}). Upstream record identifiers are withheld from this dossier.`;
 if(c.task==='question_answering'){
  return {'review-request.md':`# Review Request\n\nCase: ${c.caseId}\n\n${provenance}\n\nAn AI system was given the filing \`${c.document.file}\` and asked the question recorded in \`ai-answer.txt\`. Decide whether the AI answer is correct and supported by the filing. Quote the filing passages that settle the question. If the answer states a wrong figure or conclusion, quote the wrong statement exactly. If the answer does not answer the question, say so.\n`,
   'ai-answer.txt':`Question:\n${c.question}\n\nAI answer:\n${c.aiOutput}\n`};
 }
 const asked=c.instruction?`and asked: "${c.instruction}"`:'and asked to summarize it';
 return {'review-request.md':`# Review Request\n\nCase: ${c.caseId}\n\n${provenance}\n\nAn AI system was given the text in \`source.txt\` ${asked}. Its output is \`ai-summary.txt\`, reproduced exactly. Check every statement in the summary against the source. For each statement that the source contradicts or does not support, quote it exactly and explain why. Report important omissions separately. If every statement is supported, say so.\n`,
  'source.txt':c.source,'ai-summary.txt':c.aiOutput};
}
const LEAK_TERMS=[...new Set(Object.values(TARGET_MODELS).flat().flatMap(m=>[m,m.split('/').pop()]))].concat(['gpt','claude','openai','anthropic','unwanted','questionable','benign','baseless','conflict','incorrect answer','correct answer','refusal','hallucinat']);
export const authoredLeaks=text=>LEAK_TERMS.filter(term=>text.toLowerCase().includes(term.toLowerCase()));

export function goldRecord(c,source){
 return {caseId:c.caseId,dataset:c.dataset,datasetName:NAMES[c.dataset],repo:source.repo,commit:source.commit,license:source.license,
  partition:c.partition,family:c.family,task:c.task,model:c.model,expected:{verdict:c.verdict,category:c.category},
  aiOutput:c.aiOutput,spans:c.spans,...(c.reference?{question:c.question,reference:c.reference,document:c.document}:{}),
  ...(c.checks?{checks:c.checks}:{}),upstream:c.upstream};
}

// Whitespace-normalized search with offsets mapped back to the raw text (same normalization as validateMarkdownReport).
export function locateQuoteAll(text,quote){
 const chars=[],map=[];let space=false;
 for(let i=0;i<text.length;i++){if(/\s/.test(text[i])){if(!space&&chars.length){chars.push(' ');map.push(i);}space=true;}else{chars.push(text[i]);map.push(i);space=false;}}
 const norm=chars.join(''),needle=String(quote).replace(/\s+/g,' ').trim(),found=[];if(!needle)return found;
 for(let at=norm.indexOf(needle);at>=0;at=norm.indexOf(needle,at+1))found.push({start:map[at],end:map[at+needle.length-1]+1});
 return found;
}
export const locateQuote=(text,quote)=>locateQuoteAll(text,quote)[0]??null;
// Issues are regions of overlapping target spans, so near-duplicate spans from several annotators count once.
export function issueRegions(spans){
 const regions=[];
 for(const s of spans.filter(s=>s.target!==false).sort((a,b)=>a.start-b.start)){const last=regions.at(-1);if(last&&s.start<last.end)last.end=Math.max(last.end,s.end);else regions.push({start:s.start,end:s.end});}
 return regions;
}
export function wilson(k,n,z=1.96){
 if(!n)return null;const p=k/n,d=1+z*z/n,center=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
 return [Math.max(0,center-half),Math.min(1,center+half)].map(x=>Math.round(x*10000)/10000);
}
const rate=(k,n)=>({value:n?Math.round(k/n*10000)/10000:null,k,n,ci95:wilson(k,n)});

// predictions: {caseId:{verdict:'problem'|'no_problem',quotes?:string[]}}, quotes being exact AI-output text.
// Missing predictions are reported, never scored as negatives.
export function score(gold,predictions){
 for(const [id,p] of Object.entries(predictions))if(!['problem','no_problem'].includes(p?.verdict))throw Error(`${id}: verdict must be problem or no_problem.`);
 const groups=new Map(),add=(key,g,p)=>{if(!groups.has(key))groups.set(key,{tp:0,fp:0,fn:0,tn:0,missing:0,ambiguous:0,ambiguousFlagged:0,refusal:0,refusalFlagged:0,issues:0,issuesHit:0,quotes:0,unlocatedQuotes:0});
  const s=groups.get(key);if(!p){s.missing++;return;}const flagged=p.verdict==='problem',v=g.expected.verdict;
  const located=(p.quotes??[]).map(q=>locateQuoteAll(g.aiOutput??'',q));s.quotes+=located.length;s.unlocatedQuotes+=located.filter(found=>!found.length).length;
  if(v==='ambiguous'){s.ambiguous++;s.ambiguousFlagged+=flagged;return;}
  if(v==='refusal'){s.refusal++;s.refusalFlagged+=flagged;return;}
  if(v==='problem')flagged?s.tp++:s.fn++;else flagged?s.fp++:s.tn++;
  if(v==='problem'){
   const regions=issueRegions(g.spans??[]),hits=located.flat();
   s.issues+=regions.length;s.issuesHit+=regions.filter(r=>hits.some(h=>h.start<r.end&&r.start<h.end)).length;
  }};
 for(const g of gold){const p=predictions[g.caseId];for(const key of ['all',`dataset:${g.dataset}`,`model:${g.dataset}/${g.model}`,`partition:${g.partition}`])add(key,g,p);}
 const unknown=Object.keys(predictions).filter(id=>!gold.some(g=>g.caseId===id));
 const result={unknownPredictions:unknown,groups:{}};
 for(const [key,s] of groups)result.groups[key]={counts:s,precision:rate(s.tp,s.tp+s.fp),recall:rate(s.tp,s.tp+s.fn),
  cleanControlFalsePositiveRate:rate(s.fp,s.fp+s.tn),refusalFlagRate:rate(s.refusalFlagged,s.refusal),ambiguousFlagRate:rate(s.ambiguousFlagged,s.ambiguous),
  labelledIssueRecall:rate(s.issuesHit,s.issues),quotesNotInOutput:s.unlocatedQuotes};
 return result;
}
