import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyProviderError,terminalFailure,ProviderSessionError} from '../src/core/provider.ts';
import {ProviderResilience,installRetryHook,subscribeFailures,type RetryEvent} from '../src/opencode/resilience.ts';
import {OpenCodeAdapter,type SessionApi} from '../src/opencode/adapter.ts';
import {Synapse} from '../src/core/orchestrator.ts';
import {FileStore} from '../src/core/store.ts';
import {DiagnosticLogger,DiagnosticReports,exportLogMetadata,errorCategory} from '../src/core/diagnostics.ts';
import {CostLedger} from '../src/core/ledger.ts';
import {economicAdvice} from '../src/core/economics.ts';
import type {AgentContext,TaskSpec} from '../src/core/types.ts';
const quota={type:'provider.free-limit',message:'Free usage limit reached. SECRET_TOKEN'};
const fixture:TaskSpec={id:'a',title:'Exact',instruction:'Return the number',review:false,maxAttempts:2,contract:{requireSubmit:true}};
const context=(signal=new AbortController().signal):AgentContext=>({runId:'r',objective:'test',task:{...fixture,role:'analysis',dependsOn:[],priority:0,review:false,maxAttempts:2,status:'running',attempts:1},dependencies:[],messages:[],signal});
const api=(overrides:Partial<SessionApi>={}):SessionApi=>({create:async()=>({id:'s'}),switchAgent:async()=>{},update:async()=>{},prompt:async()=>{},wait:async()=>{},context:async()=>[],interrupt:async()=>{},...overrides});
const event=(id='s')=>({type:'session.execution.failed',data:{sessionID:id,error:quota}});
const retry=(id='s',error:unknown=quota):RetryEvent=>({sessionID:id,error,attempt:1,decision:{retry:true,delay:1000}});
const failed=[{type:'user',text:'private'},{type:'idle',outcome:'failed',error:quota}];
test('provider categories use typed quota, status and nested real error without retaining raw content',()=>{
 assert.equal(classifyProviderError(quota),'provider_quota');assert.equal(classifyProviderError(new Error('AI.Error: Free usage limit reached. Free models work in OpenCode')), 'provider_quota');
 assert.equal(classifyProviderError(new Error('drain failed',{cause:{name:'AI.Error.QuotaExceeded'}})),'provider_quota');
 assert.equal(classifyProviderError({status:429}),'provider_rate_limit');assert.equal(classifyProviderError({statusCode:401}),'provider_auth');assert.equal(classifyProviderError({status:503}),'provider_unavailable');assert.equal(classifyProviderError({type:'provider.invalid-request'}),'provider_invalid_request');assert.equal(classifyProviderError({type:'provider.unknown'}),'provider_failure');assert.equal(classifyProviderError(new Error('unknown local error')),undefined);
 const err=new ProviderSessionError('provider_quota');assert.equal(String(err),'ProviderSessionError: provider_quota');assert.equal(errorCategory(err),'provider_quota');
});
test('latest terminal marker only, never classify model text or recovered failures',()=>{
 assert.equal(terminalFailure(failed),'provider_quota');assert.equal(terminalFailure([{type:'idle',outcome:'failed'}]),'session_failed');assert.equal(terminalFailure([{type:'idle',outcome:'interrupted'}]),'session_interrupted');assert.equal(terminalFailure([...failed,{type:'user'},{type:'assistant',text:'quota exceeded'}]),undefined);assert.equal(terminalFailure([...failed,{type:'idle',outcome:'succeeded'}]),undefined);assert.equal(terminalFailure([{type:'assistant',text:'Free usage limit reached'}]),undefined);
});
test('retry hook vetoes hard limits only for owned sessions, circuit scoped to signal',()=>{
 const r=new ProviderResilience(),a=new AbortController(),b=new AbortController();r.open('s',a.signal);const other=retry('coordinator');r.retry(other);assert.equal(other.decision.retry,true);const transient=retry('s',{status:503});r.retry(transient);assert.equal(transient.decision.retry,true);assert.equal(r.failure('s'),undefined);const q=retry();r.retry(q);assert.deepEqual(q.decision,{retry:false});assert.equal(r.failure('s'),'provider_quota');assert.throws(()=>r.check(a.signal),/provider_circuit_open/);assert.doesNotThrow(()=>r.check(b.signal));r.close('s');assert.equal(r.failure('s'),undefined);r.event(event('s'));assert.equal(r.failure('s'),undefined);
});
test('hook registration and event stream are optional and abortable',async()=>{
 assert.equal(await installRetryHook({},()=>{}),false);assert.equal(await installRetryHook({hook:async()=>{throw Error('unsupported');}},()=>{}),false);let seen=0;assert.equal(await installRetryHook({hook:async(name:string,cb:(e:RetryEvent)=>void)=>{assert.equal(name,'retry');cb(retry());}},()=>{seen++;}),true);assert.equal(seen,1);assert.equal(subscribeFailures({},()=>{},()=>{}),undefined);
 let signal:AbortSignal|undefined;let notify!:()=>void;const observed=new Promise<void>(r=>notify=r);const stop=subscribeFailures({async *subscribe(options:{signal:AbortSignal}){signal=options.signal;yield event();}},()=>notify(),()=>assert.fail('stream error'));await observed;stop!();assert.equal(signal?.aborted,true);
});
test('real graph simulated terminal quota stops retries, other graph can proceed, valid prior task survives',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'synapse-provider-'));let count=0,prompts=0;let adapter:OpenCodeAdapter;const log=new DiagnosticLogger(join(dir,'diagnostics'));t.after(async()=>{await log.flush();await rm(dir,{recursive:true,force:true,maxRetries:3});});const ledger=new CostLedger(dir);
 adapter=new OpenCodeAdapter(api({create:async()=>({id:`s${++count}`}),prompt:async({sessionID})=>{prompts++;if(sessionID!=='s2')adapter.submit(sessionID,'ok');},context:async({sessionID})=>sessionID==='s2'?failed:[]}),log,undefined,ledger);
 const engine=new Synapse(new FileStore(dir,log),adapter);const plan=await engine.plan('test',[fixture,{...fixture,id:'b',dependsOn:['a']},{...fixture,id:'c',dependsOn:['a']},{...fixture,id:'d',dependsOn:['b']}],1);const result=await engine.run(plan.id);
 assert.equal(result.status,'failed');assert.equal(count,2);assert.equal(prompts,2);assert.deepEqual(result.tasks.map(x=>x.status),['completed','failed','failed','blocked']);assert.equal(result.tasks[1].attempts,1);assert.match(result.tasks[1].error!,/provider_quota/);assert.match(result.tasks[2].error!,/provider_circuit_open/);assert.equal(result.tasks[0].result,'ok');assert.equal(engine.resourceStatus().reserved,0);
 const advice=economicAdvice(result,await ledger.summary('',plan.id));assert.equal(advice.performanceEligible,false);assert.ok(advice.findings.includes('run_not_completed_no_performance_recommendation'));
 const zip=await readFile((await new DiagnosticReports(dir,log).build({runId:plan.id})).filePath);assert.ok(zip.includes(Buffer.from('provider_quota')));assert.ok(zip.includes(Buffer.from('provider_circuit_open')));assert.ok(!zip.includes(Buffer.from('SECRET_TOKEN')));
 const next=await engine.plan('new run',[fixture],1);assert.equal((await engine.run(next.id)).status,'completed');assert.equal(count,3);
});
test('retry hook and terminal event each identify an otherwise empty result',async()=>{
 for(const kind of ['retry','event']){let adapter:OpenCodeAdapter;adapter=new OpenCodeAdapter(api({wait:async()=>{if(kind==='retry')adapter.observeRetry(retry());else adapter.observeTerminal(event());}}));await assert.rejects(adapter.execute(context()),(err:unknown)=>err instanceof ProviderSessionError&&err.category==='provider_quota');}
});
test('direct host exceptions are normalized and explicit submit cannot override a known terminal failure',async()=>{
 const direct=new OpenCodeAdapter(api({prompt:async()=>{throw new Error('Free usage limit reached. SECRET_TOKEN');}}));await assert.rejects(direct.execute(context()),(err:unknown)=>err instanceof ProviderSessionError&&err.category==='provider_quota'&&!String(err).includes('SECRET_TOKEN'));
 let adapter:OpenCodeAdapter;adapter=new OpenCodeAdapter(api({prompt:async()=>{adapter.submit('s','partial');},context:async()=>failed}));await assert.rejects(adapter.execute(context()),/provider_quota/);
});
test('review quota does not rerun the worker or request a second reviewer',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'synapse-provider-review-'));t.after(()=>rm(dir,{recursive:true,force:true}));let count=0;let adapter:OpenCodeAdapter;adapter=new OpenCodeAdapter(api({create:async()=>({id:`s${++count}`}),prompt:async({sessionID})=>{if(sessionID==='s1')adapter.submit(sessionID,'work');},context:async({sessionID})=>sessionID==='s2'?failed:[]}));const engine=new Synapse(new FileStore(dir),adapter);const plan=await engine.plan('review',[{...fixture,review:true}],1);const result=await engine.run(plan.id);assert.equal(count,2);assert.equal(result.status,'failed');assert.equal(result.tasks[0].result,'work');assert.match(result.tasks[0].reviewResult!,/provider_quota/);assert.equal(result.tasks[0].attempts,1);
});
test('provider metadata exports fixed enums only',()=>{
 const row={at:new Date().toISOString(),level:'warn',event:'agent.provider.failure',fields:{runId:'r',errorCategory:'provider_quota',failureSource:'retry_hook',rawMessage:'SECRET_TOKEN',headers:{authorization:'secret'}}};assert.deepEqual(JSON.parse(exportLogMetadata(JSON.stringify(row))).fields,{runId:'r',errorCategory:'provider_quota',failureSource:'retry_hook'});
});

