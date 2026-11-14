/**
 * OpenCode service lifecycle, owned by the gateway.
 *
 * The coding lane is only as reliable as the server behind it. Starting that
 * server by hand was the last manual step in the loop: after a reboot, "hey
 * numa" would reach a dead port.
 *
 * Why the managed service and not a bare `serve`:
 * `opencode serve` mints a fresh random password per instance and prints it to
 * stdout, so the credential in `~/.config/opencode/service.json` never matches
 * it — every health probe comes back 401. `opencode service start` is the only
 * entry point that reads that credential, and `opencode service status` is the
 * only way to learn the URL it actually bound.
 *
 * Rules:
 * - Never start a second server: a healthy listener is reused as-is.
 * - Adopt the URL the service reports, so client and server cannot disagree.
 * - Leave the service running on shutdown: it is shared background
 *   infrastructure, not a child of this process.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { adoptOpenCodeUrl, resolveOpenCodeUrl, openCodeConfig } from "./opencode.ts";

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 28894;
const HEALTH_PATH = "/api/info";
const READY_TIMEOUT_MS = 40_000;
const POLL_INTERVAL_MS = 400;

export interface OpenCodeServiceConfig {
  url: string;
  port: number;
  root: string;
  binary: string;
  autostart: boolean;
  /** True when the URL came from an explicit env override, so it must not be silently changed. */
  pinned: boolean;
  /** How long to wait for the server to answer after a start. */
  readyTimeoutMs: number;
  /** Gap between health probes while waiting. */
  pollIntervalMs: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface ServiceDeps {
  probe: (url: string, headers: Record<string, string>) => Promise<boolean>;
  /** Run the OpenCode CLI with the given arguments. */
  run: (args: string[], cwd: string) => Promise<RunResult>;
  exists: (path: string) => boolean;
  log: (message: string, extra?: Record<string, unknown>) => void;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Prefer the npm CLI's v2.2.5 binary. The older `.opencode\bin` build speaks a
 * different API (`{prompt}` bodies, HTML at `/global/health`) and cannot serve
 * the gateway, so it is the last resort, not the first.
 */
export function resolveOpenCodeBinary(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const configured = env.NUMA_OPENCODE_BIN?.trim();
  if (configured) return configured;

  const candidates = [
    env.APPDATA
      ? join(env.APPDATA, "npm", "node_modules", "@opencode", "cli", "bin", "opencode.exe")
      : "",
    join(homedir(), ".opencode", "bin", "opencode.exe"),
  ].filter(Boolean);

  return candidates.find((candidate) => exists(candidate)) ?? candidates[0] ?? "opencode";
}

export function openCodeServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): OpenCodeServiceConfig {
  // Resolved once, in the client's resolver: a second formula here is exactly
  // how supervisor and client drifted onto different ports.
  const url = resolveOpenCodeUrl(env);
  const port = Number(new URL(url).port || DEFAULT_PORT);
  const readyTimeoutMs = Number(env.NUMA_OPENCODE_READY_MS ?? READY_TIMEOUT_MS);
  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new Error(`invalid NUMA_OPENCODE_READY_MS: ${env.NUMA_OPENCODE_READY_MS}`);
  }
  return {
    url,
    port,
    root: env.NUMA_OPENCODE_ROOT?.trim() || join(homedir(), "NUMA", "workbench"),
    binary: resolveOpenCodeBinary(env, exists),
    autostart: env.NUMA_OPENCODE_AUTOSTART !== "0",
    // A port the user typed is a deliberate pin; a default is a guess the
    // service is free to correct.
    pinned: Boolean(env.NUMA_OPENCODE_URL?.trim() || env.NUMA_OPENCODE_PORT?.trim()),
    readyTimeoutMs,
    pollIntervalMs: POLL_INTERVAL_MS,
  };
}

