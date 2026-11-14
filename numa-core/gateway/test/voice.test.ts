import assert from "node:assert/strict";
import { test } from "node:test";
import { fixWavHeader, synthesize, transcribe, UpstreamError } from "../src/audio.ts";
import { askOpenCode, openCodeConfig, resetOpenCodeState } from "../src/opencode.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function wav(size = 64): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(0x7fff0000, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(0x7fff0000, 40);
  return buffer;
}

const env = { DEEPGRAM_API_KEY: "test-key" } as NodeJS.ProcessEnv;

test("fixWavHeader rewrites placeholder sizes", () => {
  const fixed = fixWavHeader(wav(64));
  assert.equal(fixed.readUInt32LE(4), 64 - 8);
  assert.equal(fixed.readUInt32LE(40), 64 - 44);
});

test("transcribe posts the wav and returns the transcript", async () => {
  let seen: { url: string; auth: string; body: unknown } | null = null;
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    seen = {
      url: String(input),
      auth: String((init?.headers as Record<string, string>).authorization),
      body: init?.body,
    };
    return json({
      results: { channels: [{ alternatives: [{ transcript: " open chrome " }] }] },
    });
  }) as typeof fetch;

  const result = await transcribe(wav(), fakeFetch, env);
  assert.equal(result.text, "open chrome");
  assert.match(seen!.url, /api\.deepgram\.com\/v1\/listen/);
  assert.match(seen!.url, /model=nova-3/);
  assert.equal(seen!.auth, "Token test-key");
  assert.ok(seen!.body instanceof Uint8Array);
});

test("transcribe fails loudly without a key", async () => {
  await assert.rejects(
    () => transcribe(wav(), fetch, {} as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof UpstreamError && error.statusCode === 503,
  );
});

test("an empty transcript retries once and then resolves empty", async () => {
  let calls = 0;
  const empty = (async () => {
    calls += 1;
    return json({ results: { channels: [] } });
  }) as typeof fetch;

  const result = await transcribe(wav(), empty, env);
  assert.equal(result.text, "");
  assert.equal(calls, 2);
  assert.ok(result.ms >= 0);
});

test("a retry can recover speech the first attempt missed", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) return json({ results: { channels: [] } });
    return json({ results: { channels: [{ alternatives: [{ transcript: "open spotify" }] }] } });
  }) as typeof fetch;

  const result = await transcribe(wav(), flaky, env);
  assert.equal(result.text, "open spotify");
  assert.equal(calls, 2);
});

test("synthesize caches repeated phrases", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls += 1;
    return new Response(wav(48), { status: 200, headers: { "content-type": "audio/wav" } });
  }) as typeof fetch;

  const first = await synthesize("hello there", fakeFetch, env);
  const second = await synthesize("hello there", fakeFetch, env);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.readUInt32LE(4), first.length - 8);
});

test("askOpenCode creates one session and reuses it", async () => {
  resetOpenCodeState();
  const previous = process.env.NUMA_OPENCODE_MODEL;
  delete process.env.NUMA_OPENCODE_MODEL;

  const calls: string[] = [];
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/model")) {
      return json({
        data: [
          {
            providerID: "opencode",
            modelID: "big-pickle",
            status: "active",
            capabilities: { tools: true },
          },
        ],
      });
    }
    if (url.endsWith("/api/session")) return json({ data: { id: "ses_test" } });
    if (url.endsWith("/prompt")) return json({});
    if (url.endsWith("/wait")) return json({});
    if (url.endsWith("/message")) {
      return json({
        data: [
          { type: "assistant", content: [{ type: "text", text: "I fixed the failing test." }] },
        ],
      });
    }
    return json({ error: "unexpected route" }, 404);
  }) as typeof fetch;

  const config = { url: "http://127.0.0.1:9999", headers: {} };
  const first = await askOpenCode("fix the failing test", fakeFetch, config);
  assert.equal(first.text, "I fixed the failing test.");
  assert.equal(first.sessionId, "ses_test");

  const second = await askOpenCode("now run it", fakeFetch, config);
  assert.equal(second.sessionId, "ses_test");
  assert.equal(calls.filter((url) => url.endsWith("/api/session")).length, 1);

  if (previous === undefined) delete process.env.NUMA_OPENCODE_MODEL;
  else process.env.NUMA_OPENCODE_MODEL = previous;
  resetOpenCodeState();
});

test("openCodeConfig points at the local service", () => {
  const config = openCodeConfig({ NUMA_OPENCODE_URL: "http://127.0.0.1:1234/" } as NodeJS.ProcessEnv);
  assert.equal(config.url, "http://127.0.0.1:1234");
});
