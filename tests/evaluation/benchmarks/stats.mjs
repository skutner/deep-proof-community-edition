// Paired comparison of two review arms on the same benchmark cases. Pure functions: no files, no network, no model.
// Every case was reviewed by both arms, so the analysis works on per-case differences. A failed review counts as
// a wrong answer for its arm, and uncertainty is resampled by document family, because cases that share a source
// document are not independent.
import {checkPrediction} from './lib.mjs';

// Small deterministic generator, so a comparison can be reproduced from its seed.
export function mulberry32(seed){
 let state=seed>>>0;
 return()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};
}

// Exact two-sided McNemar test on discordant pairs: b cases only the candidate got right, c only the baseline.
export function mcnemarExact(b,c){
 const n=b+c,k=Math.min(b,c);if(!n)return {b,c,p:1};
 let sum=0;
 // Up to 1000 pairs the terms are exact powers of two times small integers; beyond that work in logarithms.
 if(n<=1000){let term=Math.pow(0.5,n);for(let i=0;i<=k;i++){sum+=term;term=term*(n-i)/(i+1);}}
 else{let logTerm=-n*Math.LN2;for(let i=0;i<=k;i++){sum+=Math.exp(logTerm);logTerm+=Math.log((n-i)/(i+1));}}
 return {b,c,p:Math.min(1,2*sum)};
}

const outcome=(expected,entry)=>!entry?'missing':entry.failed===true?'failed':(entry.verdict==='problem')===(expected==='problem')?'correct':'wrong';
const share=outcomes=>outcomes.filter(o=>o==='correct').length/outcomes.length;
const mean=values=>values.length?values.reduce((sum,v)=>sum+v,0)/values.length:null;
const round=value=>value==null?null:Math.round(value*10000)/10000;

// Sensitivity: share of problem cases flagged. Specificity: share of clean cases passed. With repeats, a case
// contributes the share of its repeats that were right. Balanced accuracy is the mean of the two.
function measures(cases,arm){
 const sensitivity=mean(cases.filter(c=>c.cls==='problem').map(c=>share(c[arm]))),specificity=mean(cases.filter(c=>c.cls==='clean').map(c=>share(c[arm])));
 return {sensitivity,specificity,balancedAccuracy:sensitivity==null||specificity==null?null:(sensitivity+specificity)/2};
}
function quantile(sorted,q){const at=(sorted.length-1)*q,low=Math.floor(at),high=Math.ceil(at);return sorted[low]+(sorted[high]-sorted[low])*(at-low);}

// gold: answer-key records. baseline, candidate: one predictions object per repeat, in score.mjs format
// ({caseId:{verdict,quotes}} or {caseId:{failed:true}}). Ambiguous and refusal cases are left out, as in score().
export function compareArms(gold,baseline,candidate,{partition=null,bootstrap=10000,seed=1,allowIncomplete=false}={}){
 if(!baseline.length||baseline.length!==candidate.length)throw Error('Both arms need the same number of repeats, and at least one.');
 for(const run of [...baseline,...candidate])for(const [id,entry] of Object.entries(run))checkPrediction(id,entry);
 const cases=[],incomplete=[],excluded={ambiguous:0,refusal:0,otherPartition:0};
 for(const g of gold){
  if(partition&&g.partition!==partition){excluded.otherPartition++;continue;}
  const expected=g.expected.verdict;if(expected!=='problem'&&expected!=='no_problem'){excluded[expected]=(excluded[expected]||0)+1;continue;}
  const a=baseline.map(run=>outcome(expected,run[g.caseId])),b=candidate.map(run=>outcome(expected,run[g.caseId]));
  if(a.includes('missing')||b.includes('missing')){incomplete.push(g.caseId);continue;}
  cases.push({caseId:g.caseId,cls:expected==='problem'?'problem':'clean',family:`${g.dataset}:${g.family??g.caseId}`,baseline:a,candidate:b});
 }
 if(incomplete.length&&!allowIncomplete)throw Error(`${incomplete.length} case(s) lack a final review from one of the arms (${incomplete.slice(0,5).join(', ')}${incomplete.length>5?', …':''}). Finish the campaign, or pass --allow-incomplete for an exploratory reading.`);
 if(!cases.length)throw Error('No case is left to compare.');
 const families=new Map();for(const c of cases){if(!families.has(c.family))families.set(c.family,[]);families.get(c.family).push(c);}
 const point={baseline:measures(cases,'baseline'),candidate:measures(cases,'candidate')},keys=['sensitivity','specificity','balancedAccuracy'];
 const samples=Object.fromEntries(keys.map(k=>[k,[]])),groups=[...families.values()],random=mulberry32(seed);
 for(let i=0;i<bootstrap;i++){
  const drawn=[];for(let j=0;j<groups.length;j++)drawn.push(...groups[Math.floor(random()*groups.length)]);
  const a=measures(drawn,'baseline'),b=measures(drawn,'candidate');
  for(const k of keys)if(a[k]!=null&&b[k]!=null)samples[k].push(b[k]-a[k]);
 }
 const difference={};
 for(const k of keys){
  const value=point.baseline[k]==null||point.candidate[k]==null?null:point.candidate[k]-point.baseline[k],sorted=samples[k].sort((x,y)=>x-y);
  difference[k]={value:round(value),ci95:value==null||sorted.length<100?null:[round(quantile(sorted,0.025)),round(quantile(sorted,0.975))],resamples:sorted.length};
 }
 // Strict reading for the exact test: a case is right for an arm only when every repeat was right.
 const strict=(c,arm)=>c[arm].every(o=>o==='correct');
 const discordant=list=>mcnemarExact(list.filter(c=>strict(c,'candidate')&&!strict(c,'baseline')).length,list.filter(c=>strict(c,'baseline')&&!strict(c,'candidate')).length);
 const arm=name=>{
  const all=cases.flatMap(c=>c[name]),count=o=>all.filter(x=>x===o).length;
  return {...Object.fromEntries(keys.map(k=>[k,round(point[name][k])])),reviews:all.length,correct:count('correct'),wrong:count('wrong'),failed:count('failed'),failureRate:round(count('failed')/all.length),
   ...(baseline.length>1?{casesWithSameOutcomeEveryRepeat:round(cases.filter(c=>new Set(c[name]).size===1).length/cases.length)}:{})};
 };
 return {partition,repeats:baseline.length,cases:{problem:cases.filter(c=>c.cls==='problem').length,clean:cases.filter(c=>c.cls==='clean').length,families:groups.length},excluded,incomplete,
  baseline:arm('baseline'),candidate:arm('candidate'),difference,
  mcnemar:{problemCases:discordant(cases.filter(c=>c.cls==='problem')),cleanCases:discordant(cases.filter(c=>c.cls==='clean')),allCases:discordant(cases)},
  method:{difference:'candidate minus baseline; a failed review counts as a wrong answer',interval:`95% percentile interval from ${bootstrap} resamples of document families, seed ${seed}`,mcnemar:'exact two-sided test; a case counts as right only when every repeat was right'}};
}
