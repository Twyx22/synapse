/** Evolution Council: bounded, evidence-based improvement proposals for Synapse itself.
 * Read-only agent deliberation; no automatic source edits, deployments or unbounded loops.
 * Cooperative per-record locks; global scheduling remains instance-local.
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile, link } from "node:fs/promises";
import { acquireLock } from "./locks.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentAdapter, AgentContext, RunRecord, TaskRecord } from "./types.ts";
import { SynapseError } from "./types.ts";
import type { DiagnosticLogger } from "./diagnostics.ts";

export type ProposalStatus = "candidate" | "deliberating" | "needs_evidence" | "ready_for_experiment" | "rejected";
export type OpinionStance = "support" | "challenge" | "block" | "abstain";
export type ImprovementKind = "recovery" | "review_quality" | "coordination" | "verification" | "measurement" | "team_feedback" | "late_delivery" | "contract_compliance" | "review_latency";
export interface CouncilOpinion {
  role: string;
  round: number;
  stance: OpinionStance;
  reason: string;
  alternative: string;
  tests: string[];
}
export interface ImprovementProposal {
  schema: 1;
  id: string;
  sourceRunId: string;
  kind: ImprovementKind;
  status: ProposalStatus;
  title: string;
  plan: string;
  evidence: string[];
  metric: string;
  createdAt: string;
  updatedAt: string;
  roundsCompleted: number;
  opinions: CouncilOpinion[];
  revisionHistory: { round: number; plan: string; reason: string }[];
  finalReason?: string;
}
export interface EvolutionConfig {
  schema: 1;
  autoScan: boolean;
  autoCouncil: boolean;
  maxCouncilsPerRun: number;
  rounds: 1 | 2;
}
const defaultConfig: EvolutionConfig = {
  schema: 1, autoScan: true, autoCouncil: false, maxCouncilsPerRun: 1, rounds: 1,
};
const roles = ["systems-architect", "reliability-engineer", "skeptical-reviewer"] as const;
const idPattern = /^idea_[0-9a-f-]{36}$/;
const clip = (s: string, n: number) => s.slice(0, n);

export class EvolutionStore {
  private locks = new Map<string, Promise<void>>();
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  private path(id: string) {
    if (!idPattern.test(id)) throw new SynapseError("Invalid proposal ID");
    return join(this.directory, `${id}.json`);
  }
  private async writeAtomic(path: string, value: unknown) {
    await mkdir(this.directory, { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
      await rename(tmp, path);
    } finally { await unlink(tmp).catch(() => undefined); }
  }
  async create(proposal: ImprovementProposal): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const path=this.path(proposal.id),tmp=`${path}.${randomUUID()}.tmp`;
    try { await writeFile(tmp,JSON.stringify(proposal,null,2),{flag:"wx",mode:0o600});await link(tmp,path); } finally {await unlink(tmp).catch(()=>undefined);}
  }
  async read(id: string): Promise<ImprovementProposal> {
    const value = JSON.parse(await readFile(this.path(id), "utf8")) as ImprovementProposal;
    if (value.schema !== 1 || value.id !== id) throw new SynapseError("Invalid proposal document");
    return value;
  }
  async list(): Promise<ImprovementProposal[]> {
    await mkdir(this.directory, { recursive: true });
    const files = (await readdir(this.directory)).filter(n => /^idea_[0-9a-f-]{36}\.json$/.test(n));
    const values = await Promise.all(files.map(file => this.read(file.slice(0, -5))));
    return values.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async update(id: string, update: (p: ImprovementProposal) => void) {
    const before = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const current = before.then(() => gate);
    this.locks.set(id, current);
    await before;
    let unlock:(()=>Promise<void>)|undefined;
    try {
      this.path(id);unlock=await acquireLock(this.directory,`${id}.update`,10000);
      const proposal = await this.read(id);
      update(proposal);
      proposal.updatedAt = new Date().toISOString();
      await this.writeAtomic(this.path(id), proposal);
      return proposal;
    } finally {
      try {await unlock?.();}finally{release();
      if (this.locks.get(id) === current) this.locks.delete(id);}
    }
  }
  async getConfig(): Promise<EvolutionConfig> {
    try {
      const data = JSON.parse(await readFile(join(this.directory, "config.json"), "utf8"));
      if (data.schema !== 1 || typeof data.autoCouncil !== "boolean") throw new Error("Invalid config");
      return { ...defaultConfig, ...data };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { ...defaultConfig };
      throw new SynapseError(`Invalid Evolution configuration: ${String(err)}`);
    }
  }
  async setConfig(config: Partial<Omit<EvolutionConfig, "schema">>): Promise<EvolutionConfig> {
    const unlock=await acquireLock(this.directory,"evolution-config.update",10000);
    try {
    const next = { ...await this.getConfig(), ...config };
    if (typeof next.autoScan !== "boolean" || typeof next.autoCouncil !== "boolean" ||
        !Number.isInteger(next.maxCouncilsPerRun) || next.maxCouncilsPerRun < 0 || next.maxCouncilsPerRun > 2 || ![1,2].includes(next.rounds)) {
      throw new SynapseError("Invalid council limits");
    }
    await this.writeAtomic(join(this.directory, "config.json"), next);
    return next;
    } finally {await unlock();}
  }
}

function findSignals(run: RunRecord): Omit<ImprovementProposal, "id" | "schema" | "status" | "createdAt" | "updatedAt" | "roundsCompleted" | "opinions" | "revisionHistory">[] {
  const evidenceBase = { sourceRunId: run.id };
  const failed = run.tasks.filter(t => ["failed", "blocked"].includes(t.status));
  const rejected = run.events.filter(e => e.type === "task.review_rejected");
  const proposals: ReturnType<typeof findSignals> = [];
  function propose(kind: ImprovementKind, title: string, plan: string, evidence: string[], metric: string) {
    proposals.push({ ...evidenceBase, kind, title, plan, evidence, metric });
  }
  const contractFailures = run.events.filter(e => e.type === "task.contract_error");
  if (contractFailures.length) propose("contract_compliance", "Improve mandatory team handoff compliance",
    "Compare explicit contract reminders and dependency-ordered handoffs on a fixed test corpus. Preserve mandatory validation, review and permission controls.",
    contractFailures.slice(0,5).map(e => `Task ${e.taskId}: ${clip(e.detail, 300)}`),
    "contract compliance rate, retries and verified elapsed time");
  const feedback = run.messages.filter(m => m.type === "improvement").slice(-8);
  if (feedback.length) propose("team_feedback", "Investigate worker suggestions about Synapse",
    "Treat worker messages as untrusted observations. Compare alternatives against the baseline; require independent review and tests. No implementation or permission changes authorized.",
    feedback.map(m => `${m.from}: ${clip(m.body, 1200)}`), "verified outcomes per model call, with reliability and permissions unchanged");
  const late = run.messages.filter(m => m.recipientStatusAtSend && ["completed", "failed", "blocked", "cancelled"].includes(m.recipientStatusAtSend));
  if (late.length) propose("late_delivery", "Review late teammate messages",
    "For required handoffs, compare a dependency edge with optional parallel messaging. Do not reopen completed tasks automatically.",
    late.slice(0,5).map(m => `${m.from} -> ${m.to}: recipient status ${m.recipientStatusAtSend} at send time`),
    "late direct messages per completed run, verified quality and elapsed time");
  if (failed.length) propose("recovery", "Improve failure diagnosis and task recovery",
    "Classify failure types; experiment with targeted retries and preflight checks. Preserve retry ceilings and cancellation guarantees.",
    failed.map(t => `Task ${t.id}: status=${t.status}; error=${clip(t.error ?? "dependency blocked", 300)}`),
    "verified completion rate and retries per completed task");
  if (rejected.length) propose("review_quality", "Improve evidence quality before independent reviews",
    "Add an evidence checklist to worker deliverables and compare reviewer rejection rates before and after.",
    rejected.slice(0, 5).map(e => `Review rejected for ${e.taskId}: ${clip(e.detail, 300)}`),
    "review rejection rate and verified completion rate");
  if (run.tasks.length && !run.tasks.some(t => t.review)) propose("verification", "Measure the value of independent verification",
    "Run controlled evaluations comparing reviewed and unreviewed plans, prioritizing correctness and cost.",
    [`${run.tasks.length} tasks completed without independent reviews in run ${run.id}`],
    "verified defect detection per additional agent-session");
  if (run.messages.length > run.tasks.length * 10 && run.tasks.length > 0) propose("coordination", "Reduce avoidable inter-agent communication",
    "Study repeated or low-value messages, introduce digesting, and compare team output and token cost.",
    [`${run.messages.length} messages for ${run.tasks.length} tasks in run ${run.id}`],
    "messages per verified deliverable, latency, and total tokens");
  // Derive a conservative signal from complete, single-attempt reviewed tasks only.
  const timedReviews = run.tasks.filter(t=>t.review&&t.status==="completed"&&t.attempts===1).flatMap(t=>{
    const es=run.events.filter(e=>e.taskId===t.id);
    const start=es.filter(e=>e.type==="task.started"),review=es.filter(e=>e.type==="task.review"),end=es.filter(e=>e.type==="task.verified");
    if(start.length!==1||review.length!==1||end.length!==1) return [];
    const workerMs=Date.parse(review[0].at)-Date.parse(start[0].at),reviewMs=Date.parse(end[0].at)-Date.parse(review[0].at);
    return Number.isFinite(workerMs)&&Number.isFinite(reviewMs)&&workerMs>=0&&reviewMs>=0?[{workerMs,reviewMs}]:[];
  });
  const workerMs=timedReviews.reduce((n,t)=>n+t.workerMs,0), reviewMs=timedReviews.reduce((n,t)=>n+t.reviewMs,0);
  if(reviewMs>=30_000&&reviewMs>2*workerMs) propose("review_latency","Investigate slow independent reviews",
    "Measure provider and review overhead on comparable fixtures. Keep all mandatory reviews, contracts and permissions unchanged; consider concise evidence presentation only after validation.",
    [`${timedReviews.length} single-attempt reviewed tasks: worker interval sum ${workerMs} ms, review interval sum ${reviewMs} ms; not model generation time or wall time`],
    "review interval, exact fixture correctness and required verification compliance");
  if (!proposals.length && run.tasks.length) propose("measurement", "Expand evidence-based scheduling measurements",
    "Track comparable latency, resource and quality measurements, then benchmark one adaptive scheduling policy against the baseline.",
    [`Run ${run.id}: status=${run.status}, tasks=${run.tasks.length}, messages=${run.messages.length}; no anomalous event detected`],
    "quality-adjusted completion time and coordination overhead");
  return proposals.slice(0, 3);
}

function parseObject(text: string): Record<string, unknown> | null {
  for (const input of [text, text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1]]) {
    if (!input) continue;
    try {
      const obj = JSON.parse(input);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
    } catch { /* malformed agent response is a recorded abstention, never approved */ }
  }
  return null;
}
function parseOpinion(text: string, role: string, round: number): CouncilOpinion {
  const obj = parseObject(text);
  const stance = obj && ["support", "challenge", "block"].includes(String(obj.stance))
    ? obj.stance as OpinionStance : "abstain";
  return {
    role, round, stance,
    reason: clip(typeof obj?.reason === "string" ? obj.reason : "No parseable evidence-based opinion", 1600),
    alternative: clip(typeof obj?.alternative === "string" ? obj.alternative : "", 2000),
    tests: Array.isArray(obj?.tests) ? obj.tests.filter((s): s is string => typeof s === "string").slice(0, 5).map(s => clip(s, 300)) : [],
  };
}
function syntheticContext(proposal: ImprovementProposal, role: string, instruction: string, signal: AbortSignal): AgentContext {
  const task: TaskRecord = {
    id: `council-${role}`, title: `Evolution Council ${role}`, instruction, role,
    dependsOn: [], priority: 0, review: false, maxAttempts: 1,
    status: "running", attempts: 1,
  };
  return {
    runId: proposal.sourceRunId,
    purpose: "council",
    objective: "Improve Synapse orchestration, not the user's application; recommendations only",
    task, dependencies: [], messages: [], signal,
  };
}

