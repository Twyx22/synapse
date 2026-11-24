import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Synapse } from "../src/core/orchestrator.ts";
import { FileStore } from "../src/core/store.ts";
import { validatePlan } from "../src/core/validate.ts";
import { OpenCodeAdapter, type SessionApi } from "../src/opencode/adapter.ts";
import { registerTools, type ToolDef } from "../src/opencode/tools.ts";
import { EvolutionCouncil, EvolutionStore } from "../src/core/evolution.ts";
import type { TaskSpec, AgentAdapter } from "../src/core/types.ts";
const plan: TaskSpec[] = [
 {id:"a",title:"A",instruction:"send",review:false,maxAttempts:1,contract:{requireSubmit:true,sendTo:["b"]}},
 {id:"b",title:"B",instruction:"receive",review:true,maxAttempts:1,dependsOn:["a"],contract:{requireSubmit:true,receiveFrom:["a"]}}
];
async function fixture(adapter:AgentAdapter) {const dir=await mkdtemp(join(tmpdir(),"synapse-contract-"));return {dir,engine:new Synapse(new FileStore(dir),adapter),cleanup:()=>rm(dir,{recursive:true,force:true})};}
test("contract validation requires declared sender, valid dependency and bounded timeout",()=>{
 assert.equal(validatePlan("x",plan)[1].contract?.receiveFrom?.[0],"a");
 assert.throws(()=>validatePlan("x",[{...plan[0],contract:{sendTo:["unknown"]}},plan[1]]));
 assert.throws(()=>validatePlan("x",[plan[0],{...plan[1],dependsOn:[]}]));
 assert.throws(()=>validatePlan("x",[{...plan[0],contract:{}},plan[1]]));
 assert.throws(()=>validatePlan("x",[{...plan[0],timeoutSeconds:0},plan[1]]));
});
test("required send + explicit submit + recipient fetch + review satisfy contract via actual tool callbacks",async()=>{
 let f:Awaited<ReturnType<typeof fixture>>; const defs=new Map<string,ToolDef>();
 f=await fixture({execute:async c=>{
  const sessionID=`session-${c.task.id}`; c.onSession?.(sessionID);
  const ctx={sessionID,signal:c.signal};
  if(c.task.id==="a") await defs.get("message")!.execute({runId:c.runId,to:"b",type:"evidence",body:"actual handoff"},ctx);
  else { const out=await defs.get("inbox")!.execute({runId:c.runId},ctx); assert.match(out.content,/actual handoff/); }
  return {text:"done",channel:"submit",sessionID};
 },review:async()=>({approved:true,reason:"checked"})});
 try {await registerTools({transform:async fn=>fn({namespace:()=>{},add:d=>{defs.set(d.name,d);}})},f.engine);
 const ctx={sessionID:"coordinator",signal:new AbortController().signal};
 const p=JSON.parse((await defs.get("plan")!.execute({objective:"contract",tasks:plan},ctx)).content);
 const r=await f.engine.run(p.runId);
 assert.equal(r.status,"completed"); assert.deepEqual(r.tasks[0].contractEvidence?.sentTo,["b"]); assert.deepEqual(r.tasks[1].contractEvidence?.receivedFrom,["a"]); assert.deepEqual(r.tasks[1].contractEvidence?.missing,[]);
 assert.equal(r.events.filter(e=>e.type==="task.contract_verified").length,2);
 await assert.rejects(defs.get("message")!.execute({runId:r.id,to:"b",type:"note",body:"late"},{...ctx,sessionID:"session-a"}),/Inactive/);
 } finally {await f.cleanup();}
});
test("context fallback and absent direct messages fail closed; dependents blocked; council opens idea",async()=>{
 const f=await fixture({execute:async()=>({text:"claimed all done",channel:"context"})});
 try {const p=await f.engine.plan("contract",plan); const r=await f.engine.run(p.id);
 assert.equal(r.status,"failed");assert.equal(r.tasks[1].status,"blocked");assert.deepEqual(r.tasks[0].contractEvidence?.missing,["explicit submit","direct send to b"]);
 const council=new EvolutionCouncil(new EvolutionStore(join(f.dir,"evolution")),{execute:async()=>{throw Error("must not use model");}});
 assert.ok((await council.scan(r)).some(i=>i.kind==="contract_compliance"));
 }finally{await f.cleanup();}
});
test("old attempt cannot satisfy new attempt or send from stale session",async()=>{
 let f:Awaited<ReturnType<typeof fixture>>; let staleRejected=false;
 f=await fixture({execute:async c=>{
 if(c.task.id==="a" && c.task.attempts===1){await f.engine.send(c.runId,"a","b","evidence","old",1); return {text:"first",channel:"context"};}
 if(c.task.id==="a"){await assert.rejects(f.engine.send(c.runId,"a","b","evidence","stale",1));staleRejected=true;}
 return {text:"second",channel:"submit"};
 }});
 try {const p=await f.engine.plan("retry",[{...plan[0],maxAttempts:2},plan[1]]);const r=await f.engine.run(p.id);
 assert.equal(staleRejected,true);assert.equal(r.status,"failed");assert.deepEqual(r.tasks[0].contractEvidence?.missing,["direct send to b"]);
 }finally{await f.cleanup();}
});
test("receiving context alone does not satisfy required inbox retrieval",async()=>{
 let f:Awaited<ReturnType<typeof fixture>>;let reviews=0;
 f=await fixture({execute:async c=>{if(c.task.id==="a")await f.engine.send(c.runId,"a","b","evidence","sent",1);else assert.equal(c.messages.length,1);return {text:"done",channel:"submit"};},review:async()=>{reviews++;return {approved:true,reason:"ok"};}});
 try{const p=await f.engine.plan("inbox",plan);const r=await f.engine.run(p.id);assert.equal(r.status,"failed");assert.equal(reviews,0);assert.deepEqual(r.tasks[1].contractEvidence?.missing,["inbox retrieval from a"]);}finally{await f.cleanup();}
});
test("unresponsive wait hits deadline, requests interrupt, does not retry or accept late submission",async()=>{
 let calls=0,interrupts=0;const api:SessionApi={create:async()=>({id:`session-${++calls}`}),switchAgent:async()=>{},update:async()=>{},prompt:async()=>{},wait:async()=>new Promise(()=>{}),context:async()=>[],interrupt:async()=>{interrupts++;}};
 const adapter=new OpenCodeAdapter(api,undefined,25);const f=await fixture(adapter);
 try{const p=await f.engine.plan("timeout",[{id:"a",title:"A",instruction:"wait",review:false,maxAttempts:3}]);const r=await f.engine.run(p.id);assert.equal(r.status,"failed");assert.equal(calls,1);assert.equal(interrupts,1);assert.match(r.tasks[0].error??"",/deadline exceeded/);assert.throws(()=>adapter.submit("session-1","late"));}finally{await f.cleanup();}
});
test("external cancellation releases unresponsive wait and invalidates deliverable",async()=>{
 let started!:()=>void; const ready=new Promise<void>(r=>{started=r;});let interrupts=0;
 const api:SessionApi={create:async()=>({id:"a"}),switchAgent:async()=>{},update:async()=>{},prompt:async()=>{},wait:async()=>{started();return new Promise(()=>{});},context:async()=>[],interrupt:async()=>{interrupts++;}};
 const adapter=new OpenCodeAdapter(api);const f=await fixture(adapter);const controller=new AbortController();
 try{const p=await f.engine.plan("cancel",[{id:"a",title:"A",instruction:"wait",review:false,maxAttempts:2}]);const promise=f.engine.run(p.id,controller.signal);await ready;controller.abort();const r=await promise;assert.equal(r.status,"planned");assert.equal(interrupts,1);assert.throws(()=>adapter.submit("a","late"));}finally{await f.cleanup();}
});