test('coordinator usage is a bounded numeric snapshot, identity checked, not a graph cost or model request',async()=>{
 let calls=0;const adapter=new OpenCodeAdapter(api({get:async({sessionID})=>{calls++;return {id:sessionID,tokens:{input:100,output:20,cache:{read:30}},cost:0.01,secret:'SECRET_TOKEN'};},prompt:async()=>assert.fail('no model call')}));
 const result=await adapter.coordinatorUsage('coordinator');assert.equal(calls,1);assert.equal(result.scope,'current_coordinator_session_cumulative');assert.equal(result.usage.inputTokens,100);assert.equal(result.billingVerified,false);assert.ok(!JSON.stringify(result).includes('SECRET_TOKEN'));
 const bad=new OpenCodeAdapter(api({get:async()=>({id:'other',tokens:{input:100}})}));assert.equal((await bad.coordinatorUsage('coordinator')).usage.usageSource,'unavailable');assert.equal((await new OpenCodeAdapter(api()).coordinatorUsage('coordinator')).usage.usageSource,'unavailable');
});

test('coordinator usage tool binds caller identity and rejects restricted sessions',async t=>{
 const {registerTools}=await import('../src/opencode/tools.ts');type ToolDef=import('../src/opencode/tools.ts').ToolDef;
 const dir=await mkdtemp(join(tmpdir(),'synapse-coordinator-'));t.after(()=>rm(dir,{recursive:true,force:true}));const engine=new Synapse(new FileStore(dir),{execute:async()=>assert.fail('no model call')});const defs=new Map<string,ToolDef>();let observed:string|undefined;
 await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>{defs.set(d.name,d);}})},engine,undefined,undefined,id=>id==='worker',undefined,undefined,undefined,async id=>{observed=id;return {scope:'test'};});const tool=defs.get('coordinator_usage')!;
 await assert.rejects(tool.execute({},{sessionID:'worker',signal:new AbortController().signal}));assert.equal(observed,undefined);await tool.execute({sessionID:'forged'},{sessionID:'coordinator',signal:new AbortController().signal});assert.equal(observed,'coordinator');
});
