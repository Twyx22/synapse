import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/core/store.ts";
import { Synapse } from "../src/core/orchestrator.ts";
import { ExperimentStore, type ExperimentPair } from "../src/core/experiments.ts";
import { DiagnosticLogger, DiagnosticReports } from "../src/core/diagnostics.ts";
import { EvolutionCouncil, EvolutionStore } from "../src/core/evolution.ts";
import { registerTools, type ToolDef } from "../src/opencode/tools.ts";
import { runCLI } from "../src/cli.ts";
import { event } from "../src/core/bus.ts";
import type { TaskSpec } from "../src/core/types.ts";
const tasks:TaskSpec[]=[{id:"a",title:"A",instruction:"answer A",review:false,contract:{requireSubmit:true},maxAttempts:1},{id:"b",title:"B",instruction:"answer B",review:true,maxAttempts:1}];
const expected=[{taskId:"a",text:"SECRET_FIXTURE_A"},{taskId:"b",text:"SECRET_FIXTURE_B"}];
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),"synapse-experiment-")); const store=new FileStore(dir); let calls=0;
 const engine=new Synapse(store,{execute:async c=>{calls++;return {text:expected.find(e=>e.taskId===c.task.id)!.text,channel:"submit"};},review:async()=>{calls++;return {approved:true,reason:"fixture review"};}});
 const ex=new ExperimentStore(store);
 async function pair():Promise<ExperimentPair>{return {baselineRunId:(await engine.plan("same fixture",tasks,1)).id,candidateRunId:(await engine.plan("same fixture",tasks,2)).id};}
 return {dir,store,engine,ex,pair,calls:()=>calls,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
type F=Awaited<ReturnType<typeof fixture>>;
/** Deterministic replay of measured records, not a performance benchmark. */
async function finish(f:F,id:string,start:number,duration:number,wrong=false){
 await f.store.update(id,r=>{
   r.status="completed";r.tasks.forEach(t=>{t.status="completed";t.attempts=1;t.result=wrong?"WRONG":expected.find(e=>e.taskId===t.id)!.text;if(t.contract)t.contractEvidence={attempt:1,sentTo:[],receivedFrom:[],channel:"submit",missing:[]};});
   event(r,"run.started","start");r.events.at(-1)!.at=new Date(start).toISOString();
   event(r,"task.verified","review","b");r.events.at(-1)!.at=new Date(start+duration).toISOString();
   event(r,"run.finished","done");r.events.at(-1)!.at=new Date(start+duration).toISOString();
 });
}
test("experiments register only fresh equivalent plans; no model sessions or answer leakage in metadata",async()=>{
 const f=await fixture();try{const pair=await f.pair();const e=await f.ex.register([pair],expected,"test-config");assert.equal(f.calls(),0);assert.equal((await f.ex.evaluate(e.id)).status,"pending");assert.doesNotMatch(JSON.stringify(await f.ex.list()),/SECRET_FIXTURE|test-config/);
 const changed=await f.engine.plan("same fixture",tasks.map(t=>({...t,review:false})),2);await assert.rejects(f.ex.register([{...pair,candidateRunId:changed.id}],expected,"test"),/identical/);
 await assert.rejects(f.ex.register([pair,pair],expected,"test"),/distinct/);await assert.rejects(f.ex.register([pair],expected.slice(0,1),"test"),/expected text/);
 await f.engine.run(pair.baselineRunId);await assert.rejects(f.ex.register([pair],expected,"test"),/fresh/);
 }finally{await f.cleanup();}
});
test("three pre-registered pairs recommend only a fixture-specific consistent gain; persisted after reopen",async()=>{
 const f=await fixture();try{const pairs=await Promise.all([f.pair(),f.pair(),f.pair()]);const e=await f.ex.register(pairs,expected,"test-config");let start=Date.now()+100;
 for(const p of pairs){await finish(f,p.baselineRunId,start,100);await finish(f,p.candidateRunId,start+101,75);start+=300;}
 const result=await new ExperimentStore(new FileStore(f.dir)).evaluate(e.id);assert.equal(result.status,"candidate_promising");assert.equal(result.medianPairedGain,0.25);assert.equal(result.allQuality,true);assert.match(result.guidance,/never adopt automatically/);assert.equal(f.calls(),0);
 }finally{await f.cleanup();}
});
test("failed quality, overlap, timing loss and too few samples never recommend adoption",async()=>{
 const f=await fixture();try{const p=await f.pair();const e=await f.ex.register([p],expected,"test-config");const start=Date.now()+100;
 await finish(f,p.baselineRunId,start,100);await finish(f,p.candidateRunId,start+101,50,true);assert.equal((await f.ex.evaluate(e.id)).status,"quality_gate_failed");
 await f.store.update(p.candidateRunId,r=>{r.events=[];});await finish(f,p.candidateRunId,start+50,25);assert.equal((await f.ex.evaluate(e.id)).status,"inconclusive");
 await f.store.update(p.candidateRunId,r=>{r.events=[];});await finish(f,p.candidateRunId,start+101,50);assert.equal((await f.ex.evaluate(e.id)).status,"insufficient_pairs");
 await f.store.update(p.candidateRunId,r=>{r.events=r.events.filter(e=>e.type!=="run.started");});assert.equal((await f.ex.evaluate(e.id)).status,"inconclusive");
 }finally{await f.cleanup();}
});
test("actual local scheduler fixture verifies exact results and required review; tools restricted and report excludes answers",async()=>{
 const f=await fixture();try{const p=await f.pair();const defs=new Map<string,ToolDef>();await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>defs.set(d.name,d)})},f.engine,undefined,undefined,id=>id==="restricted");
 const ctx={sessionID:"coordinator",signal:new AbortController().signal};const params={pairs:[p],expected,modelLabel:"SECRET_MODEL_LABEL"};await assert.rejects(defs.get("experiment_register")!.execute(params,{...ctx,sessionID:"restricted"}));
 const reg=JSON.parse((await defs.get("experiment_register")!.execute(params,ctx)).content);await f.engine.run(p.baselineRunId);await f.engine.run(p.candidateRunId);
 const view=JSON.parse((await defs.get("experiment_evaluate")!.execute({experimentId:reg.id},ctx)).content);assert.equal(view.allQuality,true);assert.equal(view.status,"insufficient_pairs");assert.equal(f.calls(),6);
 await assert.rejects(defs.get("experiment_evaluate")!.execute({experimentId:reg.id},{...ctx,sessionID:"restricted"}));assert.equal(await runCLI(["experiments","--data-dir",f.dir,"--experiment",reg.id]),0);
 const logger=new DiagnosticLogger(join(f.dir,"diagnostics"));const report=await new DiagnosticReports(f.dir,logger).build();assert.ok(report.files.includes("experiments.json"));const bytes=await readFile(report.filePath);assert.doesNotMatch(bytes.toString("utf8"),/SECRET_FIXTURE|SECRET_MODEL_LABEL/);await logger.flush();
 }finally{await f.cleanup();}
});
test("no failed pair can be hidden by faster successful trials",async()=>{
 const f=await fixture();try{const pairs=await Promise.all([f.pair(),f.pair(),f.pair()]);const e=await f.ex.register(pairs,expected,"test-config");let start=Date.now()+100;
 for(const [i,p] of pairs.entries()){await finish(f,p.baselineRunId,start,100);await finish(f,p.candidateRunId,start+101,i===2?110:50,i===2);start+=400;}
 assert.equal((await f.ex.evaluate(e.id)).status,"quality_gate_failed");
 }finally{await f.cleanup();}
});
test("retrospective creates slow-review idea without model calls or changing review policy",async()=>{
 const f=await fixture();try{const p=await f.engine.plan("review overhead",[tasks[1]],1);await f.store.update(p.id,r=>{r.status="completed";r.tasks[0].status="completed";r.tasks[0].attempts=1;let at=Date.now();for(const [name,offset] of [["task.started",0],["task.review",1000],["task.verified",98000]] as const){event(r,name,"fixture","b");r.events.at(-1)!.at=new Date(at+offset).toISOString();}});
 const council=new EvolutionCouncil(new EvolutionStore(join(f.dir,"evolution")),{execute:async()=>{throw Error("must not call model");}});const ideas=await council.scan(await f.engine.get(p.id));assert.ok(ideas.some(x=>x.kind==="review_latency"));assert.equal((await f.engine.get(p.id)).tasks[0].review,true);
 }finally{await f.cleanup();}
});

