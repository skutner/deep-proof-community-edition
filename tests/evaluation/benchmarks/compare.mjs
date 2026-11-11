#!/usr/bin/env node
// Compares two arms of one campaign on the same cases, without calling a model.
// Usage: node tests/evaluation/benchmarks/compare.mjs --predictions <campaign>/predictions --baseline plain --candidate deep-proof-check
//        [--gold .data/build/core/gold] [--partition final] [--bootstrap 10000] [--seed 1] [--output comparison.json] [--allow-incomplete]
// Reads the prediction files and index.json written by run.mjs. Answer keys are needed here and only here.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareArms} from './stats.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const pct=v=>v==null?'n/a':`${(v*100).toFixed(1)}%`;
const points=d=>d.value==null?'n/a':`${d.value>=0?'+':''}${(d.value*100).toFixed(1)} points`+(d.ci95?` (95% interval ${(d.ci95[0]*100).toFixed(1)} to ${(d.ci95[1]*100).toFixed(1)})`:' (no interval: too few cases)');

// Conditions that weaken a comparison. They are reported with the numbers, never silently accepted. Those marked
// exploratory mean the reading must not be presented as a campaign result.
export function warnings(index,baseline,candidate,{partition='final',incomplete=0}={}){
 const notes=[],a=index.arms[baseline],b=index.arms[candidate],add=(text,exploratory=false)=>notes.push({text,exploratory});
 if(index.blind?.status!=='isolated_as_attested')add('Answer keys were readable from the folders used in this campaign.',true);
 if(incomplete)add(`${incomplete} case(s) were left out because a review is missing for one of the arms. Cases that are hard to finish are the ones most likely to be missing.`,true);
 if(partition!=='final')add(`This reading is ${partition?`on the ${partition} partition`:'not restricted to the final partition'}. Development and calibration cases may have been used to tune prompts.`,true);
 if(index.flagCategoriesOverride)add(`Check Report verdicts were recomputed with the category rule ${JSON.stringify(index.flagCategoriesOverride)}, not the rule frozen in the arm. This is a sensitivity analysis.`,true);
 if(a.kind==='constant'||b.kind==='constant')add('One arm is a constant answer: this comparison shows the floor, not a reviewer.',true);
 if(index.setup.repeats<3)add(`Each case was reviewed ${index.setup.repeats} time(s) per arm. The verification standard asks for at least three, to measure run-to-run variation.`);
 if(a.meanStartedAt&&b.meanStartedAt){
  const t=x=>Date.parse(x),span=Math.max(t(a.lastStartedAt),t(b.lastStartedAt))-Math.min(t(a.firstStartedAt),t(b.firstStartedAt)),apart=Math.abs(t(a.meanStartedAt)-t(b.meanStartedAt));
  if(a.lastStartedAt<b.firstStartedAt||b.lastStartedAt<a.firstStartedAt||(span>3600000&&apart>span/4))add(`The two arms did not run over the same period (on average ${(apart/3600000).toFixed(1)} hours apart), so a change in the model service cannot be told apart from a difference between the arms. Run both arms in one invocation.`);
 }
 for(const [name,arm] of [[baseline,a],[candidate,b]]){
  if(arm.rerunsGranted||arm.markedFailed)add(`Operator decisions for "${name}": ${arm.rerunsGranted} unit(s) cleared to run again, ${arm.markedFailed} marked as failed. The reasons are in campaign.json.`);
  if(arm.interruptedUnits)add(`${arm.interruptedUnits} review(s) of "${name}" were cut short and run again. The strict reading counts them as failed.`);
  if(arm.suspectFailures)add(`${arm.suspectFailures} failed review(s) of "${name}" may be infrastructure problems (a non-zero engine exit, or a failure Deep Proof did not attribute to time or validation). They are scored as wrong answers.`);
 }
 return notes;
}

const position=interval=>!interval?'none':interval[0]>0?'above':interval[1]<0?'below':'includes';
const sentence={none:'Too few cases for an interval on balanced accuracy.',above:'The interval for balanced accuracy lies above zero: on these cases the candidate did better.',below:'The interval for balanced accuracy lies below zero: on these cases the baseline did better.',includes:'The interval for balanced accuracy includes zero: these cases do not show a difference.'};

