/**
 * The coding lane: NUMA drives OpenCode sessions as its executor.
 *
 * OpenCode already owns file edits, shells, tests, git, skills and subagents,
 * and runs as a local background service. The gateway decides when to use it,
 * records what it asked for, and keeps the conversation; it does not rebuild a
 * coding harness. This module is the thin client, ported from the old
 * `numa-core.mjs` OpenCode bridge.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UpstreamError } from "./audio.ts";

const DEFAULT_OPENCODE_PORT = 28894;

/**
 * The one place the OpenCode URL is decided.
 *
 * Both the client (health, ask) and the lifecycle supervisor resolve it here.
 * They used to compute it separately, so a port override made the supervisor
 * start a server the client never talked to — health read "up" from a different
 * process while the lane was actually dead.
 */
export function resolveOpenCodeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.NUMA_OPENCODE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const raw = env.NUMA_OPENCODE_PORT?.trim();
  const port = raw ? Number(raw) : DEFAULT_OPENCODE_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid NUMA_OPENCODE_PORT: ${raw}`);
  }
  return `http://127.0.0.1:${port}`;
}

/** How long one prompt may run before the gateway gives up. */
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 200;

const SYSTEM_PROMPT = `You are NUMA, the user's local Windows assistant with a coding lane.
Be concise and natural: your reply is usually spoken aloud through a small notch on screen.
You can carry out real coding work in this session: read and edit files, run commands and tests, use git, and verify results.
Never claim an action succeeded unless the tool output confirms it. If a step failed, say so plainly and say what you tried.
Ask before destructive, irreversible, financial, credential, or message-sending actions.
Prefer the project's existing structure, naming and style, and run its build or tests before calling work done.
If the user asks for something outside coding, answer directly without inventing work.`;

export interface OpenCodeConfig {
  url: string;
  headers: Record<string, string>;
}

function servicePassword(): string {
  const configured = process.env.OPENCODE_PASSWORD?.trim();
  if (configured) return configured;
  try {
    const service = JSON.parse(
      readFileSync(join(homedir(), ".config", "opencode", "service.json"), "utf8"),
    ) as { password?: string };
    return typeof service.password === "string" ? service.password : "";
  } catch {
    return "";
  }
}

/**
 * The URL this process is actually talking to.
 *
 * The managed service decides its own port (from `opencode service set port`),
 * so a value computed from env is only a first guess. Once the supervisor sees
 * the real URL it records it here, and every later client call follows it.
 * Without this, health could report "up" from one process while the coding lane
 * talked to a different, dead one.
 */
let activeUrl: string | null = null;

export function adoptOpenCodeUrl(url: string): void {
  activeUrl = url.replace(/\/$/, "");
}

/** Test seam: forget the adopted URL so cases cannot leak into each other. */
export function resetOpenCodeUrl(): void {
  activeUrl = null;
}

export function openCodeConfig(env: NodeJS.ProcessEnv = process.env): OpenCodeConfig {
  const url = activeUrl ?? resolveOpenCodeUrl(env);
  const headers: Record<string, string> = {};
  const password = servicePassword();
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  } else if (env.OPENCODE_API_KEY?.trim()) {
    headers.authorization = `Bearer ${env.OPENCODE_API_KEY.trim()}`;
  }
  return { url, headers };
}

interface OpenCodeError extends Error {
  statusCode?: number;
}

