/** Try Synapse's collaboration/runtime logic without installing OpenCode. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../src/core/store.ts";
import { Synapse } from "../src/core/orchestrator.ts";
import type { AgentAdapter } from "../src/core/types.ts";

const directory = await mkdtemp(join(tmpdir(), "synapse-demo-"));
let engine: Synapse;
const adapter: AgentAdapter = {
  execute: async context => {
    context.onSession?.(`mock:${context.task.id}`);
    if (context.task.id === "architecture") {
      await engine.send(context.runId, "architecture", "all", "evidence", "Event bus should be durable and append-only at the logical level");
      return { text: "Architecture: durable run snapshots and event IDs", sessionID: "mock:architecture" };
    }
    if (context.task.id === "security") {
      await engine.send(context.runId, "security", "all", "challenge", "Avoid implicit cross-run permissions");
      return { text: "Security: explicit session-to-run identity binding", sessionID: "mock:security" };
    }
    const discoveries = (await engine.inbox(context.runId, context.task.id)).map(m => m.body).join(" | ");
    return { text: `Integration: ${context.dependencies.map(d => d.result).join(" + ")}; team notes: ${discoveries}` };
  },
  review: async context => ({ approved: context.result.length > 10, reason: "Mock reviewer accepted nonempty evidence (demo only)" }),
  cancel: async () => undefined,
};
engine = new Synapse(new FileStore(directory), adapter);
try {
  const planned = await engine.plan("Build a collaborative software design", [
    { id: "architecture", title: "Architecture", instruction: "Design the durable state store" },
    { id: "security", title: "Security", instruction: "Design run isolation" },
    { id: "integration", title: "Integration", instruction: "Combine both results", dependsOn: ["architecture", "security"] },
  ], 2);
  const run = await engine.run(planned.id);
  console.log(JSON.stringify({ status: run.status, tasks: run.tasks.map(t => ({ id: t.id, status: t.status, result: t.result })), messages: run.messages }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
