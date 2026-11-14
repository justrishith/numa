import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { Store } from "../src/db.ts";
import { EventBus, type NumaEvent } from "../src/events.ts";
import { ExecutionEngine, ExecutionError } from "../src/execution.ts";
import { defineTool, ToolRegistry } from "../src/registry.ts";

function harness() {
  const store = new Store(":memory:");
  const bus = new EventBus();
  const registry = new ToolRegistry();
  const events: NumaEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const engine = new ExecutionEngine(store, registry, bus);
  return { store, bus, registry, engine, events };
}

function countingTool(options: {
  permissionLevel?: 0 | 1 | 2 | 3 | 4;
  risk?: "low" | "medium" | "high";
  verified?: boolean;
} = {}) {
  let calls = 0;
  const tool = defineTool<{ value: string }>({
    id: "test.count",
    description: "counts executions",
    risk: options.risk ?? "low",
    permissionLevel: options.permissionLevel ?? 1,
    inputSchema: z.object({ value: z.string().min(1) }),
    async execute(input) {
      calls += 1;
      return { ok: true, summary: `ran ${input.value}`, data: { value: input.value } };
    },
    async verify() {
      return {
        verified: options.verified ?? true,
        detail: (options.verified ?? true) ? "checked" : "state did not match",
      };
    },
  });
  return { tool, calls: () => calls };
}

test("a run records a full lifecycle and succeeds only after verification", async () => {
  const { engine, registry, events } = harness();
  const counter = countingTool();
  registry.register(counter.tool);

  const row = await engine.run({
    toolId: "test.count",
    input: { value: "hello" },
    sessionId: "s1",
  });

  assert.equal(row.status, "succeeded");
  assert.equal(counter.calls(), 1);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "execution.created",
      "policy.checked",
      "tool.started",
      "tool.completed",
      "verification.completed",
      "execution.succeeded",
    ],
  );
});

test("a failed verification marks the execution failed", async () => {
  const { engine, registry } = harness();
  registry.register(countingTool({ verified: false }).tool);

  const row = await engine.run({
    toolId: "test.count",
    input: { value: "x" },
    sessionId: "s1",
  });

  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /verification failed/);
});

test("the same idempotency key runs the tool once", async () => {
  const { engine, registry } = harness();
  const counter = countingTool();
  registry.register(counter.tool);

  const first = await engine.run({
    toolId: "test.count",
    input: { value: "x" },
    sessionId: "s1",
    idempotencyKey: "key-1",
  });
  const second = await engine.run({
    toolId: "test.count",
    input: { value: "x" },
    sessionId: "s1",
    idempotencyKey: "key-1",
  });

  assert.equal(first.id, second.id);
  assert.equal(counter.calls(), 1);
});

test("confirmation-level tools wait for approval, then run", async () => {
  const { engine, registry } = harness();
  const counter = countingTool({ permissionLevel: 2 });
  registry.register(counter.tool);

  const pending = await engine.run({
    toolId: "test.count",
    input: { value: "x" },
    sessionId: "s1",
  });
  assert.equal(pending.status, "awaiting_approval");
  assert.equal(counter.calls(), 0);

  const approved = await engine.approve(pending.id);
  assert.equal(approved.status, "succeeded");
  assert.equal(counter.calls(), 1);
});

test("approving an execution that is not pending is a conflict", async () => {
  const { engine, registry } = harness();
  registry.register(countingTool().tool);
  const row = await engine.run({ toolId: "test.count", input: { value: "x" }, sessionId: "s1" });

  await assert.rejects(
    () => engine.approve(row.id),
    (error: unknown) => error instanceof ExecutionError && error.statusCode === 409,
  );
});

test("cancelling a pending approval never runs the tool", async () => {
  const { engine, registry } = harness();
  const counter = countingTool({ permissionLevel: 2 });
  registry.register(counter.tool);

  const pending = await engine.run({
    toolId: "test.count",
    input: { value: "x" },
    sessionId: "s1",
  });
  const cancelled = engine.cancel(pending.id);

  assert.equal(cancelled.status, "cancelled");
  assert.equal(counter.calls(), 0);
  await assert.rejects(
    () => engine.approve(pending.id),
    (error: unknown) => error instanceof ExecutionError && error.statusCode === 409,
  );
});

test("locked capabilities are denied by policy and never executed", async () => {
  const { engine, registry } = harness();
  const counter = countingTool({ permissionLevel: 4 });
  registry.register(counter.tool);

  const row = await engine.run({ toolId: "test.count", input: { value: "x" }, sessionId: "s1" });

  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /policy denied/);
  assert.equal(counter.calls(), 0);
});

test("unknown tools and invalid input are rejected before execution", async () => {
  const { engine, registry } = harness();
  registry.register(countingTool().tool);

  await assert.rejects(
    () => engine.run({ toolId: "nope", input: {}, sessionId: "s1" }),
    (error: unknown) => error instanceof ExecutionError && error.statusCode === 404,
  );
  await assert.rejects(
    () => engine.run({ toolId: "test.count", input: { value: "" }, sessionId: "s1" }),
    (error: unknown) => error instanceof ExecutionError && error.statusCode === 400,
  );
});

test("a tool that throws is recorded as failed, not as success", async () => {
  const { engine, registry } = harness();
  registry.register(
    defineTool<Record<string, never>>({
      id: "test.boom",
      description: "throws",
      risk: "low",
      permissionLevel: 1,
      inputSchema: z.object({}),
      async execute() {
        throw new Error("device unavailable");
      },
      async verify() {
        return { verified: true, detail: "unused" };
      },
    }),
  );

  const row = await engine.run({ toolId: "test.boom", input: {}, sessionId: "s1" });
  assert.equal(row.status, "failed");
  assert.match(row.error ?? "", /device unavailable/);
});
