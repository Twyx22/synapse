import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionUsage, contextUsage, summarizeCosts } from '../src/core/cost.ts';
import { DiagnosticLogger, DiagnosticReports, exportLogMetadata } from '../src/core/diagnostics.ts';
import { OpenCodeAdapter, type SessionApi } from '../src/opencode/adapter.ts';
import { Synapse } from '../src/core/orchestrator.ts';
import { FileStore } from '../src/core/store.ts';
import { registerTools, type ToolDef } from '../src/opencode/tools.ts';
import type { AgentContext } from '../src/core/types.ts';
const tokens={input:100,output:25,reasoning:10,cache:{read:50,write:3}};
const context:AgentContext={runId:'run-fixture',objective:'test',task:{id:'a',title:'A',instruction:'test',role:'engineer',dependsOn:[],priority:0,review:false,maxAttempts:1,status:'running',attempts:1},dependencies:[],messages:[],signal:new AbortController().signal};
const entry=(event:string,fields:object)=>JSON.stringify({at:'2026-01-01T00:00:00Z',level:'info',event,fields});
const sample=(sessionId:string,role:string,reportedCostUsd?:number,extra:object={})=>entry('agent.usage.snapshot',{runId:'r',sessionId,role,usageSource:'session_get',settled:true,inputTokens:100,reportedCostUsd,...extra});

