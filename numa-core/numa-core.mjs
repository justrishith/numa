//! NUMA Core: local provider edge for speech and OpenCode actions.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8899;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
const DEFAULT_OPENCODE_MODEL = "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_FAST_MODEL = "openai/gpt-4.1-nano";
const DEFAULT_TTS_MODEL = "aura-2-thalia-en";
const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
const NUMA_SYSTEM_PROMPT = `You are NUMA, the user's local Windows voice computer assistant.
Be concise and natural because your reply is spoken aloud. Prefer fast local allowlisted actions for apps and media.
Do not open terminals or use shell commands for ordinary app, Spotify, YouTube Music, or media-key tasks.
YouTube Music is the default music service because the user has Premium. Always prefer the installed YouTube Music desktop app and its local API before any browser or website. Use Spotify only when the user explicitly says Spotify.
When a request needs memory, people, projects, preferences, or prior decisions, use the connected GBrain tools and trust retrieved context over guesses.
When computer control is needed, use only approved local computer-control tools, describe what you are doing, and ask for confirmation before destructive, irreversible, financial, credential, or message-sending actions.
Never claim an action succeeded unless the tool result confirms it.`;

let sessionId = null;
let sessionPromise = null;
let discoveredModel = null;
const speechCache = new Map();
const speechInflight = new Map();
const NUMA_HISTORY_LIMIT = 12;
const NUMA_DATA_DIR = process.env.NUMA_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), "Poni", "numa");
const NUMA_HISTORY_FILE = join(NUMA_DATA_DIR, "history.json");
const NUMA_PROFILE_FILE = process.env.NUMA_PROFILE_FILE || join(NUMA_DATA_DIR, "profile.json");
let numaHistory = loadNumaHistory();

function loadNumaProfile() {
  try {
    const value = JSON.parse(readFileSync(NUMA_PROFILE_FILE, "utf8"));
    return {
      displayName: typeof value?.displayName === "string" ? value.displayName : "",
      goals: Array.isArray(value?.goals) ? value.goals.filter((item) => typeof item === "string") : [],
      routines: Array.isArray(value?.routines) ? value.routines.filter((item) => typeof item === "string") : [],
      preferences: value?.preferences && typeof value.preferences === "object" ? value.preferences : {},
    };
  } catch {
    return { displayName: "", goals: [], routines: [], preferences: { music: "YouTube Music" } };
  }
}

function profileContext() {
  const profile = loadNumaProfile();
  const lines = ["Local user profile (use only as context; do not invent facts):"];
  if (profile.displayName) lines.push(`- Name: ${profile.displayName}`);
  if (profile.goals.length) lines.push(`- Goals: ${profile.goals.join("; ")}`);
  if (profile.routines.length) lines.push(`- Routines: ${profile.routines.join("; ")}`);
  for (const [key, value] of Object.entries(profile.preferences)) lines.push(`- ${key}: ${String(value)}`);
  return lines.join("\n");
}