async function request(
  path: string,
  options: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  config: OpenCodeConfig = openCodeConfig(),
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(`${config.url}${path}`, {
    ...options,
    headers: {
      ...config.headers,
      "content-type": "application/json",
      ...((options.headers as Record<string, string>) ?? {}),
    },
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const detail =
      (typeof body.message === "string" && body.message) ||
      (typeof body.error === "string" && body.error) ||
      `OpenCode returned HTTP ${response.status}`;
    throw new UpstreamError(detail, response.status >= 500 ? 502 : response.status);
  }
  return body;
}

interface ModelEntry {
  id?: string;
  modelID?: string;
  providerID?: string;
  status?: string;
  enabled?: boolean;
  capabilities?: { tools?: boolean };
}

/** Pick a tools-capable model, preferring the ones that have worked locally. */
function scoreModel(entry: ModelEntry): number {
  const provider = String(entry.providerID ?? "");
  const id = String(entry.modelID ?? entry.id ?? "");
  if (provider === "xkrio" && id === "stealth/big-pickle") return 100;
  if (provider === "xkrio" && id.includes("qwen3.7-flash")) return 95;
  if (provider === "xkrio" && id.includes("qwen3")) return 90;
  if (provider === "opencode-go") return 80;
  if (provider === "opencode") return 70;
  return 10;
}

let cachedModel: string | null = null;
let sessionId: string | null = null;
let sessionPromise: Promise<string> | null = null;

async function discoverModel(
  fetchImpl: typeof fetch,
  config: OpenCodeConfig,
): Promise<string> {
  const configured = process.env.NUMA_OPENCODE_MODEL?.trim();
  if (configured) return configured;
  if (cachedModel) return cachedModel;

  const catalog = await request("/api/model", {}, fetchImpl, config);
  const models: ModelEntry[] = Array.isArray(catalog)
    ? (catalog as ModelEntry[])
    : Array.isArray(catalog.data)
      ? (catalog.data as ModelEntry[])
      : [];
  const usable = models.filter(
    (entry) =>
      entry.status === "active" &&
      entry.enabled !== false &&
      entry.capabilities?.tools === true &&
      entry.id !== "openrouter/free" &&
      !String(entry.id ?? "").toLowerCase().includes("free-router"),
  );
  const candidate = usable.sort((a, b) => scoreModel(b) - scoreModel(a))[0];
  const modelId = candidate?.modelID ?? candidate?.id;
  if (!candidate?.providerID || !modelId) {
    throw new UpstreamError(
      "OpenCode has no active tools-capable model (Free Router is disabled)",
      503,
    );
  }
  cachedModel = `${candidate.providerID}/${modelId}`;
  return cachedModel;
}

async function createSession(
  fetchImpl: typeof fetch,
  config: OpenCodeConfig,
): Promise<string> {
  // `opencode serve` is location-scoped; creating in its active location avoids
  // the server rejecting a project it has not loaded yet.
  const model = await discoverModel(fetchImpl, config);
  const slash = model.indexOf("/");
  const providerID = slash > 0 ? model.slice(0, slash) : model;
  const modelID = slash > 0 ? model.slice(slash + 1) : model;
  const body = await request(
    "/api/session",
    {
      method: "POST",
      body: JSON.stringify({ title: "NUMA", model: { providerID, id: modelID } }),
    },
    fetchImpl,
    config,
  );
  const data = body.data as { id?: string } | undefined;
  const id = data?.id ?? (typeof body.id === "string" ? body.id : null);
  if (!id) throw new UpstreamError("OpenCode did not return a session id", 502);
  return id;
}

async function getSession(
  fetchImpl: typeof fetch,
  config: OpenCodeConfig,
): Promise<string> {
  if (sessionId) return sessionId;
  if (!sessionPromise) {
    sessionPromise = createSession(fetchImpl, config)
      .then((id) => {
        sessionId = id;
        return id;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }
  return sessionPromise;
}

function assistantText(message: unknown): string {
  const content = (message as { content?: { type?: string; text?: string }[] } | null)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function readProfile(): { lines: string[] } {
  const path =
    process.env.NUMA_PROFILE_FILE ||
    join(process.env.LOCALAPPDATA || homedir(), "Poni", "numa", "profile.json");
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      displayName?: string;
      goals?: string[];
      routines?: string[];
      preferences?: Record<string, unknown>;
    };
    const lines = ["Local user profile (context only; do not invent facts):"];
    if (value.displayName) lines.push(`- Name: ${value.displayName}`);
    if (Array.isArray(value.goals) && value.goals.length) {
      lines.push(`- Goals: ${value.goals.join("; ")}`);
    }
    if (Array.isArray(value.routines) && value.routines.length) {
      lines.push(`- Routines: ${value.routines.join("; ")}`);
    }
    for (const [key, entry] of Object.entries(value.preferences ?? {})) {
      lines.push(`- ${key}: ${String(entry)}`);
    }
    return { lines };
  } catch {
    return { lines: [] };
  }
}

async function readReply(
  id: string,
  fetchImpl: typeof fetch,
  config: OpenCodeConfig,
): Promise<string> {
  const messages = await request(
    `/api/session/${encodeURIComponent(id)}/message`,
    {},
    fetchImpl,
    config,
  );
  const data = Array.isArray(messages.data) ? messages.data : [];
  const assistant = [...data]
    .reverse()
    .find((message) => (message as { type?: string })?.type === "assistant") as
    | {
        content?: { type?: string; text?: string }[];
        error?: { message?: string };
        retry?: { error?: { message?: string; status?: number } };
      }
    | undefined;
  if (!assistant) return "";
  const reply = assistantText(assistant);
  if (reply) return reply;
  if (assistant.error?.message) throw new UpstreamError(assistant.error.message, 502);
  if (assistant.retry?.error?.message) {
    throw new UpstreamError(
      assistant.retry.error.message,
      assistant.retry.error.status === 429 ? 429 : 502,
    );
  }
  return "";
}

export interface AskResult {
  text: string;
  sessionId: string;
  ms: number;
}

/**
 * Send one request to a NUMA OpenCode session and wait for the assistant's
 * final text. The session is reused, so follow-ups keep context.
 */
export async function askOpenCode(
  text: string,
  fetchImpl: typeof fetch = fetch,
  config: OpenCodeConfig = openCodeConfig(),
): Promise<AskResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new UpstreamError("message is empty", 400);

  const started = performance.now();
  const prompt = `${SYSTEM_PROMPT}\n\n${readProfile().lines.join("\n")}\n\nUser request:\n${trimmed}`;

  const ask = async (id: string): Promise<string> => {
    await request(
      `/api/session/${encodeURIComponent(id)}/prompt`,
      { method: "POST", body: JSON.stringify({ text: prompt }) },
      fetchImpl,
      config,
    );
    try {
      // V2 waits inside the server until the tool loop is idle, which is far
      // cheaper than downloading the whole transcript on every poll.
      await request(
        `/api/experimental/session/${encodeURIComponent(id)}/wait`,
        { method: "POST" },
        fetchImpl,
        config,
      );
      const reply = await readReply(id, fetchImpl, config);
      if (reply) return reply;
    } catch (error) {
      if (![404, 405].includes((error as OpenCodeError).statusCode ?? 0)) throw error;
    }

    const deadline = Date.now() + PROMPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const reply = await readReply(id, fetchImpl, config);
      if (reply) return reply;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new UpstreamError("OpenCode timed out without an assistant response", 504);
  };

  try {
    const id = await getSession(fetchImpl, config);
    return { text: await ask(id), sessionId: id, ms: Math.round(performance.now() - started) };
  } catch (error) {
    // A stale session after a server restart is recoverable once.
    if ((error as OpenCodeError).statusCode === 404) {
      sessionId = null;
      const replacement = await getSession(fetchImpl, config);
      return {
        text: await ask(replacement),
        sessionId: replacement,
        ms: Math.round(performance.now() - started),
      };
    }
    throw error;
  }
}

export async function openCodeHealth(
  fetchImpl: typeof fetch = fetch,
  config: OpenCodeConfig = openCodeConfig(),
): Promise<{ up: boolean; detail?: string }> {
  try {
    // `/global/health` serves the web shell on v2, so it answers 200 even when
    // the API is unauthenticated. `/api/info` proves the API itself is usable.
    await request("/api/info", {}, fetchImpl, config);
    return { up: true };
  } catch (error) {
    return { up: false, detail: (error as Error).message };
  }
}

/** True when the request never reached a server, which a restart can fix. */
export function isConnectionFailure(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return cause?.code === "ECONNREFUSED" || cause?.code === "ECONNRESET";
}

/** Warm the session so the first spoken request is not the slow one. */
export function warmOpenCode(): void {
  const config = openCodeConfig();
  void getSession(fetch, config).catch(() => {});
}

/** Reset cached session/model state. Tests use it; nothing else should. */
export function resetOpenCodeState(): void {
  cachedModel = null;
  sessionId = null;
  sessionPromise = null;
}
