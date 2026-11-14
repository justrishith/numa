import assert from "node:assert/strict";
import test from "node:test";
import {
  ComposioMcpClient,
  parseRpcBody,
  RpcError,
  UnauthorizedError,
  type ComposioCredential,
} from "../src/composio-mcp.ts";
import {
  CONNECTOR_SLUGS,
  executeConnector,
  fetchConnectorSchemas,
  jsonSchemaToZod,
  registerComposioTools,
  riskFor,
  toolIdFor,
} from "../src/tools/composio.ts";

function fakeCredential(expires: number): ComposioCredential {
  return {
    refresh: "rt_test",
    access: "at_test",
    expires,
    clientId: "client_test",
    issuer: "https://connect.test",
    serverUrl: "https://connect.test/mcp",
    raw: JSON.stringify({
      type: "oauth",
      refresh: "rt_test",
      access: "at_test",
      expires,
      metadata: {
        serverUrl: "https://connect.test/mcp",
        issuer: "https://connect.test",
        client: { client_id: "client_test" },
      },
    }),
  };
}

/** Scripted fetch: consumes queued responses; records the requests. */
function scriptedFetch(
  responses: Array<{ status: number; body: string; headers?: Record<string, string> }>,
) {
  const requests: Array<{ headers: Record<string, string>; body: string }> = [];
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    requests.push({
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: String(init?.body ?? ""),
    });
    const next = responses.shift();
    if (!next) throw new Error("scripted fetch exhausted");
    return new Response(next.body, {
      status: next.status,
      headers: next.headers,
    });
  }) as typeof fetch;
  return { fetchFn, requests };
}

function req(requests: Array<{ headers: Record<string, string>; body: string }>, index: number) {
  const found = requests[index];
  assert.ok(found, `expected request #${index}`);
  return found;
}

function clientWith(
  responses: Array<{ status: number; body: string; headers?: Record<string, string> }>,
  expires: number,
) {
  const config = {
    dbPath: ":memory:",
    mcpUrl: "https://connect.test/mcp",
    clientName: "test",
  };
  const credential = fakeCredential(expires);
  const { fetchFn, requests } = scriptedFetch(responses);
  const client = new ComposioMcpClient({ config, credential, fetchFn });
  return { client, requests, credential };
}

test("jsonSchemaToZod converts primitives, enums, arrays and nested objects", () => {
  const schema = {
    type: "object",
    required: ["q"],
    properties: {
      q: { type: "string", minLength: 1 },
      n: { type: "integer", minimum: 1, maximum: 100 },
      mode: { type: "string", enum: ["a", "b"] },
      tags: { type: "array", items: { type: "string" } },
      nested: { type: "object", properties: { x: { type: "boolean" } } },
      maybe: { type: "string" },
    },
  };
  const parsed = jsonSchemaToZod(schema);
  assert.ok(parsed);
  const value = parsed.parse({ q: "hi", n: 5, mode: "a", tags: ["x"], nested: { x: true } });
  assert.equal(value.q, "hi");
  assert.throws(() => parsed.parse({ n: 5 }));
  assert.throws(() => parsed.parse({ q: "hi", mode: "zzz" }));
});

test("jsonSchemaToZod returns null on unsupported shapes instead of passing anything", () => {
  assert.equal(jsonSchemaToZod({ type: "string", format: "uri" }) !== null, true);
  assert.equal(jsonSchemaToZod({ type: "object", properties: { bad: { type: "weird" } } }), null);
  assert.equal(jsonSchemaToZod({ type: "array", items: { type: "weird" } }), null);
  assert.equal(jsonSchemaToZod(null), null);
  assert.equal(jsonSchemaToZod("string"), null);
  // deep nesting is refused
  let node: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 8; i++) node = { type: "object", properties: { k: node } };
  assert.equal(jsonSchemaToZod(node), null);
});

test("jsonSchemaToZod converts anyOf unions like Composio's attachment fields", () => {
  const schema = {
    anyOf: [
      { type: "object", properties: { path: { type: "string" } } },
      { type: "array", items: { type: "object", properties: { path: { type: "string" } } } },
    ],
  };
  const parsed = jsonSchemaToZod(schema);
  assert.ok(parsed);
  // both branch shapes validate
  parsed.parse({ path: "a.txt" });
  parsed.parse([{ path: "a.txt" }]);
  // a branch-less union of garbage fails closed
  assert.equal(jsonSchemaToZod({ anyOf: [{ type: "weird" }] }), null);
  // oneOf is treated the same way
  assert.ok(jsonSchemaToZod({ oneOf: [{ type: "string" }, { type: "number" }] }));
});

