import { randomUUID } from "node:crypto";
import { type MessageType, type RunRecord, type TeamMessage, SynapseError } from "./types.ts";

export function deliver(run: RunRecord, from: string, to: string, type: MessageType, body: string): TeamMessage {
  if (!["proposal", "evidence", "question", "challenge", "handoff", "blocker", "result", "note", "improvement"].includes(type)) throw new SynapseError("Invalid message type");
  const ids = new Set(run.tasks.map(t => t.id));
  if (from !== "coordinator" && !ids.has(from) && !(from.endsWith(":reviewer") && ids.has(from.slice(0, -9)))) throw new SynapseError("Unknown message sender");
  if (to !== "all" && to !== "coordinator" && !ids.has(to)) throw new SynapseError("Unknown message recipient");
  if (type === "improvement" && to !== "coordinator") throw new SynapseError("Improvement feedback must target coordinator");
  if (!body.trim() || body.length > 12_000) throw new SynapseError("Empty or oversized message");
  const message: TeamMessage = { id: randomUUID(), at: new Date().toISOString(), runId: run.id, from, to, type, body };
  const target = run.tasks.find(t => t.id === to);
  if (target) message.recipientStatusAtSend = target.status;
  run.messages.push(message);
  if (run.messages.length > run.options.maxMessages) run.messages.splice(0, run.messages.length - run.options.maxMessages);
  return message;
}

export function inbox(run: RunRecord, recipient: string): TeamMessage[] {
  return run.messages.filter(m => m.to === "all" || m.to === recipient || m.from === recipient).slice(-60);
}

export function event(run: RunRecord, type: string, detail: string, taskId?: string): void {
  run.events.push({ id: randomUUID(), at: new Date().toISOString(), type, detail, taskId });
  if (run.events.length > run.options.maxEvents) run.events.splice(0, run.events.length - run.options.maxEvents);
}
