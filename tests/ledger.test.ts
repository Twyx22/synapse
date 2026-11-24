import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CostLedger} from '../src/core/ledger.ts';
import {visibleStepProfile} from '../src/core/cost.ts';
import {DiagnosticLogger,DiagnosticReports} from '../src/core/diagnostics.ts';
import {OpenCodeAdapter,type SessionApi} from '../src/opencode/adapter.ts';
import type {AgentContext} from '../src/core/types.ts';
const id={runId:'run-test',sessionId:'session-1',role:'worker' as const};
const tokens={input:100,output:20,reasoning:4,cache:{read:30,write:2}};
const usage={usageSource:'session_get' as const,inputTokens:100,reportedCostUsd:0.25};
const ctx:AgentContext={runId:id.runId,objective:'test',task:{id:'a',title:'A',instruction:'test',role:'analysis',dependsOn:[],priority:0,review:true,maxAttempts:1,status:'running',attempts:1},dependencies:[],messages:[],signal:new AbortController().signal};
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){const dir=await mkdtemp(join(tmpdir(),'synapse-ledger-'));const logger=new DiagnosticLogger(join(dir,'diagnostics'));t.after(async()=>{await logger.flush();await rm(dir,{recursive:true,force:true,maxRetries:3});});return {dir,ledger:new CostLedger(dir),logger};}
const log=(s:string,extra:object={})=>JSON.stringify({event:'agent.usage.snapshot',fields:{runId:id.runId,sessionId:s,role:'worker',settled:true,...usage,...extra}});
test('ledger persists after all log files disappear, deduplicates legacy logs and counts unfinished sessions',async t=>{
 const {dir,ledger,logger}=await fixture(t);await ledger.start(id);await ledger.finish(id,true,usage,100);await ledger.start({...id,sessionId:'unfinished'});await logger.log('info','agent.usage.snapshot',{...id,settled:true,...usage});await logger.flush();await rm(logger.directory,{recursive:true,force:true});
 const fresh=new CostLedger(dir);const out=await fresh.summary(log(id.sessionId));assert.equal(out.total.sessions,2);assert.equal(out.total.metrics.inputTokens.observed,100);assert.equal(out.ledger.unfinished,1);assert.equal(out.total.missingSnapshots,1);assert.equal((await fresh.summary('')).total.metrics.reportedCostUsd.observed,0.25);
});
test('ledger filters runs and combines pre-ledger usage without double counting',async t=>{
 const {ledger}=await fixture(t);await ledger.start(id);await ledger.finish(id,true,usage,100);await ledger.start({...id,runId:'other'});await ledger.finish({...id,runId:'other'},true,usage,100);const out=await ledger.summary([log(id.sessionId),log('old')].join('\n'),id.runId);assert.equal(out.total.sessions,2);assert.equal(out.total.metrics.inputTokens.observed,200);assert.equal(out.ledger.finished,1);
});
test('immutable record publication is idempotent, rejects conflicting finish and unsafe IDs',async t=>{
 const {ledger}=await fixture(t);await Promise.all([ledger.start(id),ledger.start(id)]);await ledger.finish(id,true,usage,100);await ledger.finish(id,true,usage,100);await assert.rejects(ledger.finish(id,true,{...usage,inputTokens:200},100),/Conflicting/);await assert.rejects(ledger.start({...id,sessionId:'../../escape'}),/Invalid/);assert.equal((await ledger.summary('')).total.metrics.inputTokens.observed,100);
});
test('corrupt ledger record or symlink is reported and cannot certify budget',async t=>{
 const {ledger,dir}=await fixture(t);await ledger.start(id);await ledger.finish(id,true,usage,100);await writeFile(join(ledger.directory,'a'.repeat(64)+'-finish.json'),'invalid');await symlink(join(dir,'missing'),join(ledger.directory,'b'.repeat(64)+'-start.json'));const result=await ledger.summary('',undefined,1);assert.equal(result.ledger.invalidRecords,2);assert.equal(result.budget?.status,'insufficient_coverage');
});
test('visible step profile excludes user data and duplicate IDs, preserves missing and zero metrics',()=>{
 const messages=[{id:'a',type:'assistant',tokens,cost:0,content:'PRIVATE'},{id:'a',type:'assistant',tokens},{info:{id:'b',role:'assistant',tokens:{input:0,output:2}}},{id:'c',type:'user',tokens,cost:99}];const profile=visibleStepProfile(messages);assert.equal(profile.visibleSteps,2);assert.equal(profile.steps[0].reportedCostUsd,0);assert.equal(profile.steps[1].inputTokens,0);assert.equal(profile.steps[1].reportedCostUsd,undefined);assert.doesNotMatch(JSON.stringify(profile),/PRIVATE/);const large=visibleStepProfile(Array.from({length:300},(_,i)=>({id:`s${i}`,type:'assistant',tokens})));assert.equal(large.visibleSteps,300);assert.equal(large.steps.length,256);assert.equal(large.truncated,true);
});
test('real adapter wiring preserves aggregate, captures step metadata, and does not make extra prompts',async t=>{
 const {ledger,logger}=await fixture(t);let adapter:OpenCodeAdapter;let prompts=0,contexts=0,ids=0;const api:SessionApi={create:async()=>({id:`s${++ids}`}),get:async({sessionID})=>({id:sessionID,tokens,cost:0}),switchAgent:async()=>{},update:async()=>{},prompt:async({sessionID,text})=>{prompts++;assert.match(text,/synapse_submit/);if(sessionID==='s1')adapter.submit(sessionID,'result');else adapter.submitReview(sessionID,true,'proof');},wait:async()=>{},context:async()=>{contexts++;return [{id:'message-1',type:'assistant',tokens,cost:0,content:'PRIVATE_RAW'}]},interrupt:async()=>{}};adapter=new OpenCodeAdapter(api,logger,undefined,ledger);assert.equal((await adapter.execute(ctx)).text,'result');assert.equal((await adapter.review({...ctx,result:'result'})).approved,true);const result=await ledger.summary('');assert.equal(result.ledger.finished,2);assert.equal(result.profiling.visibleSteps,2);assert.equal(result.reviewShareOfInputTokens,0.5);assert.equal(prompts,2);assert.equal(contexts,2);for(const name of await readdir(ledger.directory))assert.doesNotMatch(await readFile(join(ledger.directory,name),'utf8'),/PRIVATE_RAW/);assert.equal(result.total.metrics.reportedCostUsd.observed,0);
});
test('profile failure preserves settled aggregate and accepted deliverable',async t=>{
 const {ledger,logger}=await fixture(t);let adapter:OpenCodeAdapter;const api:SessionApi={create:async()=>({id:'s'}),get:async()=>({id:'s',tokens,cost:0}),switchAgent:async()=>{},update:async()=>{},prompt:async()=>{adapter.submit('s','ok')},wait:async()=>{},context:async()=>{throw new Error('PRIVATE')},interrupt:async()=>{}};adapter=new OpenCodeAdapter(api,logger,undefined,ledger);assert.equal((await adapter.execute(ctx)).text,'ok');const result=await ledger.summary('');assert.equal(result.total.metrics.inputTokens.observed,100);assert.equal(result.profiling.sessionsWithVisibleProfile,0);assert.equal(result.profiling.sessions[0].steps,null);
});
test('setup failure remains visible in persistent ledger, not a free session',async t=>{
 const {ledger,logger}=await fixture(t);const api:SessionApi={create:async()=>({id:'s'}),switchAgent:async()=>{throw new Error('unavailable')},update:async()=>{},prompt:async()=>{},wait:async()=>{},context:async()=>[],interrupt:async()=>{}};await assert.rejects(new OpenCodeAdapter(api,logger,undefined,ledger).execute(ctx));const result=await ledger.summary('');assert.equal(result.ledger.unfinished,0);assert.equal(result.ledger.finished,1);assert.equal(result.total.missingSnapshots,1);assert.equal(result.total.metrics.reportedCostUsd.observed,null);
});
test('diagnostic export uses durable numeric summary even when no retained logs exist',async t=>{
 const {dir,ledger,logger}=await fixture(t);await ledger.start(id);await ledger.finish(id,true,usage,100,visibleStepProfile([{id:'m',type:'assistant',tokens,content:'PRIVATE'}]));const report=await new DiagnosticReports(dir,logger).build({});const raw=(await readFile(report.filePath)).toString();assert.match(raw,/persistent_session_ledger_and_retained_logs/);assert.match(raw,/"visibleSteps": 1/);assert.doesNotMatch(raw,/PRIVATE/);
});
