export type ExecutionStatus =
  | "created"
  | "policy_checked"
  | "awaiting_approval"
  | "running"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

export interface VerificationResult {
  verified: boolean;
  detail: string;
  data?: unknown;
}

export interface Execution {
  id: string;
  sessionId: string;
  toolId: string;
  requestedBy: string;
  input: unknown;
  status: ExecutionStatus;
  risk: "low" | "medium" | "high";
  permissionLevel: number;
  approvedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  result: ToolResult | null;
  verification: VerificationResult | null;
  error: string | null;
  createdAt: string;
}

export interface Tool {
  id: string;
  description: string;
  risk: "low" | "medium" | "high";
  permissionLevel: number;
}

export interface NumaEvent {
  type: string;
  executionId?: string;
  at: string;
  data?: unknown;
}
