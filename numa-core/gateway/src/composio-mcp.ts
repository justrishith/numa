/**
 * Composio over MCP.
 *
 * Connectors ride Composio's hosted MCP endpoint using the OAuth identity that
 * already lives in OpenCode's credential store — the same identity the agent
 * harness holds, so the gateway never needs its own API key and never stores
 * OAuth tokens of its own.
 *
 * Responsibilities:
 * - read/refresh/persist the Composio credential row from OpenCode's database
 * - speak JSON-RPC (streamable HTTP MCP) with session handling
 * - retry once on 401 after a forced token refresh
 *
 * The transport is injectable for tests.
 */

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ComposioCredential {
  refresh: string;
  access: string;
  expires: number;
  clientId: string;
  issuer: string;
  serverUrl: string;
  /** Raw JSON of the credential row, for writing back a refreshed token. */
  raw: string;
}

export interface ComposioMcpConfig {
  dbPath: string;
  mcpUrl: string;
  clientName: string;
}

export function composioMcpConfig(env: NodeJS.ProcessEnv = process.env): ComposioMcpConfig {
  const dataDir = env.NUMA_OPENCODE_DATA_DIR ?? join(homedir(), ".local", "share", "opencode");
  return {
    dbPath: join(dataDir, "opencode.db"),
    mcpUrl: env.NUMA_COMPOSIO_MCP_URL?.trim() || "https://connect.composio.dev/mcp",
    clientName: "numa-gateway",
  };
}

/**
 * Load the Composio credential OpenCode persists for its MCP connection.
 * Returns null when the machine has no Composio identity — the gateway then
 * boots without connectors instead of failing.
 */
export function loadComposioCredential(dbPath: string): ComposioCredential | null {
  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath);
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare(
        "select value from credential where integration_id like 'mcp_%' and label = 'composio' and active = '1' limit 1",
      )
      .get() as { value: string } | undefined;
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value) as {
      type?: string;
      refresh?: string;
      access?: string;
      expires?: number;
      metadata?: {
        serverUrl?: string;
        issuer?: string;
        client?: { client_id?: string };
      };
    };
    if (parsed.type !== "oauth" || !parsed.refresh || !parsed.access || !parsed.expires) return null;
    const clientId = parsed.metadata?.client?.client_id;
    const issuer = parsed.metadata?.issuer;
    const serverUrl = parsed.metadata?.serverUrl;
    if (!clientId || !issuer || !serverUrl) return null;
    return {
      refresh: parsed.refresh,
      access: parsed.access,
      expires: parsed.expires,
      clientId,
      issuer,
      serverUrl,
      raw: row.value,
    };
  } finally {
    db.close();
  }
}

/** Write a refreshed access token back into OpenCode's credential row. */
export function persistComposioCredential(dbPath: string, credential: ComposioCredential): void {
  const db = new DatabaseSync(dbPath);
  try {
    const updated = {
      ...(JSON.parse(credential.raw) as object),
      access: credential.access,
      expires: credential.expires,
    };
    db.prepare(
      "update credential set value = ?, time_updated = ? where value = ?",
    ).run(JSON.stringify(updated), String(Date.now()), credential.raw);
  } finally {
    db.close();
  }
}

