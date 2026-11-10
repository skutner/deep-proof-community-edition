import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {faithbenchCategory,faithbenchCases,ragtruthCases,financebenchCases,selectCases,renderDossier,authoredLeaks,goldRecord,partitionOf,locateQuote,locateQuoteAll,issueRegions,wilson,score,gitBlobSha,PROFILES,TARGET_MODELS} from './evaluation/benchmarks/lib.mjs';

// Hand-authored records shaped like the upstream schemas. They contain no upstream text and no model output.
const read=name=>JSON.parse(readFileSync(new URL(`./evaluation/benchmarks/${name}`,import.meta.url),'utf8'));
const fbSample=(id,source,model,annotations=[])=>({sample_id:id,source,summary:' The cat sat on the red mat.',annotations,metadata:{summarizer:model,raw_sample_id:id}});
const span=(label,start=20,end=23)=>({label:[label],note:'colour not in source',summary_span:' The cat sat on the red mat.'.slice(start,end),summary_start:start,summary_end:end});
const fbBatches=[{batch:1,samples:['Passage A','Passage B'].flatMap((source,i)=>[...TARGET_MODELS.faithbench,'other/model'].map((model,j)=>fbSample(i*10+j,source,model,j===0?[span('Unwanted.Extrinsic'),span('Unwanted'),span('Benign',24,27)]:j===1?[span('Questionable')]:[])))}];
const rtSources=[{source_id:'s1',task_type:'Summary',source:'CNN/DM',source_info:'A storm closed the bridge on Monday.',prompt:'Summarize the following news within 50 words:\nA storm closed the bridge on Monday.'},{source_id:'s2',task_type:'Summary',source:'Recent News',source_info:'The library reopened.',prompt:'Summarize the following news within 50 words:\nThe library reopened.'},{source_id:'q1',task_type:'QA',source:'MARCO',source_info:{question:'?'},prompt:'?'}];
const rtResponses=[
 {id:'1',source_id:'s1',model:'gpt-4-0613',quality:'good',split:'test',temperature:'0.7',response:'A storm closed the bridge on Tuesday.',labels:[{start:29,end:36,text:'Tuesday',label_type:'Evident Conflict',meta:'Monday in source',implicit_true:false,due_to_null:false}]},
 {id:'2',source_id:'s1',model:'gpt-3.5-turbo-0613',quality:'good',split:'test',temperature:'0.7',response:'A storm closed the bridge.',labels:[]},
 {id:'3',source_id:'s2',model:'gpt-4-0613',quality:'good',split:'train',temperature:'0.7',response:'The library reopened.',labels:[]},
 {id:'4',source_id:'s2',model:'gpt-3.5-turbo-0613',quality:'good',split:'train',temperature:'0.7',response:'The library reopened.',labels:[]},
 {id:'5',source_id:'s2',model:'mistral-7B-instruct',quality:'good',split:'train',temperature:'0.7',response:'x',labels:[]}];
const fnQuestions=[{financebench_id:'id_1',company:'Acme',doc_name:'ACME_2022_10K',question:'What was revenue?',answer:'$10',justification:'Income statement.',question_type:'metrics-generated',question_reasoning:'Information extraction',evidence:[{doc_name:'ACME_2022_10K',evidence_page_num:4,evidence_text:'Revenue 10'}]},{financebench_id:'id_2',company:'Big',doc_name:'BIG_2022_10K',question:'Q?',answer:'A',justification:'J',evidence:[]}];
const fnResults=label=>Object.fromEntries(TARGET_MODELS.financebench.map((m,i)=>[m,new Map(fnQuestions.map(q=>[q.financebench_id,{financebench_id:q.financebench_id,model_name:m,eval_mode:'inContext',temp:0.01,model_answer:'Revenue was $12.',label:i?label:'Refusal'}]))]));
const pdfs={ACME_2022_10K:{path:'pdfs/ACME_2022_10K.pdf',size:1000,gitBlobSha:'x'},BIG_2022_10K:{path:'pdfs/BIG_2022_10K.pdf',size:25*1024*1024,gitBlobSha:'y'}};
const source={repo:'example/repo',commit:'0123456789abcdef0123456789abcdef01234567',license:'Example'};

