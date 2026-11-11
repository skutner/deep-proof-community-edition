#!/usr/bin/env node
// Scores review verdicts against the benchmark answer keys without calling a model.
// Usage: node tests/evaluation/benchmarks/score.mjs --predictions predictions.json [--gold .data/build/core/gold] [--output result.json]
// predictions.json: {"case-…":{"verdict":"problem"|"no_problem","quotes":["exact AI-output text the review flagged"]}}
// A review that ran without producing a usable verdict is {"case-…":{"failed":true,"reason":"timeout"}}.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {score} from './lib.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const pct=r=>r.value==null?'n/a':`${(r.value*100).toFixed(1)}% (${r.k}/${r.n}; 95% CI ${(r.ci95[0]*100).toFixed(1)}–${(r.ci95[1]*100).toFixed(1)}%)`;

async function main(){
 const args={gold:path.join(here,'.data','build','core','gold'),predictions:null,output:null},argv=process.argv.slice(2);
 for(let i=0;i<argv.length;i++){const a=argv[i];if(a==='--gold')args.gold=path.resolve(argv[++i]);else if(a==='--predictions')args.predictions=path.resolve(argv[++i]);else if(a==='--output')args.output=path.resolve(argv[++i]);else throw Error(`Unknown argument: ${a}`);}
 if(!args.predictions)throw Error('Pass --predictions <file>.');
 const gold=[];for(const name of (await fs.readdir(args.gold)).filter(n=>/^case-[0-9a-f]{12}\.json$/.test(n)).sort())gold.push(JSON.parse(await fs.readFile(path.join(args.gold,name),'utf8')));
 if(!gold.length)throw Error(`No answer keys found in ${args.gold}. Run build.mjs first.`);
 const result=score(gold,JSON.parse(await fs.readFile(args.predictions,'utf8')));
 if(args.output)await fs.writeFile(args.output,JSON.stringify(result,null,1)+'\n');
 for(const [key,g] of Object.entries(result.groups)){
  const c=g.counts;
  console.log(`\n${key}: TP ${c.tp} FP ${c.fp} FN ${c.fn} TN ${c.tn}; missing ${c.missing}; failed ${c.failed}; ambiguous ${c.ambiguous}; refusals ${c.refusal}`);
  if(c.failed)console.log(`  failed reviews ${pct(g.failureRate)}\n  recall counting failures as misses ${pct(g.recallCountingFailures)}\n  clean controls passed, counting failures as not passed ${pct(g.cleanControlPassRateCountingFailures)}`);
  console.log(`  precision ${pct(g.precision)}\n  recall ${pct(g.recall)}\n  false positives on clean controls ${pct(g.cleanControlFalsePositiveRate)}\n  refusals flagged ${pct(g.refusalFlagRate)}\n  labelled issues hit by a quote ${pct(g.labelledIssueRecall)}; quotes not found in the AI output: ${g.quotesNotInOutput}`);
 }
 if(result.unknownPredictions.length)console.log(`\nPredictions for unknown cases: ${result.unknownPredictions.join(', ')}`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
