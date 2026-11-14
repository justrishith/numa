import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  host: string;
  port: number;
  dbPath: string;
  logLevel: string;
}

/**
 * The gateway binds to loopback only. It is the agent's control plane, not a
 * network service: exposing it would hand tool execution to the LAN.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.NUMA_GATEWAY_PORT ?? 8900);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid NUMA_GATEWAY_PORT: ${env.NUMA_GATEWAY_PORT}`);
  }
  return {
    host: "127.0.0.1",
    port,
    dbPath: env.NUMA_DB_PATH ?? join(env.LOCALAPPDATA ?? homedir(), "NUMA", "numa.db"),
    logLevel: env.NUMA_LOG_LEVEL ?? "info",
  };
}
