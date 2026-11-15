import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const scorer=fileURLToPath(new URL('../../scripts/decision-eval/score-portal-kit.mjs',import.meta.url));

test('kit lane scoring refuses duplicate, missing and under-repeated evidence or a different model profile',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'kit-score-'));
 try{
  const cases=path.join(dir,'cases.json'),runFile=path.join(dir,'run.json');
  writeFileSync(cases,JSON.stringify({cases:[{id:'gate5-test-ask',state:{observation:{inventory:{items:[]}}},source:{recordedCall:{arguments:{target:{count:1}}}}}]}));
  const row=sample=>({caseId:'gate5-test-ask',sample,error:null,calls:[{name:'do_step',args:{verb:'obtain',target:{item:'bucket',count:2}}}]});
  const config={provider:'codex',model:'gpt-6.1-sol',effort:'low',sampleCounts:{'gate5-test-ask':3},sampleOffset:0};
  const invoke=run=>{writeFileSync(runFile,JSON.stringify(run));return ()=>execFileSync(process.execPath,[scorer,'--cases',cases,runFile],{stdio:'pipe'});};
  assert.match(invoke({config,results:[row(0),row(1),row(2)]})().toString(),/3\/3/);
  // A sample that ended in a replay error earns no credit, even when it holds the right call.
  const failed=sample=>({...row(sample),error:{code:'PROVIDER_TIMEOUT'}});
  assert.match(invoke({config,results:[failed(0),failed(1),row(2)]})().toString(),/1\/3; majority 0\/1 cases; 2 errors/);
  for(const run of [
   {config,results:[row(0),row(0),row(2)]},
   {config,results:[row(0),row(1)]},
   {config,results:[row(0),row(1),row(2),row(3)]},
   {config:{...config,sampleCounts:{'gate5-test-ask':2}},results:[row(0),row(1)]},
   {config:{...config,sampleOffset:undefined},results:[row(0),row(1),row(2)]},
   {config:{...config,model:'another-model'},results:[row(0),row(1),row(2)]},
  ])assert.throws(invoke(run));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
