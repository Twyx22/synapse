import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/core/store.ts";
import { Synapse } from "../src/core/orchestrator.ts";
import { validatePlan } from "../src/core/validate.ts";
import type { AgentAdapter, AgentContext } from "../src/core/types.ts";

async function fixture(adapter: AgentAdapter) {
  const dir = await mkdtemp(join(tmpdir(), "synapse-test-"));
  const store = new FileStore(dir);
  const engine = new Synapse(store, adapter);
  return { dir, store, engine, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const specs = [
  { id: "research", title: "Research", instruction: "Investigate design", review: true },
  { id: "design", title: "Design", instruction: "Provide architecture", dependsOn: ["research"], review: false },
];

test("plan validator rejects unknown deps, duplicates and cycles", () => {
  assert.throws(() => validatePlan("x", [{ id: "a", title: "A", instruction: "Do", dependsOn: ["bad"] }]));
  assert.throws(() => validatePlan("x", [{ id: "a", title: "A", instruction: "Do" }, { id: "a", title: "Again", instruction: "Do" }]));
  assert.throws(() => validatePlan("x", [{ id: "a", title: "A", instruction: "Do", dependsOn: ["b"] }, { id: "b", title: "B", instruction: "Do", dependsOn: ["a"] }]));
  assert.throws(() => validatePlan("x", [{ id: "bad id", title: "A", instruction: "Do" }]));
  assert.throws(() => validatePlan("x", [{ id: "a", title: "A", instruction: "Do" }], 100));
});

test("durable DAG execution, dependency outputs and independent review", async () => {
  const calls: string[] = [];
  const f = await fixture({
    execute: async (input: AgentContext) => {
      calls.push(`work:${input.task.id}`);
      if (input.task.id === "design") assert.match(input.dependencies[0].result, /result:research/);
      return { text: `result:${input.task.id}` };
    },
    review: async input => {
      calls.push(`review:${input.task.id}`);
      assert.equal(input.result, "result:research");
      return { approved: true, reason: "Evidence checked" };
    },
  });
  try {
    const run = await f.engine.plan("Build a system", specs, 2);
    const result = await f.engine.run(run.id);
    assert.equal(result.status, "completed");
    assert.deepEqual(calls, ["work:research", "review:research", "work:design"]);
    assert.equal(result.tasks[0].reviewResult, "Evidence checked");
    const persisted = await new FileStore(f.dir).read(run.id);
    assert.equal(persisted.tasks[1].status, "completed");
    assert.ok(persisted.events.some(x => x.type === "task.verified"));
  } finally { await f.cleanup(); }
});

test("parallel ready tasks execute in same wave", async () => {
  let inFlight = 0, peak = 0;
  const f = await fixture({ execute: async input => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 25));
    inFlight--;
    return { text: input.task.id };
  }});
  try {
    const run = await f.engine.plan("Parallel", [
      { id: "a", title: "A", instruction: "1", review: false },
      { id: "b", title: "B", instruction: "2", review: false },
      { id: "c", title: "C", instruction: "3", review: false },
    ], 2);
    assert.equal((await f.engine.run(run.id)).status, "completed");
    assert.equal(peak, 2);
  } finally { await f.cleanup(); }
});

test("failed independent review retries and blocks dependents after limit", async () => {
  let reviews = 0;
  const f = await fixture({ execute: async () => ({ text: "not proven" }), review: async () => {
    reviews++; return { approved: false, reason: "No evidence" };
  }});
  try {
    const run = await f.engine.plan("Review", specs, 1);
    const result = await f.engine.run(run.id);
    assert.equal(result.status, "failed");
    assert.equal(reviews, 2);
    assert.equal(result.tasks[0].attempts, 2);
    assert.equal(result.tasks[0].status, "failed");
    assert.equal(result.tasks[1].status, "blocked");
  } finally { await f.cleanup(); }
});

test("crash recovery resets orphaned running task", async () => {
  const f = await fixture({ execute: async () => ({ text: "done" }) });
  try {
    const run = await f.engine.plan("Recover", [{ id: "a", title: "A", instruction: "Do", review: false }]);
    await f.store.update(run.id, r => { r!.status = "running"; r!.tasks[0].status = "running"; });
    const result = await f.engine.run(run.id);
    assert.equal(result.status, "completed");
    assert.ok(result.events.some(x => x.type === "task.recovered"));
  } finally { await f.cleanup(); }
});

