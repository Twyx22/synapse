import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {filterLeanTools,installToolHook,type ToolContext} from '../src/opencode/toolset.ts';
import {OpenCodeAdapter,type SessionApi} from '../src/opencode/adapter.ts';
import {Synapse} from '../src/core/orchestrator.ts';
import {FileStore} from '../src/core/store.ts';
import {newRun} from '../src/core/validate.ts';
import {DiagnosticLogger,DiagnosticReports,exportLogMetadata} from '../src/core/diagnostics.ts';
import {ExperimentStore} from '../src/core/experiments.ts';
import type {TaskSpec} from '../src/core/types.ts';
const fixture:TaskSpec={id:'a',title:'Exact',instruction:'Return the integer',review:false,maxAttempts:1,contract:{requireSubmit:true},verification:{kind:'exact',expected:'703'},toolProfile:'lean'};
const tools=()=>({synapse_submit:{description:'Submit'},synapse_message:{description:'Message'},synapse_inbox:{description:'Inbox'},read:{description:'private schema'},shell:{description:'Shell'},synapse_execute:{description:'Execute graph'},execute:{description:'Code Mode'}});
const ctx=(sessionID:string):ToolContext=>({sessionID,tools:tools()});
test('lean filter only subtracts, preserves submit and both direct communication tools',()=>{
 const e=ctx('s');const submit=e.tools.synapse_submit;const r=filterLeanTools(e,{send:true,receive:true});
 assert.equal(r.filterStatus,'applied');assert.equal(r.toolsBefore,7);assert.equal(r.toolsAfter,3);assert.ok(r.schemaCharsAfter!<r.schemaCharsBefore!);assert.equal(e.tools.synapse_submit,submit);assert.deepEqual(Object.keys(e.tools),['synapse_submit','synapse_message','synapse_inbox']);
});
test('missing submit, missing mandatory inbox and immutable registry leave tools unchanged',()=>{
 for(const missing of ['synapse_submit','synapse_inbox']){const e=ctx('s');delete e.tools[missing];const before=structuredClone(e.tools);assert.equal(filterLeanTools(e,{send:false,receive:true}).filterStatus,'required_missing');assert.deepEqual(e.tools,before);}
 const e=ctx('s');Object.freeze(e.tools);assert.equal(filterLeanTools(e,{send:false,receive:false}).filterStatus,'immutable');assert.equal(Object.keys(e.tools).length,7);
});
test('optional hook feature detection handles unsupported hosts and registration errors',async()=>{
 assert.equal(await installToolHook({},()=>{}),false);assert.equal(await installToolHook({hook:async()=>{throw Error('no hook');}},()=>{}),false);
 let called=false;assert.equal(await installToolHook({hook:async(name:string,cb:(e:ToolContext)=>void)=>{assert.equal(name,'context');cb(ctx('s'));}},()=>{called=true;}),true);assert.equal(called,true);
});
test('lean profile is opt-in and valid only for exact fixture with explicit submission',()=>{
 assert.equal(newRun('test',[fixture],1).tasks[0].toolProfile,'lean');
 assert.throws(()=>newRun('test',[{...fixture,verification:undefined}],1),/Lean tool profile/);
 assert.throws(()=>newRun('test',[{...fixture,toolProfile:'bad' as 'lean'}],1),/Lean tool profile/);
 assert.equal(newRun('test',[{...fixture,toolProfile:undefined}],1).tasks[0].toolProfile,undefined);
});
test('end-to-end mock host filters only active lean worker, preserves review and fixture secrecy',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'synapse-toolset-'));let n=0;let adapter:OpenCodeAdapter;const seen:number[]=[];const log=new DiagnosticLogger(join(dir,'diagnostics'));
 const api:SessionApi={create:async()=>({id:`s${++n}`}),switchAgent:async()=>{},update:async()=>{},prompt:async({sessionID,text})=>{
  assert.ok(!text.includes('703')||sessionID==='s2');const unrelated=ctx('coordinator');adapter.filterTools(unrelated);assert.equal(Object.keys(unrelated.tools).length,7);
  const e=ctx(sessionID);adapter.filterTools(e);seen.push(Object.keys(e.tools).length);
  if(sessionID==='s2')adapter.submitReview(sessionID,true,'Reviewed');else adapter.submit(sessionID,'703');
 },wait:async()=>{},context:async()=>[],interrupt:async()=>{}};
 try{adapter=new OpenCodeAdapter(api,log);adapter.setToolHookAvailable(true);const engine=new Synapse(new FileStore(dir,log),adapter);
  const plan=await engine.plan('fixture',[{...fixture,review:true}],1,3);assert.equal((await engine.run(plan.id)).status,'completed');assert.deepEqual(seen,[3,7]);
  const late=ctx('s1');adapter.filterTools(late);assert.equal(Object.keys(late.tools).length,7);
  const standard=await engine.plan('fixture',[{...fixture,toolProfile:undefined}],1,1);assert.equal((await engine.run(standard.id)).status,'completed');assert.deepEqual(seen,[3,7,7]);
  const report=await new DiagnosticReports(dir,log).build({runId:plan.id});const zip=await readFile(report.filePath);assert.ok(zip.includes(Buffer.from('agent.toolset.filtered')));assert.ok(zip.includes(Buffer.from('schemaCharsBefore')));assert.ok(!zip.includes(Buffer.from('private schema')));assert.ok(!zip.includes(Buffer.from('"expected"')));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('experiments reject different tool profiles and diagnostic allowlist exports only counts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'synapse-toolset-exp-'));try{const store=new FileStore(dir);const engine=new Synapse(store,{execute:async()=>({text:'703',channel:'submit'})});const a=await engine.plan('fixture',[fixture],1),b=await engine.plan('fixture',[{...fixture,toolProfile:undefined}],2);
 await assert.rejects(new ExperimentStore(store).register([{baselineRunId:a.id,candidateRunId:b.id}],[{taskId:'a',text:'703'}],'model'),/identical/);
 const raw=JSON.stringify({at:new Date().toISOString(),level:'info',event:'agent.toolset.filtered',fields:{filterStatus:'applied',toolProfile:'lean',toolsBefore:7,toolsAfter:3,schemaCharsBefore:1000,schemaCharsAfter:200,toolNames:['secret'],text:'secret'}});
 assert.deepEqual(JSON.parse(exportLogMetadata(raw)).fields,{filterStatus:'applied',toolProfile:'lean',toolsBefore:7,toolsAfter:3,schemaCharsBefore:1000,schemaCharsAfter:200});
 }finally{await rm(dir,{recursive:true,force:true});}
});
