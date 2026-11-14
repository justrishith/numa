/**
 * Connector tools from Composio, spoken over MCP.
 *
 * The gateway registers each connector slug it knows about as a registry tool,
 * with the real input schema Composio publishes (fetched over MCP at boot) so
 * policy sees the same inputs the service will enforce. Execution goes through
 * COMPOSIO_MULTI_EXECUTE_TOOL on the user's connected accounts — no custom
 * catalog, no direct OAuth tokens stored by the gateway.
 *
 * Registration is best-effort per tool: a slug whose schema cannot be fetched
 * or converted is skipped with a log line, never half-registered.
 */

import { z } from "zod";
import type { PermissionLevel, RiskLevel } from "../db.ts";
import type { ComposioMcpClient } from "../composio-mcp.ts";
import { defineTool } from "../registry.ts";
import type { RegisteredTool } from "../registry.ts";

/** Connected accounts: discovered by the Composio MCP identity this machine holds. */
export const CONNECTED_ACCOUNTS: Record<string, string | undefined> = {
  GITHUB: process.env.NUMA_COMPOSIO_GITHUB_ACCOUNT ?? "github_azoth-thrust",
  GMAIL: process.env.NUMA_COMPOSIO_GMAIL_ACCOUNT ?? "gmail_warnel-wong",
  // Todoist is the connected default account; no explicit account field.
  TODOIST: undefined,
};

interface ConnectorSpec {
  slug: string;
  toolkit: string;
}

