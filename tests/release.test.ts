import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/core/store.ts';
import { Synapse } from '../src/core/orchestrator.ts';
import { ProviderSessionError } from '../src/core/provider.ts';
import { DiagnosticLogger, DiagnosticReports } from '../src/core/diagnostics.ts';
import { OpenCodeAdapter, type SessionApi } from '../src/opencode/adapter.ts';
import { CostLedger } from '../src/core/ledger.ts';
import type { TaskSpec } from '../src/core/types.ts';
const task=(id:string,extra:Partial<TaskSpec>={}):TaskSpec=>({id,title:id,instruction:'Test',review:false,maxAttempts:1,...extra});
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function fixture(t: {after:(fn:()=>Promise<void>)=>void}) {
 const dir=await mkdtemp(join(tmpdir(),'synapse-rc-'));const log=new DiagnosticLogger(join(dir,'diagnostics'));
 t.after(async()=>{await log.flush();await rm(dir,{recursive:true,force:true,maxRetries:3});});return {dir,log,store:new FileStore(dir,log)};
}
function zipJSON(buf:Buffer,name:string){let offset=0;while(offset+30<=buf.length&&buf.readUInt32LE(offset)===0x04034b50){const n=buf.readUInt16LE(offset+26),e=buf.readUInt16LE(offset+28),size=buf.readUInt32LE(offset+18),start=offset+30+n+e;const label=buf.subarray(offset+30,offset+30+n).toString();if(label===name)return JSON.parse(buf.subarray(start,start+size).toString());offset=start+size;}throw Error('Missing '+name);}
test('atomic creation publishes one full file under competing creates; no overwrite or temp residue',async t=>{
 const {store,dir}=await fixture(t);const engine=new Synapse(store,{execute:async()=>({text:'ok'})});const source=await engine.plan('original',[task('a')]);const other={...source,id:'run_00000000-0000-4000-8000-000000000001'};
 const outcomes=await Promise.allSettled(Array.from({length:24},(_,i)=>store.create({...other,objective:`candidate-${i}`})));assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);const result=await store.read(other.id);assert.match(result.objective,/^candidate-/);assert.equal((await readdir(dir)).filter(n=>n.endsWith('.tmp')).length,0);assert.equal((await store.list()).length,2);
});
test('64 concurrent updates in one store preserve all events and failed mutation leaves snapshot intact',async t=>{
 const {store}=await fixture(t);const engine=new Synapse(store,{execute:async()=>({text:'ok'})});const run=await engine.plan('test',[task('a')]);
 await Promise.all(Array.from({length:64},(_,i)=>engine.send(run.id,'coordinator','all','note',`message-${i}`)));const before=await store.read(run.id);assert.equal(before.messages.length,64);assert.equal(new Set(before.messages.map(m=>m.id)).size,64);
 await assert.rejects(store.update(run.id,r=>{r.messages=[];throw Error('injected failure')}));assert.deepEqual(await store.read(run.id),before);
});
test('32-task DAG respects 8 slots, dependencies, and one execution admission under simultaneous starts',async t=>{
 const {store}=await fixture(t);let active=0,peak=0,calls=0;const completed=new Set<string>();
 const engine=new Synapse(store,{execute:async ctx=>{for(const d of ctx.dependencies)assert.ok(completed.has(d.id));active++;calls++;peak=Math.max(peak,active);await delay(5);active--;completed.add(ctx.task.id);return{text:'ok'};}});
 const specs=Array.from({length:32},(_,i)=>task(`t${i}`,{dependsOn:i<8?[]:[`t${i-8}`]}));const plan=await engine.plan('stress',specs,8,32);const runs=await Promise.allSettled([engine.run(plan.id),engine.run(plan.id),engine.run(plan.id)]);assert.equal(runs.filter(r=>r.status==='fulfilled').length,1);assert.equal((await store.read(plan.id)).status,'completed');assert.equal(calls,32);assert.ok(peak>1&&peak<=8);assert.equal(engine.resourceStatus().reserved,0);
});
test('failure source is persisted and exported only when known; old records are not backfilled; coordinator snapshot is numeric only',async t=>{
 const {dir,store,log}=await fixture(t);const engine=new Synapse(store,{execute:async ctx=>{if(ctx.task.id==='a')throw new ProviderSessionError('provider_quota','retry_hook');return{text:'ok'}}});const r=await engine.plan('PRIVATE_PLAN',[task('a'),task('b')],1);await engine.run(r.id);
 assert.equal((await store.read(r.id)).tasks[0].failureSource,'retry_hook');const historical=await engine.plan('old',[task('old')]);await store.update(historical.id,s=>{s.status='failed';s.tasks[0].status='failed';s.tasks[0].error='ProviderSessionError: provider_quota';});
 const report=await new DiagnosticReports(dir,log).build({coordinatorUsage:{observedAt:'2026-01-01T00:00:00.000Z',sessionId:'PRIVATE_SESSION',usage:{usageSource:'session_get',inputTokens:100,outputTokens:-1,secret:'PRIVATE_SECRET'}}});const raw=await readFile(report.filePath);const rows=zipJSON(raw,'runs.json');assert.equal(rows.find((x:any)=>x.id===r.id).tasks[0].failureSource,'retry_hook');assert.equal(rows.find((x:any)=>x.id===r.id).tasks[1].failureSource,undefined);assert.equal(rows.find((x:any)=>x.id===historical.id).tasks[0].failureSource,undefined);const advice=zipJSON(raw,'economics.json');assert.equal(advice.advice.find((x:any)=>x.runId===r.id).performanceEligible,false);assert.deepEqual(zipJSON(raw,'coordinator.json').usage,{usageSource:'session_get',inputTokens:100});assert.doesNotMatch(raw.toString(),/PRIVATE_PLAN|PRIVATE_SESSION|PRIVATE_SECRET/);
});
test('quota during setup closes ledger with unknown usage, skips prompt and prevents next session',async t=>{
 const {dir,log,store}=await fixture(t);const ledger=new CostLedger(dir);let created=0,interrupted=0;
 const api:SessionApi={create:async()=>({id:`s${++created}`}),switchAgent:async()=>{},update:async()=>{throw {name:'AI.Error.QuotaExceeded'};},prompt:async()=>assert.fail('unexpected prompt'),wait:async()=>{},context:async()=>[],interrupt:async()=>{interrupted++;}};
 const engine=new Synapse(store,new OpenCodeAdapter(api,log,undefined,ledger));const run=await engine.plan('setup quota',[task('a',{maxAttempts:3}),task('b')],1);const result=await engine.run(run.id);assert.equal(created,1);assert.equal(interrupted,1);assert.equal(result.tasks[0].failureSource,'host_error');assert.equal(result.tasks[1].failureSource,'circuit');assert.equal(result.tasks[0].attempts,1);const cost=await ledger.summary('',run.id);assert.equal(cost.ledger.finished,1);assert.equal(cost.ledger.unfinished,0);assert.equal(cost.total.metrics.inputTokens.observed,null);assert.equal(engine.resourceStatus().reserved,0);
});
test('quota during create prevents subsequent sessions even before a session ID exists',async t=>{
 const {store,log}=await fixture(t);let created=0;const api:SessionApi={create:async()=>{created++;throw {status:429}},switchAgent:async()=>{},update:async()=>{},prompt:async()=>assert.fail(),wait:async()=>{},context:async()=>[],interrupt:async()=>{}};
 const engine=new Synapse(store,new OpenCodeAdapter(api,log));const p=await engine.plan('limit',[task('a',{maxAttempts:3}),task('b')],1);const result=await engine.run(p.id);assert.equal(created,1);assert.equal(result.tasks[0].failureSource,'host_error');assert.equal(result.tasks[1].failureSource,'circuit');assert.equal(result.tasks[0].attempts,1);
});
test('orphaned running task resumes within attempt limit and does not expose stale previous result',async t=>{
 const {store}=await fixture(t);const engine=new Synapse(store,{execute:async ctx=>{assert.equal(ctx.task.result,undefined);assert.equal(ctx.task.error,undefined);assert.equal(ctx.task.workerSession,undefined);assert.equal(ctx.task.attempts,2);return{text:'new result'}}});const p=await engine.plan('recovery',[task('a',{maxAttempts:2})]);await store.update(p.id,r=>{r.status='running';Object.assign(r.tasks[0],{status:'running',attempts:1,result:'old',error:'old',workerSession:'old'});});const result=await engine.run(p.id);assert.equal(result.status,'completed');assert.equal(result.tasks[0].result,'new result');assert.equal(result.tasks[0].attempts,2);
});
test('stop is bounded when remote interrupt never settles; cancellation remains durable',async t=>{
 const {store}=await fixture(t);let started!:()=>void;const entered=new Promise<void>(r=>started=r);const engine=new Synapse(store,{execute:async ctx=>{ctx.onSession?.('s');started();await new Promise<void>(r=>ctx.signal.addEventListener('abort',()=>r(),{once:true}));return{text:'late'};},cancel:async()=>new Promise<void>(()=>{})});const p=await engine.plan('stop',[task('a')]);const execution=engine.run(p.id);await entered;const now=Date.now();const stopped=await engine.stop(p.id);assert.equal(stopped.status,'cancelled');assert.ok(Date.now()-now<3500);assert.equal((await execution).status,'cancelled');assert.equal(engine.resourceStatus().reserved,0);
});
test('hung session creation times out without retry and a late-created session is interrupted without a prompt',async t=>{
 const {store,log}=await fixture(t);let release!: (value:{id:string})=>void,created=0,interrupted=0;const api:SessionApi={create:async()=>{created++;return new Promise(r=>{release=r;})},switchAgent:async()=>assert.fail('late setup'),update:async()=>assert.fail('late policy'),prompt:async()=>assert.fail('late prompt'),wait:async()=>{},context:async()=>[],interrupt:async()=>{interrupted++;}};
 const engine=new Synapse(store,new OpenCodeAdapter(api,log,40));const p=await engine.plan('hung create',[task('a',{maxAttempts:3})]);const result=await engine.run(p.id);assert.equal(result.status,'failed');assert.equal(created,1);assert.match(result.tasks[0].error!,/deadline exceeded during setup/);assert.equal(engine.resourceStatus().reserved,0);release({id:'late'});await delay(5);assert.equal(interrupted,1);
});
test('hung policy setup times out, closes known ledger and does not send prompt',async t=>{
 const {store,log,dir}=await fixture(t);let interrupted=0;const ledger=new CostLedger(dir);const api:SessionApi={create:async()=>({id:'s'}),switchAgent:async()=>{},update:async()=>new Promise(()=>{}),prompt:async()=>assert.fail('unexpected prompt'),wait:async()=>{},context:async()=>[],interrupt:async()=>{interrupted++;}};const engine=new Synapse(store,new OpenCodeAdapter(api,log,80,ledger));const p=await engine.plan('policy hang',[task('a',{maxAttempts:3})]);const result=await engine.run(p.id);assert.equal(result.status,'failed');assert.match(result.tasks[0].error!,/deadline exceeded during setup/);assert.equal(result.tasks[0].attempts,1);assert.equal(interrupted,1);assert.equal(engine.resourceStatus().reserved,0);const cost=await ledger.summary('',p.id);assert.equal(cost.ledger.finished,1);assert.equal(cost.total.metrics.inputTokens.observed,null);
});