test('session usage distinguishes zero, absent and malformed fields, rejects mismatched session',()=>{
  assert.deepEqual(sessionUsage({id:'s',tokens,cost:0},'s'),{inputTokens:100,outputTokens:25,reasoningTokens:10,cacheReadTokens:50,cacheWriteTokens:3,reportedCostUsd:0,usageSource:'session_get'});
  assert.deepEqual(sessionUsage({id:'s',tokens:{input:-1,output:1.2,reasoning:'5',cache:{read:Infinity}},cost:NaN},'s'),{usageSource:'unavailable'});
  assert.deepEqual(sessionUsage({id:'other',tokens,cost:1},'s'),{usageSource:'unavailable'});
});
test('context sums only recognized steps, deduplicates IDs, marks partial and suppresses missing metrics',()=>{
  const a={type:'assistant',id:'a',tokens,cost:0.2,content:'private'};
  const b={info:{role:'assistant',id:'b',tokens}};
  const u=contextUsage([a,a,b,{type:'user',id:'u',tokens,cost:3},{type:'assistant',cost:999}]);
  assert.equal(u.inputTokens,200);assert.equal(u.observedSteps,2);assert.equal(u.reportedCostUsd,undefined);assert.equal(u.usageSource,'context_partial');
  assert.equal(contextUsage([{type:'idle',cost:0}]).usageSource,'unavailable');
});
test('aggregates deduplicate sessions, preserve zero and missing, separate roles and filter runs',()=>{
  const raw=[sample('w','worker',0.1),sample('w','worker',0.2),sample('r','review',0.3),sample('c','council',0),sample('other','worker',8,{runId:'another'})].join('\n');
  const out=summarizeCosts(raw,'r',0.4);
  assert.equal(out.total.sessions,3);assert.equal(out.total.metrics.reportedCostUsd.observed,0.5);assert.equal(out.byRole.council.metrics.reportedCostUsd.observed,0);assert.equal(out.reviewShareOfReportedCost,0.6);assert.equal(out.budget?.status,'observed_over_limit');
  const missing=summarizeCosts(raw+'\n'+entry('agent.session.created',{runId:'r',sessionId:'legacy'}),'r',2);
  assert.equal(missing.total.missingSnapshots,1);assert.equal(missing.total.metrics.reportedCostUsd.completeForRetainedSessions,false);assert.equal(missing.reviewShareOfReportedCost,null);assert.equal(missing.budget?.status,'insufficient_coverage');
  assert.equal(summarizeCosts('','r',0).total.metrics.reportedCostUsd.observed,null);
  assert.throws(()=>summarizeCosts('',undefined,-1));
});
test('partial context and unsettled snapshots cannot certify coverage or budget',()=>{
  for(const extra of [{usageSource:'context_partial'},{settled:false}]){
    const c=summarizeCosts(sample('r','review',0,extra),'r',1);
    assert.equal(c.total.metrics.reportedCostUsd.observed,0);assert.equal(c.budget?.status,'insufficient_coverage');assert.equal(c.reviewShareOfReportedCost,null);
  }
});
async function setup(t:{after:(fn:()=>Promise<void>)=>void}){
  const dir=await mkdtemp(join(tmpdir(),'synapse-cost-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const logger=new DiagnosticLogger(join(dir,'diagnostics'));return {dir,logger};
}
test('explicit submissions collect host aggregate once per worker and reviewer without context reads or new prompts',async t=>{
  const {logger}=await setup(t);let i=0,reads=0,prompts=0;let adapter:OpenCodeAdapter;
  const api:SessionApi={create:async()=>({id:`s${++i}`}),get:async({sessionID})=>{reads++;return {id:sessionID,tokens,cost:sessionID==='s1'?0:0.3,secret:'DO_NOT_EXPORT'}},switchAgent:async()=>{},update:async()=>{},prompt:async({sessionID})=>{prompts++;if(sessionID==='s1')adapter.submit(sessionID,'answer');else adapter.submitReview(sessionID,true,'evidence');},wait:async()=>{},context:async()=>{throw new Error('must not read context')},interrupt:async()=>{}};
  adapter=new OpenCodeAdapter(api,logger);const result=await adapter.execute(context);assert.equal(result.text,'answer');assert.equal((await adapter.review({...context,result:result.text})).approved,true);assert.equal(reads,2);assert.equal(prompts,2);
  const raw=await logger.recent();const usage=summarizeCosts(raw);assert.equal(usage.total.sessions,2);assert.equal(usage.total.metrics.reportedCostUsd.observed,0.3);assert.equal(usage.byRole.worker.metrics.reportedCostUsd.observed,0);assert.equal(usage.reviewShareOfReportedCost,1);assert.doesNotMatch(raw,/DO_NOT_EXPORT/);
});
test('usage read failure never invalidates an accepted deliverable',async t=>{
  const {logger}=await setup(t);let adapter:OpenCodeAdapter;
  const api:SessionApi={create:async()=>({id:'s'}),get:async()=>{throw new Error('API unavailable')},switchAgent:async()=>{},update:async()=>{},prompt:async()=>{adapter.submit('s','ok')},wait:async()=>{},context:async()=>{throw new Error('not exposed')},interrupt:async()=>{}};
  adapter=new OpenCodeAdapter(api,logger);assert.equal((await adapter.execute(context)).text,'ok');assert.equal(summarizeCosts(await logger.recent()).total.missingSnapshots,1);
});
test('usage timeout is bounded and cannot cancel a completed session',async t=>{
  const {logger}=await setup(t);let adapter:OpenCodeAdapter;let interrupts=0;
  const api:SessionApi={create:async()=>({id:'s'}),get:async()=>new Promise(()=>{}),switchAgent:async()=>{},update:async()=>{},prompt:async()=>{adapter.submit('s','ok')},wait:async()=>{},context:async()=>[],interrupt:async()=>{interrupts++}};
  adapter=new OpenCodeAdapter(api,logger,500);assert.equal((await adapter.execute(context)).text,'ok');assert.equal(interrupts,0);assert.equal(summarizeCosts(await logger.recent()).total.missingSnapshots,1);
});
test('interrupted wait records missing usage rather than zero, never calls usage endpoint',async t=>{
  const {logger}=await setup(t);let reads=0;
  const api:SessionApi={create:async()=>({id:'s'}),get:async()=>{reads++;return {}},switchAgent:async()=>{},update:async()=>{},prompt:async()=>{},wait:async()=>new Promise(()=>{}),context:async()=>[],interrupt:async()=>{}};
  const adapter=new OpenCodeAdapter(api,logger,20);await assert.rejects(adapter.execute(context),/deadline/);assert.equal(reads,0);assert.equal(summarizeCosts(await logger.recent()).total.missingSnapshots,1);
});
test('cost metadata survives export, arbitrary fields do not; inspection is coordinator-only',async t=>{
  const {dir,logger}=await setup(t);const engine=new Synapse(new FileStore(dir,logger),{execute:async()=>({text:'ok'})});const run=await engine.plan('fixture',[{id:'a',title:'a',instruction:'a'}]);
  await logger.log('info','agent.usage.snapshot',{runId:run.id,sessionId:'s',role:'review',usageSource:'session_get',settled:true,inputTokens:123,reportedCostUsd:0.125,unknownPrivate:'PRIVATE_RAW'});
  const exported=exportLogMetadata(await logger.recent());assert.doesNotMatch(exported,/PRIVATE_RAW/);assert.equal(summarizeCosts(exported).total.metrics.inputTokens.observed,123);
  const reports=new DiagnosticReports(dir,logger);const report=await reports.build({runId:run.id});assert.ok(report.files.includes('costs.json'));assert.doesNotMatch((await readFile(report.filePath)).toString(),/PRIVATE_RAW/);
  const defs=new Map<string,ToolDef>();await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>{defs.set(d.name,d);}})},engine,undefined,reports,id=>id==='worker');
  const ctx={sessionID:'coordinator',signal:new AbortController().signal};const result=JSON.parse((await defs.get('costs')!.execute({runId:run.id,budgetUsd:0.1},ctx)).content);assert.equal(result.budget.status,'observed_over_limit');await assert.rejects(defs.get('costs')!.execute({}, {...ctx,sessionID:'worker'}),/coordinator-only/);
});