test("team bus delivers directed and broadcast messages with persistence", async () => {
  const f = await fixture({ execute: async x => ({ text: x.task.id }) });
  try {
    const run = await f.engine.plan("Team", [
      { id: "a", title: "A", instruction: "Analyze" },
      { id: "b", title: "B", instruction: "Assess" },
    ]);
    await f.engine.send(run.id, "a", "b", "evidence", "File API is stable");
    await f.engine.send(run.id, "b", "all", "proposal", "Use adapter");
    const inbox = await f.engine.inbox(run.id, "a");
    assert.equal(inbox.length, 2);
    assert.equal((await f.engine.inbox(run.id, "b")).length, 2);
    await assert.rejects(f.engine.send(run.id, "invalid", "all", "note", "hack"));
    assert.equal((await f.store.read(run.id)).messages.length, 2);
  } finally { await f.cleanup(); }
});

test("stop marks tasks cancelled and interrupts known sessions", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const cancelled: string[] = [];
  const f = await fixture({
    execute: async context => {
      context.onSession?.("session-a");
      entered();
      await wait;
      return { text: "late" };
    },
    cancel: async id => { cancelled.push(id); release(); },
  });
  try {
    const run = await f.engine.plan("Stop", [{ id: "a", title: "A", instruction: "Stop test", review: false }]);
    const execution = f.engine.run(run.id);
    await started;
    const stopped = await f.engine.stop(run.id);
    assert.equal(stopped.status, "cancelled");
    await execution;
    assert.deepEqual(cancelled, ["session-a"]);
    assert.equal((await f.engine.get(run.id)).tasks[0].status, "cancelled");
  } finally { await f.cleanup(); }
});

test("concurrent store mutations never lose messages", async () => {
  const f = await fixture({ execute: async () => ({ text: "ok" }) });
  try {
    const run = await f.engine.plan("Stress", [{ id: "a", title: "A", instruction: "test" }]);
    await Promise.all(Array.from({ length: 80 }, (_, i) => f.engine.send(run.id, "a", "all", "note", `msg-${i}`)));
    const messages = (await f.engine.get(run.id)).messages;
    assert.equal(messages.length, 80);
    assert.equal(new Set(messages.map(m => m.body)).size, 80);
  } finally { await f.cleanup(); }
});

test('rolling scheduler starts dependent tasks before an unrelated slow worker finishes', async () => {
  let release!: () => void;
  const slow = new Promise<void>(r => { release = r; });
  const calls: string[] = [];
  let slowFinished = false, nextBeforeSlow = false;
  const f = await fixture({ execute: async c => {
    calls.push(c.task.id);
    if (c.task.id === 'slow') { await Promise.race([slow, new Promise(r => setTimeout(r, 500))]); slowFinished = true; }
    if (c.task.id === 'next') { nextBeforeSlow = !slowFinished; release(); }
    return { text: 'ok' };
  }});
  try {
    const r = await f.engine.plan('pipeline', [
      {id:'fast',title:'fast',instruction:'fast',review:false},
      {id:'slow',title:'slow',instruction:'slow',review:false},
      {id:'next',title:'next',instruction:'next',dependsOn:['fast'],review:false},
    ], 2);
    const result = await f.engine.run(r.id, AbortSignal.timeout(2000));
    assert.equal(result.status, 'completed');
    assert.deepEqual(calls.slice(0,2).sort(), ['fast','slow']);
    assert.equal(calls[2], 'next');
    assert.equal(nextBeforeSlow, true);
  } finally { release(); await f.cleanup(); }
});

test('pre-aborted run does not launch agents and returns resumable state', async () => {
  let calls = 0;
  const f = await fixture({execute:async()=>{calls++;return {text:'ok'};}});
  try {
    const r = await f.engine.plan('cancel', [{id:'a',title:'a',instruction:'a',review:false}]);
    const controller = new AbortController(); controller.abort();
    assert.equal((await f.engine.run(r.id, controller.signal)).status, 'planned');
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});
