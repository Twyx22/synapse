import test from "node:test";
import assert from "node:assert/strict";
import { lastAssistantText, parseVerdict, OpenCodeAdapter, type SessionApi } from "../src/opencode/adapter.ts";
import { registerTools, type ToolDef } from "../src/opencode/tools.ts";
import { Synapse } from "../src/core/orchestrator.ts";
import { FileStore } from "../src/core/store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("OpenCode V2 assistant response extraction and strict reviewer parsing", () => {
  assert.equal(lastAssistantText([
    { info: { role: "user" }, parts: [{ type: "text", text: "request" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "review result" }, { type: "tool", text: "ignore" }] },
  ]), "review result");
  assert.deepEqual(parseVerdict('```json\n{"approved":true,"reason":"All checked"}\n```'), { approved: true, reason: "All checked" });
  assert.equal(parseVerdict("APPROVED").approved, false);
});

test("OpenCode adapter spawns read-only sessions, runs worker and reviewer", async () => {
  const sessions: string[] = [];
  const restrictions: unknown[] = [];
  const mock: SessionApi = {
    create: async () => ({ id: `session-${sessions.push("new")}` }),
    switchAgent: async ({ agent }) => { assert.equal(agent, "plan"); },
    update: async ({ permissions }) => { restrictions.push(permissions); },
    prompt: async () => ({}), wait: async () => ({}),
    context: async ({ sessionID }) => [{ info: { role: "assistant" }, parts: [{ type: "text", text: sessionID === "session-1" ? "worker evidence" : '{"approved":true,"reason":"reviewed"}' }] }],
    interrupt: async () => {},
  };
  const adapter = new OpenCodeAdapter(mock);
  const calls: string[] = [];
  const context = { runId: "test", objective: "build", task: { id: "a", title: "A", instruction: "Do", role: "engineer", dependsOn: [], priority: 0, review: true, maxAttempts: 2, status: "running" as const, attempts: 1 }, dependencies: [], messages: [], signal: new AbortController().signal,
    onSession: (id: string) => calls.push(id) };
  const executed = await adapter.execute(context);
  const review = await adapter.review({ ...context, result: executed.text });
  assert.equal(executed.text, "worker evidence");
  assert.equal(review.approved, true);
  assert.deepEqual(calls, ["session-1", "session-2"]);
  assert.equal(restrictions.length, 2);
});

