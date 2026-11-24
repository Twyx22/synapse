import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FileStore} from '../src/core/store.ts';
import {Synapse} from '../src/core/orchestrator.ts';
import {CostLedger} from '../src/core/ledger.ts';
import {economicAdvice,economicPair} from '../src/core/economics.ts';
import {registerTools,type ToolDef} from '../src/opencode/tools.ts';
import {runCLI} from '../src/cli.ts';
async function fixture(t:{after:(f:()=>Promise<void>)=>void}){
 const dir=await mkdtemp(join(tmpdir(),'synapse-economics-'));t.after(()=>rm(dir,{recursive:true,force:true}));const engine=new Synapse(new FileStore(dir),{execute:async()=>{throw Error('must not call model');}});const run=await engine.plan('fixture',[{id:'a',title:'a',instruction:'test',review:true,contract:{requireSubmit:true}}],4);return {dir,engine,run,ledger:new CostLedger(dir)};
}
test('economic advice reconciles input steps and identifies structural waste without modifying reviews',async t=>{
 const {run,ledger,engine}=await fixture(t);const id={runId:run.id,sessionId:'s',role:'review' as const};await ledger.start(id);await ledger.finish(id,true,{usageSource:'session_get',inputTokens:100,cacheReadTokens:900,reportedCostUsd:0},100,{visibleSteps:2,truncated:false,steps:[{inputTokens:99},{inputTokens:1}]});
 const advice=economicAdvice(run,await ledger.summary('',run.id));assert.equal(advice.firstVisibleStepInputShare,.99);assert.equal(advice.observedCacheReadTokens,900);assert.equal(advice.observedInputTokens,100);assert.equal(advice.reviewInputShare,1);assert.ok(advice.findings.includes('concurrency_above_dag_width'));assert.equal(advice.billingVerified,false);assert.equal((await engine.get(run.id)).tasks[0].review,true);
});
test('economic advice refuses unmatched profile or unfinished sessions',async t=>{
 const {run,ledger}=await fixture(t);const id={runId:run.id,sessionId:'s',role:'worker' as const};await ledger.start(id);await ledger.finish(id,true,{usageSource:'session_get',inputTokens:100},20,{visibleSteps:1,truncated:false,steps:[{inputTokens:99}]});assert.equal(economicAdvice(run,await ledger.summary('')).firstVisibleStepInputShare,null);await ledger.start({...id,sessionId:'unfinished'});const out=economicAdvice(run,await ledger.summary(''));assert.equal(out.completeInputForObservedSessions,false);assert.equal(out.reviewInputShare,null);
});
test('economic pairs keep token and cache categories separate, refuse quality failure, and never infer savings from zero dollars',async t=>{
 const {ledger}=await fixture(t);for(const [runId,input,cache] of [['a',100,5],['b',40,100]] as const){const id={runId,sessionId:'s',role:'worker' as const};await ledger.start(id);await ledger.finish(id,true,{usageSource:'session_get',inputTokens:input,cacheReadTokens:cache,reportedCostUsd:0},20);}
 const a=await ledger.summary('','a'),b=await ledger.summary('','b'),out=economicPair(a,b,true);assert.equal(out.input.relativeReduction,.6);assert.equal(out.cacheRead.relativeReduction,-19);assert.equal(out.reportedUsd.relativeReduction,null);assert.equal(out.output.comparable,false);assert.equal(economicPair(a,b,false).input.comparable,false);assert.equal(out.billingVerified,false);await ledger.start({runId:'b',sessionId:'unfinished',role:'worker'});assert.equal(economicPair(a,await ledger.summary('','b'),true).input.comparable,false);
});
test('economic CLI and coordinator-only tool are read-only and require a real run',async t=>{
 const {engine,run,dir}=await fixture(t);const defs=new Map<string,ToolDef>();await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>defs.set(d.name,d)})},engine,undefined,undefined,id=>id==='worker');const ctx={sessionID:'coordinator',signal:new AbortController().signal};const tool=defs.get('economic_advice')!;const result=JSON.parse((await tool.execute({runId:run.id},ctx)).content);assert.equal(result.completeInputForObservedSessions,false);assert.equal(result.graph.requiredReviews,1);await assert.rejects(tool.execute({runId:run.id},{...ctx,sessionID:'worker'}));assert.equal(await runCLI(['economics','--data-dir',dir,'--run',run.id]),0);assert.equal((await engine.get(run.id)).status,'planned');
});
test('mismatched per-session profiles cannot cancel each other out to falsely reconcile',async t=>{
 const {run,ledger}=await fixture(t);
 for(const [sessionId,input] of [['s1',90],['s2',110]] as const){const id={runId:run.id,sessionId,role:'worker' as const};await ledger.start(id);await ledger.finish(id,true,{usageSource:'session_get',inputTokens:100},20,{visibleSteps:1,truncated:false,steps:[{inputTokens:input}]});}
 const out=economicAdvice(run,await ledger.summary('',run.id));assert.equal(out.observedInputTokens,200);assert.equal(out.profileReconciled,false);assert.equal(out.firstVisibleStepInputShare,null);
});
