import { randomUUID } from "node:crypto";
import type {
  ExecutionRow,
  PermissionLevel,
  RequestedBy,
  RiskLevel,
  Store,
} from "./db.ts";
import type { EventBus } from "./events.ts";
import { evaluatePolicy } from "./policy.ts";
import type { RegisteredTool, ToolRegistry } from "./registry.ts";

export interface ExecutionRequest {
  toolId: string;
  input: unknown;
  sessionId: string;
  requestedBy?: RequestedBy;
  idempotencyKey?: string;
}

export class ExecutionError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "ExecutionError";
    this.statusCode = statusCode;
  }
}

interface PendingApproval {
  tool: RegisteredTool;
  input: unknown;
  sessionId: string;
  requestedBy: RequestedBy;
  controller: AbortController;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ExecutionEngine {
  readonly #store: Store;
  readonly #registry: ToolRegistry;
  readonly #bus: EventBus;
  readonly #clock: () => Date;
  readonly #pendingApprovals = new Map<string, PendingApproval>();
  readonly #controllers = new Map<string, AbortController>();

  constructor(
    store: Store,
    registry: ToolRegistry,
    bus: EventBus,
    clock: () => Date = () => new Date(),
  ) {
    this.#store = store;
    this.#registry = registry;
    this.#bus = bus;
    this.#clock = clock;
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #emit(executionId: string, type: string, data?: unknown): void {
    const at = this.#now();
    this.#store.appendEvent(executionId, type, data, at);
    this.#bus.publish({ type, executionId, at, data });
  }

  #load(id: string): ExecutionRow {
    const row = this.#store.getExecution(id);
    if (!row) throw new ExecutionError(`execution not found: ${id}`, 404);
    return row;
  }

