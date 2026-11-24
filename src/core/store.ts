/** Atomic snapshots and cooperative per-run disk locks. */
import { acquireLock } from "./locks.ts";
import { mkdir, readFile, readdir, rename, writeFile, unlink, link } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SynapseError, type RunRecord } from "./types.ts";
import { errorCategory, type DiagnosticLogger } from "./diagnostics.ts";

export class FileStore {
  private locks = new Map<string, Promise<void>>();
  readonly directory: string;
  readonly logger?: DiagnosticLogger;
  constructor(directory: string, logger?: DiagnosticLogger) { this.directory = directory; this.logger = logger; }
  private path(id: string) {
    if (!/^run_[a-f0-9-]{36}$/.test(id)) throw new SynapseError("Invalid run ID");
    return join(this.directory, `${id}.json`);
  }
  async read(id: string): Promise<RunRecord> {
    let parsed: RunRecord;
    try { parsed = JSON.parse(await readFile(this.path(id), "utf8")) as RunRecord; }
    catch (err) { throw new SynapseError(`Cannot load run ${id}: ${String(err)}`); }
    if (parsed.schema !== 1 || parsed.id !== id) throw new SynapseError(`Invalid saved run: ${id}`);
    return parsed;
  }
  async list(): Promise<{ id: string; objective: string; status: string; updatedAt: string }[]> {
    await mkdir(this.directory, { recursive: true });
    const names = (await readdir(this.directory)).filter(n => /^run_[a-f0-9-]{36}\.json$/.test(n));
    const records = await Promise.all(names.map(n => this.read(n.slice(0, -5))));
    return records.map(({ id, objective, status, updatedAt }) => ({ id, objective, status, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  private async atomicWrite(record: RunRecord) {
    await mkdir(this.directory, { recursive: true });
    const target = this.path(record.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temp, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 }); await rename(temp, target); }
    finally { await unlink(temp).catch(() => undefined); }
  }
  async lockExecution(id:string) { this.path(id); return acquireLock(this.directory,`${id}.execute`); }
  /** Atomic disk replace avoids torn JSON files. */
  async update<T>(id: string, fn: (record: RunRecord) => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => gate);
    this.locks.set(id, current);
    await previous;
    let unlock: (()=>Promise<void>) | undefined;
    try {
      this.path(id); unlock=await acquireLock(this.directory,`${id}.update`,10000);
      const state = await this.read(id);
      const priorEvents = new Set(state.events.map(e => e.id));
      const priorMessages = new Set(state.messages.map(m => m.id));
      const result = await fn(state);
      state.updatedAt = new Date().toISOString();
      await this.atomicWrite(state);
      if (this.logger) {
        // Only metadata is logged; message bodies and model responses remain in private run files.
        for (const evt of state.events.filter(e => !priorEvents.has(e.id))) {
          void this.logger.log(evt.type.endsWith("error") ? "error" : "info", evt.type, {
            runId: id, taskId: evt.taskId,
            // Ordinary event descriptions can contain reviewer conclusions or private project content.
            // Record only categories; raw reviewer feedback stays in the private run.
            ...(evt.type === "task.exact_rejected" || evt.type === "task.contract_error" || evt.type === "task.error" || evt.type === "task.provider_error" || evt.type === "task.review_rejected" || evt.type === "evolution.error"
              ? { errorCategory: errorCategory(evt.detail) } : {}),
          });
        }
        for (const msg of state.messages.filter(m => !priorMessages.has(m.id))) {
          void this.logger.log("info", "team.message", {
            runId: id, from: msg.from, to: msg.to, messageType: msg.type, messageId: msg.id, recipientStatusAtSend: msg.recipientStatusAtSend,
          });
        }
      }
      return result;
    } finally {
      try { await unlock?.(); } finally { release();
      if (this.locks.get(id) === current) this.locks.delete(id); }
    }
  }
  async create(record: RunRecord): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = this.path(record.id);
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
      await link(temp, target); // atomic publication, EEXIST never overwrites
    } finally { await unlink(temp).catch(() => undefined); }
    void this.logger?.log("info", "run.created", { runId: record.id, taskCount: record.tasks.length,
      concurrency: record.options.concurrency });
  }
}