test('FaithBench labels map to verdicts without the upstream binarize defect, and unknown labels fail',()=>{
 assert.equal(faithbenchCategory([]),'no_annotation');
 assert.equal(faithbenchCategory([{label:['Questionable']},{label:['Unwanted.Intrinsic']}]),'unwanted');
 assert.equal(faithbenchCategory([{label:['Benign']},{label:['Questionable']}]),'questionable');
 assert.equal(faithbenchCategory([{label:['Benign']}]),'benign');
 assert.throws(()=>faithbenchCategory([{label:['Unwanted.Instrinsic']}]),/Unknown FaithBench label/);
 const cases=faithbenchCases(fbBatches);
 assert.equal(cases.length,6);assert.ok(cases.every(c=>TARGET_MODELS.faithbench.includes(c.model)));
 const flagged=cases.find(c=>c.category==='unwanted');
 assert.equal(flagged.verdict,'problem');assert.equal(flagged.aiOutput,' The cat sat on the red mat.');
 assert.deepEqual(flagged.spans.map(s=>({start:s.start,end:s.end,text:s.text,annotations:s.annotations,labels:s.labels.sort(),target:s.target})),[{start:20,end:23,text:'red',annotations:2,labels:['Unwanted','Unwanted.Extrinsic'],target:true},{start:24,end:27,text:'mat',annotations:1,labels:['Benign'],target:false}]);
 assert.deepEqual(issueRegions(flagged.spans),[{start:20,end:23}]);
 assert.deepEqual(cases.map(c=>c.verdict).sort(),['ambiguous','ambiguous','no_problem','no_problem','problem','problem']);
 const shifted=structuredClone(fbBatches);shifted[0].samples[0].annotations[0].summary_start=19;
 assert.throws(()=>faithbenchCases(shifted),/does not match/);
});

test('RAGTruth keeps only GPT summaries, exact spans and the summarization instruction',()=>{
 const cases=ragtruthCases(rtSources,rtResponses);
 assert.equal(cases.length,4);
 const bad=cases.find(c=>c.record==='response_1');
 assert.equal(bad.verdict,'problem');assert.equal(bad.instruction,'Summarize the following news within 50 words');
 assert.deepEqual(bad.spans.map(s=>[s.start,s.end,s.text,s.labels[0]]),[[29,36,'Tuesday','Evident Conflict']]);
 assert.throws(()=>ragtruthCases(rtSources,[{...rtResponses[0],labels:[{...rtResponses[0].labels[0],start:28}]}]),/does not match/);
 for(const quality of ['odd','truncated','constructor'])assert.throws(()=>ragtruthCases(rtSources,[{...rtResponses[1],quality}]),/unsupported quality/);
 assert.ok(ragtruthCases(rtSources,rtResponses).flatMap(c=>c.spans).every(s=>s.target===true));
 assert.equal(ragtruthCases(rtSources,[{...rtResponses[1],quality:'incorrect_refusal'}])[0].verdict,'refusal');
});

test('FinanceBench grades map to separate verdicts, oversized filings are skipped and pages become 1-based',()=>{
 const cases=financebenchCases(fnQuestions,[{doc_name:'ACME_2022_10K',doc_type:'10k',doc_period:2022}],fnResults('Incorrect Answer'),pdfs);
 assert.deepEqual(cases.map(c=>[c.model,c.verdict]),[['gpt-4-1106-preview','refusal'],['claude-2','problem']]);
 assert.deepEqual(cases[0].reference.evidence,[{document:'ACME_2022_10K',pageIndex:4,pdfPage:5,text:'Revenue 10'}]);
 assert.equal(financebenchCases(fnQuestions,[],fnResults('Correct Answer'),pdfs)[1].verdict,'no_problem');
 assert.throws(()=>financebenchCases(fnQuestions,[],fnResults('Partly Correct'),pdfs),/unknown label/);
});

test('selection takes whole families and every family stays in one partition',()=>{
 const all=[...faithbenchCases(fbBatches),...ragtruthCases(rtSources,rtResponses),...financebenchCases(fnQuestions,[],fnResults('Incorrect Answer'),pdfs)];
 const picked=selectCases(all,'core');
 assert.equal(picked.length,all.length);
 assert.equal(new Set(picked.map(c=>c.caseId)).size,picked.length);
 for(const c of picked)assert.equal(c.partition,partitionOf(c.dataset,c.family));
 assert.ok(['development','calibration','final'].includes(partitionOf('ragtruth','s1')));
 for(const name of ['huge','constructor'])assert.throws(()=>selectCases(all,name),/Unknown profile/);
 const limited=selectCases(all,{faithbench:{families:1},ragtruth:{positiveFamilies:1,cleanFamilies:0},financebench:{families:0,questionsPerFamily:0}});
 assert.equal(limited.filter(c=>c.dataset==='faithbench').length,3);assert.equal(new Set(limited.filter(c=>c.dataset==='faithbench').map(c=>c.family)).size,1);
 assert.deepEqual(limited.filter(c=>c.dataset==='ragtruth').map(c=>c.family),['s1','s1']);
 assert.equal(limited.filter(c=>c.dataset==='financebench').length,0);
});

