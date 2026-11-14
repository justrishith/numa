/**
 * Speech in and out, straight from the gateway.
 *
 * This replaces the old `numa-core.mjs` audio edge (port 8899). The Deepgram
 * key never leaves this process, and nothing here talks to a second brain:
 * a finished WAV goes in, text comes out; text goes in, a WAV comes out.
 */

const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";
const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
const DEFAULT_TTS_MODEL = "aura-2-thalia-en";

/** Largest synthesized clip accepted (about eleven minutes of 24 kHz mono PCM). */
export const MAX_SPEECH_BYTES = 32 * 1024 * 1024;

export class UpstreamError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "UpstreamError";
    this.statusCode = statusCode;
  }
}

export function deepgramKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.DEEPGRAM_API_KEY?.trim() ?? "";
}

export interface TranscribeResult {
  text: string;
  ms: number;
}

/**
 * Transcribe a finished WAV. Nova-3 with smart formatting because the output is
 * read by a person in the notch, not parsed.
 *
 * An empty transcript is a normal outcome, not an error: the mic may have
 * caught a breath. Deepgram also returns empty for some short clips that do
 * contain speech, so one retry is attempted; if that is empty too, the caller
 * gets `{ text: "" }` and decides what to say.
 */
export async function transcribe(
  audio: Buffer,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TranscribeResult> {
  const key = deepgramKey(env);
  if (!key) throw new UpstreamError("DEEPGRAM_API_KEY is not configured", 503);
  if (audio.length < 44) throw new UpstreamError("recording is too short", 400);

  const started = performance.now();
  const url = new URL(env.NUMA_DEEPGRAM_URL || DEEPGRAM_LISTEN_URL);
  url.searchParams.set("model", env.NUMA_STT_MODEL || "nova-3");
  url.searchParams.set("language", env.NUMA_STT_LANGUAGE || "en");
  url.searchParams.set("smart_format", "true");

  const once = async (): Promise<string> => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Token ${key}`,
        "content-type": "audio/wav",
        accept: "application/json",
      },
      body: new Uint8Array(audio),
    });
    const body = (await response.json().catch(() => ({}))) as {
      err_msg?: string;
      message?: string;
      results?: {
        channels?: { alternatives?: { transcript?: string }[] }[];
      };
    };
    if (!response.ok) {
      throw new UpstreamError(
        body.err_msg || body.message || `Deepgram returned HTTP ${response.status}`,
        502,
      );
    }
    return body.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
  };

  const first = await once();
  if (first) return { text: first, ms: Math.round(performance.now() - started) };

  const second = await once();
  return { text: second, ms: Math.round(performance.now() - started) };
}

/**
 * Deepgram streams its WAV, so the header carries placeholder lengths
 * (0x7FFF0000, roughly 2 GB) instead of the real sizes. Windows' winmm loads
 * that header, decides the file is far larger than the bytes that exist, and
 * plays nothing while still reporting success. Rewrite the RIFF and `data`
 * sizes from the bytes actually received.
 */
export function fixWavHeader(audio: Buffer): Buffer {
  if (audio.length < 44) return audio;
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") {
    return audio;
  }
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

const speechCache = new Map<string, Buffer>();
const speechInflight = new Map<string, Promise<Buffer>>();

/** Synthesize a spoken reply, cached so repeated phrases cost nothing. */
export async function synthesize(
  text: string,
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  const key = deepgramKey(env);
  if (!key) throw new UpstreamError("DEEPGRAM_API_KEY is not configured", 503);
  const cacheKey = text.trim();
  if (!cacheKey) throw new UpstreamError("nothing to say", 400);

  const cached = speechCache.get(cacheKey);
  if (cached) return Buffer.from(cached);
  const inflight = speechInflight.get(cacheKey);
  if (inflight) return Buffer.from(await inflight);

  const request = (async () => {
    const model = encodeURIComponent(env.NUMA_TTS_MODEL || DEFAULT_TTS_MODEL);
    const url = new URL(
      env.NUMA_DEEPGRAM_TTS_URL ||
        `${DEEPGRAM_SPEAK_URL}?model=${model}&encoding=linear16&container=wav`,
    );
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Token ${key}`,
        "content-type": "application/json",
        accept: "audio/wav",
      },
      body: JSON.stringify({ text: cacheKey }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new UpstreamError(
        detail || `Deepgram TTS returned HTTP ${response.status}`,
        502,
      );
    }
    const audio = fixWavHeader(Buffer.from(await response.arrayBuffer()));
    if (audio.length > MAX_SPEECH_BYTES) {
      throw new UpstreamError("synthesized clip is too large", 502);
    }
    speechCache.set(cacheKey, audio);
    while (speechCache.size > 32) {
      const oldest = speechCache.keys().next().value;
      if (oldest === undefined) break;
      speechCache.delete(oldest);
    }
    return audio;
  })();

  speechInflight.set(cacheKey, request);
  try {
    return Buffer.from(await request);
  } finally {
    speechInflight.delete(cacheKey);
  }
}
