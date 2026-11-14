import websocket from "@fastify/websocket";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { z } from "zod";
import { appIndex } from "./apps.ts";
import { MAX_SPEECH_BYTES, UpstreamError, deepgramKey, synthesize, transcribe } from "./audio.ts";
import type { ExecutionRow, Store } from "./db.ts";
import type { EventBus } from "./events.ts";
import { ExecutionError, type ExecutionEngine } from "./execution.ts";
import { askOpenCode, isConnectionFailure, openCodeHealth } from "./opencode.ts";
import { ensureOpenCodeOnce } from "./opencode-service.ts";
import type { ToolRegistry } from "./registry.ts";
import { type RouteMatch, routeText } from "./router.ts";

const executionRequestSchema = z.object({
  toolId: z.string().min(1),
  input: z.unknown().optional(),
  sessionId: z.string().min(1).max(200).default("local"),
  requestedBy: z.enum(["voice", "text", "telegram", "routine"]).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

const commandSchema = z.object({
  text: z.string().min(1).max(500),
  sessionId: z.string().min(1).max(200).default("local"),
  requestedBy: z.enum(["voice", "text", "telegram", "routine"]).optional(),
});

const askSchema = z.object({
  text: z.string().min(1).max(8000),
});

const speechSchema = z.object({
  input: z.string().min(1).max(8000),
});

function serialize(row: ExecutionRow) {  return {
    id: row.id,
    sessionId: row.session_id,
    toolId: row.tool_id,
    requestedBy: row.requested_by,
    input: JSON.parse(row.input_json) as unknown,
    status: row.status,
    risk: row.risk,
    permissionLevel: row.permission_level,
    approvedAt: row.approved_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    result: row.result_json ? (JSON.parse(row.result_json) as unknown) : null,
    verification: row.verification_json
      ? (JSON.parse(row.verification_json) as unknown)
      : null,
    error: row.error,
    createdAt: row.created_at,
  };
}

/**
 * What NUMA says after a fast-lane action. The status is the truth: a run that
 * never verified must not be spoken as "opening it".
 */
function spokenAppReply(row: ExecutionRow, route: RouteMatch): string {
  const result = row.result_json
    ? (JSON.parse(row.result_json) as { data?: { label?: string } })
    : null;
  const verification = row.verification_json
    ? (JSON.parse(row.verification_json) as { detail?: string })
    : null;
  const label =
    result?.data?.label ??
    (typeof route.input["app"] === "string" ? (route.input["app"] as string) : "it");
  if (row.status === "succeeded") {
    // Saying "opening" for something that was already on screen is a small lie
    // the user can see through.
    if (verification?.detail?.includes("already")) return `${label} is already open.`;
    return `Opening ${label}.`;
  }
  if (row.status === "awaiting_approval") return "That needs your approval first.";
  if (row.status === "cancelled") return "Cancelled.";
  return `I couldn't open ${label}.`;
}

export interface GatewayDeps {  engine: ExecutionEngine;
  registry: ToolRegistry;
  bus: EventBus;
  store: Store;
  logLevel?: string;
}

export async function buildServer(deps: GatewayDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.logLevel ?? "info" },
    bodyLimit: 2 * 1024 * 1024,
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof ExecutionError || error instanceof UpstreamError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }
    if (error.validation) {
      return reply.status(400).send({ error: error.message });
    }
    app.log.error(error);
    return reply.status(500).send({ error: "internal gateway error" });
  });

  // Finished WAVs arrive as raw bytes; JSON parsing would corrupt them.
  app.addContentTypeParser(
    ["audio/wav", "audio/wave", "application/octet-stream"],
    { parseAs: "buffer", bodyLimit: MAX_SPEECH_BYTES },
    (_request, body, done) => done(null, body),
  );

  app.get("/v1/health", async () => {
    const opencode = await openCodeHealth();
    return {
      gateway: "up",
      db: "up",
      tools: deps.registry.list().length,
      stt: deepgramKey() ? "configured" : "missing_key",
      opencode: opencode.up ? "up" : "down",
    };
  });

  app.get("/v1/tools", async () =>
    deps.registry.list().map((tool) => ({
      id: tool.id,
      description: tool.description,
      risk: tool.risk,
      permissionLevel: tool.permissionLevel,
    })),
  );

  app.post("/v1/executions", async (request, reply) => {
    const parsed = executionRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      });
    }
    const { toolId, input, sessionId, requestedBy, idempotencyKey } = parsed.data;
    const row = await deps.engine.run({
      toolId,
      input: input ?? {},
      sessionId,
      ...(requestedBy ? { requestedBy } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return reply.status(202).send(serialize(row));
  });

  app.post("/v1/commands", async (request, reply) => {
    const parsed = commandSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      });
    }
    const { text, sessionId, requestedBy } = parsed.data;
    const route = routeText(text, await appIndex());
    if (!route) {
      return reply.status(422).send({ error: `no deterministic route for: ${text}` });
    }
    const row = await deps.engine.run({
      toolId: route.toolId,
      input: route.input,
      sessionId,
      ...(requestedBy ? { requestedBy } : {}),
    });
    return reply.status(202).send({ ...serialize(row), route: route.matched });
  });

  app.post("/v1/audio", async (request, reply) => {
    const audio = request.body;
    if (!Buffer.isBuffer(audio)) {
      return reply.status(400).send({ error: "expected a WAV body" });
    }
    const result = await transcribe(audio);
    return reply.status(200).send(result);
  });

  app.post("/v1/speech", async (request, reply) => {
    const parsed = speechSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
    }
    const audio = await synthesize(parsed.data.input);
    return reply.status(200).type("audio/wav").send(audio);
  });

  app.post("/v1/ask", async (request, reply) => {
    const parsed = askSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      });
    }

    // Fast lane first: "open youtube music" is an action, not a question, and
    // must not wait for a model to agree with it.
    const route = routeText(parsed.data.text, await appIndex());
    if (route) {
      const started = performance.now();
      const row = await deps.engine.run({
        toolId: route.toolId,
        input: route.input,
        sessionId: "voice",
        requestedBy: "voice",
      });
      return reply.status(200).send({
        reply: spokenAppReply(row, route),
        route: route.matched,
        status: row.status,
        executionId: row.id,
        ms: Math.round(performance.now() - started),
      });
    }

    let result;
    try {
      result = await askOpenCode(parsed.data.text);
    } catch (error) {
      // A dead server between boot and now is recoverable: start it and retry
      // once, rather than surfacing a 502 the user can do nothing about.
      if (!isConnectionFailure(error)) throw error;
      await ensureOpenCodeOnce();
      result = await askOpenCode(parsed.data.text);
    }
    return reply.status(200).send({
      reply: result.text,
      route: "opencode",
      sessionId: result.sessionId,
      ms: result.ms,
    });
  });

  app.get("/v1/executions", async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 50);
    return deps.engine.list(Number.isFinite(limit) ? limit : 50).map(serialize);
  });

  app.get("/v1/executions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return serialize(deps.engine.get(id));
    } catch (error) {
      if (error instanceof ExecutionError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/executions/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return deps.engine.events(id).map((event) => ({
        id: event.id,
        type: event.type,
        at: event.at,
        data: event.payload_json ? (JSON.parse(event.payload_json) as unknown) : null,
      }));
    } catch (error) {
      if (error instanceof ExecutionError) {
        return reply.status(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/executions/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.status(200).send(serialize(await deps.engine.approve(id)));
  });

  app.post("/v1/executions/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.status(200).send(serialize(deps.engine.cancel(id)));
  });

  await app.register(websocket);

  app.get("/v1/events", { websocket: true }, (socket) => {
    const send = (payload: unknown) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    };
    send({ type: "gateway.ready", at: new Date().toISOString() });
    const unsubscribe = deps.bus.subscribe(send);
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });

  return app;
}
