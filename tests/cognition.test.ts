import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {join} from 'node:path';
import {newRun} from '../src/core/validate.ts';
import {selectTeamContext} from '../src/core/context.ts';
import {retrospective} from '../src/core/retrospective.ts';
import {searchMemory} from '../src/core/memory.ts';
import {FileStore} from '../src/core/store.ts';
import {Synapse} from '../src/core/orchestrator.ts';
import {DiagnosticLogger,DiagnosticReports,exportLogMetadata} from '../src/core/diagnostics.ts';
import {registerTools,type ToolDef} from '../src/opencode/tools.ts';
import {OpenCodeAdapter,type SessionApi} from '../src/opencode/adapter.ts';
import type {AgentContext,TeamMessage} from '../src/core/types.ts';
const context = ():AgentContext => {
  const run=newRun('objective',[{id:'a',title:'A',instruction:'mandatory instruction',contract:{requireSubmit:true}}],1);
  return {runId:run.id,objective:run.objective,task:run.tasks[0],dependencies:[{id:'dep',result:'FULL DEPENDENCY'}],messages:[],signal:new AbortController().signal};
};
const msg=(id:string,from:string,to:string,body:string):TeamMessage=>({id,from,to,body,at:new Date().toISOString(),runId:'test',type:'evidence'});
async function fixture(t: {after:(fn:()=>Promise<void>)=>void}) {
  const dir=await mkdtemp(join(tmpdir(),'synapse-cognition-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const log=new DiagnosticLogger(join(dir,'diagnostics'));const store=new FileStore(dir,log);
  return {dir,log,store};
}
test('context selector keeps direct messages, deduplicates broadcasts, excludes own messages and bounds optional payload',()=>{
  const ctx=context();ctx.messages=[msg('1','b','all','repeat'),msg('2','b','all','repeat'),msg('3','b','a','important '.repeat(500)),msg('4','b','all','large '.repeat(3000)),msg('5','a','all','own text')];
  const original=structuredClone(ctx.messages);const result=selectTeamContext(ctx,100);
  assert.match(result.text,/important/);assert.equal((result.text.match(/repeat/g)??[]).length,1);
  assert.ok(!result.text.includes('own text'));assert.ok(!result.text.includes('large '));
  assert.equal(result.omittedMessages,3);assert.equal(result.dependencyChars,15);assert.deepEqual(ctx.messages,original);
});
test('adapter emits context metadata and preserves dependency, instructions and explicit contract',async t=>{
  const {log}=await fixture(t);let prompt='';const ctx=context();ctx.messages=[msg('1','b','all','large '.repeat(2000)),msg('2','b','a','direct evidence')];
  const api:SessionApi={create:async()=>({id:'s'}),switchAgent:async()=>{},update:async()=>{},prompt:async({text})=>{prompt=text;},wait:async()=>{},context:async()=>[{role:'assistant',text:'done'}],interrupt:async()=>{}};
  await new OpenCodeAdapter(api,log).execute(ctx);
  assert.match(prompt,/FULL DEPENDENCY/);assert.match(prompt,/mandatory instruction/);assert.match(prompt,/requireSubmit/);assert.match(prompt,/direct evidence/);assert.match(prompt,/1 optional/);
  assert.ok(!prompt.includes('large '.repeat(5)));const raw=await log.recent();assert.match(raw,/agent.context.prepared/);assert.ok(!raw.includes('direct evidence'));
});
test('reviewed results of a failed graph are searchable; blocked or rejected tasks stay blocked or failed',async t=>{
  const {store}=await fixture(t);const engine=new Synapse(store,{execute:async c=>({text:c.task.id==='good'?'unique validated finding':'unique invalid finding'}),review:async c=>({approved:c.task.id==='good',reason:'independent review'})});
  const run=await engine.plan('unique study',[{id:'good',title:'good',instruction:'x',maxAttempts:1},{id:'bad',title:'bad',instruction:'x',maxAttempts:1},{id:'blocked',title:'blocked',instruction:'x',dependsOn:['bad']}]);
  const finished=await engine.run(run.id);assert.equal(finished.status,'failed');const result=retrospective(finished);assert.deepEqual(result.reusableTaskIds,['good']);assert.deepEqual(result.tasks.find(t=>t.taskId==='blocked')?.blockedBy,['bad']);
  const memory=await searchMemory(store,'unique');assert.deepEqual(memory.hits.map(h=>h.taskId),['good']);assert.equal(memory.hits[0].runStatus,'failed');assert.equal((await engine.get(run.id)).tasks.find(t=>t.id==='blocked')?.status,'blocked');
});
test('retrospective is coordinator-only and performs no work',async t=>{
  const {store}=await fixture(t);let calls=0;const engine=new Synapse(store,{execute:async()=>{calls++;return {text:'x'};}});const run=await engine.plan('test',[{id:'a',title:'a',instruction:'x'}]);const defs=new Map<string,ToolDef>();
  await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>{defs.set(d.name,d);}})},engine,undefined,undefined,id=>id==='restricted');
  const tool=defs.get('retrospective')!;const args={runId:run.id};const signal=new AbortController().signal;
  await assert.rejects(tool.execute(args,{sessionID:'restricted',signal}),/coordinator-only/);const result=JSON.parse((await tool.execute(args,{sessionID:'coordinator',signal})).content);assert.equal(result.status,'planned');assert.equal(calls,0);
});
test('diagnostic ZIP drops private reviewer prose, historical error payload and unrelated run logs',async t=>{
  const {dir,log,store}=await fixture(t);const engine=new Synapse(store,{execute:async()=>({text:'private deliverable'}),review:async()=>({approved:false,reason:'PRIVATE_REVIEWER_PROSE nonsecret project text'})});
  const run=await engine.plan('private objective',[{id:'a',title:'a',instruction:'x',maxAttempts:1}]);await engine.run(run.id);await log.log('warn','task.review_rejected',{runId:run.id,error:'Review rejected: PRIVATE_HISTORICAL_REVIEW',notes:'PRIVATE_UNKNOWN_FIELD'});
  const other=await engine.plan('other',[{id:'b',title:'b',instruction:'x'}]);await log.flush();
  const report=await new DiagnosticReports(dir,log).build({runId:run.id});const bytes=(await readFile(report.filePath)).toString('utf8');
  for(const secret of ['PRIVATE_REVIEWER_PROSE','PRIVATE_HISTORICAL_REVIEW','PRIVATE_UNKNOWN_FIELD',other.id])assert.ok(!bytes.includes(secret),secret);
  assert.match(bytes,/review_rejected/);assert.match((await engine.get(run.id)).tasks[0].error!,/PRIVATE_REVIEWER_PROSE/);
});
test('historical metadata export drops malformed rows and unknown nested fields',()=>{
 const at=new Date().toISOString();const row=JSON.stringify({at,event:'agent.wait.completed',level:'info',fields:{durationMs:42,unexpected:{comment:'PRIVATE'},error:{message:'Worker returned no result PRIVATE'}}});
 const parsed=JSON.parse(exportLogMetadata(row+'\n{broken\n').trim());assert.deepEqual(parsed.fields,{durationMs:42,errorCategory:'empty_result'});
});