function loadNumaHistory() {
  try {
    const value = JSON.parse(readFileSync(NUMA_HISTORY_FILE, "utf8"));
    return Array.isArray(value) ? value.filter((turn) => turn?.user && turn?.assistant).slice(-NUMA_HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function saveNumaHistory() {
  try {
    mkdirSync(NUMA_DATA_DIR, { recursive: true });
    writeFileSync(NUMA_HISTORY_FILE, JSON.stringify(numaHistory, null, 2), "utf8");
  } catch {
    // History must never prevent a local action or assistant response.
  }
}

function rememberTurn(user, assistant, route) {
  numaHistory = [...numaHistory, { user, assistant, route, at: new Date().toISOString() }].slice(-NUMA_HISTORY_LIMIT);
  saveNumaHistory();
}

export function getNumaHistory() {
  return numaHistory.map((turn) => ({ ...turn }));
}

export function resetNumaHistory() {
  numaHistory = [];
  saveNumaHistory();
}

function recentContext() {
  return numaHistory.flatMap((turn) => [
    { role: "user", content: turn.user },
    { role: "assistant", content: turn.assistant },
  ]);
}

function deepgramKey() {
  return process.env.DEEPGRAM_API_KEY?.trim() || "";
}

function opencodeUrl() {
  return (process.env.NUMA_OPENCODE_URL || "http://127.0.0.1:28894").replace(/\/$/, "");
}

function opencodePassword() {
  const configured = process.env.OPENCODE_PASSWORD?.trim();
  if (configured) return configured;
  try {
    const service = JSON.parse(readFileSync(resolve(homedir(), ".config", "opencode", "service.json"), "utf8"));
    return typeof service.password === "string" ? service.password.trim() : "";
  } catch {
    return "";
  }
}

function opencodeHeaders() {
  const headers = { accept: "application/json" };
  const password = opencodePassword();
  if (password) {
    headers.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  } else {
    const key = process.env.OPENCODE_API_KEY?.trim();
    if (key) headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

function portFromArgs(argv = process.argv.slice(2)) {
  const index = argv.indexOf("--port");
  return Number(index >= 0 ? argv[index + 1] : process.env.NUMA_CORE_PORT || DEFAULT_PORT);
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  return JSON.parse((await readBody(request, 2 * 1024 * 1024)).toString("utf8"));
}

export async function transcribeWav(audio, fetchImpl = fetch) {
  const key = deepgramKey();
  if (!key) throw Object.assign(new Error("DEEPGRAM_API_KEY is not configured"), { statusCode: 503 });
  const started = performance.now();
  const url = new URL(process.env.NUMA_DEEPGRAM_URL || DEEPGRAM_URL);
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("language", "en");
  url.searchParams.set("smart_format", "true");
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Token ${key}`, "content-type": "audio/wav", accept: "application/json" },
    body: audio,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.err_msg || body?.message || `Deepgram returned HTTP ${response.status}`), { statusCode: 502 });
  const text = body?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (!text) throw Object.assign(new Error("Deepgram returned no transcript"), { statusCode: 502 });
  return { text, ms: Math.round(performance.now() - started) };
}

/**
 * Deepgram streams its WAV, so the header carries placeholder lengths
 * (0x7FFF0000, roughly 2 GB) instead of the real sizes. Windows' winmm loads
 * that header, decides the file is far larger than the bytes that exist, and
 * plays nothing while still reporting success. Rewrite the RIFF and `data`
 * sizes from the bytes actually received.
 */
export function fixWavHeader(audio) {
  if (audio.length < 44) return audio;
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") return audio;
  const fixed = Buffer.from(audio);
  fixed.writeUInt32LE(fixed.length - 8, 4);
  let offset = 12;
  while (offset + 8 <= fixed.length) {
    const id = fixed.toString("ascii", offset, offset + 4);
    const size = fixed.readUInt32LE(offset + 4);
    if (id === "data") {
      fixed.writeUInt32LE(fixed.length - (offset + 8), offset + 4);
      return fixed;
    }
    // A placeholder or impossible size means the chunk list can't be walked.
    if (size === 0 || size > fixed.length - offset - 8) break;
    offset += 8 + size + (size % 2);
  }
  return fixed;
}

export async function synthesizeSpeech(text, fetchImpl = fetch) {
  const key = deepgramKey();
  if (!key) throw Object.assign(new Error("DEEPGRAM_API_KEY is not configured"), { statusCode: 503 });
  const cacheKey = text.trim();
  const cached = speechCache.get(cacheKey);
  if (cached) return Buffer.from(cached);
  const inflight = speechInflight.get(cacheKey);
  if (inflight) return Buffer.from(await inflight);
  const request = (async () => {
    const response = await fetchImpl(process.env.NUMA_DEEPGRAM_TTS_URL || DEEPGRAM_SPEAK_URL + `?model=${encodeURIComponent(process.env.NUMA_TTS_MODEL || DEFAULT_TTS_MODEL)}&encoding=linear16&container=wav`, {
      method: "POST",
      headers: { authorization: `Token ${key}`, "content-type": "application/json", accept: "audio/wav" },
      body: JSON.stringify({ text: cacheKey }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(detail || `Deepgram TTS returned HTTP ${response.status}`), { statusCode: 502 });
    }
    const audio = fixWavHeader(Buffer.from(await response.arrayBuffer()));
    speechCache.set(cacheKey, audio);
    while (speechCache.size > 32) speechCache.delete(speechCache.keys().next().value);
    return audio;
  })();
  speechInflight.set(cacheKey, request);
  try {
    return Buffer.from(await request);
  } finally {
    speechInflight.delete(cacheKey);
  }
}

export function warmSpeech(fetchImpl = fetch) {
  if (!deepgramKey()) return;
  for (const phrase of [
    "Opening Spotify now. Spotify launch request finished.",
    "Opening Spotify search now. Search request finished.",
    "Opening Spotify search now. Search request finished.",
    "Skipping forward.",
    "Going back.",
    "Playing.",
  ]) {
    void synthesizeSpeech(phrase, fetchImpl).catch(() => {});
  }
}

async function openCodeRequest(path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${opencodeUrl()}${path}`, {
    ...options,
    headers: { ...opencodeHeaders(), "content-type": "application/json", ...(options.headers || {}) },
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw Object.assign(new Error(body?.message || body?.error || `OpenCode returned HTTP ${response.status}`), { statusCode: response.status });
  return body;
}

async function createSession(fetchImpl = fetch) {
  // `opencode serve` already has a location-scoped working directory. Passing
  // an arbitrary location here can make the server reject the session when it
  // has not loaded that project yet, so create in the server's active location.
  const configured = process.env.NUMA_OPENCODE_MODEL?.trim();
  let model = configured || discoveredModel;
  if (!model) {
    const catalog = await openCodeRequest("/api/model", {}, fetchImpl);
    const models = Array.isArray(catalog) ? catalog : (Array.isArray(catalog?.data) ? catalog.data : []);
    const usable = models.filter((entry) =>
      entry?.status === "active" && entry?.enabled !== false && entry?.capabilities?.tools === true &&
      entry?.id !== "openrouter/free" && !String(entry?.id || "").toLowerCase().includes("free-router")
    );
    const score = (entry) => {
      const provider = String(entry?.providerID || "");
      const id = String(entry?.modelID || entry?.id || "");
      if (provider === "xkrio" && id === "stealth/big-pickle") return 100;
      if (provider === "xkrio" && id.includes("qwen3.7-flash")) return 95;
      if (provider === "xkrio" && id.includes("qwen3")) return 90;
      if (provider === "opencode-go") return 80;
      if (provider === "opencode") return 70;
      return 10;
    };
    const candidate = usable.sort((a, b) => score(b) - score(a))[0];
    if (!candidate?.providerID || !(candidate.modelID || candidate.id)) {
      throw Object.assign(new Error("OpenCode has no active tools-capable model (Free Router is disabled)"), { statusCode: 503 });
    }
    model = `${candidate.providerID}/${candidate.modelID || candidate.id}`;
    discoveredModel = model;
  }
  const slash = model.indexOf("/");
  const providerID = slash > 0 ? model.slice(0, slash) : model;
  const modelID = slash > 0 ? model.slice(slash + 1) : model;
  const body = await openCodeRequest("/api/session", {
    method: "POST",
    body: JSON.stringify({ title: "NUMA", model: { providerID, id: modelID } }),
  }, fetchImpl);
  return body?.data?.id || body?.id || null;
}

async function getSession(fetchImpl = fetch) {
  if (sessionId) return sessionId;
  if (!sessionPromise) {
    sessionPromise = createSession(fetchImpl).then((id) => {
      if (!id) throw Object.assign(new Error("OpenCode did not return a session id"), { statusCode: 502 });
      sessionId = id;
      return id;
    }).finally(() => {
      sessionPromise = null;
    });
  }
  return sessionPromise;
}

export function warmOpenCode(fetchImpl = fetch) {
  void getSession(fetchImpl).catch(() => {});
}

function assistantText(message) {
  return message?.content?.filter((part) => part?.type === "text").map((part) => part.text).join("\n").trim() || "";
}

function spawnDetached(command, args = []) {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  // A user may not have every optional app installed. Never let an ENOENT
  // from a preloaded command bring down NUMA Core.
  child.on("error", () => {});
  child.unref();
  return child;
}

function launchAppWindow(url) {
  const candidates = [
    join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable) {
    spawnDetached(executable, [`--app=${url}`]);
    return true;
  }
  // PATH-installed Edge/Chrome still gets an app-window attempt.
  spawnDetached("msedge.exe", [`--app=${url}`]);
  return false;
}

function launchYouTubeMusic(url = "https://music.youtube.com") {
  const candidates = [
    join(process.env.LOCALAPPDATA || "", "Programs", "youtube-music", "YouTube Music.exe"),
    join(process.env.LOCALAPPDATA || "", "Programs", "YouTube Music", "YouTube Music.exe"),
  ];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (executable) {
    // YouTube Music Desktop does not reliably accept a URL argument; it can
    // start and immediately exit. Launch the app normally for the default
    // command and let the browser fallback handle URL searches.
    spawnDetached(executable);
    return true;
  }
  if (url === "https://music.youtube.com") {
    spawnDetached("explorer.exe", ["shell:AppsFolder\\com.github.th-ch.youtube-music"]);
    return true;
  }
  return false;
}

async function promptSession(id, text, fetchImpl = fetch) {
  const prompt = `${NUMA_SYSTEM_PROMPT}\n\n${profileContext()}\n\nUser request:\n${text}`;
  await openCodeRequest(`/api/session/${encodeURIComponent(id)}/prompt`, { method: "POST", body: JSON.stringify({ text: prompt }) }, fetchImpl);
  const readReply = async () => {
    const messages = await openCodeRequest(`/api/session/${encodeURIComponent(id)}/message`, {}, fetchImpl);
    const data = Array.isArray(messages?.data) ? messages.data : [];
    const assistant = [...data].reverse().find((message) => message?.type === "assistant");
    const reply = assistantText(assistant);
    if (reply) return reply;
    if (assistant?.error?.message) throw Object.assign(new Error(assistant.error.message), { statusCode: 502 });
    if (assistant?.retry?.error?.message) {
      const statusCode = assistant.retry.error.status === 429 ? 429 : 502;
      throw Object.assign(new Error(assistant.retry.error.message), { statusCode });
    }
    return "";
  };
  try {
    // V2 waits inside the server until the agent/tool loop is idle. This is
    // materially cheaper than repeatedly downloading the entire transcript.
    await openCodeRequest(`/api/experimental/session/${encodeURIComponent(id)}/wait`, { method: "POST" }, fetchImpl);
    const reply = await readReply();
    if (reply) return reply;
  } catch (error) {
    // Older/managed servers may not expose the experimental wait route. Keep
    // a compatibility fallback for those servers.
    if (![404, 405].includes(error.statusCode)) throw error;
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const reply = await readReply();
    if (reply) return reply;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw Object.assign(new Error("OpenCode timed out without an assistant response"), { statusCode: 504 });
}

export async function askOpenCode(text, fetchImpl = fetch) {
  if (!text?.trim()) throw Object.assign(new Error("message is empty"), { statusCode: 400 });
  const started = performance.now();
   const id = await getSession(fetchImpl);
   try {
     return { text: await promptSession(id, text.trim(), fetchImpl), session_id: id, ms: Math.round(performance.now() - started) };
   } catch (error) {
     if (error.statusCode === 404) {
       sessionId = null;
       const replacement = await getSession(fetchImpl);
       return { text: await promptSession(replacement, text.trim(), fetchImpl), session_id: replacement, ms: Math.round(performance.now() - started) };
    }
    throw error;
  }
}

function openrouterKey() {
  return process.env.OPENROUTER_API_KEY?.trim() || "";
}

function needsOpenCode(text) {
  const value = text.toLowerCase();
  return text.length > 240 || /\b(gbrain|remember|recall|memory|context|coding|code|implement|debug|fix|edit|file|repo|repository|git|terminal|command|script|research|search the web|use a tool)\b/.test(value);
}

function launchWindowsTarget(target) {
  const value = target.trim().toLowerCase();
  const appUris = {
    spotify: "spotify:",
    discord: "discord:",
    steam: "steam:",
    calculator: "calculator:",
    settings: "ms-settings:",
    teams: "msteams:",
    outlook: "ms-outlook:",
  };
  const appExecutables = {
    vscode: "code.exe",
    "visual studio code": "code.exe",
    chrome: "chrome.exe",
    edge: "msedge.exe",
    explorer: "explorer.exe",
    "file explorer": "explorer.exe",
    terminal: "wt.exe",
    "windows terminal": "wt.exe",
    notepad: "notepad.exe",
    "task manager": "taskmgr.exe",
  };
  const webUrls = {
    youtube: "https://youtube.com",
    "youtube music": "https://music.youtube.com",
    google: "https://google.com",
    gmail: "https://mail.google.com",
    calendar: "https://calendar.google.com",
    github: "https://github.com",
    notion: "https://notion.so",
    slack: "https://app.slack.com",
    chrome: "https://google.com",
    edge: "https://bing.com",
  };
  const executable = appExecutables[value];
  if (executable) {
    spawnDetached(executable);
    return `Opening ${target.trim()} now. Launch request finished.`;
  }
  if (value === "spotify") {
    // The URI broker focuses an already-running Spotify window; launching the
    // exe alone can leave Spotify in the background with no visible window.
    spawnDetached("explorer.exe", ["spotify:"]);
    return "Opening Spotify now. Spotify launch request finished.";
  }
  if (value === "spotify desktop") {
    const candidates = [
      join(process.env.APPDATA || "", "Spotify", "Spotify.exe"),
      join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "Spotify.exe"),
    ];
    const installed = candidates.find((candidate) => candidate && existsSync(candidate));
    if (installed) {
      spawnDetached(installed);
      return "Opening Spotify now. Spotify launch request finished.";
    }
  }
  if (value === "youtube music") {
    const app = launchYouTubeMusic();
    if (!app) spawnDetached("explorer.exe", ["https://music.youtube.com"]);
    return "Opening YouTube Music now. YouTube Music launch request finished.";
  }
  const destination = appUris[value] || webUrls[value] || (value.startsWith("http") ? value : null);
  if (!destination) return null;
  // Explorer is Windows' shell protocol broker. Unlike `cmd /c start`, it
  // does not create a console window while opening a URI or web URL.
  spawnDetached("explorer.exe", [destination]);
  return `Opening ${target.trim()} now. Launch request finished.`;
}

// ------------------------------------------------------- YouTube Music app

/**
 * The YouTube Music desktop app ships an optional local API server. It speaks
 * JWT: `POST /auth/{id}` shows a one-time Allow dialog in the app, then the id
 * stays in `authorizedClients` and later tokens are signed silently.
 */
const YTM_CLIENT_ID = "numa-core";
let ytmToken = null;
let ytmAuth = null;
let ytmDownUntil = 0;
let ytmUpAt = 0;

function ytmUrl() {
  return (process.env.NUMA_YTM_URL || "http://127.0.0.1:26538").replace(/\/$/, "");
}

/** Drop the cached token (tests, and after the app restarts). */
export function forgetYoutubeMusic() {
  ytmToken = null;
  ytmAuth = null;
  ytmDownUntil = 0;
  ytmUpAt = 0;
}

async function ytmAuthorize(fetchImpl = fetch) {
  if (ytmAuth) return ytmAuth;
  ytmAuth = (async () => {
    const response = await fetchImpl(`${ytmUrl()}/auth/${YTM_CLIENT_ID}`, {
      method: "POST",
      headers: { accept: "application/json" },
      // The app's approval dialog can sit on screen for a while, but not
      // longer than a person would leave it there.
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 403) {
      throw Object.assign(new Error("YouTube Music denied NUMA"), { statusCode: 502 });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`YouTube Music auth returned HTTP ${response.status}`), { statusCode: 502 });
    }
    const body = await response.json().catch(() => ({}));
    const token = typeof body?.accessToken === "string" ? body.accessToken : "";
    if (!token) throw Object.assign(new Error("YouTube Music returned no access token"), { statusCode: 502 });
    ytmToken = token;
    return token;
  })().finally(() => {
    ytmAuth = null;
  });
  return ytmAuth;
}

async function ytmRequest(path, { method = "GET", body, timeoutMs = 1500, fetchImpl = fetch } = {}) {
  const send = (token) =>
    fetchImpl(`${ytmUrl()}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  let response = await send(ytmToken || (await ytmAuthorize(fetchImpl)));
  if (response.status === 401) {
    // Tokens are signed with a per-launch secret, so a restart makes the
    // cached one stale. The id is already approved, so this is silent.
    ytmToken = null;
    response = await send(await ytmAuthorize(fetchImpl));
  }
  if (!response.ok) {
    throw Object.assign(new Error(`YouTube Music returned HTTP ${response.status}`), { statusCode: 502 });
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

/** True when the app is running and answering. Cached briefly both ways. */
async function ytmReady(fetchImpl = fetch) {
  const now = Date.now();
  if (now < ytmDownUntil) return false;
  if (now - ytmUpAt < 5000) return true;
  try {
    await ytmRequest("/song", { timeoutMs: 800, fetchImpl });
    ytmUpAt = Date.now();
    return true;
  } catch {
    ytmDownUntil = Date.now() + 15_000;
    return false;
  }
}

/**
 * Up or down without asking the app for a token: an unauthenticated request
 * that comes back 401 still proves the server is there. A health check must
 * never pop the approval dialog.
 */
async function ytmStatus(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${ytmUrl()}/api/v1/song`, {
      signal: AbortSignal.timeout(800),
    });
    return [200, 204, 401].includes(response.status) ? "up" : `http_${response.status}`;
  } catch {
    return "down";
  }
}

function textOf(field) {
  if (!field) return null;
  if (typeof field === "string") return field;
  if (Array.isArray(field.runs)) {
    const text = field.runs.map((run) => run?.text || "").join("").trim();
    return text || null;
  }
  return typeof field.simpleText === "string" ? field.simpleText : null;
}

/**
 * The first song in an innertube search response, whichever renderer wraps
 * it. The app hands back YouTube's own JSON, so the shape is not ours to fix.
 */
export function firstSong(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 40) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = firstSong(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const renderer =
    node.videoRenderer || node.compactVideoRenderer || node.playlistPanelVideoRenderer;
  if (renderer?.videoId) {
    return {
      videoId: renderer.videoId,
      title: textOf(renderer.title),
      artist: textOf(renderer.ownerText || renderer.longBylineText || renderer.shortBylineText),
    };
  }
  // Current YouTube Music search responses put the first match in a
  // musicCardShelfRenderer. Its title navigation endpoint carries the video
  // id, while subtitle runs are [Song, artist, duration].
  const card = node.musicCardShelfRenderer;
  const cardTitle = textOf(card?.title);
  const cardVideoId = card?.title?.runs?.find((run) => run?.navigationEndpoint?.watchEndpoint?.videoId)
    ?.navigationEndpoint?.watchEndpoint?.videoId;
  if (cardVideoId) {
    const subtitle = card?.subtitle?.runs?.map((run) => (run?.text || "").trim())
      .filter((text) => text && text !== "•") || [];
    return {
      videoId: cardVideoId,
      title: cardTitle,
      artist: subtitle[0] === "Song" ? subtitle[1] || null : subtitle[0] || null,
    };
  }
  for (const value of Object.values(node)) {
    const found = firstSong(value, depth + 1);
    if (found) return found;
  }
  return null;
}

async function ytmConfirm(videoId, fetchImpl = fetch) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const song = await ytmRequest("/song", { fetchImpl }).catch(() => null);
    if (song?.videoId && (!videoId || song.videoId === videoId)) return song;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

function queueVideoId(item) {
  const renderer = item?.playlistPanelVideoRenderer ||
    item?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer;
  return renderer?.videoId || renderer?.navigationEndpoint?.watchEndpoint?.videoId || null;
}

/**
 * Play the best match for `query` and report what actually started, or null
 * when the app isn't there so the caller can fall back to a search page.
 */
export async function ytmPlay(query, fetchImpl = fetch) {
  if (!(await ytmReady(fetchImpl))) return null;
  const results = await ytmRequest("/search", {
    method: "POST",
    body: { query },
    timeoutMs: 4000,
    fetchImpl,
  });
  const found = firstSong(results);
  if (!found) return null;
  await ytmRequest("/queue", {
    method: "POST",
    body: { videoId: found.videoId, insertPosition: "INSERT_AFTER_CURRENT_VIDEO" },
    fetchImpl,
  });
  // Queue insertion is asynchronous. Calling /next here can skip over the
  // requested song when the app already has a queue. Wait for the item, then
  // select its exact queue index through the API.
  const deadline = Date.now() + 3000;
  let queueIndex = -1;
  while (Date.now() < deadline) {
    const queue = await ytmRequest("/queue", { fetchImpl }).catch(() => null);
    queueIndex = Array.isArray(queue?.items) ? queue.items.findIndex((item) => queueVideoId(item) === found.videoId) : -1;
    if (queueIndex >= 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (queueIndex < 0) return null;
  await ytmRequest("/queue", { method: "PATCH", body: { index: queueIndex }, fetchImpl });
  return ytmConfirm(found.videoId, fetchImpl);
}

/** One media action through the app, or null when it isn't running. */
export async function ytmMedia(action, fetchImpl = fetch) {
  // Volume stays on the Windows media keys: "louder" means the machine, not
  // the player's own fader.
  if (!["play", "pause", "play_pause", "next", "prev", "mute", "unmute"].includes(action)) {
    return null;
  }
  if (!(await ytmReady(fetchImpl))) return null;
  if (action === "play" || action === "pause" || action === "play_pause") {
    // A toggle needs the state it started from, or the reply can't tell
    // whether the flip landed.
    const before =
      action === "play_pause"
        ? await ytmRequest("/song", { fetchImpl }).catch(() => null)
        : null;
    const path = action === "play_pause" ? "/toggle-play" : `/${action}`;
    await ytmRequest(path, { method: "POST", fetchImpl });
    const want =
      action === "play_pause" ? before?.isPaused !== true : action === "play" ? false : true;
    // Poll for the state the action asked for instead of sleeping a fixed
    // time: a stale read would report "Playing" while it is paused.
    const deadline = Date.now() + 400;
    let song = null;
    while (Date.now() < deadline) {
      song = await ytmRequest("/song", { fetchImpl }).catch(() => null);
      if (song?.title && song.isPaused === want) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (!song?.title) return action === "pause" ? "Paused." : "Playing.";
    const state = song.isPaused ? "Paused" : "Playing";
    return `${state} ${song.title}${song.artist ? ` by ${song.artist}` : ""}.`;
  }
  if (action === "next") {
    await ytmRequest("/next", { method: "POST", fetchImpl });
    return "Skipping forward.";
  }
  if (action === "prev") {
    await ytmRequest("/previous", { method: "POST", fetchImpl });
    return "Going back.";
  }
  if (action === "mute" || action === "unmute") {
    const volume = await ytmRequest("/volume", { fetchImpl }).catch(() => null);
    const muted = volume?.isMuted === true;
    // Toggling blind would mute when the user asked to unmute.
    if ((action === "mute") !== muted) {
      await ytmRequest("/toggle-mute", { method: "POST", fetchImpl });
    }
    return action === "mute" ? "Muted." : "Unmuted.";
  }
  return null;
}

async function localAction(text, fetchImpl = fetch) {
  const value = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (/^(?:please\s+)?(?:close|hide)\s+(?:yourself|the notch|your notch)$/.test(value)) {
    return { text: "Closing.", action: "collapse" };
  }
  const compact = value
    .replace(/^(please\s+)?(can you\s+)?/i, "")
    .replace(/\b(the|my|music|media|song|track)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // [app action, media-key fallback, spoken reply]. The app gets a real
  // play/pause rather than a toggle, so "pause" can never start playback.
  const media = new Map([
    ["pause", ["pause", "play_pause", "Pausing." ]],
    ["pause music", ["pause", "play_pause", "Pausing." ]],
    ["play", ["play", "play_pause", "Playing." ]],
    ["play music", ["play", "play_pause", "Playing." ]],
    ["resume", ["play", "play_pause", "Resuming." ]],
    ["stop", ["pause", "play_pause", "Stopping." ]],
    ["stop music", ["pause", "play_pause", "Stopping." ]],
    ["next", ["next", "next", "Skipping forward." ]],
    ["next track", ["next", "next", "Skipping forward." ]],
    ["previous", ["prev", "prev", "Going back." ]],
    ["previous track", ["prev", "prev", "Going back." ]],
    ["volume up", ["volume_up", "volume_up", "Volume up." ]],
    ["louder", ["volume_up", "volume_up", "Volume up." ]],
    ["volume down", ["volume_down", "volume_down", "Volume down." ]],
    ["quieter", ["volume_down", "volume_down", "Volume down." ]],
    ["mute", ["mute", "mute", "Muted." ]],
    ["unmute", ["unmute", "unmute", "Unmuted." ]],
  ]);
  const mediaCommand = media.get(compact);
  if (mediaCommand) {
    const [action, fallback, reply] = mediaCommand;
    // Prefer the app's own API: it knows the real player state and can name
    // the track. A media key only nudges whatever Windows thinks is playing.
    const handled = await ytmMedia(action, fetchImpl).catch(() => null);
    return handled ? { text: handled } : { text: reply, action: fallback };
  }
  // YouTube Music is NUMA's default music target. A specific song/artist
  // should never fall through to a conversational model.
  const defaultPlay = value.match(/^play\s+(.+)$/i);
  if (defaultPlay && !/^music$/i.test(defaultPlay[1].trim()) &&
      !/\s+(?:on|in)\s+(?:spotify|youtube music|yt music)$/i.test(value)) {
    const query = defaultPlay[1].trim();
    let song = await ytmPlay(query, fetchImpl).catch(() => null);
    if (!song) {
      // Start the desktop app when its local API is not running, then give it
      // a short bounded window to become ready before falling back.
      const launched = launchYouTubeMusic();
      if (launched) {
        ytmDownUntil = 0;
        for (let attempt = 0; attempt < 10 && !song; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          song = await ytmPlay(query, fetchImpl).catch(() => null);
        }
      }
    }
    if (song?.title) {
      return { text: `Playing ${song.title}${song.artist ? ` by ${song.artist}` : ""}.` };
    }
    // Do not claim playback when the app/API did not confirm it.
    const url = `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
    spawnDetached("explorer.exe", [url]);
    return { text: "YouTube Music opened, but playback could not be confirmed. I opened the search instead." };
  }
  const spotifySearch = value.match(/^(?:play|search)\s+(.+?)\s+(?:on|in)\s+spotify$/i);
  if (spotifySearch) {
    spawnDetached("explorer.exe", [`spotify:search:${encodeURIComponent(spotifySearch[1].trim())}`]);
    return { text: "Opening Spotify search now. Search request finished." };
  }
  const youtubeSearch = value.match(/^(?:play|search)\s+(.+?)\s+(?:on|in)\s+(?:youtube music|yt music)$/i);
  if (youtubeSearch) {
    const url = `https://music.youtube.com/search?q=${encodeURIComponent(youtubeSearch[1].trim())}`;
    const app = launchYouTubeMusic(url);
    if (!app) spawnDetached("explorer.exe", [url]);
    return { text: "Opening YouTube Music search now. Search request finished." };
  }
  const match = text.trim().match(/^(?:open|launch|start)\s+(.+)$/i);
  if (!match) return null;
  const opened = launchWindowsTarget(match[1]);
  return opened ? { text: opened } : null;
}

export async function askFast(text, fetchImpl = fetch) {
  const key = openrouterKey();
  if (!key) throw Object.assign(new Error("OPENROUTER_API_KEY is not configured"), { statusCode: 503 });
  const response = await fetchImpl(process.env.NUMA_FAST_URL || OPENROUTER_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      model: process.env.NUMA_FAST_MODEL || DEFAULT_FAST_MODEL,
      messages: [
        { role: "system", content: `${NUMA_SYSTEM_PROMPT}\n\n${profileContext()}` },
        ...recentContext(),
        { role: "user", content: text.trim() },
      ],
      max_tokens: 256,
      temperature: 0.2,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || `Fast API returned HTTP ${response.status}`), { statusCode: response.status });
  const reply = body?.choices?.[0]?.message?.content?.trim();
  if (!reply) throw Object.assign(new Error("Fast API returned no response"), { statusCode: 502 });
  return { text: reply, route: "fast" };
}

export async function askNuma(text, fetchImpl = fetch) {
  if (!text?.trim()) throw Object.assign(new Error("message is empty"), { statusCode: 400 });
  const started = performance.now();
  const local = await localAction(text, fetchImpl);
  if (local) {
    const result = { ...local, route: "local", ms: Math.round(performance.now() - started) };
    rememberTurn(text.trim(), result.text, result.route);
    return result;
  }
  if (!needsOpenCode(text)) {
    try {
      const result = { ...(await askFast(text, fetchImpl)), ms: Math.round(performance.now() - started) };
      rememberTurn(text.trim(), result.text, result.route);
      return result;
    } catch (error) {
      if (error.statusCode !== 503) throw error;
    }
  }
  const result = { ...(await askOpenCode(text, fetchImpl)), route: "opencode", ms: Math.round(performance.now() - started) };
  rememberTurn(text.trim(), result.text, result.route);
  return result;
}

async function openCodeHealth(fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`${opencodeUrl()}/global/health`, { headers: opencodeHeaders() });
    return response.ok ? "up" : `http_${response.status}`;
  } catch {
    return "down";
  }
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

export function createNumaCoreServer({ fetchImpl = fetch } = {}) {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/v1/health") {
        return json(response, 200, { core: "up", stt: deepgramKey() ? "configured" : "missing_key", opencode: await openCodeHealth(fetchImpl), ytm: await ytmStatus(fetchImpl) });
      }
      if (request.method === "GET" && request.url === "/v1/models") return json(response, 200, { data: [{ id: "numa-core", object: "model", owned_by: "oyenza" }] });
      if (request.method === "GET" && request.url === "/v1/numa/history") return json(response, 200, { data: getNumaHistory() });
      if (request.method === "GET" && request.url === "/v1/numa/profile") return json(response, 200, { data: loadNumaProfile() });
      if (request.method === "POST" && request.url === "/v1/numa/reset") {
        resetNumaHistory();
        return json(response, 200, { ok: true });
      }
      if (request.method === "POST" && request.url === "/v1/audio/transcriptions") {
        if (!request.headers["content-type"]?.startsWith("audio/wav")) return json(response, 415, { error: "expected audio/wav" });
        return json(response, 200, await transcribeWav(await readBody(request), fetchImpl));
      }
      if (request.method === "POST" && request.url === "/v1/audio/speech") {
        const body = await readJson(request);
        if (typeof body?.input !== "string" || !body.input.trim()) return json(response, 400, { error: "input is required" });
        const audio = await synthesizeSpeech(body.input, fetchImpl);
        response.writeHead(200, { "content-type": "audio/wav", "content-length": audio.length });
        return response.end(audio);
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const body = await readJson(request);
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const last = [...messages].reverse().find((message) => message?.role === "user");
        const text = typeof last?.content === "string" ? last.content : body?.text;
         const result = await askNuma(text, fetchImpl);
         return json(response, 200, { choices: [{ message: { role: "assistant", content: result.text } }], numa_action: result.action || null, route: result.route, ms: result.ms });
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      return json(response, error.statusCode || 502, { error: error.message || "NUMA Core request failed" });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = portFromArgs();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`);
  const server = createNumaCoreServer();
  server.listen(port, HOST, () => {
    warmOpenCode();
    warmSpeech();
    console.log(`NUMA Core listening on http://${HOST}:${port}`);
  });
}
