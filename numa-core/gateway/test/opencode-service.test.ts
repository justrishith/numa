import assert from "node:assert/strict";
import { test } from "node:test";
import { openCodeConfig, resetOpenCodeUrl } from "../src/opencode.ts";
import {
  ensureOpenCode,
  ensureOpenCodeOnce,
  openCodeServiceConfig,
  parseServiceStatus,
  resetOpenCodeState,
  resolveOpenCodeBinary,
  type OpenCodeServiceConfig,
  type ServiceDeps,
} from "../src/opencode-service.ts";

const config: OpenCodeServiceConfig = {
  url: "http://127.0.0.1:28894",
  port: 28894,
  root: "C:\\Users\\test\\NUMA\\workbench",
  binary: "C:\\opencode.exe",
  autostart: true,
  // The default port is a guess, not a pin: the service may report another one.
  pinned: false,
  // Short enough that a failure case is instant; the real default is 40s.
  readyTimeoutMs: 50,
  pollIntervalMs: 5,
};

function deps(
  overrides: Partial<ServiceDeps> & {
    healthy?: boolean[];
    status?: string;
    hasBinary?: boolean;
  } = {},
) {
  // Each case starts clean: no inherited start, no adopted URL.
  resetOpenCodeState();
  resetOpenCodeUrl();

  const healthy = overrides.healthy ?? [];
  const runs: string[][] = [];
  const logs: string[] = [];
  const probes: string[] = [];

  const serviceDeps: ServiceDeps = {
    probe: async (url) => {
      probes.push(url);
      return healthy.shift() ?? false;
    },
    run: async (args) => {
      runs.push(args);
      if (args[0] === "service" && args[1] === "status") {
        return { stdout: overrides.status ?? "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    exists: () => overrides.hasBinary ?? true,
    log: (message) => logs.push(message),
    sleep: async () => undefined,
    ...overrides,
  };

  return { deps: serviceDeps, runs, logs, probes };
}

test("a healthy server is reused and never started", async () => {
  const { deps: d, runs } = deps({ healthy: [true] });
  const result = await ensureOpenCode(config, d);
  assert.equal(result.started, false);
  assert.equal(result.url, config.url);
  assert.equal(runs.length, 0);
});

test("a healthy server is adopted by the client, so ask follows health", async () => {
  const { deps: d } = deps({ healthy: [true] });
  await ensureOpenCode(config, d);
  assert.equal(openCodeConfig().url, config.url);
});

test("a dead server is started through the managed service, not `serve`", async () => {
  const { deps: d, runs } = deps({
    healthy: [false, true],
    status: "http://127.0.0.1:28894\n",
  });
  const result = await ensureOpenCode(config, d);
  assert.equal(result.started, true);
  assert.deepEqual(runs[0], ["service", "start"]);
  // `serve` would mint a password nobody holds; it must never be used here.
  assert.equal(
    runs.some((args) => args.includes("serve")),
    false,
  );
});

test("the URL the service reports is the one the client uses", async () => {
  // The managed service owns its port; NUMA's default is only a first guess.
  const { deps: d } = deps({
    healthy: [false, true],
    status: "http://127.0.0.1:28895\n",
  });
  const result = await ensureOpenCode(config, d);
  assert.equal(result.url, "http://127.0.0.1:28895");
  assert.equal(openCodeConfig().url, "http://127.0.0.1:28895");
});

test("autostart disabled refuses instead of starting", async () => {
  const { deps: d, runs } = deps({ healthy: [false] });
  await assert.rejects(
    () => ensureOpenCode({ ...config, autostart: false }, d),
    /autostart is disabled/,
  );
  assert.equal(runs.length, 0);
});

test("a server that never answers fails loudly", async () => {
  const { deps: d } = deps({ healthy: [false], status: "http://127.0.0.1:28894\n" });
  const started = Date.now();
  await assert.rejects(() => ensureOpenCode(config, d), /did not become healthy/);
  // The wait is bounded by the configured timeout, not by luck.
  assert.ok(Date.now() - started < 5000);
});

test("a missing binary is reported before anything is run", async () => {
  const { deps: d, runs } = deps({ healthy: [false], hasBinary: false });
  await assert.rejects(() => ensureOpenCode(config, d), /binary not found/);
  assert.equal(runs.length, 0);
});

test("an unpinned port follows the service instead of splitting the lane", async () => {
  const { deps: d } = deps({
    healthy: [false, true],
    status: "http://127.0.0.1:28999\n",
  });
  const result = await ensureOpenCode(config, d);
  assert.equal(result.url, "http://127.0.0.1:28999");
  // The client now talks to the same server health just confirmed.
  assert.equal(openCodeConfig().url, "http://127.0.0.1:28999");
});

test("a pinned port is refused when the service is elsewhere", async () => {
  const { deps: d } = deps({
    healthy: [false, true],
    status: "http://127.0.0.1:28999\n",
  });
  await assert.rejects(
    () => ensureOpenCode({ ...config, pinned: true }, d),
    /listening at http:\/\/127\.0\.0\.1:28999, but NUMA is configured for/,
  );
});

test("concurrent callers share one start attempt", async () => {
  const { deps: d, probes } = deps({ healthy: [true] });
  const [a, b] = await Promise.all([
    ensureOpenCodeOnce(config, d),
    ensureOpenCodeOnce(config, d),
  ]);
  assert.deepEqual(a, b);
  assert.equal(probes.length, 1);
});

test("service status parsing takes the first URL and ignores noise", () => {
  assert.equal(parseServiceStatus("http://127.0.0.1:28894\n"), "http://127.0.0.1:28894");
  assert.equal(parseServiceStatus("  http://127.0.0.1:28894/  \n"), "http://127.0.0.1:28894");
  assert.equal(parseServiceStatus("service is not running"), null);
  assert.equal(parseServiceStatus(""), null);
});

test("the npm v2 binary wins over the older bundled build", () => {
  const binary = resolveOpenCodeBinary(
    { APPDATA: "C:\\Users\\test\\AppData\\Roaming" } as NodeJS.ProcessEnv,
    () => true,
  );
  assert.match(binary, /npm[\\/]node_modules[\\/]@opencode[\\/]cli[\\/]bin[\\/]opencode\.exe$/);
});

test("service config honours env overrides", () => {
  const value = openCodeServiceConfig(
    {
      NUMA_OPENCODE_PORT: "29000",
      NUMA_OPENCODE_ROOT: "D:\\work",
      NUMA_OPENCODE_BIN: "D:\\opencode.exe",
      NUMA_OPENCODE_AUTOSTART: "0",
    } as NodeJS.ProcessEnv,
    () => true,
  );
  assert.equal(value.url, "http://127.0.0.1:29000");
  assert.equal(value.port, 29000);
  assert.equal(value.root, "D:\\work");
  assert.equal(value.binary, "D:\\opencode.exe");
  assert.equal(value.autostart, false);
  assert.equal(value.readyTimeoutMs, 40_000);
});

test("an explicit URL wins over the port", () => {
  const value = openCodeServiceConfig(
    {
      NUMA_OPENCODE_URL: "http://127.0.0.1:29500/",
      NUMA_OPENCODE_PORT: "29000",
    } as NodeJS.ProcessEnv,
    () => true,
  );
  assert.equal(value.url, "http://127.0.0.1:29500");
  assert.equal(value.port, 29500);
});

test("an invalid port is rejected, not silently defaulted", () => {
  assert.throws(
    () => openCodeServiceConfig({ NUMA_OPENCODE_PORT: "nope" } as NodeJS.ProcessEnv, () => true),
    /invalid NUMA_OPENCODE_PORT/,
  );
});
