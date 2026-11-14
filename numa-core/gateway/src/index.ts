import { loadConfig } from "./config.ts";
import { warmAppIndex } from "./apps.ts";
import { Store } from "./db.ts";
import { EventBus } from "./events.ts";
import { ExecutionEngine } from "./execution.ts";
import { warmOpenCode } from "./opencode.ts";
import {
  defaultServiceDeps,
  ensureOpenCodeOnce,
  openCodeServiceConfig,
} from "./opencode-service.ts";
import {
  composioMcpConfig,
  ComposioMcpClient,
  loadComposioCredential,
} from "./composio-mcp.ts";
import { ToolRegistry } from "./registry.ts";
import { buildServer } from "./server.ts";
import { appLaunchTool } from "./tools/app-launch.ts";
import { registerComposioTools } from "./tools/composio.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const bus = new EventBus();
  const registry = new ToolRegistry();
  registry.register(appLaunchTool);
  try {
    const credential = loadComposioCredential(composioMcpConfig().dbPath);
    if (!credential) {
      console.log("composio: no OAuth identity in opencode db; connectors unavailable");
    } else {
      const client = new ComposioMcpClient({
        config: composioMcpConfig(),
        credential,
      });
      const ids = await registerComposioTools(registry, client, console.log);
      console.log(`composio connectors registered: ${ids.length}`);
    }
  } catch (error) {
    console.error("composio connector registration failed:", (error as Error).message);
  }

  const engine = new ExecutionEngine(store, registry, bus);
  const app = await buildServer({
    engine,
    registry,
    bus,
    store,
    logLevel: config.logLevel,
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down NUMA gateway");
    // The OpenCode server is a shared background service, not a child of this
    // process: leaving it up means the next gateway boot finds it already warm.
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { port: config.port, db: config.dbPath, tools: registry.list().map((t) => t.id) },
    "NUMA gateway ready",
  );

  // The coding lane is part of the product, not a manual setup step: bring the
  // OpenCode server up here so a cold boot is enough for "hey numa" to work.
  try {
    const ready = await ensureOpenCodeOnce(openCodeServiceConfig(), {
      ...defaultServiceDeps,
      log: (message, extra) => app.log.info(extra ?? {}, message),
    });
    app.log.info({ ...ready }, "opencode lane ready");
  } catch (error) {
    // Speech and app actions still work without the coding lane; say so loudly
    // rather than taking the whole gateway down.
    app.log.error({ error: (error as Error).message }, "opencode lane unavailable");
  }

  // The first spoken request should not pay for session and model discovery.
  warmOpenCode();
  // Nor should it pay for the Start Menu scan behind "open minecraft".
  warmAppIndex();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
