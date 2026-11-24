import { ProviderSessionError } from "./provider.ts";
import { assertSessionBudget, sessionEnvelope, exactCheck } from "./lean.ts";
import { topology } from "./topology.ts";
import { ExperimentStore } from "./experiments.ts";
import { extractPatch } from "./contributions.ts";
import type { AgentAdapter, AgentContext, MessageType, RunRecord, TaskRecord, TaskSpec, TeamMessage } from "./types.ts";
import { SynapseError, SessionTimeoutError } from "./types.ts";
import { FileStore } from "./store.ts";
import { newRun } from "./validate.ts";
import { deliver, event, inbox } from "./bus.ts";

const clone = <T>(v: T): T => structuredClone(v);
const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);

/** Durable task coordination, bounded parallelism, explicit review, retry and recovery. */
export class Synapse {
  private active = new Map<string, AbortController>();
  private reservations = new Map<string, number>();
  private exclusiveRunId?: string;
  readonly slotLimit = 8;
  resourceStatus() {
    const reservations = [...this.reservations].map(([runId, slots]) => ({runId, slots}));
    const reserved = reservations.reduce((n, r) => n + r.slots, 0);
    return {scope: "single Synapse engine instance", limit: this.slotLimit, reserved, available: this.slotLimit - reserved, reservations, exclusiveRunId: this.exclusiveRunId ?? null, caveat: "Reservations cover graph workers and their sequential reviews, not council debates, other plugin instances or remote sessions whose interruption is unconfirmed."};
  }
  private sessions = new Map<string, { runId: string; taskId: string; reviewer: boolean; attempt: number }>();
  readonly store: FileStore;
  readonly adapter: AgentAdapter;
  private finishedHook?: (run: RunRecord) => Promise<unknown>;
  onRunFinished(callback: (run: RunRecord) => Promise<unknown>): void { this.finishedHook = callback; }
  constructor(store: FileStore, adapter: AgentAdapter) { this.store = store; this.adapter = adapter; }

  async plan(objective: string, specs: TaskSpec[], concurrency = 2, sessionBudget?: number): Promise<RunRecord> {
    const run = newRun(objective, specs, concurrency, sessionBudget);
    await this.store.create(run);
    return clone(run);
  }
  async get(id: string) { return this.store.read(id); }
  async list() { return this.store.list(); }
  actor(sessionID: string) { return this.sessions.get(sessionID); }
  private assertActor(run: RunRecord, actor: string, attempt?: number) {
    if (attempt === undefined) return; // internal callers, not exposed model arguments
    const review = actor.endsWith(":reviewer");
    const task = run.tasks.find(t => t.id === (review ? actor.slice(0,-9) : actor));
    if (run.status !== "running" || !task || task.attempts !== attempt || task.status !== (review ? "review" : "running")) throw new SynapseError("Inactive or stale agent session");
  }
  async send(runId: string, from: string, to: string, type: MessageType, body: string, attempt?: number): Promise<TeamMessage> {
    return this.store.update(runId, run => {
      if (run!.status === "cancelled") throw new SynapseError("Run cancelled");
      this.assertActor(run, from, attempt);
      const message = deliver(run!, from, to, type, body);
      const sender = run.tasks.find(t => t.id === from);
      if (sender && sender.status === "running") {
        message.senderAttempt = sender.attempts;
        const evidence = sender.contractEvidence;
        if (evidence?.attempt === sender.attempts && sender.contract?.sendTo?.includes(to) && message.recipientStatusAtSend && !terminal.has(message.recipientStatusAtSend) && !evidence.sentTo.includes(to)) evidence.sentTo.push(to);
      }
      if (message.recipientStatusAtSend && terminal.has(message.recipientStatusAtSend))
        event(run, "team.message_late", message.id, to);
      return message;
    });
  }
  async inbox(runId: string, recipient: string) { return inbox(await this.get(runId), recipient); }
  /** Records explicit inbox retrieval, not proof of comprehension. */
  async fetchInbox(runId: string, recipient: string, attempt?: number) {
    return this.store.update(runId, run => {
      this.assertActor(run, recipient, attempt);
      const taskId = recipient.endsWith(":reviewer") ? recipient.slice(0, -9) : recipient;
      if (!run.tasks.some(t => t.id === taskId)) throw new SynapseError("Unknown inbox recipient");
      const messages = inbox(run, taskId);
      const receiver = run.tasks.find(t => t.id === recipient);
      const evidence = receiver?.contractEvidence;
      if (receiver?.status === "running" && evidence && evidence.attempt === receiver.attempts) {
        for (const m of messages) {
          const sender = run.tasks.find(t => t.id === m.from);
          if (m.to === recipient && sender?.status === "completed" && m.senderAttempt === sender.attempts && receiver.contract?.receiveFrom?.includes(m.from) && !evidence.receivedFrom.includes(m.from)) evidence.receivedFrom.push(m.from);
        }
      }
      for (const message of messages) {
        if (message.from === recipient || (message.to !== "all" && message.to !== taskId)) continue;
        message.fetchedBy ??= {};
        if (!Object.hasOwn(message.fetchedBy, recipient)) {
          message.fetchedBy[recipient] = new Date().toISOString();
          event(run, "team.message_fetched", message.id, taskId);
        }
      }
      return messages;
    });
  }