async function probeHealth(url: string, headers: Record<string, string>): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${url}${HEALTH_PATH}`, {
      headers,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const defaultServiceDeps: ServiceDeps = {
  probe: probeHealth,
  run: async (args, cwd) => {
    // Launch the real .exe: the PowerShell shim on PATH is not a valid Win32
    // image, and `serve` would also mint a password nobody holds.
    const binary = resolveOpenCodeBinary();
    const { stdout, stderr } = await execFileAsync(binary, args, {
      cwd,
      timeout: 30_000,
      windowsHide: true,
    }).catch((error: unknown) => {
      const failure = error as { stdout?: string; stderr?: string };
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error) };
    });
    return { stdout, stderr };
  },
  exists: existsSync,
  log: (message, extra) => console.log(message, extra ?? ""),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface EnsureResult {
  url: string;
  started: boolean;
}

/**
 * Pull the bound URL out of `opencode service status`. It prints a bare URL on
 * success and something else when nothing is running, so the first URL wins.
 */
export function parseServiceStatus(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/[^\s"']+/);
  return match ? match[0].replace(/\/$/, "") : null;
}

/**
 * Make sure an OpenCode server answers, starting the managed service if needed.
 * Returns once it is healthy or throws with the reason it isn't.
 */
export async function ensureOpenCode(
  config: OpenCodeServiceConfig = openCodeServiceConfig(),
  deps: ServiceDeps = defaultServiceDeps,
): Promise<EnsureResult> {
  const headers = openCodeConfig().headers;

  if (await deps.probe(config.url, headers)) {
    deps.log("opencode: reusing healthy server", { url: config.url });
    adoptOpenCodeUrl(config.url);
    return { url: config.url, started: false };
  }

  if (!config.autostart) {
    throw new Error(
      `OpenCode is not running at ${config.url} and autostart is disabled (NUMA_OPENCODE_AUTOSTART=0)`,
    );
  }
  if (!deps.exists(config.binary)) {
    throw new Error(`OpenCode binary not found: ${config.binary}`);
  }

  deps.log("opencode: starting managed service", { binary: config.binary });
  let detail: string | undefined;
  try {
    // A no-op when it is already up, and it reads the port and password from
    // the user's service config, so no second credential can drift in.
    const result = await deps.run(["service", "start"], config.root);
    detail = result.stderr.trim() || undefined;
  } catch (error) {
    detail = (error as Error).message;
  }

  const deadline = Date.now() + config.readyTimeoutMs;
  // Bound by attempts as well as wall clock: a test with a stubbed sleep would
  // otherwise spin the whole timeout in a tight loop.
  const maxAttempts = Math.max(1, Math.ceil(config.readyTimeoutMs / config.pollIntervalMs) + 1);
  let attempts = 0;
  let expected = config.url;
  while (attempts < maxAttempts && Date.now() < deadline) {
    attempts += 1;
    const status = await deps.run(["service", "status"], config.root).catch(() => null);
    const url = status ? parseServiceStatus(status.stdout) : null;
    if (url && url !== expected) {
      if (config.pinned) {
        // A typed port is a promise to the user; a service on another one means
        // the lane is split, so say so instead of reporting a healthy server.
        throw new Error(
          `OpenCode service is listening at ${url}, but NUMA is configured for ${config.url}. ` +
            `Run \`opencode service set port ${config.port}\` and restart it, or unset NUMA_OPENCODE_PORT/NUMA_OPENCODE_URL.`,
        );
      }
      // Otherwise the service is the authority: follow the URL it actually bound
      // so health and ask can never point at a different process.
      deps.log("opencode: adopting service url", { configured: config.url, url });
      expected = url;
      adoptOpenCodeUrl(url);
    }
    if (url && (await deps.probe(url, headers))) {
      deps.log("opencode: service ready", { url });
      adoptOpenCodeUrl(url);
      return { url, started: true };
    }
    await deps.sleep(config.pollIntervalMs);
  }

  throw new Error(
    `OpenCode did not become healthy within ${Math.round(config.readyTimeoutMs / 1000)}s` +
      (detail ? ` (${detail})` : ""),
  );
}

let ensureInFlight: Promise<EnsureResult> | null = null;

/** Test seam: forget any pending start so one case cannot inherit another. */
export function resetOpenCodeState(): void {
  ensureInFlight = null;
}

/**
 * One shared start attempt for boot and for the first request that needs it.
 * Concurrent callers wait on the same promise instead of racing two starts.
 */
export function ensureOpenCodeOnce(
  config: OpenCodeServiceConfig = openCodeServiceConfig(),
  deps: ServiceDeps = defaultServiceDeps,
): Promise<EnsureResult> {
  if (!ensureInFlight) {
    ensureInFlight = ensureOpenCode(config, deps).finally(() => {
      ensureInFlight = null;
    });
  }
  return ensureInFlight;
}
