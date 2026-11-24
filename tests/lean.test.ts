import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileStore} from '../src/core/store.ts';
import {Synapse} from '../src/core/orchestrator.ts';
import {leanAdvice,exactCheck} from '../src/core/lean.ts';
import {newRun} from '../src/core/validate.ts';
import {ExperimentStore} from '../src/core/experiments.ts';
import {DiagnosticLogger,DiagnosticReports} from '../src/core/diagnostics.ts';
import {registerTools,type ToolDef} from '../src/opencode/tools.ts';
import type {AgentAdapter,TaskSpec} from '../src/core/types.ts';
const task:TaskSpec={id:'a',title:'Fixture',instruction:'Return only the result',review:false,maxAttempts:1,contract:{requireSubmit:true},verification:{kind:'exact',expected:'703'}};
async function withEngine(adapter:AgentAdapter, fn:(engine:Synapse,dir:string)=>Promise<void>) {
 const dir=await mkdtemp(join(tmpdir(),'synapse-lean-'));
 try{await fn(new Synapse(new FileStore(dir),adapter),dir);}finally{await rm(dir,{recursive:true,force:true});}
}
test('exact fixture validates only whole trimmed answer',()=>{
 assert.equal(exactCheck(task.verification!,' 703\n'),true);
 assert.equal(exactCheck(task.verification!,'703 because ...'),false);
 assert.equal(exactCheck(task.verification!,'704'),false);
});
test('exact verification requires explicit submit, rejects malformed and patch checks',()=>{
 assert.throws(()=>newRun('fixture',[{...task,contract:undefined}],1),/submission/);
 assert.throws(()=>newRun('fixture',[{...task,verification:{kind:'exact',expected:' '}}],1),/Invalid exact/);
 assert.throws(()=>newRun('fixture',[{...task,patch:{baseCommit:'a'.repeat(40),paths:['a.ts']}}],1),/patches/);
});
test('exact fixture completes with one worker and no reviewer, expected withheld from adapter',async()=>{
 let workers=0,reviews=0;
 await withEngine({execute:async c=>{workers++;assert.equal(c.task.verification,undefined);return {text:'703',channel:'submit'};},review:async()=>{reviews++;return {approved:true,reason:'ok'};}},async e=>{
  const plan=await e.plan('fixture',[task],1,1);const run=await e.run(plan.id);
  assert.equal(run.status,'completed');assert.equal(workers,1);assert.equal(reviews,0);
  assert.deepEqual(run.tasks[0].verificationEvidence,{attempt:1,passed:true});assert.equal(leanAdvice(run).tasks[0].exactOutcome,'passed');
  assert.equal(run.events.some(v=>v.type==='task.verified'),false);
 });
});
test('exact mismatch blocks dependent and keeps expected value out of error',async()=>{
 await withEngine({execute:async()=>({text:'702',channel:'submit'})},async e=>{
  const p=await e.plan('fixture',[task,{id:'b',title:'dependent',instruction:'do',review:false,maxAttempts:1,dependsOn:['a']}],1,2);
  const r=await e.run(p.id);assert.equal(r.status,'failed');assert.equal(r.tasks[0].status,'failed');assert.equal(r.tasks[1].status,'blocked');assert.equal(r.tasks[0].error,'Exact fixture mismatch');assert.equal(r.tasks[0].verificationEvidence?.passed,false);
 });
});
test('exact match does not replace mandatory review',async()=>{
 let reviews=0;
 await withEngine({execute:async()=>({text:'703',channel:'submit'}),review:async()=>{reviews++;return {approved:false,reason:'missing requirement'};}},async e=>{
  const p=await e.plan('fixture',[{...task,review:true}],1,3);const r=await e.run(p.id);assert.equal(reviews,1);assert.equal(r.status,'failed');assert.equal(r.tasks[0].verificationEvidence?.passed,true);
 });
});
test('contract failure cannot be rescued by correct fixture text',async()=>{
 await withEngine({execute:async()=>({text:'703',channel:'context'})},async e=>{
  const r=await e.run((await e.plan('fixture',[task],1,1)).id);assert.equal(r.status,'failed');assert.equal(r.tasks[0].verificationEvidence,undefined);
 });
});
test('session envelope includes retries and two potential review sessions; reject insufficient before launch',async()=>{
 let calls=0;
 await withEngine({execute:async()=>{calls++;return {text:'703',channel:'submit'};}},async e=>{
  await assert.rejects(e.plan('fixture',[{...task,review:true,maxAttempts:2}],1,5),/budget/);
  const p=await e.plan('fixture',[{...task,review:true,maxAttempts:2}],1,6);assert.equal(leanAdvice(p).maxGraphSessions,6);
  await e.store.update(p.id,r=>{r.options.sessionBudget=1;});await assert.rejects(e.run(p.id),/budget/);assert.equal(calls,0);
 });
});
test('retry records only latest exact result',async()=>{
 let calls=0;
 await withEngine({execute:async()=>({text:++calls===1?'702':'703',channel:'submit'})},async e=>{
  const r=await e.run((await e.plan('fixture',[{...task,maxAttempts:2}],1,2)).id);assert.equal(r.status,'completed');assert.deepEqual(r.tasks[0].verificationEvidence,{attempt:2,passed:true});
 });
});
test('experiment rejects different fixture checks or session budget',async()=>{
 await withEngine({execute:async()=>({text:'703',channel:'submit'})},async e=>{
  const a=await e.plan('fixture',[task],1,1),b=await e.plan('fixture',[{...task,verification:{kind:'exact',expected:'704'}}],2,1),c=await e.plan('fixture',[task],2,2);
  for(const candidate of [b,c])await assert.rejects(new ExperimentStore(e.store).register([{baselineRunId:a.id,candidateRunId:candidate.id}],[{taskId:'a',text:'703'}],'model'),/identical/);
 });
});
test('tool exposes envelope without fixture answer and rejects restricted sessions',async()=>{
 await withEngine({execute:async()=>({text:'703',channel:'submit'})},async e=>{
  const defs=new Map<string,ToolDef>();await registerTools({transform:async fn=>fn({namespace(){},add(t){defs.set(t.name,t);}})},e,undefined,undefined,id=>id==='restricted');
  const ctx={sessionID:'coordinator',signal:new AbortController().signal};
  const p=JSON.parse((await defs.get('plan')!.execute({objective:'fixture',tasks:[task],sessionBudget:1,concurrency:1},ctx)).content);
  assert.equal(p.executionEnvelope.maxGraphSessions,1);assert.ok(!JSON.stringify(p).includes('703'));
  await assert.rejects(defs.get('lean_advice')!.execute({runId:p.runId},{...ctx,sessionID:'restricted'}),/coordinator-only/);
  assert.equal(JSON.parse((await defs.get('lean_advice')!.execute({runId:p.runId},ctx)).content).tasks[0].exactOnly,true);
 });
});
test('diagnostics export exact outcome and budget without expected text',async()=>{
 await withEngine({execute:async()=>({text:'WRONG',channel:'submit'})},async(e,dir)=>{
  const p=await e.plan('fixture',[{...task,verification:{kind:'exact',expected:'PRIVATE_FIXTURE_987XYZ'}}],1,1);await e.run(p.id);
  const report=await new DiagnosticReports(dir,new DiagnosticLogger(join(dir,'diagnostics'))).build({runId:p.id});
  const data=await readFile(report.filePath); // ZIP writer uses stored entries
  assert.ok(data.includes(Buffer.from('"exactVerification"')));assert.ok(data.includes(Buffer.from('"exact_mismatch"')));assert.ok(!data.includes(Buffer.from('PRIVATE_FIXTURE_987XYZ')));
 });
});