  private async mutateTask(id: string, taskId: string, fn: (run: RunRecord, task: TaskRecord) => void) {
    await this.store.update(id, run => {
      const task = run!.tasks.find(t => t.id === taskId);
      if (!task) throw new SynapseError(`Unknown task ${taskId}`);
      fn(run!, task);
    });
  }
  private makeContext(run: RunRecord, task: TaskRecord, signal: AbortSignal): AgentContext {
    return {
      runId: run.id, objective: run.objective, task: { ...clone(task), verification: undefined }, verificationKind: task.verification?.kind,
      dependencies: task.dependsOn.map(id => {
        const item = run.tasks.find(t => t.id === id)!;
        return { id, result: item.result ?? "" };
      }),
      messages: inbox(run, task.id), signal,
      onSession: sessionID => {
        this.sessions.set(sessionID, { runId: run.id, taskId: task.id, reviewer: false, attempt: task.attempts });
      },
    };
  }
  private async doTask(id: string, taskId: string, signal: AbortSignal) {
    const current = await this.get(id);
    const task = current.tasks.find(t => t.id === taskId)!;
    if (signal.aborted || current.status === "cancelled") return;
    const context = this.makeContext(current, task, signal);
    let attemptFinished = false;
    try {
      const response = await this.adapter.execute(context);
      if (!response.text?.trim()) throw new SynapseError("Worker returned no result");
      if (task.patch) { if (response.text.length > 60_000) throw new SynapseError("Patch response exceeds review limit"); extractPatch(response.text); }
      if (signal.aborted) return;
      await this.mutateTask(id, taskId, (run, record) => {
        if (run.status === "cancelled") return;
        record.result = response.text.slice(0, 100_000);
        record.workerSession = response.sessionID;
        record.error = undefined;
        if (record.contract && record.contractEvidence) {
          const evidence = record.contractEvidence;
          evidence.channel = response.channel;
          evidence.missing = [
            ...(record.contract.requireSubmit && response.channel !== "submit" ? ["explicit submit"] : []),
            ...(record.contract.sendTo ?? []).filter(peer => !evidence.sentTo.includes(peer)).map(peer => `direct send to ${peer}`),
            ...(record.contract.receiveFrom ?? []).filter(peer => !evidence.receivedFrom.includes(peer)).map(peer => `inbox retrieval from ${peer}`),
          ];
          if (evidence.missing.length) {
            record.status = record.attempts < record.maxAttempts ? "pending" : "failed";
            record.error = `Contract unmet: ${evidence.missing.join("; ")}`;
            record.endedAt = new Date().toISOString();
            event(run, "task.contract_error", record.error, taskId);
            return;
          }
          event(run, "task.contract_verified", "Observed required collaboration actions", taskId);
        }
        if (record.verification) {
          const passed = exactCheck(record.verification, response.text);
          record.verificationEvidence = {attempt: record.attempts, passed};
          event(run, passed ? "task.exact_verified" : "task.exact_rejected", passed ? "Exact fixture matched" : "Exact fixture mismatch", taskId);
          if (!passed) {
            record.status = record.attempts < record.maxAttempts ? "pending" : "failed";
            record.error = "Exact fixture mismatch";
            record.endedAt = new Date().toISOString();
            return;
          }
        }
        record.status = record.review ? "review" : "completed";
        record.endedAt = new Date().toISOString();
        event(run, record.review ? "task.review" : "task.completed", `Worker finished ${taskId}`, taskId);
      });
      const afterWorker = (await this.get(id)).tasks.find(t => t.id === taskId)!;
      if (afterWorker.status !== "review") return;
      attemptFinished = true;
      if (!this.adapter.review) throw new SynapseError("Review requested but no reviewer configured");
      const latest = await this.get(id);
      const reviewContext = this.makeContext(latest, latest.tasks.find(t => t.id === taskId)!, signal);
      reviewContext.onSession = sessionID => this.sessions.set(sessionID, { runId: id, taskId, reviewer: true, attempt: task.attempts });
      const verdict = await this.adapter.review({ ...reviewContext, result: response.text });
      if (signal.aborted) return;
      await this.mutateTask(id, taskId, (run, record) => {
        if (run.status === "cancelled") return;
        record.reviewerSession = verdict.sessionID;
        record.reviewResult = verdict.reason.slice(0, 10_000);
        if (verdict.protocolError) {
          record.status = "failed";
          record.error = `Review protocol failure: ${verdict.reason.slice(0, 2000)}`;
          record.endedAt = new Date().toISOString();
          event(run, "task.review_protocol_error", record.error, taskId);
        } else if (verdict.approved) {
          record.status = "completed";
          record.endedAt = new Date().toISOString();
          event(run, "task.verified", verdict.reason, taskId);
        } else {
          record.status = record.attempts < record.maxAttempts ? "pending" : "failed";
          record.error = `Review rejected: ${verdict.reason.slice(0, 2000)}`;
          event(run, "task.review_rejected", record.error, taskId);
        }
      });
    } catch (error) {
      if (signal.aborted) return;
      await this.mutateTask(id, taskId, (run, record) => {
        if (run.status === "cancelled") return;
        record.status = error instanceof SessionTimeoutError || error instanceof ProviderSessionError ? "failed" : record.attempts < record.maxAttempts ? "pending" : "failed";
        record.error = String(error).slice(0, 2000);
        record.failureSource = error instanceof ProviderSessionError ? error.source : undefined;
        if (attemptFinished) record.reviewResult = record.error;
        record.endedAt = new Date().toISOString();
        event(run, error instanceof ProviderSessionError ? "task.provider_error" : "task.error", record.error, taskId);
      });
    } finally {
      // Session identities are retained until plugin shutdown to permit reading final communication.
    }
  }