test('dossiers are blind and reproduce the AI output exactly; answer keys keep provenance',()=>{
 const [c]=selectCases(ragtruthCases(rtSources,rtResponses),'core').filter(c=>c.record==='response_1');
 const files=renderDossier(c,source);
 assert.deepEqual(Object.keys(files).sort(),['ai-summary.txt','review-request.md','source.txt']);
 assert.equal(files['ai-summary.txt'],c.aiOutput);assert.equal(files['source.txt'],'A storm closed the bridge on Monday.');
 assert.deepEqual(authoredLeaks(files['review-request.md']),[]);
 assert.ok(!files['review-request.md'].includes('response_1')&&!files['review-request.md'].includes(c.model));
 assert.deepEqual(authoredLeaks('Summary by Claude, label: Evident Conflict'),['claude','conflict']);
 const [finance]=selectCases(financebenchCases(fnQuestions,[],fnResults('Incorrect Answer'),pdfs),'core').filter(c=>c.model==='claude-2');
 const financeFiles=renderDossier(finance,source);
 assert.deepEqual(Object.keys(financeFiles).sort(),['ai-answer.txt','review-request.md']);
 assert.deepEqual(authoredLeaks(financeFiles['review-request.md']),[]);assert.ok(financeFiles['ai-answer.txt'].includes('Revenue was $12.'));
 const gold=goldRecord(c,source);
 assert.equal(gold.expected.verdict,'problem');assert.equal(gold.model,'gpt-4-0613');assert.equal(gold.commit,source.commit);assert.equal(gold.upstream.record,'1');
});

test('scoring separates ambiguous, refusal and missing cases and locates quotes with normalized whitespace',()=>{
 assert.deepEqual(locateQuote(' The cat  sat\non the red mat.','cat sat on the'),{start:5,end:20});
 assert.equal(locateQuote('abc','zzz'),null);
 assert.deepEqual(locateQuoteAll('a b\na  b','a b'),[{start:0,end:3},{start:4,end:8}]);
 assert.deepEqual(wilson(5,10),[0.2366,0.7634]);assert.equal(wilson(0,0),null);
 const g=(caseId,verdict,spans=[])=>({caseId,dataset:'d',model:'m',partition:'final',expected:{verdict},aiOutput:'The bridge closed on Tuesday after the storm.',spans});
 const gold=[g('a','problem',[{start:20,end:27},{start:22,end:30},{start:0,end:3,target:false}]),g('b','problem',[{start:0,end:3}]),g('c','no_problem'),g('d','no_problem'),g('e','ambiguous'),g('f','refusal'),g('h','problem')];
 const result=score(gold,{a:{verdict:'problem',quotes:['on  Tuesday','invented quote']},b:{verdict:'no_problem'},c:{verdict:'problem',quotes:['not in the output']},d:{verdict:'no_problem'},e:{verdict:'problem'},f:{verdict:'problem'},z:{verdict:'problem'}});
 const all=result.groups.all;
 assert.deepEqual([all.counts.tp,all.counts.fn,all.counts.fp,all.counts.tn,all.counts.missing,all.counts.ambiguous,all.counts.refusal],[1,1,1,1,1,1,1]);
 assert.equal(all.precision.value,0.5);assert.equal(all.recall.value,0.5);assert.equal(all.refusalFlagRate.value,1);
 assert.deepEqual([all.labelledIssueRecall.k,all.labelledIssueRecall.n,all.quotesNotInOutput],[1,2,2]);
 assert.deepEqual(result.unknownPredictions,['z']);
 assert.throws(()=>score(gold,{a:{verdict:'maybe'}}),/verdict/);
});

test('committed sources and core selection are pinned, unique and family-consistent',()=>{
 const sources=read('sources.json'),selection=read('selection.json');
 for(const d of Object.values(sources.datasets)){assert.match(d.commit,/^[0-9a-f]{40}$/);for(const f of d.files){assert.match(f.sha256,/^[0-9a-f]{64}$/);assert.ok(f.size>0);}}
 for(const p of Object.values(sources.datasets.financebench.pdfs)){assert.match(p.gitBlobSha,/^[0-9a-f]{40}$/);assert.ok(p.size>0&&p.path.startsWith('pdfs/'));}
 assert.equal(gitBlobSha(Buffer.from('hello\n')),'ce013625030ba8dba906f756967f9e9ca394464a');
 const cases=selection.cases;assert.equal(selection.profile,'core');
 assert.equal(new Set(cases.map(c=>c.caseId)).size,cases.length);
 const partitions=new Map();for(const c of cases){const key=`${c.dataset}:${c.family}`;assert.equal(partitions.get(key)??c.partition,c.partition);partitions.set(key,c.partition);assert.deepEqual(Object.keys(c).sort(),['caseId','dataset','family','partition']);}
 const families=d=>new Set(cases.filter(c=>c.dataset===d).map(c=>c.family)).size;
 assert.equal(families('faithbench'),PROFILES.core.faithbench.families);
 assert.equal(families('ragtruth'),PROFILES.core.ragtruth.positiveFamilies+PROFILES.core.ragtruth.cleanFamilies);
 assert.equal(families('financebench'),PROFILES.core.financebench.families);
 assert.deepEqual(Object.fromEntries(['faithbench','ragtruth','financebench'].map(d=>[d,cases.filter(c=>c.dataset===d).length])),{faithbench:48,ragtruth:40,financebench:32});
});
