import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { type AppEntry, appIndex, normalizeAppQuery, resolveFromIndex } from "../apps.ts";
import { defineTool } from "../registry.ts";

const execFileAsync = promisify(execFile);

/**
 * tasklist exits 1 when it prints a "no tasks" note, so the output matters,
 * not the status code.
 */
async function tasklist(args: string[], timeout: number, maxBuffer = 1024 * 1024): Promise<string> {
  try {
    const { stdout } = await execFileAsync("tasklist.exe", args, {
      windowsHide: true,
      timeout,
      maxBuffer,
    });
    return stdout;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) return stdout;
    throw error;
  }
}

/** How many processes currently carry this image name. */
async function countProcesses(image: string): Promise<number> {
  const stdout = await tasklist(["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], 5_000);
  return stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('"')).length;
}

/**
 * Every visible window title on the machine right now.
 *
 * `tasklist /v` is not usable here: it asks each process for its window title
 * and blocks on any hung process, which on a real desktop can take minutes.
 * `Get-Process` reads the same information in about 150 ms.
 */
const WINDOW_TITLES_SCRIPT =
  "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle } | ConvertTo-Json -Compress";

async function windowTitles(): Promise<Set<string>> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", WINDOW_TITLES_SCRIPT],
    { windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const text = stdout.trim();
  if (!text) return new Set();
  const parsed = JSON.parse(text) as string | string[];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return new Set(list.map((title) => title.trim()).filter(Boolean));
}

/** Words too generic to prove which window is ours. */
const WEAK_HINTS = new Set(["app", "web", "the", "and", "for", "music", "desktop"]);

function hintsFor(entry: AppEntry): string[] {
  const words = [entry.label, ...entry.keys]
    .map(normalizeAppQuery)
    .join(" ")
    .split(" ")
    .filter((word) => word.length >= 3 && !WEAK_HINTS.has(word));
  return [...new Set(words)];
}

function titleMatches(title: string, hints: string[]): boolean {
  const normalized = normalizeAppQuery(title);
  return hints.some((hint) => normalized.includes(hint));
}

/**
 * A name that is really a web address. The router only sends these here, and
 * the entry is built on the spot so nothing has to be installed.
 */
function adHocUrl(query: string): AppEntry | null {
  const raw = query.trim();
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i.test(raw)) return null;
  const host = raw.split("/")[0] ?? raw;
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return {
    key: raw.toLowerCase(),
    label: host.replace(/^www\./i, ""),
    kind: "url",
    url,
    source: "web",
    keys: [raw.toLowerCase(), host.toLowerCase()],
  };
}

function launch(entry: AppEntry): void {
  let child;
  if (entry.kind === "exe" && entry.exe) {
    child = spawn(entry.exe, entry.args ?? [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } else if (entry.kind === "aumid" && entry.aumid) {
    child = spawn("explorer.exe", [`shell:AppsFolder\\${entry.aumid}`], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } else if (entry.kind === "url" && entry.url) {
    child = spawn("cmd.exe", ["/c", "start", "", entry.url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    throw new Error(`${entry.label} has no launch target`);
  }
  child.unref();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const inputSchema = z.object({
  app: z.string().min(1).max(160),
});

interface LaunchData {
  app: string;
  key: string;
  label: string;
  kind: AppEntry["kind"];
  image: string | null;
  hints: string[];
  beforeProcesses: number;
  beforeTitles: string[];
  /** A window that already matched the app, so a relaunch adds nothing new. */
  alreadyOpen: boolean;
}

/**
 * Opens whatever the user named and then checks, from the operating system,
 * that it really came up. The launch request alone is never proof: an exe must
 * show a process, and an AUMID or URL must show a window it did not have before.
 */
export const appLaunchTool = defineTool<z.infer<typeof inputSchema>>({
  id: "app.launch",
  description:
    "Open a desktop app, Store app or website by name, e.g. Chrome, Notepad, YouTube Music, Minecraft.",
  risk: "low",
  permissionLevel: 1,
  timeoutMs: 25_000,
  inputSchema,
  async execute(input, context) {
    if (context.signal.aborted) return { ok: false, summary: "cancelled before launch" };

    const index = await appIndex();
    const entry = resolveFromIndex(input.app, index) ?? adHocUrl(input.app);
    if (!entry) {
      return { ok: false, summary: `I don't know an app called "${input.app}"` };
    }

    const hints = hintsFor(entry);
    const beforeProcesses = entry.image ? await countProcesses(entry.image) : 0;
    const beforeTitles = entry.kind === "exe" && entry.image ? [] : [...(await windowTitles())];
    const alreadyOpen = beforeTitles.some((title) => titleMatches(title, hints));

    try {
      launch(entry);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, summary: `could not open ${entry.label}: ${detail}` };
    }

    const data: LaunchData = {
      app: input.app,
      key: entry.key,
      label: entry.label,
      kind: entry.kind,
      image: entry.image ?? null,
      hints,
      beforeProcesses,
      beforeTitles,
      alreadyOpen,
    };
    return {
      ok: true,
      summary: `Launch requested for ${entry.label}`,
      data,
    };
  },
  async verify(result, context) {
    if (!result.ok) return { verified: false, detail: result.summary };
    const data = result.data as LaunchData;

    // Opening a page or app that is already on screen changes no window title,
    // so the honest answer is that it was already open.
    if (data.alreadyOpen) {
      return { verified: true, detail: `${data.label} was already open` };
    }

    const deadline = Date.now() + 8_000;
    let lastDetail = "";

    while (Date.now() < deadline) {
      if (context.signal.aborted) {
        return { verified: false, detail: "cancelled during verification" };
      }

      if (data.image) {
        const after = await countProcesses(data.image);
        if (after > 0) {
          return {
            verified: true,
            detail:
              after > data.beforeProcesses
                ? `${data.label} is running (${data.beforeProcesses} → ${after} processes)`
                : `${data.label} was already running`,
            data: { before: data.beforeProcesses, after },
          };
        }
        lastDetail = `${data.label} did not appear within 8 seconds`;
      } else {
        const before = new Set(data.beforeTitles);
        const opened = [...(await windowTitles())].filter((title) => !before.has(title));
        const hit = opened.find((title) => titleMatches(title, data.hints));
        if (hit) {
          return {
            verified: true,
            detail: `${data.label} opened: ${hit}`,
            data: { title: hit },
          };
        }
        lastDetail = opened.length
          ? `${data.label} did not open; new windows: ${opened.slice(0, 3).join(", ")}`
          : `${data.label} did not open within 8 seconds`;
      }

      await sleep(400);
    }

    return { verified: false, detail: lastDetail };
  },
});
