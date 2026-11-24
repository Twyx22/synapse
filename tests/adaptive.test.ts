import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Synapse} from "../src/core/orchestrator.ts";
import {FileStore} from "../src/core/store.ts";
import {ExperimentStore} from "../src/core/experiments.ts";
import {topology} from "../src/core/topology.ts";
import {newRun} from "../src/core/validate.ts";
import {registerTools,type ToolDef} from "../src/opencode/tools.ts";
const spec=(id:string,dependsOn:string[]=[])=>({id,title:id,instruction:"return ok",review:false,maxAttempts:1,dependsOn});
function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
test("DAG width accounts for transitive dependencies and independent branches",()=>{
 const chain=newRun("chain",[spec("a"),spec("b",["a"]),spec("c",["b"])],8);
 assert.equal(topology(chain).maxIndependentTasks,1);assert.equal(topology(chain).concurrencyAboveWidth,true);
 const branch=newRun("branch",[spec("a"),spec("b",["a"]),spec("c",["a"]),spec("d",["b","c"]),spec("e")],8);
 assert.equal(topology(branch).maxIndependentTasks,3);
});
test("shared capacity admission prevents oversubscription and releases graph slots",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"synapse-capacity-"));const hold=barrier(),entered=barrier();let calls=0;
 const e=new Synapse(new FileStore(dir),{execute:async()=>{calls++;entered.release();await hold.promise;return {text:"ok"};}});
 let active:Promise<unknown>|undefined;
 try {
  const tasks=Array.from({length:6},(_,i)=>spec(`t${i}`));const a=await e.plan("a",tasks,6), b=await e.plan("b",tasks,6);
  active=e.run(a.id);await entered.promise;assert.equal(e.resourceStatus().reserved,6);
  await assert.rejects(e.run(b.id),/capacity exhausted/);assert.equal((await e.get(b.id)).status,"planned");assert.equal(e.resourceStatus().available,2);
  hold.release();await active;assert.equal(e.resourceStatus().reserved,0);await e.run(b.id);assert.equal(calls,12);assert.equal(e.resourceStatus().reserved,0);
 }finally{hold.release();await active?.catch(()=>undefined);await rm(dir,{recursive:true,force:true});}
});
test("registered experiment receives an exclusive graph reservation in both directions",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"synapse-exclusive-"));let hold=barrier(),entered=barrier();const store=new FileStore(dir);
 const e=new Synapse(store,{execute:async()=>{entered.release();await hold.promise;return {text:"ok"};}});
 let active:Promise<unknown>|undefined;
 try {
  const a=await e.plan("fixture",[spec("a"),spec("b")],1),b=await e.plan("fixture",[spec("a"),spec("b")],2),other=await e.plan("other",[spec("c")],1);
  await new ExperimentStore(store).register([{baselineRunId:a.id,candidateRunId:b.id}],[{taskId:"a",text:"ok"},{taskId:"b",text:"ok"}],"model");
  active=e.run(other.id);await entered.promise;await assert.rejects(e.run(a.id),/Experiment isolation/);hold.release();await active;
  hold=barrier();entered=barrier();active=e.run(a.id);await entered.promise;assert.equal(e.resourceStatus().exclusiveRunId,a.id);
  await assert.rejects(e.run(b.id),/Experiment isolation/);const c=await e.plan("more work",[spec("d")],1);await assert.rejects(e.run(c.id),/Experiment isolation/);
  hold.release();await active;assert.equal(e.resourceStatus().exclusiveRunId,null);assert.equal(e.resourceStatus().reserved,0);
 }finally{hold.release();await active?.catch(()=>undefined);await rm(dir,{recursive:true,force:true});}
});
test("new resource and strategy inspection tools remain coordinator-only",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"synapse-inspection-"));try{
  const engine=new Synapse(new FileStore(dir),{execute:async()=>{throw Error("unexpected model call");}});const defs=new Map<string,ToolDef>();
  await registerTools({transform:async fn=>fn({namespace:()=>{},add:t=>defs.set(t.name,t)})},engine,undefined,undefined,id=>id==="worker");
  const signal=new AbortController().signal;
  for(const name of ["resource_status","strategy_advice"])await assert.rejects(defs.get(name)!.execute({},{sessionID:"worker",signal}),/coordinator-only/);
  const res=JSON.parse((await defs.get("resource_status")!.execute({},{sessionID:"coordinator",signal})).content);assert.equal(res.available,8);
 }finally{await rm(dir,{recursive:true,force:true});}
});
