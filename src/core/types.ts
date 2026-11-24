import type { FailureSource } from "./provider.ts";
import type { PatchContract } from "./contributions.ts";
/** Synapse's durable public data contracts. */
export type TaskStatus = "pending" | "running" | "review" | "completed" | "failed" | "blocked" | "cancelled";
export type RunStatus = "planned" | "running" | "completed" | "failed" | "cancelled";
export type MessageType = "proposal" | "evidence" | "question" | "challenge" | "handoff" | "blocker" | "result" | "note" | "improvement";

/** Obligations enforced from observed actions, not model assertions. */
export interface CollaborationContract {
  requireSubmit?: boolean;
  sendTo?: string[];
  receiveFrom?: string[];
}
export interface ContractEvidence {
  attempt: number;
  sentTo: string[];
  receivedFrom: string[];
  channel?: "submit" | "context";
  missing?: string[];
}
export interface ExactVerification { kind: "exact"; expected: string }
export interface TaskSpec {
  id: string;
  title: string;
  instruction: string;
  role?: string;
  dependsOn?: string[];
  priority?: number;
  review?: boolean;
  maxAttempts?: number;
  patch?: PatchContract;
  contract?: CollaborationContract;
  timeoutSeconds?: number;
  verification?: ExactVerification;
  toolProfile?: "lean";
}

export interface TaskRecord extends Required<Omit<TaskSpec, "role" | "patch" | "contract" | "timeoutSeconds" | "verification" | "toolProfile">> {
  role: string;
  patch?: PatchContract;
  contract?: CollaborationContract;
  timeoutSeconds?: number;
  verification?: ExactVerification;
  toolProfile?: "lean";
  verificationEvidence?: { attempt: number; passed: boolean };
  contractEvidence?: ContractEvidence;
  status: TaskStatus;
  attempts: number;
  result?: string;
  reviewResult?: string;
  error?: string;
  failureSource?: FailureSource;
  workerSession?: string;
  reviewerSession?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface TeamMessage {
  id: string;
  at: string;
  runId: string;
  from: string;
  to: string;
  type: MessageType;
  body: string;
  recipientStatusAtSend?: TaskStatus;
  fetchedBy?: Record<string, string>;
  senderAttempt?: number;
}

export interface RunEvent {
  id: string;
  at: string;
  type: string;
  taskId?: string;
  detail: string;
}

export interface RunRecord {
  schema: 1;
  id: string;
  objective: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  tasks: TaskRecord[];
  messages: TeamMessage[];
  events: RunEvent[];
  options: {
    concurrency: number;
    maxMessages: number;
    maxEvents: number;
    sessionBudget?: number;
  };
}

export type AgentContext = {
  runId: string;
  objective: string;
  task: TaskRecord;
  dependencies: { id: string; result: string }[];
  messages: TeamMessage[];
  signal: AbortSignal;
  onSession?: (sessionID: string) => void;
  purpose?: "council";
  verificationKind?: "exact"; // no expected answer in agent context
};

export interface AgentResult { text: string; sessionID?: string; channel?: "submit" | "context" }
export interface ReviewResult { approved: boolean; reason: string; sessionID?: string; protocolError?: boolean }
export interface AgentAdapter {
  execute(context: AgentContext): Promise<AgentResult>;
  review?(context: AgentContext & { result: string }): Promise<ReviewResult>;
  cancel?(sessionID: string): Promise<void>;
}

export class SynapseError extends Error {
  constructor(message: string) { super(message); this.name = "SynapseError"; }
}

/** A timeout is not evidence that the remote session stopped. Never auto-retry it. */
export class SessionTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "SessionTimeoutError"; }
}