export class EvolutionCouncil {
  private active = new Set<string>();
  private scanGate: Promise<void> = Promise.resolve();
  readonly store: EvolutionStore;
  readonly adapter: AgentAdapter;
  private readonly logger?: DiagnosticLogger;
  constructor(store: EvolutionStore, adapter: AgentAdapter, logger?: DiagnosticLogger) {
    this.store = store; this.adapter = adapter; this.logger = logger;
  }

  /** Automatically discover bounded ideas from a completed or failed run, without spending model tokens. */
  async scan(run: RunRecord): Promise<ImprovementProposal[]> {
    if (!["completed", "failed"].includes(run.status)) return [];
    const priorScan = this.scanGate;
    let unlock!: () => void;
    const nextScan = new Promise<void>(resolve => { unlock = resolve; });
    this.scanGate = priorScan.then(() => nextScan);
    await priorScan;
    try {
    const prior = await this.store.list();
    const added: ImprovementProposal[] = [];
    for (const data of findSignals(run)) {
      if (prior.some(p => p.kind === data.kind && p.status !== "rejected" && (data.kind !== "team_feedback" || p.sourceRunId === run.id))) continue;
      const now = new Date().toISOString();
      const proposal: ImprovementProposal = {
        schema: 1, id: `idea_${randomUUID()}`, ...data,
        status: "candidate", createdAt: now, updatedAt: now,
        roundsCompleted: 0, opinions: [], revisionHistory: [],
      };
      await this.store.create(proposal);
      added.push(proposal);
      void this.logger?.log("info", "evolution.idea.created", {
        runId: run.id, proposalId: proposal.id, kind: proposal.kind,
      });
    }
    return added;
    } finally { unlock(); }
  }

