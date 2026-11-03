import test from "node:test";
import assert from "node:assert/strict";
import { askNuma, askOpenCode, createNumaCoreServer, firstSong, fixWavHeader, forgetYoutubeMusic, transcribeWav, ytmPlay } from "../numa-core.mjs";

test("translates the Deepgram response to NUMA's stable transcript shape", async () => {
  const previous = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "test-key";
  let request;
  const result = await transcribeWav(Buffer.from("RIFF"), async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: " open spotify " }] }] } }), { status: 200 });
  });
  if (previous === undefined) delete process.env.DEEPGRAM_API_KEY;
  else process.env.DEEPGRAM_API_KEY = previous;
  assert.equal(result.text, "open spotify");
  assert.equal(new URL(request.url).searchParams.get("model"), "nova-3");
  assert.equal(new URL(request.url).searchParams.get("language"), "en");
  assert.equal(request.options.headers.authorization, "Token test-key");
});

test("repairs Deepgram's placeholder WAV lengths so Windows can play the clip", () => {
  const samples = Buffer.alloc(2000);
  const wav = Buffer.alloc(44 + samples.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(0x7fff0024, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(0x7fff0000, 40);

  const fixed = fixWavHeader(wav);

  assert.equal(fixed.readUInt32LE(4), fixed.length - 8);
  assert.equal(fixed.readUInt32LE(40), fixed.length - 44);
  // The caller's buffer is never modified.
  assert.equal(wav.readUInt32LE(40), 0x7fff0000);
});

test("leaves an already-correct WAV untouched", () => {
  const wav = Buffer.alloc(1044);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(wav.length - 44, 40);

  assert.deepEqual(fixWavHeader(wav), wav);
});

test("serves speech as WAV bytes and never writes a file", async () => {
  const previous = process.env.DEEPGRAM_API_KEY;
  process.env.DEEPGRAM_API_KEY = "test-key";
  const wav = Buffer.alloc(44 + 400);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(0x7fff0024, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(0x7fff0000, 40);

  const server = createNumaCoreServer({ fetchImpl: async () => new Response(wav, { status: 200 }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: "hello" }),
  });
  const audio = Buffer.from(await response.arrayBuffer());
  if (previous === undefined) delete process.env.DEEPGRAM_API_KEY;
  else process.env.DEEPGRAM_API_KEY = previous;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/wav");
  // The response is the audio itself, not a path to a temp file.
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.readUInt32LE(4), audio.length - 8);
  assert.equal(audio.readUInt32LE(40), audio.length - 44);
});

test("serves health and rejects non-WAV audio", async () => {
  // A dead network: health must answer without waiting on any provider.
  const server = createNumaCoreServer({
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/v1/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.core, "up");
  assert.equal(body.ytm, "down");
  const rejected = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: "x" });
  assert.equal(rejected.status, 415);
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("routes a message through the OpenCode V2 session API", async () => {
  const previousModel = process.env.NUMA_OPENCODE_MODEL;
  process.env.NUMA_OPENCODE_MODEL = "test-provider/tools-model";
  const calls = [];
  const responses = [
    new Response(JSON.stringify({ data: { id: "ses_numa_test" } }), { status: 200 }),
    new Response(JSON.stringify({ data: { type: "user", text: "open downloads" } }), { status: 200 }),
    new Response(null, { status: 204 }),
    new Response(JSON.stringify({ data: [
      { type: "user", text: "open downloads" },
      { type: "assistant", content: [{ type: "text", text: "Opened Downloads." }] },
    ], cursor: { previous: null, next: null } }), { status: 200 }),
  ];
  const result = await askOpenCode("open downloads", async (url, options) => {
    calls.push({ url: String(url), options });
    return responses.shift();
  });
  assert.equal(result.text, "Opened Downloads.");
  assert.match(calls[0].url, /\/api\/session$/);
  assert.match(calls[1].url, /\/api\/session\/ses_numa_test\/prompt$/);
  assert.match(calls[2].url, /\/api\/experimental\/session\/ses_numa_test\/wait$/);
  assert.match(calls[3].url, /\/api\/session\/ses_numa_test\/message$/);
  const prompt = JSON.parse(calls[1].options.body).text;
  assert.match(prompt, /You are NUMA/);
  assert.match(prompt, /open downloads/);
  if (previousModel === undefined) delete process.env.NUMA_OPENCODE_MODEL;
  else process.env.NUMA_OPENCODE_MODEL = previousModel;
});

test("plays a named song through the YouTube Music app", async () => {
  forgetYoutubeMusic();
  const calls = [];
  const search = {
    contents: {
      sectionListRenderer: {
        contents: [
          {
            itemSectionRenderer: {
              contents: [
                {
                  videoRenderer: {
                    videoId: "abc123",
                    title: { runs: [{ text: "Blinding Lights" }] },
                    longBylineText: { runs: [{ text: "The Weeknd" }] },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  };
  const song = { videoId: "abc123", title: "Blinding Lights", artist: "The Weeknd", isPaused: false };
  const result = await askNuma("play Blinding Lights", async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, body: options?.body });
    if (path === "/auth/numa-core") return new Response(JSON.stringify({ accessToken: "t1" }), { status: 200 });
    if (path === "/api/v1/search") return new Response(JSON.stringify(search), { status: 200 });
    if (path === "/api/v1/song") return new Response(JSON.stringify(song), { status: 200 });
    if (path === "/api/v1/queue" || path === "/api/v1/next") return new Response(null, { status: 204 });
    return new Response("{}", { status: 200 });
  });
  assert.equal(result.route, "local");
  assert.equal(result.text, "Playing Blinding Lights by The Weeknd.");
  // Played through the app, so no media key is also sent.
  assert.equal(result.action, undefined);
  const queued = calls.find((call) => call.path === "/api/v1/queue");
  assert.equal(JSON.parse(queued.body).videoId, "abc123");
  assert.equal(JSON.parse(queued.body).insertPosition, "INSERT_AFTER_CURRENT_VIDEO");
  assert.ok(calls.some((call) => call.path === "/api/v1/next"));
});

test("re-authorizes once when the app restarted and the token went stale", async () => {
  forgetYoutubeMusic();
  const paths = [];
  let songCalls = 0;
  const song = { videoId: "x", title: "Nightcall", artist: "Kavinsky", isPaused: true };
  const result = await askNuma("pause", async (url) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === "/auth/numa-core") {
      const count = paths.filter((entry) => entry === "/auth/numa-core").length;
      return new Response(JSON.stringify({ accessToken: `t${count}` }), { status: 200 });
    }
    if (path === "/api/v1/song") {
      songCalls += 1;
      if (songCalls === 1) return new Response("Unauthorized", { status: 401 });
      return new Response(JSON.stringify(song), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
  // The stale token is replaced once, not on every call.
  assert.equal(paths.filter((entry) => entry === "/auth/numa-core").length, 2);
  assert.ok(paths.includes("/api/v1/pause"));
  assert.equal(result.text, "Paused Nightcall by Kavinsky.");
});

test("falls back when the music app is not running", async () => {
  forgetYoutubeMusic();
  const played = await ytmPlay("blinding lights", async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:26538");
  });
  assert.equal(played, null);
});

test("reads the first song out of whatever renderer YouTube returns", () => {
  const found = firstSong({
    contents: {
      sectionListRenderer: {
        contents: [
          {
            itemSectionRenderer: {
              contents: [
                { compactVideoRenderer: { videoId: "zzz", title: { simpleText: "Track" } } },
              ],
            },
          },
        ],
      },
    },
  });
  assert.deepEqual(found, { videoId: "zzz", title: "Track", artist: null });
  assert.equal(firstSong({ contents: {} }), null);
});

test("reads the current YouTube Music card search renderer", () => {
  const found = firstSong({
    musicCardShelfRenderer: {
      title: {
        runs: [{
          text: "Blinding Lights",
          navigationEndpoint: { watchEndpoint: { videoId: "J7p4bzqLvCw" } },
        }],
      },
      subtitle: { runs: [{ text: "Song" }, { text: " • " }, { text: "The Weeknd" }] },
    },
  });
  assert.deepEqual(found, { videoId: "J7p4bzqLvCw", title: "Blinding Lights", artist: "The Weeknd" });
});
