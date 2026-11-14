import type { z } from "zod";
import type { PermissionLevel, RequestedBy, RiskLevel } from "./db.ts";

export interface ExecutionContext {
  executionId: string;
  sessionId: string;
  signal: AbortSignal;
  requestedBy: RequestedBy;
  permissionState: { approved: boolean };
}

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

export interface RollbackResult {
  rolledBack: boolean;
  detail: string;
}

/**
 * What the registry stores. Verification is not optional: an action NUMA
 * cannot check is an action NUMA must not claim.
 */
export interface RegisteredTool {
  id: string;
  description: string;
  risk: RiskLevel;
  permissionLevel: PermissionLevel;
  inputSchema: z.ZodTypeAny;
  execute(input: unknown, context: ExecutionContext): Promise<ToolResult>;
  verify(result: ToolResult, context: ExecutionContext): Promise<VerificationResult>;
  rollback?(result: ToolResult, context: ExecutionContext): Promise<RollbackResult>;
  timeoutMs?: number;
}

export type ToolDefinition<I> = Omit<
  RegisteredTool,
  "inputSchema" | "execute"
> & {
  inputSchema: z.ZodType<I>;
  execute(input: I, context: ExecutionContext): Promise<ToolResult>;
};

/** Keeps `input` typed at the definition site while the registry stays uniform. */
export function defineTool<I>(tool: ToolDefinition<I>): RegisteredTool {
  return tool as unknown as RegisteredTool;
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    if (this.#tools.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
    this.#tools.set(tool.id, tool);
  }

  get(id: string): RegisteredTool | undefined {
    return this.#tools.get(id);
  }

  list(): RegisteredTool[] {
    return [...this.#tools.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
}