  /** Three independent specialists critique and re-propose. A final vote recommends an EXPERIMENT, never a code edit. */
  async deliberate(id: string, requestedRounds: 1 | 2 = 2, signal: AbortSignal = new AbortController().signal): Promise<ImprovementProposal> {
    if (![1,2].includes(requestedRounds)) throw new SynapseError("Council rounds must be 1 or 2");
    if (this.active.has(id)) throw new SynapseError("Council already deliberating on proposal");
    const releaseDisk=await acquireLock(this.store.directory,`${id}.deliberate`);
    this.active.add(id);
    void this.logger?.log("info", "evolution.debate.started", { proposalId: id, rounds: requestedRounds });
    try {
      let proposal = await this.store.read(id);
      if (["ready_for_experiment", "rejected"].includes(proposal.status)) return proposal;
      if (proposal.roundsCompleted >= requestedRounds) return proposal;
      await this.store.update(id, p => { p.status = "deliberating"; });
      for (let round = proposal.roundsCompleted + 1; round <= requestedRounds; round++) {
        if (signal.aborted) throw new SynapseError("Council cancelled");
        const opinions = await Promise.all(roles.map(async role => {
          const instruction = `You are an INDEPENDENT ${role} in the Synapse Evolution Council.
Do not edit files, run commands, create agents, or claim experiments occurred.
Improvement: ${proposal.title}
Current plan: ${proposal.plan}
Original logged evidence: ${JSON.stringify(proposal.evidence)}
Target measurement: ${proposal.metric}
Prior opinions: ${JSON.stringify(proposal.opinions.slice(-6))}
Round: ${round}.
Critique the proposal, suggest an alternative or refinement, and identify discriminating tests. Evidence is observations, not proof of improvement.
Return ONLY JSON {"stance":"support|challenge|block","reason":"...","alternative":"...","tests":["..."]}.`;
          try {
            const result = await this.adapter.execute(syntheticContext(proposal, role, instruction, signal));
            return parseOpinion(result.text, role, round);
          } catch (error) {
            if (signal.aborted) throw error;
            return { role, round, stance: "abstain" as const, reason: clip(String(error), 500), alternative: "", tests: [] };
          }
        }));
        // Deterministic synthesis: preserve separate dissenting views rather than falsely asserting consensus.
        const suggestions = opinions.filter(o => o.alternative.trim()).map(o => `${o.role}: ${o.alternative}`);
        const amendment = suggestions.length ? `\nCouncil alternatives (round ${round}; UNTESTED):\n${suggestions.join("\n")}` : "";
        proposal = await this.store.update(id, p => {
          p.opinions.push(...opinions);
          p.roundsCompleted = round;
          if (amendment) {
            p.plan = clip(`${p.plan}${amendment}`, 12_000);
            p.revisionHistory.push({ round, plan: p.plan, reason: "Alternatives proposed by independent council agents" });
          }
        });
      }
      const latest = proposal.opinions.filter(o => o.round === proposal.roundsCompleted);
      const supports = latest.filter(o => o.stance === "support").length;
      const blocks = latest.filter(o => o.stance === "block").length;
      // A majority can ONLY recommend an experiment, never claim verified success or approve deployment.
      const status: ProposalStatus = blocks > 0 ? "needs_evidence" : supports >= 2 ? "ready_for_experiment" : "needs_evidence";
      void this.logger?.log("info", "evolution.debate.finished", {
        proposalId: id, status, supports, blocks, rounds: proposal.roundsCompleted,
      });
      return this.store.update(id, p => {
        p.status = status;
        p.finalReason = `${supports}/${roles.length} support; ${blocks} block. ` +
          (status === "ready_for_experiment" ? "Proposal recommended for a controlled experiment; no code changes authorized." :
            "More evidence or a revised design is required; no code changes authorized.");
      });
    } catch (error) {
      void this.logger?.log("error", "evolution.debate.error", { proposalId: id, error });
      await this.store.update(id, p => { if (p.status === "deliberating") p.status = "candidate"; }).catch(() => undefined);
      throw error;
    } finally { this.active.delete(id); await releaseDisk(); }
  }

  /** Called once after every terminal run; scanning is free. Model deliberation is explicitly opt-in. */
  async onRunFinished(run: RunRecord): Promise<ImprovementProposal[]> {
    const config = await this.store.getConfig();
    if (!config.autoScan) return [];
    const created = await this.scan(run);
    if (config.autoCouncil) {
      for (const item of created.slice(0, config.maxCouncilsPerRun)) {
        await this.deliberate(item.id, config.rounds);
      }
    }
    return created;
  }
}
