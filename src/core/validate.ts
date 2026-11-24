import { sessionEnvelope, assertSessionBudget } from "./lean.ts";
import { validatePatchContract } from "./contributions.ts";
import { randomUUID } from "node:crypto";
import { SynapseError, type RunRecord, type TaskRecord, type TaskSpec } from "./types.ts";

const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const stamp = () => new Date().toISOString();

export function validatePlan(objective: string, specs: TaskSpec[], concurrency = 2): TaskRecord[] {
  if (!objective.trim() || objective.length > 10_000) throw new SynapseError("Objective is empty or too long");
  if (!Array.isArray(specs) || specs.length < 1 || specs.length > 64) throw new SynapseError("Plan must have 1 to 64 tasks");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new SynapseError("Concurrency must be 1-8");
  const ids = new Set<string>();
  for (const task of specs) {
    if (!ID.test(task.id) || ids.has(task.id) || ["all", "coordinator"].includes(task.id)) throw new SynapseError(`Invalid or duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (task.timeoutSeconds !== undefined && (!Number.isInteger(task.timeoutSeconds) || task.timeoutSeconds < 10 || task.timeoutSeconds > 1800)) throw new SynapseError(`Invalid timeoutSeconds: ${task.id}`);
    if (task.contract !== undefined) {
      const c = task.contract;
      if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some(k => !["requireSubmit", "sendTo", "receiveFrom"].includes(k))) throw new SynapseError(`Invalid contract: ${task.id}`);
      if (c.requireSubmit !== undefined && typeof c.requireSubmit !== "boolean") throw new SynapseError(`Invalid requireSubmit: ${task.id}`);
      for (const peers of [c.sendTo, c.receiveFrom]) if (peers !== undefined && (!Array.isArray(peers) || peers.length > 16 || new Set(peers).size !== peers.length || peers.some(x => typeof x !== "string" || x === task.id))) throw new SynapseError(`Invalid contract peers: ${task.id}`);
    }
    if (task.verification !== undefined) {
      const v = task.verification;
      if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["kind", "expected"].includes(k)) || v.kind !== "exact" || typeof v.expected !== "string" || !v.expected.trim() || v.expected.length > 2000) throw new SynapseError("Invalid exact verification");
      if (task.patch) throw new SynapseError("Exact fixture verification is not supported for patches");
      if (task.contract?.requireSubmit !== true) throw new SynapseError("Exact verification requires explicit submission");
    }
    if (task.toolProfile !== undefined && (task.toolProfile !== "lean" || task.verification?.kind !== "exact" || task.contract?.requireSubmit !== true || task.patch)) throw new SynapseError("Lean tool profile requires an exact fixture, explicit submission and no patch");
    if (task.patch !== undefined) { validatePatchContract(task.patch); if (task.review === false) throw new SynapseError("Patch tasks require review"); }
    if (!task.title?.trim() || !task.instruction?.trim()) throw new SynapseError(`Empty title/instruction for ${task.id}`);
    if (task.instruction.length > 20_000) throw new SynapseError(`Instruction too long: ${task.id}`);
    if (task.priority !== undefined && (!Number.isInteger(task.priority) || task.priority < -100 || task.priority > 100)) throw new SynapseError(`Invalid priority: ${task.id}`);
    if (task.maxAttempts !== undefined && (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1 || task.maxAttempts > 3)) throw new SynapseError(`Invalid maxAttempts: ${task.id}`);
  }
  const dependencies = new Map(specs.map(t => [t.id, t.dependsOn ?? []]));
  for (const [id, deps] of dependencies) {
    if (new Set(deps).size !== deps.length) throw new SynapseError(`Duplicate dependency for ${id}`);
    for (const dep of deps) if (!ids.has(dep)) throw new SynapseError(`Unknown dependency ${dep} for ${id}`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function dfs(id: string) {
    if (visiting.has(id)) throw new SynapseError(`Dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of dependencies.get(id) ?? []) dfs(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) dfs(id);
  // Mandatory incoming handoffs are dependency-ordered: no waiting workers can deadlock the pool.
  const ancestors = (id: string): Set<string> => {
    const found = new Set<string>();
    const visit = (key: string) => { for (const dep of dependencies.get(key) ?? []) if (!found.has(dep)) { found.add(dep); visit(dep); } };
    visit(id); return found;
  };
  for (const task of specs) {
    for (const peer of [...(task.contract?.sendTo ?? []), ...(task.contract?.receiveFrom ?? [])]) if (!ids.has(peer)) throw new SynapseError(`Unknown contract peer ${peer}`);
    for (const sender of task.contract?.receiveFrom ?? []) {
      if (!ancestors(task.id).has(sender)) throw new SynapseError(`Required sender ${sender} must be a dependency of ${task.id}`);
      if (!specs.find(t => t.id === sender)?.contract?.sendTo?.includes(task.id)) throw new SynapseError(`Required sender ${sender} must declare sendTo ${task.id}`);
    }
  }
  return specs.map(t => ({
    id: t.id, title: t.title, instruction: t.instruction,
    role: t.role?.trim() || "engineer", dependsOn: [...(t.dependsOn ?? [])],
    priority: t.priority ?? 0, review: t.review ?? true, maxAttempts: t.maxAttempts ?? 2,
    ...(t.contract ? { contract: structuredClone(t.contract) } : {}),
    ...(t.timeoutSeconds !== undefined ? { timeoutSeconds: t.timeoutSeconds } : {}),
    ...(t.toolProfile ? { toolProfile: t.toolProfile } : {}),
    ...(t.verification ? { verification: structuredClone(t.verification) } : {}),
    ...(t.patch ? { patch: structuredClone(t.patch) } : {}),
    status: "pending", attempts: 0,
  }));
}

export function newRun(objective: string, specs: TaskSpec[], concurrency: number, sessionBudget?: number): RunRecord {
  const tasks = validatePlan(objective, specs, concurrency);
  assertSessionBudget(sessionEnvelope(tasks), sessionBudget);
  const now = stamp();
  return {
    schema: 1, id: `run_${randomUUID()}`, objective, status: "planned", createdAt: now,
    updatedAt: now, tasks, messages: [], events: [],
    options: { concurrency, maxMessages: 500, maxEvents: 1000, ...(sessionBudget !== undefined ? {sessionBudget} : {}) },
  };
}