/** Refresh the OAuth access token via the issuer's token endpoint. */
export async function refreshComposioToken(
  credential: ComposioCredential,
  fetchFn: typeof fetch = fetch,
): Promise<{ access: string; expires: number }> {
  const response = await fetchFn(`${credential.issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credential.refresh,
      client_id: credential.clientId,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new Error(
      `composio token refresh failed (${response.status}): ${body.error_description ?? "no access token"}`,
    );
  }
  return {
    access: body.access_token,
    expires: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
}

/** Parse an MCP HTTP response body: plain JSON or the last SSE `data:` line. */
export function parseRpcBody(text: string): { result?: unknown; error?: unknown; id?: number | string } {
  try {
    return JSON.parse(text) as { result?: unknown; error?: unknown; id?: number | string };
  } catch {
    const lines = text.split("\n").filter((line) => line.startsWith("data:"));
    const last = lines.at(-1)?.slice(5).trim() ?? "";
    return JSON.parse(last) as { result?: unknown; error?: unknown; id?: number | string };
  }
}

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super("composio mcp returned 401");
    this.name = "UnauthorizedError";
  }
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/**
 * Minimal MCP streamable-HTTP client: initialize, list tools, call tools.
 * One process-level session; 401 forces a token refresh and one retry.
 */
export class ComposioMcpClient {
  readonly #config: ComposioMcpConfig;
  readonly #credential: ComposioCredential;
  readonly #fetchFn: typeof fetch;
  #session: string | undefined;
  #nextId = 0;
  #ready: Promise<void> | undefined;
  #forcedRefresh: Promise<void> | undefined;

  constructor(options: {
    config: ComposioMcpConfig;
    credential: ComposioCredential;
    fetchFn?: typeof fetch;
  }) {
    this.#config = options.config;
    this.#credential = options.credential;
    this.#fetchFn = options.fetchFn ?? fetch;
  }

  /** Valid bearer token, refreshing (and persisting) when close to expiry. */
  async token(): Promise<string> {
    if (this.#credential.expires - Date.now() < 60_000) {
      await refreshComposioToken(this.#credential, this.#fetchFn).then((next) => {
        this.#credential.access = next.access;
        this.#credential.expires = next.expires;
        try {
          persistComposioCredential(this.#config.dbPath, this.#credential);
        } catch {
          // A read-only credential store must not break execution.
        }
      });
    }
    return this.#credential.access;
  }

  /** One initialize handshake per client; concurrent callers share the promise. */
  async #ensureReady(): Promise<void> {
    this.#ready ??= (async () => {
      const token = await this.token();
      const response = await this.#post(
        {
          jsonrpc: "2.0",
          id: ++this.#nextId,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: this.#config.clientName, version: "0.1.0" },
          },
        },
        token,
      );
      await response.text();
      if (response.status === 401) throw new UnauthorizedError();
      // `initialized` is a bare notification: post it directly instead of
      // through #rpc, which would await this same #ready promise (deadlock).
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, token);
    })();
    return this.#ready;
  }

  async #post(body: unknown, token: string): Promise<Response> {
    const response = await this.#fetchFn(this.#config.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.#session ? { "mcp-session-id": this.#session } : {}),
      },
      body: JSON.stringify(body),
    });
    // The session id comes from the initialize response; capture it no matter
    // which call surfaces it.
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.#session = sessionId;
    return response;
  }

  async #rpc(
    method: string,
    params: Record<string, unknown>,
    options: { notify?: boolean } = {},
  ): Promise<{ result: unknown }> {
    await this.#ensureReady();
    const token = await this.token();
    const body = options.notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: ++this.#nextId, method, params };
    let response = await this.#post(body, token);

    if (response.status === 401 && !options.notify) {
      // Force a refresh once, then retry the same call.
      this.#forcedRefresh ??= refreshComposioToken(this.#credential, this.#fetchFn).then(
        (next) => {
          this.#credential.access = next.access;
          this.#credential.expires = next.expires;
          try {
            persistComposioCredential(this.#config.dbPath, this.#credential);
          } catch {
            // non-fatal
          }
        },
      );
      await this.#forcedRefresh;
      this.#forcedRefresh = undefined;
      response = await this.#post(body, this.#credential.access);
      if (response.status === 401) throw new UnauthorizedError();
    }

    const text = await response.text();
    if (options.notify) return { result: undefined };
    const message = parseRpcBody(text);
    if (message.error) {
      const err = message.error as { code?: number; message?: string };
      throw new RpcError(err.code ?? -32000, err.message ?? "rpc error");
    }
    return { result: message.result };
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const { result } = await this.#rpc("tools/list", cursor ? { cursor } : {});
      const page = result as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{
    isError: boolean;
    text: string;
  }> {
    const { result } = await this.#rpc("tools/call", { name, arguments: args });
    const call = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
    return {
      isError: call.isError === true,
      text: (call.content ?? [])
        .map((part) => part.text ?? "")
        .join("\n"),
    };
  }
}
