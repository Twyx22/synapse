import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/core/store.ts";
import { Synapse } from "../src/core/orchestrator.ts";
import { DiagnosticLogger } from "../src/core/diagnostics.ts";
import { inspectRun, availableRuns, renderMonitor } from "../src/core/monitor.ts";
import { registerTools, type ToolDef } from "../src/opencode/tools.ts";
import { OpenCodeAdapter, type SessionApi } from "../src/opencode/adapter.ts";
import { EvolutionCouncil, EvolutionStore } from "../src/core/evolution.ts";
import { runCLI } from "../src/cli.ts";
import type { AgentContext } from "../src/core/types.ts";
const specs=[{id:"a",title:"A",instruction:"PRIVATE_PROMPT",review:false},{id:"b",title:"B",instruction:"B",review:false}];
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"synapse-monitor-"));
  const logger=new DiagnosticLogger(join(dir,"diagnostics"));
  const store=new FileStore(dir,logger);
  const engine=new Synapse(store,{execute:async()=>({text:"PRIVATE_RESULT"})});
  const run=await engine.plan("PRIVATE_OBJECTIVE",specs);
  return {dir,logger,store,engine,run,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
test("late direct message flagged, explicit inbox retrieval persisted idempotently, old read API remains read-only",async()=>{
  const f=await fixture(); try {
    await f.store.update(f.run.id,r=>{r.tasks[1].status="completed";});
    const msg=await f.engine.send(f.run.id,"a","b","evidence","PRIVATE_MESSAGE");
    assert.equal(msg.recipientStatusAtSend,"completed");
    await f.engine.inbox(f.run.id,"b");
    assert.equal((await f.engine.get(f.run.id)).messages[0].fetchedBy,undefined);
    await f.engine.fetchInbox(f.run.id,"b"); await f.engine.fetchInbox(f.run.id,"b");
    const run=await f.engine.get(f.run.id);
    assert.ok(run.messages[0].fetchedBy?.b);
    assert.equal(run.events.filter(e=>e.type==="team.message_fetched").length,1);
    assert.equal(run.events.filter(e=>e.type==="team.message_late").length,1);
    await f.logger.flush();
    const view=await inspectRun(f.dir,f.run.id);
    assert.equal(view.metrics.lateMessages,1); assert.equal(view.metrics.explicitInboxFetches,1);
    assert.doesNotMatch(JSON.stringify(view),/PRIVATE_/);
  } finally {await f.logger.flush();await f.cleanup();}
});
test("profile preserves separate worker/review sessions and flags absent recent events without claiming model activity",async()=>{
  const f=await fixture();try {
    await f.store.update(f.run.id,r=>{r.tasks[0].status="review";r.tasks[0].startedAt=new Date().toISOString();});
    const fields={runId:f.run.id,taskId:"a"};
    await f.logger.log("info","plugin.setup.completed",{version:"0.6.0"});
    await f.logger.log("info","agent.execute.completed",{...fields,sessionId:"worker",durationMs:150});
    await f.logger.log("info","agent.review.completed",{...fields,sessionId:"reviewer1",durationMs:900});
    await f.logger.log("info","agent.wait.started",{...fields,sessionId:"reviewer2",role:"review"});
    const view=await inspectRun(f.dir,f.run.id,Date.now()+60_000);
    assert.equal(view.observedVersion,"0.6.0"); assert.equal(view.metrics.workerMs,150); assert.equal(view.metrics.reviewMs,900);
    assert.equal(view.sessions.length,3); assert.match(view.tasks[0].warning??"",/possible stall/);
    assert.match(renderMonitor(view),/not model activity/);
  }finally{await f.cleanup();}
});
test("monitor skips malformed snapshots, works with old messages, and --once does not write state",async()=>{
  const f=await fixture();try {
    await f.store.update(f.run.id,r=>{r.messages.push({id:"old",at:r.createdAt,runId:r.id,from:"a",to:"b",type:"note",body:"PRIVATE_MESSAGE"});});
    await writeFile(join(f.dir,"run_00000000-0000-0000-0000-000000000000.json"),"{");
    await f.logger.flush();
    assert.equal((await availableRuns(f.dir)).length,1);
    assert.equal((await inspectRun(f.dir,f.run.id)).metrics.unknownDeliveryStatus,1);
    const before=await readdir(f.dir);
    assert.equal(await runCLI(["monitor","--data-dir",f.dir,"--once"]),0);
    assert.deepEqual(await readdir(f.dir),before);
  }finally{await f.cleanup();}
});
test("late delivery yields a bounded advisory evolution proposal without model calls",async()=>{
  const f=await fixture();try {
    await f.store.update(f.run.id,r=>{r.tasks[1].status="completed";});
    await f.engine.send(f.run.id,"a","b","note","PRIVATE_MESSAGE");
    await f.store.update(f.run.id,r=>{r.status="completed";});
    const council=new EvolutionCouncil(new EvolutionStore(join(f.dir,"evolution")),{execute:async()=>{throw Error("No model calls allowed");}});
    const ideas=await council.scan(await f.engine.get(f.run.id));
    assert.ok(ideas.some(i=>i.kind==="late_delivery"));
    assert.deepEqual(await council.scan(await f.engine.get(f.run.id)),[]);
  }finally{await f.logger.flush();await f.cleanup();}
});
test("runtime version and profile tools, profile restricted to coordinator",async()=>{
  const f=await fixture();try {
    const defs=new Map<string,ToolDef>();
    await registerTools({transform:async fn=>fn({namespace:()=>{},add:def=>{defs.set(def.name,def);}})},f.engine,undefined,undefined,id=>id==="worker");
    const ctx={sessionID:"coordinator",signal:new AbortController().signal};
    assert.equal(JSON.parse((await defs.get("version")!.execute({},ctx)).content).version,"1.0.0");
    assert.equal(JSON.parse((await defs.get("profile")!.execute({runId:f.run.id},ctx)).content).runId,f.run.id);
    await assert.rejects(defs.get("profile")!.execute({runId:f.run.id},{...ctx,sessionID:"worker"}));
  }finally{await f.logger.flush();await f.cleanup();}
});
test("typed review channel and API timing explicitly recorded, no raw prompt logged",async()=>{
  const f=await fixture();try {
    let adapter:OpenCodeAdapter;
    const api:SessionApi={create:async()=>({id:"review"}),switchAgent:async()=>{},update:async()=>{},
      prompt:async()=>{adapter.submitReview("review",true,"PRIVATE_VERDICT");},wait:async()=>{},context:async()=>[],interrupt:async()=>{}};
    adapter=new OpenCodeAdapter(api,f.logger);
    const context:AgentContext={runId:f.run.id,objective:"PRIVATE_OBJECTIVE",task:f.run.tasks[0],dependencies:[],messages:[],signal:new AbortController().signal};
    assert.equal((await adapter.review({...context,result:"PRIVATE_RESULT"})).approved,true);
    await f.logger.flush(); const log=await f.logger.recent();
    assert.match(log,/"channel":"submit_review"/); assert.match(log,/agent.prompt.completed/);assert.match(log,/agent.wait.completed/);assert.doesNotMatch(log,/PRIVATE_/);
  }finally{await f.cleanup();}
});