  async run(id: string, externalSignal?: AbortSignal): Promise<RunRecord> {
    if (this.active.has(id)) throw new SynapseError("Run is already executing");
    const unlock=await this.store.lockExecution(id);
    try { return await this.runLocked(id,externalSignal); } finally { await unlock(); }
  }
  private async runLocked(id: string, externalSignal?: AbortSignal): Promise<RunRecord> {
    if (this.active.has(id)) throw new SynapseError("Run is already executing");
    const initial = await this.get(id);
    const experimental = await new ExperimentStore(this.store).isRegistered(id);
    if (this.active.has(id)) throw new SynapseError("Run is already executing");
    if (initial.status === "completed") return initial;
    assertSessionBudget(sessionEnvelope(initial.tasks), initial.options.sessionBudget);
    if (initial.status === "cancelled") throw new SynapseError("Cancelled runs cannot restart");
    if (this.exclusiveRunId || (experimental && this.reservations.size > 0)) {
      void this.store.logger?.log("warn", "run.isolation_refused", {runId:id, experimental});
      throw new SynapseError("Experiment isolation: wait for the other graph to finish; no agent started");
    }
    const slots = Math.min(initial.options.concurrency, topology(initial).maxIndependentTasks);
    if (!Number.isInteger(slots) || slots < 1 || slots > this.slotLimit) throw new SynapseError("Invalid resource reservation");
    if (this.resourceStatus().available < slots) {
      void this.store.logger?.log("warn", "run.capacity_refused", {runId:id, requestedSlots:slots, availableSlots:this.resourceStatus().available});
      throw new SynapseError("Runtime capacity exhausted; execute later or explicitly plan a smaller graph");
    }
    // No await between admission and reservation; concurrent calls in this engine cannot oversubscribe.
    this.reservations.set(id, slots);
    if (experimental) this.exclusiveRunId = id;
    void this.store.logger?.log("info", "run.capacity_reserved", {runId:id, reservedSlots:slots, totalReserved:this.resourceStatus().reserved, experimental});
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) controller.abort();
    this.active.set(id, controller);
    const running = new Map<string, Promise<{ id: string; error?: unknown }>>();
    const reap = async () => {
      const finished = await Promise.race(running.values());
      running.delete(finished.id);
      if (finished.error !== undefined) throw finished.error;
    };
    try {
      await this.store.update(id, run => {
        if (run!.status === "cancelled") throw new SynapseError("Cancelled runs cannot restart");
        // Crash recovery: running/review means an orphaned previous execution.
        for (const task of run!.tasks) {
          if (task.status === "running" || task.status === "review") {
            task.status = task.attempts < task.maxAttempts ? "pending" : "failed";
            event(run!, "task.recovered", "Reset orphaned task after interruption", task.id);
          }
        }
        if (run!.status === "completed") return;
        run!.status = "running";
        event(run!, "run.started", "Execution started");
      });
      while (!controller.signal.aborted) {
        const state = await this.get(id);
        if (state.status === "cancelled" || state.status === "completed") break;
        const failed = new Set(state.tasks.filter(t => t.status === "failed" || t.status === "blocked").map(t => t.id));
        const blocked = state.tasks.filter(t => t.status === "pending" && t.dependsOn.some(dep => failed.has(dep)));
        if (blocked.length) {
          await this.store.update(id, run => {
            if (run.status === "cancelled" || controller.signal.aborted) return;
            for (const spec of blocked) {
              const task = run!.tasks.find(t => t.id === spec.id)!;
              task.status = "blocked";
              event(run!, "task.blocked", "Dependency failed", task.id);
            }
          });
          continue;
        }
        const completed = new Set(state.tasks.filter(t => t.status === "completed").map(t => t.id));
        const ready = state.tasks.filter(t => t.status === "pending" && !running.has(t.id) && t.dependsOn.every(dep => completed.has(dep)))
          .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
          .slice(0, Math.max(0, state.options.concurrency - running.size));
        if (!ready.length) {
          if (running.size) { await reap(); continue; }
          await this.store.update(id, run => {
            if (run.status === "cancelled" || controller.signal.aborted) return;
            run!.status = run!.tasks.every(t => t.status === "completed") ? "completed" : "failed";
            event(run!, "run.finished", `Finished with status ${run!.status}`);
          });
          break;
        }
        await this.store.update(id, run => {
          if (run!.status === "cancelled" || controller.signal.aborted) return;
          for (const entry of ready) {
            const task = run!.tasks.find(t => t.id === entry.id)!;
            task.attempts++;
            task.verificationEvidence = undefined;
            task.failureSource = undefined;
            task.error = undefined;
            task.result = undefined;
            task.reviewResult = undefined;
            task.workerSession = undefined;
            task.reviewerSession = undefined;
            if (task.contract) task.contractEvidence = { attempt: task.attempts, sentTo: [], receivedFrom: [] };
            task.status = "running";
            task.startedAt = new Date().toISOString();
            task.endedAt = undefined;
            event(run!, "task.started", `Attempt ${task.attempts}`, task.id);
          }
        });
        if (controller.signal.aborted || (await this.get(id)).status === "cancelled") break;
        for (const task of ready) {
          const work = this.doTask(id, task.id, controller.signal)
            .then(() => ({ id: task.id }), error => ({ id: task.id, error }));
          running.set(task.id, work);
        }
        if (running.size) await reap();
      }
      await Promise.allSettled(running.values());
      if (controller.signal.aborted) await this.resetInterrupted(id);
      const result = await this.get(id);
      if ((result.status === "completed" || result.status === "failed") && this.finishedHook) {
        try { await this.finishedHook(result); }
        catch (error) {
          await this.store.update(id, state => {
            event(state!, "evolution.error", `Evolution monitoring failed: ${String(error).slice(0, 800)}`);
          });
        }
      }
      return this.get(id);
    } catch (error) {
      controller.abort();
      throw error;
    } finally {
      await Promise.allSettled(running.values());
      externalSignal?.removeEventListener("abort", abort);
      try { if (controller.signal.aborted) await this.resetInterrupted(id); }
      finally {
        this.active.delete(id); this.reservations.delete(id);
        if (this.exclusiveRunId === id) this.exclusiveRunId = undefined;
        void this.store.logger?.log("info", "run.capacity_released", {runId:id, totalReserved:this.resourceStatus().reserved});
      }
    }
  }

  private async resetInterrupted(id: string) {
    await this.store.update(id, run => {
      if (run.status !== "running") return;
      run.status = "planned";
      for (const task of run.tasks) {
        if (task.status === "running" || task.status === "review") task.status = task.attempts < task.maxAttempts ? "pending" : "failed";
      }
      event(run, "run.interrupted", "Execution interrupted; remaining work can be resumed");
    });
  }

  async stop(id: string): Promise<RunRecord> {
    // A different engine cannot safely interrupt sessions it does not own.
    if(this.active.has(id))return this.stopOwned(id);
    const unlock=await this.store.lockExecution(id);
    try { return await this.stopOwned(id); } finally { await unlock(); }
  }
  private async stopOwned(id: string): Promise<RunRecord> {
    this.active.get(id)?.abort();
    await this.store.update(id, run => {
      run!.status = "cancelled";
      for (const task of run!.tasks) if (!terminal.has(task.status)) task.status = "cancelled";
      event(run!, "run.cancelled", "Stopped by coordinator");
    });
    const sessions = [...this.sessions].filter(([, identity]) => identity.runId === id);
    await Promise.allSettled(sessions.map(async ([sessionID]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.resolve().then(() => this.adapter.cancel?.(sessionID)), new Promise<void>(resolve => {timer=setTimeout(resolve, 1500);})]); }
      finally {if(timer)clearTimeout(timer);}
    }));
    return this.get(id);
  }
}
