#!/usr/bin/env node
// Strict first accepted-call rates. Reads and errors earn no kit credit; no probe replies or judge are used.
import { privateInput, skipWithoutPrivateInputs } from '../../coordinator/scripts/private-inputs.mjs';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
const {values:a,positionals:files}=parseArgs({allowPositionals:true,options:{cases:{type:'string',default:undefined},out:{type:'string'}}});
if(!files.length) throw new Error('Usage: node scripts/decision-eval/score-portal-kit.mjs [--cases corpus.json] [--out report.json] run.json ...');
if (!a.cases) skipWithoutPrivateInputs('decision-eval score-portal-kit');
const cases=new Map(JSON.parse(fs.readFileSync(a.cases ?? privateInput('coordinator/test/fixtures/decision-eval/extra/portal-kit-continuity.json'))).cases.map(c=>[c.id,c]));
const reports=[];
for(const file of files){
 const run=JSON.parse(fs.readFileSync(file));
 if(run.config.provider!=='codex'||run.config.model!=='gpt-6.1-sol'||run.config.effort!=='low'||run.config.probe)throw new Error('Lane scoring requires Codex gpt-6.1-sol low without probe replies');
 if(!Number.isSafeInteger(run.config.sampleOffset)||run.config.sampleOffset<0)throw new Error('A nonnegative sample offset is required');
 if(Object.keys(run.config.sampleCounts).length!==cases.size||Object.entries(run.config.sampleCounts).some(([id,n])=>!cases.has(id)||!Number.isSafeInteger(n)||n<3))throw new Error('Every corpus point needs at least three planned samples');
 const seen=new Set(), rows=[], groups={};
 for(const r of run.results){
  const c=cases.get(r.caseId);if(!c)throw new Error(`Unknown case ${r.caseId}`);
  if(!Number.isSafeInteger(r.sample)||r.sample<run.config.sampleOffset||r.sample>=run.config.sampleOffset+run.config.sampleCounts[r.caseId])throw new Error('Sample outside the declared plan');
  const key=`${r.caseId}#${r.sample}`;if(seen.has(key))throw new Error(`Duplicate sample ${key}`);seen.add(key);
  const call=r.calls.find(x=>!x.normalizeError), args=call?.args??{}, target=args.target??{};
  const item=(target.item??'').replace(/^minecraft:/,'');
  const items=c.state.observation.inventory?.items??[];
  const count=re=>items.filter(i=>re.test(i.itemId)).reduce((n,i)=>n+i.count,0);
  const buckets=count(/^minecraft:(bucket|water_bucket|lava_bucket)$/), empty=count(/^minecraft:bucket$/);
  let kind=c.id.endsWith('-ask')?'ask':c.id.endsWith('-danger')||c.id.endsWith('-hunger')?'survival':'continue';
  if(kind==='continue'&&buckets>=2&&count(/^minecraft:flint_and_steel$/)>0)kind='already-ready';
  const obtain=call?.name==='do_step'&&args.verb==='obtain';
  let good=obtain&&((buckets<2&&item==='bucket'&&(target.count??1)>=empty+2-buckets)||(kind==='continue'&&item==='flint_and_steel'));
  if(kind==='survival'){
   // Candidate survival calls still need a human geometry/threat review; this is the action-category rate.
   good=call?.name==='do_step'&&(['rest','travel_to','fight_until'].includes(args.verb)||(obtain&&/cooked_|bread|apple|stew|potato|carrot|berries/.test(item)));
  }
  if(r.error)good=false;
  const row={caseId:c.id,sample:r.sample,kind,good,error:r.error??null,call:call?{name:call.name,args}:null};rows.push(row);
  const cohort=c.id.startsWith('gate5')?'gate5':'nov9';
  const labels=[`${cohort}/${kind}`];
  if(kind==='continue'&&c.id.endsWith('-after0'))labels.push(`${cohort}/first-after`);
  if(kind==='ask'&&c.source.recordedCall.arguments.target.count===2)labels.push(`${cohort}/two-bucket-controls`);
  for(const label of labels){const g=groups[label]??={good:0,total:0,errors:0,cases:{}};g.good+=Number(good);g.total++;g.errors+=Number(Boolean(r.error));const p=g.cases[c.id]??={good:0,total:0};p.good+=Number(good);p.total++;}
 }
 const missing=[];
 for(const [id,n] of Object.entries(run.config.sampleCounts))for(let s=run.config.sampleOffset;s<run.config.sampleOffset+n;s++)if(!seen.has(`${id}#${s}`))missing.push(`${id}#${s}`);
 for(const g of Object.values(groups)){g.majorityCases=Object.values(g.cases).filter(c=>c.good>c.total/2).length;g.caseCount=Object.keys(g.cases).length;}
 const report={file,build:run.build,profile:{provider:run.config.provider,model:run.config.model,effort:run.config.effort},caseSha256:run.config.casesSha256,missing,groups,rows};reports.push(report);
 console.log(file);for(const [name,g]of Object.entries(groups))console.log(`${name}: ${g.good}/${g.total}; majority ${g.majorityCases}/${g.caseCount} cases; ${g.errors} errors`);
 if(missing.length)throw new Error(`${missing.length} declared samples missing`);
}
if(a.out)fs.writeFileSync(a.out,JSON.stringify(reports,null,2)+'\n');