test("riskFor marks reads low and everything else approval-gated", () => {
  assert.deepEqual(riskFor("GMAIL_GET_PROFILE"), { risk: "low", permissionLevel: 1 });
  assert.deepEqual(riskFor("GMAIL_FETCH_EMAILS"), { risk: "low", permissionLevel: 1 });
  assert.deepEqual(riskFor("TODOIST_FILTER_TASKS"), { risk: "low", permissionLevel: 1 });
  assert.deepEqual(riskFor("GMAIL_CREATE_EMAIL_DRAFT"), { risk: "high", permissionLevel: 3 });
  assert.deepEqual(riskFor("TODOIST_MCP_ADD_TASKS"), { risk: "high", permissionLevel: 3 });
});

test("toolIdFor builds dotted registry ids", () => {
  assert.equal(toolIdFor("GMAIL_GET_PROFILE", "GMAIL"), "composio.gmail.get.profile");
});

test("parseRpcBody handles plain JSON and SSE data lines", () => {
  assert.deepEqual(parseRpcBody('{"result":{"ok":1}}'), { result: { ok: 1 } });
  assert.deepEqual(parseRpcBody('event: message\ndata: {"result":2}\n\n'), { result: 2 });
});

test("client refreshes an expired token before use", async () => {
  const { client, requests, credential } = clientWith(
    [
      { status: 200, body: '{"access_token":"at_test","expires_in":3600}' }, // refresh
      { status: 200, body: "{}", headers: { "mcp-session-id": "s1" } }, // initialize
      { status: 200, body: "{}" }, // initialized notification
      { status: 200, body: '{"result":{"isError":false,"content":[{"text":"ok"}]}}' },
    ],
    Date.now() - 1000,
  );
  await client.callTool("X", {});
  const refresh = req(requests, 0);
  assert.equal(refresh.body.includes("grant_type=refresh_token"), true);
  assert.equal(refresh.body.includes("client_id=client_test"), true);
  // refreshed token flowed into the MCP calls
  assert.equal(req(requests, 1).headers.authorization, `Bearer ${credential.access}`);
});

test("client skips refresh when the token is fresh", async () => {
  const { client, requests, credential } = clientWith(
    [
      { status: 200, body: "{}", headers: { "mcp-session-id": "s1" } },
      { status: 200, body: "{}" },
      { status: 200, body: '{"result":{"isError":false,"content":[]}}' },
    ],
    Date.now() + 10_000_000,
  );
  await client.callTool("X", {});
  assert.equal(requests.length, 3);
  assert.equal(req(requests, 0).headers.authorization, "Bearer at_test");
  assert.equal(credential.access, "at_test");
});

test("a 401 mid-session forces one refresh and retries the call", async () => {
  const { client, requests, credential } = clientWith(
    [
      { status: 200, body: "{}", headers: { "mcp-session-id": "s1" } }, // initialize
      { status: 200, body: "{}" }, // initialized notification
      { status: 401, body: "unauthorized" }, // tools/call rejected
      { status: 200, body: '{"access_token":"at_new","expires_in":3600}' }, // refresh
      { status: 200, body: '{"result":{"isError":false,"content":[{"text":"done"}]}}' },
    ],
    Date.now() + 10_000_000,
  );
  const call = await client.callTool("X", {});
  assert.equal(call.isError, false);
  assert.equal(call.text, "done");
  assert.equal(req(requests, 3).body.includes("grant_type=refresh_token"), true);
  assert.equal(req(requests, 4).headers.authorization, "Bearer at_new");
  assert.equal(credential.access, "at_new");
});

test("client captures and replays the mcp-session-id", async () => {
  const { client, requests } = clientWith(
    [
      { status: 200, body: "{}", headers: { "mcp-session-id": "sid_42" } },
      { status: 200, body: "{}" },
      { status: 200, body: '{"result":{"isError":false,"content":[]}}' },
      { status: 200, body: '{"result":{"isError":false,"content":[]}}' },
      { status: 200, body: '{"result":{"isError":false,"content":[]}}' },
    ],
    Date.now() + 10_000_000,
  );
  await client.callTool("X", {});
  await client.callTool("X", {});
  await client.callTool("X", {});
  assert.equal(req(requests, 2).headers["mcp-session-id"], "sid_42");
  assert.equal(req(requests, 3).headers["mcp-session-id"], "sid_42");
  assert.equal(req(requests, 4).headers["mcp-session-id"], "sid_42");
});

test("rpc errors surface as RpcError with the server's code", async () => {
  const { client } = clientWith(
    [
      { status: 200, body: "{}", headers: { "mcp-session-id": "s" } },
      { status: 200, body: "{}" },
      { status: 200, body: '{"error":{"code":-32602,"message":"bad params"}}' },
    ],
    Date.now() + 10_000_000,
  );
  await assert.rejects(() => client.callTool("X", {}), (error: unknown) => {
    assert.ok(error instanceof RpcError);
    assert.equal(error.code, -32602);
    return true;
  });
});

