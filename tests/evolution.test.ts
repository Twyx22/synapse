import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/core/store.ts";
import { Synapse } from "../src/core/orchestrator.ts";
import { EvolutionCouncil, EvolutionStore } from "../src/core/evolution.ts";
import type { AgentAdapter } from "../src/core/types.ts";

async function fixture(adapter: AgentAdapter) {
  const dir = await mkdtemp(join(tmpdir(), "synapse-evolution-"));
  const engine = new Synapse(new FileStore(dir), adapter);
  const evolution = new EvolutionCouncil(new EvolutionStore(join(dir, "evolution")), adapter);
  engine.onRunFinished(run => evolution.onRunFinished(run));
  return { engine, evolution, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("completed run autonomously opens an evidence-linked improvement idea, without model calls", async () => {
  let calls = 0;
  const f = await fixture({ execute: async () => { calls++; return { text: "done" }; } });
  try {
    const r = await f.engine.plan("Investigate", [{ id: "a", title: "Analyze", instruction: "Analyze", review: false }]);
    assert.equal((await f.engine.run(r.id)).status, "completed");
    const ideas = await f.evolution.store.list();
    assert.equal(ideas.length, 1);
    assert.equal(ideas[0].kind, "verification");
    assert.match(ideas[0].evidence.join("\n"), /without independent reviews/);
    assert.equal(ideas[0].status, "candidate");
    assert.equal(calls, 1, "auto-scanning must not trigger extra LLM calls");
    assert.deepEqual(await f.evolution.scan(await f.engine.get(r.id)), [], "same issue should not be duplicated");
  } finally { await f.cleanup(); }
});

test("council specialists critique and counter-propose in two rounds, without changing code", async () => {
  const seen: string[] = [];
  const f = await fixture({ execute: async ctx => {
    seen.push(`${ctx.task.role}:${ctx.task.id}`);
    if (ctx.task.id === "a") return { text: "done" };
    return { text: JSON.stringify({
      stance: "support", reason: `${ctx.task.role}: benchmark needed`,
      alternative: `Measure comparative behavior for ${ctx.task.role}`,
      tests: ["A/B quality test"],
    }) };
  } });
  try {
    const r = await f.engine.plan("Assess", [{ id: "a", title: "A", instruction: "A", review: false }]);
    await f.engine.run(r.id);
    const idea = (await f.evolution.store.list())[0];
    const result = await f.evolution.deliberate(idea.id, 2);
    assert.equal(result.status, "ready_for_experiment");
    assert.equal(result.roundsCompleted, 2);
    assert.equal(result.opinions.length, 6);
    assert.equal(result.revisionHistory.length, 2);
    assert.match(result.plan, /Council alternatives/);
    assert.match(result.finalReason ?? "", /no code changes authorized/);
    assert.equal(seen.length, 7);
    const disk = await f.evolution.store.read(idea.id);
    assert.equal(disk.status, "ready_for_experiment");
    assert.equal((await f.evolution.deliberate(idea.id, 2)).opinions.length, 6, "finished proposal is idempotent");
  } finally { await f.cleanup(); }
});

test("strong dissent and malformed responses cannot approve an experiment", async () => {
  const f = await fixture({ execute: async ctx => {
    if (ctx.task.id === "a") return { text: "done" };
    if (ctx.task.role === "skeptical-reviewer") return { text: '{"stance":"block","reason":"unmeasured","alternative":"","tests":[]}' };
    if (ctx.task.role === "reliability-engineer") return { text: "this is not JSON" };
    return { text: '{"stance":"support","reason":"plausible","alternative":"","tests":[]}' };
  } });
  try {
    const run = await f.engine.plan("Audit", [{ id: "a", title: "A", instruction: "A", review: false }]);
    await f.engine.run(run.id);
    const idea = (await f.evolution.store.list())[0];
    const result = await f.evolution.deliberate(idea.id, 1);
    assert.equal(result.status, "needs_evidence");
    assert.ok(result.opinions.some(o => o.stance === "abstain"));
    assert.ok(result.opinions.some(o => o.stance === "block"));
  } finally { await f.cleanup(); }
});

test("explicit automatic council opt-in uses bounded number of sessions", async () => {
  let councilCalls = 0;
  const f = await fixture({ execute: async ctx => {
    if (ctx.task.id === "a") return { text: "done" };
    councilCalls++;
    return { text: '{"stance":"challenge","reason":"test needed","alternative":"compare baselines","tests":["A/B"]}' };
  } });
  try {
    const defaults = await f.evolution.store.getConfig();
    assert.equal(defaults.autoCouncil, false);
    await assert.rejects(f.evolution.store.setConfig({ rounds: 3 as 1 }), /Invalid council limits/);
    await f.evolution.store.setConfig({ autoCouncil: true, maxCouncilsPerRun: 1, rounds: 1 });
    const run = await f.engine.plan("Audit", [{ id: "a", title: "A", instruction: "A", review: false }]);
    await f.engine.run(run.id);
    assert.equal(councilCalls, 3, "one idea / one round / three reviewers maximum");
    assert.equal((await f.evolution.store.list())[0].roundsCompleted, 1);
    assert.equal((await f.evolution.store.getConfig()).autoCouncil, true);
  } finally { await f.cleanup(); }
});

test("failed run creates recovery hypothesis and persists failure evidence", async () => {
  const f = await fixture({ execute: async ctx => {
    if (ctx.task.id === "a") throw new Error("network unavailable");
    return { text: "done" };
  } });
  try {
    const run = await f.engine.plan("Recover", [{ id: "a", title: "A", instruction: "A", review: false, maxAttempts: 1 }]);
    assert.equal((await f.engine.run(run.id)).status, "failed");
    const ideas = await f.evolution.store.list();
    assert.ok(ideas.some(p => p.kind === "recovery" && p.evidence.some(e => e.includes("network unavailable"))));
  } finally { await f.cleanup(); }
});

test("simultaneous completed runs do not create duplicate open ideas of same kind", async () => {
  const f = await fixture({ execute: async () => ({ text: "done" }) });
  try {
    const r1 = await f.engine.plan("one", [{ id: "a", title: "A", instruction: "A", review: false }]);
    const r2 = await f.engine.plan("two", [{ id: "b", title: "B", instruction: "B", review: false }]);
    await Promise.all([f.engine.run(r1.id), f.engine.run(r2.id)]);
    const ideas = await f.evolution.store.list();
    assert.equal(ideas.filter(p => p.kind === "verification").length, 1);
  } finally { await f.cleanup(); }
});

test('worker improvement messages become council proposals with provenance and no model calls', async () => {
  let calls=0;
  const f=await fixture({execute:async()=>{calls++;return {text:'ok'};}});
  try {
    const r=await f.engine.plan('Observe coordination', [{id:'a',title:'A',instruction:'A',review:false}]);
    await f.engine.send(r.id,'a','coordinator','improvement','Observed redundant review; compare quality and cost with baseline');
    await assert.rejects(f.engine.send(r.id,'a','all','improvement','wrong recipient'));
    await f.engine.run(r.id);
    const proposal=(await f.evolution.store.list()).find(p=>p.kind==='team_feedback');
    assert.ok(proposal);
    assert.match(proposal.evidence[0],/a: Observed redundant review/);
    assert.equal(calls,1);
    assert.equal(proposal.status,'candidate');
    assert.equal((await f.evolution.scan(await f.engine.get(r.id))).length,0);
  } finally { await f.cleanup(); }
});