test("tool integration registers and executes plan, status and runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synapse-tools-"));
  try {
    const engine = new Synapse(new FileStore(dir), { execute: async () => ({ text: "ok" }) });
    const definitions = new Map<string, ToolDef>();
    await registerTools({ transform: async fn => {
      fn({ namespace: () => undefined, add: item => { definitions.set(item.name, item); } });
      return undefined;
    } }, engine);
    assert.ok(definitions.has("plan"));
    assert.ok(definitions.has("message"));
    assert.equal(definitions.size, 25);
    assert.ok(definitions.has("version"));
    assert.ok(definitions.has("profile"));
    const context = { sessionID: "coordinator", signal: new AbortController().signal };
    const created = JSON.parse((await definitions.get("plan")!.execute({ objective: "Test", tasks: [{ id: "one", title: "One", instruction: "Find" }] }, context)).content);
    const status = JSON.parse((await definitions.get("status")!.execute({ runId: created.runId }, context)).content);
    assert.equal(status.status, "planned");
    const listed = JSON.parse((await definitions.get("runs")!.execute({}, context)).content);
    assert.equal(listed.length, 1);
    await assert.rejects(definitions.get("message")!.execute({ runId: created.runId, to: "all", type: "note", body: "bad" }, context));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unregistered restricted council sessions cannot invoke coordinator tools', async () => {
  const dir=await mkdtemp(join(tmpdir(),'synapse-restricted-'));
  try {
    const engine=new Synapse(new FileStore(dir),{execute:async()=>({text:'ok'})});
    const defs=new Map<string,ToolDef>();
    await registerTools({transform:async fn=>fn({namespace:()=>{},add:entry=>{defs.set(entry.name,entry)}})},engine,undefined,undefined,id=>id==='council');
    const context={sessionID:'council',signal:new AbortController().signal};
    await assert.rejects(defs.get('runs')!.execute({},context));
    await assert.rejects(defs.get('plan')!.execute({objective:'x',tasks:[]},context));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('retry prompt carries the reviewer objection and previous result', async () => {
  let captured = '';
  const mock: SessionApi = {
    create: async()=>({id:'retry'}), switchAgent:async()=>{}, update:async()=>{},
    prompt:async({text})=>{captured=text;}, wait:async()=>{}, context:async()=>[{role:'assistant',text:'revised'}], interrupt:async()=>{},
  };
  const adapter=new OpenCodeAdapter(mock);
  await adapter.execute({runId:'r',objective:'fix',task:{id:'a',title:'a',instruction:'inspect',role:'engineer',dependsOn:[],priority:0,review:true,maxAttempts:2,status:'running',attempts:2,error:'Review rejected: missing test',reviewResult:'missing test',result:'previous analysis'},dependencies:[],messages:[],signal:new AbortController().signal});
  assert.match(captured,/Attempt: 2\/2/);
  assert.match(captured,/missing test/);
  assert.match(captured,/previous analysis/);
  assert.equal(adapter.isRestricted('retry'),true);
});

test('task result pagination returns full content without silently truncating it', async () => {
  const dir=await mkdtemp(join(tmpdir(),'synapse-result-'));
  try {
    const text='0123456789'.repeat(1800);
    const engine=new Synapse(new FileStore(dir),{execute:async()=>({text})});
    const defs=new Map<string,ToolDef>();
    await registerTools({transform:async fn=>fn({namespace:()=>{},add:entry=>{defs.set(entry.name,entry)}})},engine);
    const run=await engine.plan('read result',[{id:'a',title:'a',instruction:'a',review:false}]);
    await engine.run(run.id);
    const ctx={sessionID:'coordinator',signal:new AbortController().signal};
    const read=async(offset:number)=>JSON.parse((await defs.get('result')!.execute({runId:run.id,taskId:'a',offset,limit:12000},ctx)).content);
    const first=await read(0), second=await read(first.nextOffset);
    assert.equal(first.result+second.result,text);
    assert.equal(second.nextOffset,null);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('V2 context assistant content is recognized, user and tool content never substitutes', () => {
  assert.equal(lastAssistantText([
    {type:'user',text:'private prompt'},
    {type:'assistant',content:[{type:'reasoning',text:'ignore'},{type:'text',text:'actual deliverable'},{type:'tool',text:'ignore'}]},
    {type:'idle',text:'not a deliverable'},
  ]), 'actual deliverable');
  assert.equal(lastAssistantText([{type:'user',text:'not a result'},{type:'idle',text:'not a result'}]), '');
  assert.equal(lastAssistantText([{type:'assistant',text:'flat assistant'}]), 'flat assistant');
});

test('explicit submit works when V2 context omits assistant messages, including reviewer', async () => {
  let count = 0;
  let adapter: OpenCodeAdapter;
  const api: SessionApi = {
    create: async()=>({id:`s${++count}`}), switchAgent:async()=>{}, update:async()=>{},
    prompt:async({sessionID,text})=>{
      assert.match(text,/synapse_submit/);
      assert.throws(()=>adapter.submit('coordinator','forged'));
      assert.throws(()=>adapter.submit(sessionID,'   '));
      const value = sessionID === 's1' ? 'final worker evidence' : '{"approved":true,"reason":"verified"}';
      assert.equal(adapter.submit(sessionID,value).accepted,true);
      assert.equal(adapter.submit(sessionID,value).accepted,true);
      assert.throws(()=>adapter.submit(sessionID,'different'));
    }, wait:async()=>{}, context:async()=>{throw new Error('context must not be required');}, interrupt:async()=>{},
  };
  adapter = new OpenCodeAdapter(api);
  const context = {runId:'r',objective:'test',task:{id:'a',title:'a',instruction:'inspect',role:'engineer',dependsOn:[],priority:0,review:true,maxAttempts:1,status:'running' as const,attempts:1},dependencies:[],messages:[],signal:new AbortController().signal};
  const result = await adapter.execute(context);
  assert.equal(result.text,'final worker evidence');
  assert.throws(()=>adapter.submit('s1','late'));
  assert.equal((await adapter.review({...context,result:result.text})).approved,true);
});

test('submit tool uses caller identity, not a model-supplied session identifier', async () => {
  const dir=await mkdtemp(join(tmpdir(),'synapse-submit-'));
  try {
    const engine=new Synapse(new FileStore(dir),{execute:async()=>({text:'ok'})});
    const defs=new Map<string,ToolDef>();
    await registerTools({transform:async fn=>fn({namespace:()=>{},add:entry=>{defs.set(entry.name,entry)}})},engine,undefined,undefined,()=>false,(id,text)=>{assert.equal(id,'actual');assert.equal(text,'hello');return {accepted:true};});
    const output=await defs.get('submit')!.execute({text:'hello',sessionID:'forged'},{sessionID:'actual',signal:new AbortController().signal});
    assert.equal(JSON.parse(output.content).accepted,true);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('review submission rejects free prose without locking the slot; typed verdict works only for active reviewer', async () => {
  let adapter: OpenCodeAdapter;
  const api: SessionApi = {
    create: async()=>({id:'review-session'}), switchAgent:async()=>{}, update:async()=>{},
    prompt:async({sessionID,text})=>{
      assert.match(text,/synapse_submit_review/);
      assert.throws(()=>adapter.submit(sessionID,'The work looks correct. Approved.'));
      assert.throws(()=>adapter.submitReview('coordinator',true,'forged'));
      assert.throws(()=>adapter.submitReview(sessionID,'true','invalid type'));
      assert.throws(()=>adapter.submitReview(sessionID,true,'  '));
      assert.equal(adapter.submitReview(sessionID,false,'Missing evidence').accepted,true);
      assert.throws(()=>adapter.submitReview(sessionID,true,'Changed verdict'));
    }, wait:async()=>{}, context:async()=>{throw new Error('not needed');}, interrupt:async()=>{},
  };
  adapter=new OpenCodeAdapter(api);
  const context={runId:'r',objective:'test',task:{id:'a',title:'a',instruction:'inspect',role:'engineer',dependsOn:[],priority:0,review:true,maxAttempts:1,status:'review' as const,attempts:1},dependencies:[],messages:[],signal:new AbortController().signal};
  const result=await adapter.review({...context,result:'evidence'});
  assert.equal(result.approved,false);
  assert.equal(result.reason,'Missing evidence');
  assert.equal(result.protocolError,undefined);
  assert.throws(()=>adapter.submitReview('review-session',true,'late'));
});

test('malformed review retries only reviewer, retaining author result and preserving fail-closed semantics', async () => {
  for (const eventualSuccess of [true,false]) {
    const dir=await mkdtemp(join(tmpdir(),'synapse-review-protocol-'));
    try {
      let adapter: OpenCodeAdapter; let workerCalls=0, reviewCalls=0, sessionCount=0;
      const api: SessionApi = {
        create:async()=>({id:`session-${++sessionCount}`}), switchAgent:async()=>{}, update:async()=>{},
        prompt:async({sessionID,text})=>{
          if(text.startsWith('You are a Synapse specialist')) {
            workerCalls++;
            assert.throws(()=>adapter.submitReview(sessionID,true,'worker cannot approve'));
            adapter.submit(sessionID,'original evidence');
          } else {
            reviewCalls++;
            assert.match(text,/original evidence/);
            if(eventualSuccess && reviewCalls===2) adapter.submitReview(sessionID,true,'Verified evidence');
          }
        },wait:async()=>{},context:async()=>[{role:'assistant',text:'Looks good, but this is not a verdict object.'}],interrupt:async()=>{},
      };
      adapter=new OpenCodeAdapter(api);
      const engine=new Synapse(new FileStore(dir),adapter);
      const run=await engine.plan('Review',[{id:'a',title:'A',instruction:'inspect',review:true,maxAttempts:3}]);
      const result=await engine.run(run.id);
      assert.equal(workerCalls,1);
      assert.equal(reviewCalls,2);
      assert.equal(result.tasks[0].attempts,1);
      assert.equal(result.tasks[0].result,'original evidence');
      assert.equal(result.status,eventualSuccess?'completed':'failed');
      if(!eventualSuccess) {
        assert.match(result.tasks[0].error!,/Review protocol failure/);
        assert.ok(result.events.some(e=>e.type==='task.review_protocol_error'));
        assert.ok(!result.events.some(e=>e.type==='task.verified'));
      }
    } finally {await rm(dir,{recursive:true,force:true});}
  }
});

test('structured review tool binds caller identity and declares boolean verdict', async () => {
  const dir=await mkdtemp(join(tmpdir(),'synapse-review-tool-'));
  try {
    const engine=new Synapse(new FileStore(dir),{execute:async()=>({text:'ok'})});
    const defs=new Map<string,ToolDef>();
    await registerTools({transform:async fn=>fn({namespace:()=>{},add:entry=>{defs.set(entry.name,entry)}})},engine,undefined,undefined,()=>false,undefined,(id,approved,reason)=>{
      assert.equal(id,'real-reviewer'); assert.equal(approved,false); assert.equal(reason,'missing proof');return {accepted:true};
    });
    const def=defs.get('submit_review')!;
    assert.deepEqual(def.input.required,['approved','reason']);
    assert.equal(JSON.parse((await def.execute({approved:false,reason:'missing proof',sessionID:'forged'},{sessionID:'real-reviewer',signal:new AbortController().signal})).content).accepted,true);
  } finally {await rm(dir,{recursive:true,force:true});}
});