async function main(){
 const args={predictions:null,gold:path.join(here,'.data','build','core','gold'),baseline:null,candidate:null,partition:null,bootstrap:10000,seed:1,output:null,allowIncomplete:false},argv=process.argv.slice(2);
 for(let i=0;i<argv.length;i++){
  const a=argv[i],value=()=>{if(i+1>=argv.length)throw Error(`${a} needs a value.`);return argv[++i];};
  if(a==='--predictions')args.predictions=path.resolve(value());else if(a==='--gold')args.gold=path.resolve(value());else if(a==='--baseline')args.baseline=value();else if(a==='--candidate')args.candidate=value();
  else if(a==='--partition')args.partition=value();else if(a==='--bootstrap')args.bootstrap=Number(value());else if(a==='--seed')args.seed=Number(value());else if(a==='--output')args.output=path.resolve(value());
  else if(a==='--allow-incomplete')args.allowIncomplete=true;else throw Error(`Unknown argument: ${a}`);
 }
 if(!args.predictions||!args.baseline||!args.candidate)throw Error('Pass --predictions <folder>, --baseline <arm> and --candidate <arm>.');
 if(!Number.isInteger(args.bootstrap)||args.bootstrap<1000||!Number.isInteger(args.seed)||args.seed<0)throw Error('--bootstrap needs a whole number of at least 1000, and --seed a whole number.');
 const index=JSON.parse(await fs.readFile(path.join(args.predictions,'index.json'),'utf8'));
 for(const arm of [args.baseline,args.candidate])if(!index.arms[arm])throw Error(`Arm "${arm}" is not in this campaign. Available: ${Object.keys(index.arms).join(', ')}.`);
 const runs=async(arm,strict=false)=>Promise.all((strict&&index.arms[arm].strictRepeats||index.arms[arm].repeats).map(async name=>JSON.parse(await fs.readFile(path.join(args.predictions,name),'utf8'))));
 const wanted=new Set(index.cases),gold=[];
 for(const name of (await fs.readdir(args.gold)).filter(n=>/^case-[0-9a-f]{12}\.json$/.test(n)).sort()){const record=JSON.parse(await fs.readFile(path.join(args.gold,name),'utf8'));if(wanted.has(record.caseId))gold.push(record);}
 if(gold.length!==wanted.size)throw Error(`Answer keys were found for ${gold.length} of the campaign's ${wanted.size} cases in ${args.gold}.`);
 const options={partition:args.partition,bootstrap:args.bootstrap,seed:args.seed,allowIncomplete:args.allowIncomplete};
 const compared=compareArms(gold,await runs(args.baseline),await runs(args.candidate),options);
 const notes=warnings(index,args.baseline,args.candidate,{partition:args.partition,incomplete:compared.incomplete.length});
 // When reviews were cleared by an operator or cut short and then run again, the same comparison is made with each
 // of them counted as failed. A second try can only help its arm, so a result that depends on them is not a campaign result.
 const cleared=[args.baseline,args.candidate].some(arm=>index.arms[arm].strictRepeats);
 const strict=cleared?compareArms(gold,await runs(args.baseline,true),await runs(args.candidate,true),{...options,allowIncomplete:true}):null;
 if(strict&&position(strict.difference.balancedAccuracy.ci95)!==position(compared.difference.balancedAccuracy.ci95))notes.push({text:'The two readings disagree: the result depends on reviews that were run a second time.',exploratory:true});
 const exploratory=notes.some(n=>n.exploratory);
 const result={baselineArm:args.baseline,candidateArm:args.candidate,setup:index.setup,exploratory,...compared,...(strict?{strictReading:{baseline:strict.baseline,candidate:strict.candidate,difference:strict.difference,mcnemar:strict.mcnemar}}:{}),warnings:notes.map(n=>n.text)};
 if(args.output)await fs.writeFile(args.output,JSON.stringify(result,null,1)+'\n');
 const {baseline:a,candidate:b,difference:d,mcnemar:m,setup}=result,ia=index.arms[args.baseline],ib=index.arms[args.candidate],row=(label,x,y,rest='')=>console.log(`${label.padEnd(30)}${String(x).padStart(10)}${String(y).padStart(11)}${rest?'   '+rest:''}`);
 console.log(`Candidate "${args.candidate}" against baseline "${args.baseline}", ${args.partition?`${args.partition} partition`:'all partitions'}.`);
 console.log(`Agent ${setup.agent??'none'}${setup.model?' / '+setup.model:''}${setup.effort?' / '+setup.effort:''}; ${setup.minutes} minutes per review; ${result.repeats} repeat(s).`);
 console.log(`Cases: ${result.cases.problem} with a labelled problem, ${result.cases.clean} clean, from ${result.cases.families} document families. Left out: ${result.excluded.ambiguous} ambiguous, ${result.excluded.refusal} refusal${result.incomplete.length?`, ${result.incomplete.length} incomplete`:''}.\n`);
 row('Measure','baseline','candidate','difference');
 for(const [label,key] of [['Problem cases flagged','sensitivity'],['Clean cases passed','specificity'],['Balanced accuracy','balancedAccuracy']])row(label,pct(a[key]),pct(b[key]),points(d[key]));
 row('Failed reviews',pct(a.failureRate),pct(b.failureRate),`(${a.failed} of ${a.reviews}; ${b.failed} of ${b.reviews})`);
 row('Errors before a review',ia.errorsBeforeStart,ib.errorsBeforeStart,'(not scored)');
 row('Attempts lost to an error',ia.attemptsLost,ib.attemptsLost,'(not scored; includes interrupted runs)');
 row('Cleared to run again',ia.rerunsGranted,ib.rerunsGranted,'(operator decisions)');
 row('Run time, minutes',ia.engineMinutes,ib.engineMinutes);
 console.log(`\nExact McNemar test, cases right in every repeat: only the candidate right on ${m.allCases.b}, only the baseline right on ${m.allCases.c}, p = ${m.allCases.p.toPrecision(3)} (problem cases ${m.problemCases.b} against ${m.problemCases.c}; clean cases ${m.cleanCases.b} against ${m.cleanCases.c}).`);
 console.log((exploratory?'Exploratory reading, not a campaign result. ':'')+sentence[position(d.balancedAccuracy.ci95)]);
 if(strict)console.log(`Strict reading, with every review that was cleared by an operator or cut short and then run again counted as failed: balanced accuracy ${pct(strict.baseline.balancedAccuracy)} against ${pct(strict.candidate.balancedAccuracy)}, ${points(strict.difference.balancedAccuracy)}. ${sentence[position(strict.difference.balancedAccuracy.ci95)]}`);
 for(const note of result.warnings)console.log(`Warning: ${note}`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