test("unregistered overlapping graph invalidates otherwise promising benchmark; corrupt history is unknown",async()=>{
 const f=await fixture();try{
  const pairs=await Promise.all([f.pair(),f.pair(),f.pair()]);const e=await f.ex.register(pairs,expected,"test-config");let start=Date.now()+100;const first=start;
  for(const p of pairs){await finish(f,p.baselineRunId,start,100);await finish(f,p.candidateRunId,start+101,75);start+=300;}
  const other=await f.engine.plan("other work",tasks,2);await finish(f,other.id,first+50,25);
  const result=await f.ex.evaluate(e.id);assert.equal(result.status,"inconclusive");assert.equal(result.isolation.status,"overlap_detected");assert.deepEqual(result.isolation.overlappingRunIds,[other.id]);assert.equal(result.allQuality,true);
  await f.store.update(other.id,r=>{r.events=[];});const unknown=await f.ex.evaluate(e.id);assert.equal(unknown.status,"inconclusive");assert.equal(unknown.isolation.status,"unknown");
 }finally{await f.cleanup();}
});
test("strategy advice matches exact plan and model label; no settings or permissions changed",async()=>{
 const f=await fixture();try{
  const pairs=await Promise.all([f.pair(),f.pair(),f.pair()]);await f.ex.register(pairs,expected,"test-config");let start=Date.now()+100;
  for(const p of pairs){await finish(f,p.baselineRunId,start,100);await finish(f,p.candidateRunId,start+101,75);start+=300;}
  const plan=await f.engine.plan("same fixture",tasks,1);const before=await f.engine.get(plan.id);
  const advice=await f.ex.advise(plan.id,"test-config");assert.equal(advice.suggestedConcurrency,2);assert.equal(advice.status,"advisory_candidate");assert.equal(advice.graph.maxIndependentTasks,2);
  assert.equal((await f.ex.advise(plan.id,"different-model")).suggestedConcurrency,null);
  const changed=await f.engine.plan("same fixture",tasks.map(t=>({...t,review:false})),1);assert.equal((await f.ex.advise(changed.id,"test-config")).suggestedConcurrency,null);
  assert.deepEqual(await f.engine.get(plan.id),before);assert.equal(f.calls(),0);
  assert.equal(await runCLI(["strategy","--data-dir",f.dir,"--run",plan.id,"--model-label","test-config"]),0);
 }finally{await f.cleanup();}
});
test('registered experiment exports separate economic comparisons only after quality and isolation pass',async()=>{
 const f=await fixture();try {const {CostLedger}=await import('../src/core/ledger.ts');const ledger=new CostLedger(f.dir);const p=await f.pair();const e=await f.ex.register([p],expected,'test-config');const start=Date.now()+100;await finish(f,p.baselineRunId,start,100);await finish(f,p.candidateRunId,start+101,80);
 for(const [runId,input] of [[p.baselineRunId,100],[p.candidateRunId,50]] as const){const id={runId,sessionId:'worker',role:'worker' as const};await ledger.start(id);await ledger.finish(id,true,{usageSource:'session_get',inputTokens:input,reportedCostUsd:0},100);}
 const result=await f.ex.evaluate(e.id);assert.equal(result.economics[0].input.relativeReduction,.5);assert.equal(result.economics[0].reportedUsd.relativeReduction,null);assert.equal(result.status,'insufficient_pairs');await f.store.update(p.candidateRunId,r=>{r.tasks[0].result='wrong';});assert.equal((await f.ex.evaluate(e.id)).economics[0].input.comparable,false);
 } finally {await f.cleanup();}
});