test("fetchConnectorSchemas parses the multi-execute schema response", async () => {
  const { client } = clientWith(
    [
      { status: 200, body: "{}", headers: { "mcp-session-id": "s" } },
      { status: 200, body: "{}" },
      {
        status: 200,
        body: JSON.stringify({
          result: {
            isError: false,
            content: [
              {
                text: JSON.stringify({
                  successful: true,
                  data: {
                    tool_schemas: {
                      GMAIL_GET_PROFILE: {
                        toolkit: "GMAIL",
                        tool_slug: "GMAIL_GET_PROFILE",
                        description: "Get the Gmail profile.",
                        input_schema: { type: "object", properties: {} },
                      },
                    },
                  },
                }),
              },
            ],
          },
        }),
      },
    ],
    Date.now() + 10_000_000,
  );
  const schemas = await fetchConnectorSchemas(client, ["GMAIL_GET_PROFILE"]);
  assert.ok(schemas?.GMAIL_GET_PROFILE);
  assert.equal(schemas.GMAIL_GET_PROFILE.description, "Get the Gmail profile.");
});

test("registerComposioTools skips slugs without schemas and registers the rest", async () => {
  const registry = {
    tools: [] as Array<{ id: string }>,
    register(tool: { id: string }) {
      this.tools.push(tool);
    },
  };
  const { client } = clientWith(
    [
      { status: 200, body: "{}", headers: { "mcp-session-id": "s" } },
      { status: 200, body: "{}" },
      {
        status: 200,
        body: JSON.stringify({
          result: {
            isError: false,
            content: [
              {
                text: JSON.stringify({
                  successful: true,
                  data: {
                    tool_schemas: {
                      GMAIL_GET_PROFILE: {
                        toolkit: "GMAIL",
                        description: "profile",
                        input_schema: { type: "object", properties: {} },
                      },
                      GMAIL_CREATE_EMAIL_DRAFT: {
                        toolkit: "GMAIL",
                        description: "draft",
                        input_schema: { type: "object", properties: { broken: { type: "weird" } } },
                      },
                    },
                  },
                }),
              },
            ],
          },
        }),
      },
    ],
    Date.now() + 10_000_000,
  );
  const logs: string[] = [];
  const ids = await registerComposioTools(registry, client, (message) => logs.push(message));
  assert.deepEqual(ids, ["composio.gmail.get.profile"]);
  assert.equal(registry.tools.length, 1);
  assert.equal(logs.some((m) => m.includes("GMAIL_CREATE_EMAIL_DRAFT")), true);
});

test("executeConnector unwraps the multi-execute response", async () => {
  const exec = (body: unknown, isError = false) => [
    { status: 200, body: "{}", headers: { "mcp-session-id": "s" } },
    { status: 200, body: "{}" },
    {
      status: 200,
      body: JSON.stringify({ result: { isError, content: [{ text: JSON.stringify(body) }] } }),
    },
  ];

  const okClient = clientWith(
    exec({
      successful: true,
      data: {
        results: [{ tool_slug: "GMAIL_GET_PROFILE", response: { successful: true, data: { emailAddress: "me@x" } } }],
      },
    }),
    Date.now() + 10_000_000,
  ).client;
  const ok = await executeConnector(okClient, { slug: "GMAIL_GET_PROFILE", toolkit: "GMAIL" }, "acct", {});
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { emailAddress: "me@x" });

  const failClient = clientWith(
    exec({
      successful: true,
      data: {
        results: [{ tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: false, error: "nope" } }],
      },
    }),
    Date.now() + 10_000_000,
  ).client;
  const failed = await executeConnector(failClient, { slug: "GMAIL_FETCH_EMAILS", toolkit: "GMAIL" }, "acct", {});
  assert.equal(failed.ok, false);
  assert.equal(failed.summary.includes("nope"), true);

  const emptyClient = clientWith(
    exec({ successful: true, data: { results: [] } }),
    Date.now() + 10_000_000,
  ).client;
  const empty = await executeConnector(emptyClient, { slug: "GMAIL_FETCH_EMAILS", toolkit: "GMAIL" }, "acct", {});
  assert.equal(empty.ok, false);
});

test("connector slug catalog covers the three connected toolkits", () => {
  const kits = new Set(CONNECTOR_SLUGS.map((spec) => spec.toolkit));
  assert.deepEqual([...kits].sort(), ["GITHUB", "GMAIL", "TODOIST"]);
  assert.equal(CONNECTOR_SLUGS.some((spec) => spec.slug === "GMAIL_GET_PROFILE"), true);
});

test("a persistent 401 becomes UnauthorizedError, not a silent failure", async () => {
  const { client } = clientWith(
    [
      { status: 401, body: "unauthorized" },
    ],
    Date.now() + 10_000_000,
  );
  await assert.rejects(() => client.callTool("X", {}), UnauthorizedError);
});
