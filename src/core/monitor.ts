/** Offline, read-only metadata view. Heartbeats measure the wrapper, not model progress. */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { FileStore } from "./store.ts";
import { DiagnosticLogger, redact, type LogEntry } from "./diagnostics.ts";
import { VERSION } from "./version.ts";
const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const safe = (v: unknown) => redact(String(v ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160);
export async function availableRuns(directory: string) {
  const store = new FileStore(directory);
  const names = (await readdir(directory).catch(() => [])).filter(n => /^run_[a-f0-9-]{36}\.json$/.test(n));
  const results = await Promise.all(names.map(async n => {
    try { const r = await store.read(n.slice(0,-5)); return { id: r.id, status: r.status, updatedAt: r.updatedAt }; }
    catch { return undefined; }
  }));
  return results.filter(r => r !== undefined).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function inspectRun(directory: string, id: string, now = Date.now()) {
  const run = await new FileStore(directory).read(id);
  const raw = await new DiagnosticLogger(join(directory,"diagnostics")).recent(10000, 4_000_000);
  const entries: LogEntry[] = [];
  for (const line of raw.split("\n")) {
    try { const row = JSON.parse(line); if (typeof row.event === "string" && row.fields && typeof row.at === "string") entries.push(row); } catch { /* malformed or partial log line */ }
  }
  const logs = entries.filter(e => e.fields.runId === id);
  const observedVersion = entries.filter(e => e.event === "plugin.setup.completed").at(-1)?.fields.version;
  const sessions = new Map<string, {taskId:string; sessionId:string; phase:string; lastAt:string; lastHeartbeatAt?:string; role?:string; promptMs?:number; waitMs?:number; setupMs?:number; durationMs?:number; channel?:string; completed?:boolean}>();
  for (const row of logs) {
    if (!row.event.startsWith("agent.") || typeof row.fields.sessionId !== "string") continue;
    const id = row.fields.sessionId;
    const s = sessions.get(id) ?? {taskId:safe(row.fields.taskId),sessionId:safe(id),phase:"created",lastAt:row.at};
    s.lastAt = row.at;
    if (row.fields.role === "worker" || row.fields.role === "review") s.role = row.fields.role;
    switch (row.event) {
      case "agent.setup.completed": s.setupMs=num(row.fields.durationMs); break;
      case "agent.prompt.started": s.phase="prompt"; break;
      case "agent.prompt.completed": s.promptMs=num(row.fields.durationMs); break;
      case "agent.wait.started": s.phase="wait"; break;
      case "agent.timeout": s.phase="timeout"; break;
      case "agent.wait.completed": s.waitMs=num(row.fields.durationMs); break;
      case "agent.heartbeat": s.lastHeartbeatAt=row.at; s.phase=safe(row.fields.phase); break;
      case "agent.result.received": s.channel=safe(row.fields.channel); s.phase="result"; break;
      case "agent.result.context": s.channel="context"; s.phase="result"; break;
      case "agent.review.completed": case "agent.review.protocol_error": case "agent.execute.completed":
        s.role=row.event.includes("review")?"review":"worker"; s.phase="finished"; s.durationMs=num(row.fields.durationMs); s.completed=true; break;
    }
    sessions.set(id,s);
  }
  const tasks = run.tasks.map(t => {
    const last = [...sessions.values()].filter(s => s.taskId === t.id).at(-1);
    const ageMs = last ? Math.max(0, now-Date.parse(last.lastAt)) : undefined;
    const active = t.status === "running" || t.status === "review";
    return {id:t.id,role:safe(t.role),status:t.status,dependsOn:t.dependsOn,attempts:t.attempts,
      elapsedMs:t.startedAt ? Math.max(0,(active?now:Date.parse(t.endedAt ?? run.updatedAt))-Date.parse(t.startedAt)) : undefined,
      contract: t.contract ? { required: true, missingCount: t.contractEvidence?.missing?.length, verified: t.contractEvidence?.missing?.length === 0 } : undefined,
      session:last?.sessionId, phase:active?last?.phase:undefined, lastEventAgeMs:ageMs,
      warning: active && ageMs !== undefined && ageMs>45000 ? "No recent session log (possible stall; not proven)" : undefined};
  });
  const direct = run.messages.filter(m => m.to !== "all" && m.to !== "coordinator");
  const late = direct.filter(m=>m.recipientStatusAtSend && terminal.has(m.recipientStatusAtSend));
  const fetched = direct.filter(m=>Object.hasOwn(m.fetchedBy ?? {},m.to));
  const reviewMs=[...sessions.values()].filter(s=>s.role==="review"&&s.completed).reduce((n,s)=>n+(s.durationMs??0),0);
  const workerMs=[...sessions.values()].filter(s=>s.role==="worker"&&s.completed).reduce((n,s)=>n+(s.durationMs??0),0);
  return {version:VERSION,observedVersion:typeof observedVersion==="string"?safe(observedVersion):null,runId:run.id,status:run.status,concurrency:run.options.concurrency,
    completed:tasks.filter(t=>t.status==="completed").length,total:tasks.length,tasks,sessions:[...sessions.values()],
    metrics:{workerMs,reviewMs, directMessages:direct.length,lateMessages:late.length,explicitInboxFetches:fetched.length,
      contractFailures: run.tasks.filter(t=>t.contractEvidence?.missing?.length).length, timeouts: logs.filter(e=>e.event==="agent.timeout").length,
      contextOmittedMessages:logs.filter(e=>e.event==="agent.context.prepared").reduce((n,e)=>n+(num(e.fields.omittedMessages)??0),0),
      contextMessageChars:logs.filter(e=>e.event==="agent.context.prepared").reduce((n,e)=>n+(num(e.fields.messageChars)??0),0),
      unknownDeliveryStatus:direct.filter(m=>m.recipientStatusAtSend===undefined).length},
    recentEvents:logs.slice(-12).map(e=>({at:e.at,event:safe(e.event),taskId:safe(e.fields.taskId),from:safe(e.fields.from),to:safe(e.fields.to)})),
    caveat:"Timings cover retained logs only; sums are session time, not wall time. Inbox retrieval is not proof of reading. Heartbeats are not model activity."};
}
export function renderMonitor(view: Awaited<ReturnType<typeof inspectRun>>) {
  const seconds=(ms:number|undefined)=>ms===undefined?"-":`${(ms/1000).toFixed(1)}s`;
  return [`SYNAPSE LIVE | CLI ${view.version} | last startup: ${view.observedVersion??"unknown"}`,
    `${view.runId}  ${view.status}  ${view.completed}/${view.total} completed  concurrency ${view.concurrency}`,
    ...view.tasks.map(t=>`${t.id.padEnd(18)} ${t.status.padEnd(10)} ${seconds(t.elapsedMs).padStart(9)}  ${t.phase??""}  deps=${t.dependsOn.join(",")||"-"}${t.warning?`  ! ${t.warning}`:""}`),
    `Workers ${seconds(view.metrics.workerMs)} | Reviews ${seconds(view.metrics.reviewMs)} | Direct ${view.metrics.directMessages} | Late ${view.metrics.lateMessages} | Fetched ${view.metrics.explicitInboxFetches}`,
    `Contracts unmet ${view.metrics.contractFailures} | Session timeouts (retained logs) ${view.metrics.timeouts}`,
    `Context: ${view.metrics.contextOmittedMessages} omitted messages | ${view.metrics.contextMessageChars} message chars (retained logs)`,
    "Recent events:",...view.recentEvents.map(e=>`${e.at} ${e.event} ${e.taskId} ${e.from&&e.to?`${e.from} -> ${e.to}`:""}`),view.caveat].join("\n");
}