  #fail(id: string, message: string): ExecutionRow {
    this.#store.updateExecution(id, {
      status: "failed",
      finishedAt: this.#now(),
      error: message,
    });
    this.#emit(id, "execution.failed", { error: message });
    return this.#load(id);
  }

  async run(request: ExecutionRequest): Promise<ExecutionRow> {
    const tool = this.#registry.get(request.toolId);
    if (!tool) throw new ExecutionError(`unknown tool: ${request.toolId}`, 404);

    const parsed = tool.inputSchema.safeParse(request.input ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new ExecutionError(`invalid input for ${tool.id}: ${detail}`, 400);
    }

    if (request.idempotencyKey) {
      const existing = this.#store.findByIdempotencyKey(request.idempotencyKey);
      if (existing) return existing;
    }

    const requestedBy: RequestedBy = request.requestedBy ?? "text";
    const id = randomUUID();
    this.#store.createExecution({
      id,
      idempotencyKey: request.idempotencyKey ?? null,
      sessionId: request.sessionId,
      toolId: tool.id,
      requestedBy,
      inputJson: JSON.stringify(parsed.data),
      risk: tool.risk,
      permissionLevel: tool.permissionLevel,
      createdAt: this.#now(),
    });
    this.#emit(id, "execution.created", {
      toolId: tool.id,
      risk: tool.risk,
      permissionLevel: tool.permissionLevel,
    });

    const policy = evaluatePolicy({
      permissionLevel: tool.permissionLevel,
      risk: tool.risk,
      approved: false,
    });
    this.#store.updateExecution(id, { status: "policy_checked" });
    this.#emit(id, "policy.checked", policy);

    if (policy.decision === "deny") {
      return this.#fail(id, `policy denied: ${policy.reason}`);
    }

    if (policy.decision === "approve") {
      const controller = new AbortController();
      this.#pendingApprovals.set(id, {
        tool,
        input: parsed.data,
        sessionId: request.sessionId,
        requestedBy,
        controller,
      });
      this.#store.updateExecution(id, { status: "awaiting_approval" });
      this.#emit(id, "approval.required", {
        toolId: tool.id,
        risk: tool.risk,
        permissionLevel: tool.permissionLevel,
        reason: policy.reason,
      });
      return this.#load(id);
    }

    return this.#execute(id, tool, parsed.data, {
      sessionId: request.sessionId,
      requestedBy,
      approved: false,
    });
  }

  async approve(id: string): Promise<ExecutionRow> {
    const row = this.#load(id);
    if (row.status !== "awaiting_approval") {
      throw new ExecutionError(`execution is ${row.status}, not awaiting approval`, 409);
    }
    const pending = this.#pendingApprovals.get(id);
    if (!pending) {
      return this.#fail(id, "approval context expired before the user approved");
    }
    this.#pendingApprovals.delete(id);
    this.#store.updateExecution(id, { approvedAt: this.#now() });
    this.#emit(id, "approval.granted", { approvedBy: "user" });

    return this.#execute(id, pending.tool, pending.input, {
      sessionId: pending.sessionId,
      requestedBy: pending.requestedBy,
      approved: true,
      controller: pending.controller,
    });
  }

  cancel(id: string): ExecutionRow {
    const row = this.#load(id);
    if (row.status === "succeeded" || row.status === "failed" || row.status === "cancelled") {
      return row;
    }
    this.#pendingApprovals.get(id)?.controller.abort();
    this.#pendingApprovals.delete(id);
    this.#controllers.get(id)?.abort();
    this.#store.updateExecution(id, {
      status: "cancelled",
      finishedAt: this.#now(),
      error: "cancelled by user",
    });
    this.#emit(id, "execution.cancelled", {});
    return this.#load(id);
  }

  async #execute(
    id: string,
    tool: RegisteredTool,
    input: unknown,
    options: {
      sessionId: string;
      requestedBy: RequestedBy;
      approved: boolean;
      controller?: AbortController;
    },
  ): Promise<ExecutionRow> {
    const controller = options.controller ?? new AbortController();
    this.#controllers.set(id, controller);

    const timeoutMs = tool.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);

    const context = {
      executionId: id,
      sessionId: options.sessionId,
      signal,
      requestedBy: options.requestedBy,
      permissionState: { approved: options.approved },
    };

    this.#store.updateExecution(id, { status: "running", startedAt: this.#now() });
    this.#emit(id, "tool.started", { toolId: tool.id });

    try {
      let result;
      try {
        result = await tool.execute(input, context);
      } catch (error) {
        const cancelled = controller.signal.aborted;
        const timedOut = !cancelled && signal.aborted;
        const detail =
          error instanceof Error ? error.message : String(error);
        if (cancelled) {
          this.#emit(id, "execution.cancelled", { reason: detail });
          this.#store.updateExecution(id, {
            status: "cancelled",
            finishedAt: this.#now(),
            error: "cancelled by user",
          });
          return this.#load(id);
        }
        return this.#fail(
          id,
          timedOut ? `tool timed out after ${timeoutMs}ms` : detail,
        );
      }

      this.#emit(id, "tool.completed", result);
      this.#store.updateExecution(id, {
        status: "verifying",
        resultJson: JSON.stringify(result),
      });

      let verification;
      try {
        verification = await tool.verify(result, context);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return this.#fail(id, `verification failed: ${detail}`);
      }

      this.#emit(id, "verification.completed", verification);
      this.#store.updateExecution(id, {
        verificationJson: JSON.stringify(verification),
      });

      if (result.ok && verification.verified) {
        this.#store.updateExecution(id, {
          status: "succeeded",
          finishedAt: this.#now(),
        });
        this.#emit(id, "execution.succeeded", { summary: result.summary });
        return this.#load(id);
      }

      return this.#fail(
        id,
        verification.verified
          ? `tool reported failure: ${result.summary}`
          : `verification failed: ${verification.detail}`,
      );
    } finally {
      this.#controllers.delete(id);
    }
  }

  /** Exposed for tests and the dashboard: a truthful, typed view of a run. */
  get(id: string): ExecutionRow {
    return this.#load(id);
  }

  list(limit?: number): ExecutionRow[] {
    return this.#store.listExecutions(limit);
  }

  events(id: string) {
    this.#load(id);
    return this.#store.listEvents(id);
  }
}

export type { PermissionLevel, RiskLevel };