/** The slugs NUMA exposes. Everything else Composio knows stays out of the registry. */
export const CONNECTOR_SLUGS: ConnectorSpec[] = [
  { slug: "GITHUB_GET_THE_AUTHENTICATED_USER", toolkit: "GITHUB" },
  { slug: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER", toolkit: "GITHUB" },
  { slug: "GITHUB_GET_A_REPOSITORY", toolkit: "GITHUB" },
  { slug: "GITHUB_SEARCH_CODE", toolkit: "GITHUB" },
  { slug: "GMAIL_GET_PROFILE", toolkit: "GMAIL" },
  { slug: "GMAIL_FETCH_EMAILS", toolkit: "GMAIL" },
  { slug: "GMAIL_CREATE_EMAIL_DRAFT", toolkit: "GMAIL" },
  { slug: "TODOIST_FILTER_TASKS", toolkit: "TODOIST" },
  { slug: "TODOIST_GET_TASK", toolkit: "TODOIST" },
  { slug: "TODOIST_MCP_ADD_TASKS", toolkit: "TODOIST" },
];

const READ_VERB = /^[A-Z]+_(GET_|SEARCH_|FETCH_|LIST_|FILTER_)/;

/** Read-only connectors run freely; everything else needs explicit approval. */
export function riskFor(slug: string): { risk: RiskLevel; permissionLevel: PermissionLevel } {
  if (READ_VERB.test(slug)) return { risk: "low", permissionLevel: 1 };
  return { risk: "high", permissionLevel: 3 };
}

/** Tool id in the registry: composio.<toolkit>.<slug minus toolkit prefix, dotted>. */
export function toolIdFor(slug: string, toolkit: string): string {
  const bare = slug.startsWith(`${toolkit}_`) ? slug.slice(toolkit.length + 1) : slug;
  return `composio.${toolkit.toLowerCase()}.${bare.toLowerCase().replace(/_/g, ".")}`;
}

/**
 * Convert the subset of JSON Schema Composio publishes into a zod validator.
 * Returns null for anything the converter does not understand, so an unknown
 * schema can never sneak through as `any`.
 */
export function jsonSchemaToZod(schema: unknown, depth = 0): z.ZodTypeAny | null {
  if (depth > 6 || schema === null || typeof schema !== "object") return null;
  const node = schema as {
    type?: string | string[];
    enum?: unknown[];
    anyOf?: unknown[];
    oneOf?: unknown[];
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    minLength?: number;
    maxLength?: number;
    minimum?: number;
    maximum?: number;
    minItems?: number;
    maxItems?: number;
  };
  const type = Array.isArray(node.type) ? node.type[0] : node.type;

  // Unions: convert every branch we understand; fail only if none survive.
  const branches = node.anyOf ?? node.oneOf;
  if (branches) {
    const converted = branches
      .map((branch) => jsonSchemaToZod(branch, depth + 1))
      .filter((branch): branch is z.ZodTypeAny => branch !== null);
    if (converted.length === 0) return null;
    if (converted.length === 1) return converted[0] ?? null;
    return z.union(converted as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  if (node.enum) {
    if (node.enum.some((value) => typeof value !== "string")) return null;
    return z.enum(node.enum as [string, ...string[]]);
  }

  switch (type) {
    case "string": {
      let base = z.string();
      if (typeof node.minLength === "number") base = base.min(node.minLength);
      if (typeof node.maxLength === "number") base = base.max(node.maxLength);
      return base;
    }
    case "number":
    case "integer": {
      let base = type === "integer" ? z.number().int() : z.number();
      if (typeof node.minimum === "number") base = base.min(node.minimum);
      if (typeof node.maximum === "number") base = base.max(node.maximum);
      return base;
    }
    case "boolean":
      return z.boolean();
    case "array": {
      const inner = jsonSchemaToZod(node.items, depth + 1);
      if (!inner) return null;
      let base = z.array(inner);
      if (typeof node.minItems === "number") base = base.min(node.minItems);
      if (typeof node.maxItems === "number") base = base.max(node.maxItems);
      return base;
    }
    case "object": {
      const properties = node.properties ?? {};
      const required = new Set(node.required ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(properties)) {
        const inner = jsonSchemaToZod(value, depth + 1);
        if (!inner) return null;
        shape[key] = required.has(key) ? inner : inner.optional();
      }
      return z.object(shape);
    }
    default:
      return null;
  }
}

export type ConnectorSchemas = Record<
  string,
  { toolkit?: string; tool_slug?: string; description?: string; input_schema?: unknown }
>;

interface ComposioSchemaResponse {
  successful?: boolean;
  data?: { tool_schemas?: ConnectorSchemas };
  error?: unknown;
}

interface MultiExecuteResponse {
  successful?: boolean;
  data?: {
    results?: Array<{
      response?: { successful?: boolean; data?: unknown; error?: unknown };
      tool_slug?: string;
    }>;
    error_count?: number;
  };
  error?: unknown;
}

/** Fetch schemas for the connector slugs over MCP. Throws when the call fails. */
export async function fetchConnectorSchemas(
  client: ComposioMcpClient,
  slugs: string[],
): Promise<ConnectorSchemas> {
  const call = await client.callTool("COMPOSIO_GET_TOOL_SCHEMAS", {
    tool_slugs: slugs,
    include: ["input_schema"],
  });
  if (call.isError) throw new Error(`COMPOSIO_GET_TOOL_SCHEMAS failed: ${call.text.slice(0, 300)}`);
  const parsed = JSON.parse(call.text) as ComposioSchemaResponse;
  if (parsed.error) throw new Error(`COMPOSIO_GET_TOOL_SCHEMAS error: ${String(parsed.error).slice(0, 200)}`);
  return parsed.data?.tool_schemas ?? {};
}

/**
 * Register every connector that survives schema fetch + conversion.
 * Returns the ids that were registered; skips are logged, never fatal.
 */
export async function registerComposioTools(
  registry: { register(tool: RegisteredTool): void },
  client: ComposioMcpClient,
  log: (message: string) => void = console.log,
): Promise<string[]> {
  let schemas: ConnectorSchemas;
  try {
    schemas = await fetchConnectorSchemas(client, CONNECTOR_SLUGS.map((spec) => spec.slug));
  } catch (error) {
    log(`composio: schema fetch failed, connectors unavailable (${error instanceof Error ? error.message : error})`);
    return [];
  }

  const registered: string[] = [];
  for (const spec of CONNECTOR_SLUGS) {
    const schema = schemas?.[spec.slug];
    if (!schema?.input_schema) {
      log(`composio: skipping ${spec.slug} (no schema published)`);
      continue;
    }
    const inputSchema = jsonSchemaToZod(schema.input_schema);
    if (!inputSchema) {
      log(`composio: skipping ${spec.slug} (schema not convertible)`);
      continue;
    }
    const { risk, permissionLevel } = riskFor(spec.slug);
    const account = CONNECTED_ACCOUNTS[spec.toolkit];
    registry.register(
      defineTool<unknown>({
        id: toolIdFor(spec.slug, spec.toolkit),
        description: schema.description ?? spec.slug,
        risk,
        permissionLevel,
        inputSchema: inputSchema as z.ZodType<unknown>,
        async execute(input) {
          return executeConnector(client, spec, account, input);
        },
        async verify(result) {
          return {
            verified: result.ok,
            detail: result.ok ? "composio reported success" : result.summary,
            data: result.data,
          };
        },
      }),
    );
    registered.push(toolIdFor(spec.slug, spec.toolkit));
  }
  return registered;
}

/** Run one connector through Composio's multi-execute meta tool. */
export async function executeConnector(
  client: ComposioMcpClient,
  spec: ConnectorSpec,
  account: string | undefined,
  input: unknown,
): Promise<{ ok: boolean; summary: string; data?: unknown }> {
  const call = await client.callTool("COMPOSIO_MULTI_EXECUTE_TOOL", {
    tools: [
      {
        tool_slug: spec.slug,
        arguments: (input ?? {}) as Record<string, unknown>,
        ...(account ? { account } : {}),
      },
    ],
    thought: `NUMA executing ${spec.slug} via Composio`,
    current_step: spec.slug,
    session_id: "numa-gateway",
    sync_response_to_workbench: false,
  });
  if (call.isError) {
    return { ok: false, summary: `composio ${spec.slug} failed: ${call.text.slice(0, 300)}` };
  }

  let parsed: MultiExecuteResponse;
  try {
    parsed = JSON.parse(call.text) as MultiExecuteResponse;
  } catch {
    return { ok: false, summary: `composio ${spec.slug} returned unparseable output` };
  }
  if (parsed.error) {
    return { ok: false, summary: `composio ${spec.slug} failed: ${String(parsed.error).slice(0, 300)}` };
  }

  const execution = parsed.data?.results?.[0];
  if (!execution) {
    return { ok: false, summary: `composio ${spec.slug} produced no result` };
  }
  const response = execution.response;
  if (response?.successful === false || response?.error) {
    const detail = response?.error ?? "composio reported failure";
    return { ok: false, summary: `composio ${spec.slug} failed: ${String(detail).slice(0, 300)}` };
  }

  return {
    ok: true,
    summary: `composio ${spec.slug} completed`,
    data: response?.data ?? response,
  };
}
