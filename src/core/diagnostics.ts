import { failureSources, type FailureSource, providerCategories } from "./provider.ts";
import { economicAdvice } from "./economics.ts";
import type { RunRecord } from "./types.ts";
import { CostLedger } from "./ledger.ts";
import { usageKeys } from "./cost.ts";
import type { storageReport } from "./storage.ts";
import { ExperimentStore } from "./experiments.ts";
import { FileStore } from "./store.ts";
/** Local, bounded, privacy-conscious diagnostics. No network operations. */
import { VERSION } from "./version.ts";
import { mkdir, readFile, readdir, rename, stat, writeFile, appendFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogFields {
  runId?: string;
  taskId?: string;
  sessionId?: string;
  durationMs?: number;
  attempt?: number;
  status?: string;
  error?: unknown;
  [key: string]: unknown;
}
export interface LogEntry {
  at: string;
  level: LogLevel;
  event: string;
  fields: Record<string, unknown>;
}
const DEFAULT_LIMIT = 1024 * 1024;
const DEFAULT_FILES = 4;
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Defense in depth. Reports additionally exclude raw objectives, prompts, replies and message bodies. */
export function redact(value: string): string {
  return value
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?-----END [\w ]*PRIVATE KEY-----/gi, "[REDACTED:PRIVATE_KEY]")
    .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|AKIA)[A-Za-z0-9_\-]{8,}\b/g, "[REDACTED:TOKEN]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|cookie|client_secret)\b["']?\s*[:=]\s*["']?([^\s,;"'}]+)/gi,
      (_match, key: string) => `${key}=[REDACTED]`)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:EMAIL]")
    .replace(/(?:\/home\/|\/Users\/|C:\\Users\\)[^\\/\s:'"\]\[]+/g, "[HOME]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED:IP]");
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[TRUNCATED]";
  if (value instanceof Error) return { name: value.name, message: redact(value.message).slice(0, 2000),
    stack: value.stack ? redact(value.stack).slice(0, 4000) : undefined };
  if (typeof value === "string") return redact(value).slice(0, 4000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 25).map(v => sanitize(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[key] = /secret|password|token|cookie|authorization|api.?key|private.?key|credential/i.test(key)
        ? "[REDACTED:FIELD]" : sanitize(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Free-form errors may contain arbitrary source excerpts or model feedback. */
export function errorCategory(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  const provider = text.replace(/^ProviderSessionError: /, "");
  if ((providerCategories as readonly string[]).includes(provider)) return provider;
  if (text === "Exact fixture mismatch") return "exact_mismatch";
  if (text.startsWith("Review rejected:")) return "review_rejected";
  if (text.startsWith("Review protocol failure:")) return "review_protocol_error";
  if (text.startsWith("Contract unmet:")) return "contract_unmet";
  if (/Session deadline exceeded/.test(text)) return "session_timeout";
  if (/Worker returned no result/.test(text)) return "empty_result";
  if (/Dependency failed/.test(text)) return "dependency_failed";
  return "unspecified_error";
}

/** Re-sanitize historical logs at export, including pre-0.10 free-form error fields. */
export function exportLogMetadata(raw: string, runId?: string): string {
  const numeric = new Set("durationMs elapsedMs timeoutMs responseLength promptChars attempt taskCount concurrency rounds reservedSlots totalReserved requestedSlots availableSlots runCount bytes count textParts inputMessages includedMessages omittedMessages directMessages optionalBudget messageChars dependencyChars fileCount imported conflicts invalid archived identical toolsBefore toolsAfter schemaCharsBefore schemaCharsAfter".split(" "));
  usageKeys.forEach(k=>numeric.add(k)); numeric.add("observedSteps");
  const flags = new Set(["approved", "experimental", "settled", "retryHook", "terminalEvents"]);
  const ids = new Set(["runId","taskId","sessionId","messageId","proposalId","from","to"]);
  const enums: Record<string, string[]> = {
    failureSource:["retry_hook","terminal_event","terminal_context","host_error","circuit"], toolProfile:["lean"], filterStatus:["applied","required_missing","unsupported","invalid_shape","not_observed","immutable"], role:["worker","review","council"], usageSource:["session_get","context_partial","unavailable"], phase:["prompt","wait","context","created","finished","timeout","result"],
    channel:["submit","submit_review","context"], messageType:["proposal","evidence","question","challenge","handoff","blocker","result","note","improvement"],
    recipientStatusAtSend:["pending","running","review","completed","failed","blocked","cancelled"],
    kind:["recovery","review_quality","team_feedback","verification","measurement","contract_compliance","review_latency","communication"]
  };
  const lines: string[] = [];
  for (const line of raw.split("\n")) {
    try {
      const entry = JSON.parse(line) as LogEntry;
      if (!entry.fields || !/^[a-z][a-z0-9_.-]{0,119}$/i.test(entry.event) || !Object.hasOwn(LEVELS,entry.level) || !Number.isFinite(Date.parse(entry.at))) continue;
      if (runId && entry.fields.runId !== runId && !entry.event.startsWith("plugin.setup.")) continue;
      const fields: Record<string,unknown> = {};
      for (const [key,value] of Object.entries(entry.fields)) {
        if (numeric.has(key) && typeof value === "number" && Number.isFinite(value)) fields[key]=value;
        else if (flags.has(key) && typeof value === "boolean") fields[key]=value;
        else if (ids.has(key) && typeof value === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value)) fields[key]=value;
        else if (typeof value === "string" && Object.hasOwn(enums,key) && enums[key].includes(value)) fields[key]=value;
        else if (key === "version" && typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value)) fields[key]=value;
        else if (key === "error" && value !== undefined) fields.errorCategory=errorCategory(typeof value === "object" && value !== null && "message" in value ? value.message : value);
        else if (key === "errorCategory" && typeof value === "string" && ["exact_mismatch","review_rejected","review_protocol_error","contract_unmet","session_timeout","empty_result","dependency_failed","unspecified_error",...providerCategories].includes(value)) fields.errorCategory=value;
      }
      lines.push(JSON.stringify({at:entry.at,level:entry.level,event:entry.event,fields}));
    } catch { /* Invalid lines are not copied verbatim. */ }
  }
  return lines.length ? lines.join("\n")+"\n" : "";
}

export class DiagnosticLogger {
  readonly directory: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly level: LogLevel;
  private queue: Promise<void> = Promise.resolve();
  private failures = 0;
  private lastFailure?: string;
  constructor(directory: string, options: { maxBytes?: number; maxFiles?: number; level?: LogLevel } = {}) {
    this.directory = directory;
    this.maxBytes = Math.max(512, options.maxBytes ?? DEFAULT_LIMIT);
    this.maxFiles = Math.min(10, Math.max(1, options.maxFiles ?? DEFAULT_FILES));
    this.level = options.level ?? "info";
  }
  get path() { return join(this.directory, "synapse.jsonl"); }
  get errors() { return { count: this.failures, latest: this.lastFailure }; }

  /** Best effort: logging failures must never break task execution or create unhandled rejections. */
  log(level: LogLevel, event: string, fields: LogFields = {}): Promise<void> {
    if (LEVELS[level] < LEVELS[this.level]) return Promise.resolve();
    // Intentionally do not accept raw prompts, outputs, source code or conversation bodies.
    const safeFields: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val === undefined || /^(?:objective|prompt|instruction|result|body|content|messages|source|code)$/i.test(key)) continue;
      safeFields[key] = sanitize(val);
    }
    const entry: LogEntry = { at: new Date().toISOString(), level, event: redact(event).slice(0, 120), fields: safeFields };
    const line = JSON.stringify(entry) + "\n";
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const size = (await stat(this.path).catch(() => ({ size: 0 }))).size;
      if (size + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
      await appendFile(this.path, line, { mode: 0o600 });
    }).catch(error => {
      this.failures++;
      this.lastFailure = redact(String(error)).slice(0, 500);
    });
    return this.queue;
  }
  private async rotate() {
    if (this.maxFiles === 1) { await unlink(this.path).catch(() => undefined); return; }
    await unlink(`${this.path}.${this.maxFiles - 1}`).catch(() => undefined);
    for (let i = this.maxFiles - 2; i >= 1; i--) {
      await rename(`${this.path}.${i}`, `${this.path}.${i + 1}`).catch(err => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
    }
    await rename(this.path, `${this.path}.1`).catch(err => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
  async flush() { await this.queue; }
  async status() {
    await this.flush();
    const files = await readdir(this.directory).catch(() => []);
    const logs = files.filter(n => /^synapse\.jsonl(?:\.\d+)?$/.test(n));
    let totalBytes = 0;
    for (const name of logs) totalBytes += (await stat(join(this.directory, name)).catch(() => ({ size: 0 }))).size;
    return { directory: this.directory, logFiles: logs.length, bytes: totalBytes,
      maxBytesPerFile: this.maxBytes, maxFiles: this.maxFiles, level: this.level, loggingErrors: this.errors };
  }
  async recent(maxLines = 2000, maxBytes = 2_000_000): Promise<string> {
    await this.flush();
    const names = (await readdir(this.directory).catch(() => []))
      .filter(n => /^synapse\.jsonl(?:\.\d+)?$/.test(n))
      .sort((a, b) => {
        const rank = (n: string) => n === "synapse.jsonl" ? 0 : Number(n.split(".").at(-1));
        return rank(b) - rank(a);
      });
    const all: string[] = [];
    for (const name of names) {
      const data = await readFile(join(this.directory, name), "utf8").catch(() => "");
      all.push(...data.split("\n").filter(Boolean));
    }
    const selected: string[] = [];
    let length = 0;
    for (const line of all.slice(-Math.max(1, Math.min(10_000, maxLines))).reverse()) {
      const safeLine = redact(line);
      const size = Buffer.byteLength(safeLine) + 1;
      if (length + size > maxBytes) break;
      selected.unshift(safeLine);
      length += size;
    }
    return selected.length ? selected.join("\n") + "\n" : "";
  }
}

// A deliberately small ZIP writer avoids new runtime dependencies and external CLI processes.
// Files are stored (no compression); CRC-32 and ZIP central directory are standards-compliant.
function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files: { name: string; data: string }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of files) {
    if (!/^[a-zA-Z0-9_./-]{1,128}$/.test(name) || name.includes("..") || name.startsWith("/"))
      throw new Error("Unsafe ZIP entry name");
    const label = Buffer.from(name);
    const body = Buffer.from(data, "utf8");
    const crc = crc32(body);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(body.length, 22);
    head.writeUInt16LE(label.length, 26);
    local.push(head, label, body);
    const middle = Buffer.alloc(46);
    middle.writeUInt32LE(0x02014b50, 0);
    middle.writeUInt16LE(20, 4);
    middle.writeUInt16LE(20, 6);
    middle.writeUInt32LE(crc, 16);
    middle.writeUInt32LE(body.length, 20);
    middle.writeUInt32LE(body.length, 24);
    middle.writeUInt16LE(label.length, 28);
    middle.writeUInt32LE(offset, 42);
    central.push(middle, label);
    offset += head.length + label.length + body.length;
  }
  const centerSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centerSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

export interface DiagnosticRunSummary {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  tasks: { id: string; role: string; status: string; attempts: number; error?: string;
    durationMs?: number; reviewed: boolean; failureSource?: FailureSource; toolProfile?: "lean"; exactVerification?: {passed: boolean|null}; contract?: { verified: boolean; missingCount?: number; sentCount: number; receivedCount: number; channel?: string } }[];
  sessionBudget?: number;
  tasksWithExactVerification?: number;
  eventsByType: Record<string, number>;
  messagesByType: Record<string, number>;
  timeline: { at: string; type: string; taskId?: string }[];
  communication: { at: string; from: string; to: string; type: string; recipientStatusAtSend?: string; fetchedByCount?: number }[];
}
export interface ReportResult { filePath: string; bytes: number; runCount: number; warnings: string[]; files: string[] }

export class DiagnosticReports {
  readonly dataDirectory: string;
  readonly logger: DiagnosticLogger;
  private readonly storageSnapshot?: () => ReturnType<typeof storageReport>;
  constructor(dataDirectory: string, logger: DiagnosticLogger, storageSnapshot?: () => ReturnType<typeof storageReport>) { this.dataDirectory = dataDirectory; this.logger = logger; this.storageSnapshot=storageSnapshot; }
  /** No prompts/replies/message bodies/raw snapshots, environment variables or source files. */
  async build(options: { runId?: string; coordinatorUsage?: unknown } = {}): Promise<ReportResult> {
    await this.logger.flush();
    const warnings: string[] = [];
    const names = (await readdir(this.dataDirectory).catch(() => []))
      .filter(name => /^run_[a-f0-9-]{36}\.json$/.test(name))
      .filter(name => !options.runId || name === `${options.runId}.json`)
      .slice(0, 300);
    if (options.runId && !names.length) throw new Error("Requested run not found");
    const runs: DiagnosticRunSummary[] = [];
    const records: RunRecord[] = [];
    for (const name of names) {
      try {
        const parsed = JSON.parse(await readFile(join(this.dataDirectory, name), "utf8")) as Record<string, any>;
        if (parsed.schema !== 1 || parsed.id !== name.slice(0, -5) || !Array.isArray(parsed.tasks)) throw new Error("Invalid run schema");
        const eventsByType: Record<string, number> = {}, messagesByType: Record<string, number> = {};
        for (const item of (Array.isArray(parsed.events) ? parsed.events : []).slice(-5000)) {
          const key = String(item.type ?? "unknown").slice(0, 80);
          eventsByType[key] = (eventsByType[key] ?? 0) + 1;
        }
        for (const item of (Array.isArray(parsed.messages) ? parsed.messages : []).slice(-5000)) {
          const key = String(item.type ?? "unknown").slice(0, 80);
          messagesByType[key] = (messagesByType[key] ?? 0) + 1;
        }
        runs.push({ id: parsed.id, status: String(parsed.status).slice(0, 80),
          createdAt: String(parsed.createdAt).slice(0, 40), updatedAt: String(parsed.updatedAt).slice(0, 40),
          sessionBudget: Number.isSafeInteger(parsed.options?.sessionBudget) ? parsed.options.sessionBudget : undefined,
          tasksWithExactVerification: parsed.tasks.filter((t:Record<string,any>)=>t.verification?.kind === "exact").length,
          tasks: parsed.tasks.slice(0, 128).map((t: Record<string, any>) => ({
            id: redact(String(t.id ?? "")).slice(0, 100), role: redact(String(t.role ?? "")).slice(0, 80),
            status: String(t.status ?? "").slice(0, 40), attempts: Number(t.attempts ?? 0),
            error: t.error ? errorCategory(t.error) : undefined,
            reviewed: Boolean(t.review),
            failureSource: t.status === "failed" && typeof t.failureSource === "string" && (failureSources as readonly string[]).includes(t.failureSource) && (providerCategories as readonly string[]).includes(errorCategory(t.error)) ? t.failureSource as FailureSource : undefined, toolProfile: t.toolProfile === "lean" ? "lean" as const : undefined,
            exactVerification: t.verification?.kind === "exact" ? {passed: t.verificationEvidence?.attempt === t.attempts && typeof t.verificationEvidence?.passed === "boolean" ? t.verificationEvidence.passed : null} : undefined,
            contract: t.contract ? { verified: Array.isArray(t.contractEvidence?.missing) && t.contractEvidence.missing.length === 0,
              missingCount: Array.isArray(t.contractEvidence?.missing) ? t.contractEvidence.missing.length : undefined,
              sentCount: Array.isArray(t.contractEvidence?.sentTo) ? t.contractEvidence.sentTo.length : 0,
              receivedCount: Array.isArray(t.contractEvidence?.receivedFrom) ? t.contractEvidence.receivedFrom.length : 0,
              channel: ["submit", "context"].includes(t.contractEvidence?.channel) ? t.contractEvidence.channel : undefined } : undefined,
            durationMs: t.startedAt && t.endedAt ? Math.max(0, new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime()) : undefined,
          })), eventsByType, messagesByType,
          timeline: (Array.isArray(parsed.events) ? parsed.events : []).slice(-300).map((e: Record<string, any>) => ({
            at: String(e.at ?? "").slice(0, 40), type: redact(String(e.type ?? "")).slice(0, 80),
            taskId: e.taskId ? redact(String(e.taskId)).slice(0, 100) : undefined,
          })),
          communication: (Array.isArray(parsed.messages) ? parsed.messages : []).slice(-200).map((m: Record<string, any>) => ({
            at: String(m.at ?? "").slice(0, 40), from: redact(String(m.from ?? "")).slice(0, 100),
            to: redact(String(m.to ?? "")).slice(0, 100), type: redact(String(m.type ?? "")).slice(0, 80),
            recipientStatusAtSend: ["pending", "running", "review", "completed", "failed", "blocked", "cancelled"].includes(m.recipientStatusAtSend) ? m.recipientStatusAtSend : undefined, fetchedByCount: m.fetchedBy && typeof m.fetchedBy === "object" ? Object.keys(m.fetchedBy).length : undefined,
          })) });
        records.push(parsed as RunRecord);
      } catch (error) { warnings.push(`Could not summarize ${name}`); }
    }
    const status = await this.logger.status();
    const manifest = {
      schema: 1, product: "Synapse OpenCode", version: VERSION, createdAt: new Date().toISOString(),
      node: process.version, platform: process.platform, arch: process.arch,
      privacy: "Redacted, metadata-only diagnostic bundle; review before sharing.",
      runCount: runs.length, loggingErrors: {count:status.loggingErrors.count}, warnings,
    };
    const logMetadata=exportLogMetadata(await this.logger.recent(), options.runId);
    const files = [
      { name: "README.txt", data: "Synapse diagnostic report. No source code, prompts, objectives, model responses or message bodies are intentionally exported. Free-form errors, reviewer comments and unknown log fields are omitted; identifiers and roles can still reveal project information. REVIEW BEFORE SHARING. No report is uploaded automatically.\n" },
      { name: "manifest.json", data: JSON.stringify(manifest, null, 2) + "\n" },
      { name: "runs.json", data: JSON.stringify(runs, null, 2) + "\n" },
      { name: "logs.jsonl", data: logMetadata },
    ];
    files.push({name:"costs.json",data:JSON.stringify(await new CostLedger(this.dataDirectory).summary(logMetadata,options.runId),null,2)+"\n"});
    // Bounded, recomputed advice; no raw plan, task result, or coordinator session ID.
    const ledger = new CostLedger(this.dataDirectory);
    const selectedRecords = records.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,12);
    const advice = [];
    for(const record of selectedRecords){
      try { advice.push(economicAdvice(record,await ledger.summary(logMetadata,record.id))); }
      catch {warnings.push(`Could not compute economic advice ${record.id}`);}
    }
    if(records.length)files.push({name:"economics.json",data:JSON.stringify({schema:1,scope:"latest_included_runs",omitted:records.length-selectedRecords.length,advice},null,2)+"\n"});
    if(options.coordinatorUsage!==undefined){
      const row=options.coordinatorUsage as Record<string,unknown>|null;
      const raw=row?.usage as Record<string,unknown>|undefined;
      const usage:Record<string,unknown>={usageSource:raw?.usageSource==='session_get'?'session_get':'unavailable'};
      if(usage.usageSource==='session_get')for(const k of usageKeys){const v=raw?.[k];if(typeof v==='number'&&Number.isFinite(v)&&v>=0&&(k==='reportedCostUsd'?v<=Number.MAX_SAFE_INTEGER:Number.isSafeInteger(v)))usage[k]=v;}
      if(Object.keys(usage).length===1)usage.usageSource='unavailable';
      files.push({name:"coordinator.json",data:JSON.stringify({schema:1,scope:"current_coordinator_session_cumulative",observedAt:typeof row?.observedAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.observedAt)?row.observedAt:null,usage,billingVerified:false,coverageNote:"Separate cumulative snapshot; not attributable to this graph and may omit in-flight usage."},null,2)+"\n"});
    }

    // Export only derived experiment metadata; never exact answers, plan digests or model labels.
    try {
      const experiments = new ExperimentStore(new FileStore(this.dataDirectory));
      const selected = (await experiments.list()).filter(e=>!options.runId||e.pairs.some(p=>p.baselineRunId===options.runId||p.candidateRunId===options.runId)).slice(0,20);
      const outcomes=[];
      for(const experiment of selected) {
        try {outcomes.push(await experiments.evaluate(experiment.id));}
        catch {warnings.push(`Could not evaluate experiment ${experiment.id}`);}
      }
      if(outcomes.length) files.push({name:"experiments.json",data:JSON.stringify(outcomes,null,2)+"\n"});
    } catch {warnings.push("Could not summarize experiments");}
    if(this.storageSnapshot) {
      try {
        const storage=await this.storageSnapshot();
        if(storage.warning) warnings.push(storage.warning);
        files.push({name:"storage.json",data:JSON.stringify(storage,null,2)+"\n"});
      } catch {warnings.push("storage_inventory_unavailable");}
    }
    // Include any warnings discovered while summarizing experiments.
    files[1].data=JSON.stringify(manifest,null,2)+"\n";
    const buffer = zip(files);
    const destination = join(this.dataDirectory, "reports");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const filePath = join(destination, `synapse-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.zip`);
    await writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
    await this.logger.log("info", "diagnostics.report.created", { runCount: runs.length, bytes: buffer.length });
    return { filePath, bytes: buffer.length, runCount: runs.length, warnings, files: files.map(f => f.name) };
  }
}
