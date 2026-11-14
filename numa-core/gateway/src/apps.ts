/**
 * The machine's app index.
 *
 * "open minecraft" has to work for whatever the user actually installed, so the
 * resolver reads the real Windows inventory instead of a hardcoded table: Start
 * Menu shortcuts (with their resolved targets), App Paths registry entries, and
 * `Get-StartApps` AUMIDs. Builtins and web targets cover the things that have no
 * shortcut at all.
 *
 * Everything here is pure data plus one cached probe, so routing stays testable
 * without touching the machine.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AppKind = "exe" | "aumid" | "url";

export type AppSource = "builtin" | "start-menu" | "start-apps" | "app-paths" | "web";

export interface AppEntry {
  /** Canonical identity, also the first lookup key. */
  key: string;
  label: string;
  kind: AppKind;
  /** Absolute path for `exe` entries. */
  exe?: string;
  args?: string[];
  /** Process image name used to verify an `exe` launch. */
  image?: string;
  aumid?: string;
  url?: string;
  source: AppSource;
  /** Every phrase that should find this entry. */
  keys: string[];
}

export interface AppIndex {
  entries: AppEntry[];
  /** Spoken phrase → entry key. Applied before fuzzy matching. */
  synonyms: Record<string, string>;
}

const SOURCE_RANK: Record<AppSource, number> = {
  builtin: 0,
  "start-menu": 1,
  "start-apps": 2,
  "app-paths": 3,
  web: 4,
};

const WINDIR = process.env["WINDIR"] ?? "C:\\Windows";
const PROGRAM_FILES = process.env["PROGRAMFILES"];
const LOCAL_APP_DATA = process.env["LOCALAPPDATA"];

function exe(
  key: string,
  label: string,
  path: string,
  image: string,
  keys: string[] = [],
): AppEntry {
  return {
    key,
    label,
    kind: "exe",
    exe: path,
    image,
    source: "builtin",
    keys: [key, ...keys],
  };
}

function builtinEntries(): AppEntry[] {
  const entries: AppEntry[] = [
    exe("notepad", "Notepad", `${WINDIR}\\System32\\notepad.exe`, "notepad.exe", [
      "text editor",
      "notes",
    ]),
    exe("explorer", "File Explorer", `${WINDIR}\\explorer.exe`, "explorer.exe", [
      "files",
      "file explorer",
      "my files",
      "folders",
    ]),
    exe("cmd", "Command Prompt", `${WINDIR}\\System32\\cmd.exe`, "cmd.exe", [
      "terminal",
      "command prompt",
      "shell",
    ]),
    exe("powershell", "PowerShell", `${WINDIR}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "powershell.exe", []),
    exe("taskmgr", "Task Manager", `${WINDIR}\\System32\\Taskmgr.exe`, "Taskmgr.exe", [
      "task manager",
    ]),
    exe("mspaint", "Paint", `${WINDIR}\\System32\\mspaint.exe`, "mspaint.exe", ["paint"]),
    {
      key: "settings",
      label: "Settings",
      kind: "url",
      url: "ms-settings:",
      source: "builtin",
      keys: ["settings", "windows settings"],
    },
  ];

  const chromeCandidates = [
    PROGRAM_FILES && `${PROGRAM_FILES}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env["PROGRAMFILES(X86)"] &&
      `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    LOCAL_APP_DATA && `${LOCAL_APP_DATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ];
  const chrome = chromeCandidates.find((path): path is string => !!path);
  if (chrome) {
    entries.push(exe("chrome", "Google Chrome", chrome, "chrome.exe", ["google chrome", "browser"]));
  }
  return entries;
}

const WEB_APPS: [key: string, label: string, url: string, keys: string[]][] = [
  ["youtube", "YouTube", "https://www.youtube.com", ["youtube"]],
  ["gmail", "Gmail", "https://mail.google.com", ["gmail", "email", "mail"]],
  ["github", "GitHub", "https://github.com", ["github"]],
  ["google", "Google", "https://www.google.com", ["google", "search"]],
  ["chatgpt", "ChatGPT", "https://chatgpt.com", ["chatgpt", "chat gpt", "openai"]],
  ["reddit", "Reddit", "https://www.reddit.com", ["reddit"]],
  ["twitter", "X", "https://x.com", ["twitter", "x"]],
  ["maps", "Google Maps", "https://maps.google.com", ["maps", "google maps"]],
  ["drive", "Google Drive", "https://drive.google.com", ["drive", "google drive"]],
  ["docs", "Google Docs", "https://docs.google.com", ["docs", "google docs"]],
  ["calendar", "Google Calendar", "https://calendar.google.com", ["calendar"]],
  ["netflix", "Netflix", "https://www.netflix.com", ["netflix"]],
  ["spotify-web", "Spotify Web", "https://open.spotify.com", ["spotify web"]],
];

function webEntries(): AppEntry[] {
  return WEB_APPS.map(([key, label, url, keys]) => ({
    key,
    label,
    kind: "url" as const,
    url,
    source: "web" as const,
    keys: [key, ...keys],
  }));
}

/**
 * Spoken names that do not look like the installed name. A phrase is only
 * honoured when the key it points at exists in the index.
 */
const BASE_SYNONYMS: Record<string, string> = {
  minecraft: "sklauncher",
  "mine craft": "sklauncher",
  "minecraft launcher": "sklauncher",
  ytm: "youtube music",
  ytmusic: "youtube music",
  "you tube music": "youtube music",
  yt: "youtube",
  "vs code": "visual studio code",
  vscode: "visual studio code",
  code: "visual studio code",
  "chrome browser": "chrome",
  "google browser": "chrome",
  "file manager": "explorer",
  "windows explorer": "explorer",
  "the terminal": "cmd",
  "command line": "cmd",
  "music": "youtube music",
  "discord app": "discord",
  "opencode desktop": "opencode",
};

/** Builtins plus web targets: no machine scan, safe for tests and cold paths. */
export function builtinIndex(): AppIndex {
  return {
    entries: [...builtinEntries(), ...webEntries()],
    synonyms: { ...BASE_SYNONYMS },
  };
}

/** Lowercased, punctuation-free, single-spaced. */
export function normalizeAppQuery(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text: string): string[] {
  const normalized = normalizeAppQuery(text);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Pick the entry a spoken phrase names, or nothing.
 *
 * Order: exact key or label, then a synonym, then "every word the user said
 * appears in this app's name". Ties go to the more trustworthy source and the
 * shorter label, so "youtube music" never lands on the YouTube website.
 */
export function resolveFromIndex(query: string, index: AppIndex): AppEntry | null {
  const wanted = normalizeAppQuery(query);
  if (!wanted) return null;

  // Shortcut names often carry a version ("SKlauncher 4.0") that nobody says.
  // Normalization turns the dot into a space, so versions look like "4 0".
  const variants = [wanted];
  const withoutVersion = wanted.replace(/\s+\d+(?:\s+\d+)*$/, "").trim();
  if (withoutVersion && withoutVersion !== wanted) variants.push(withoutVersion);

  let best: AppEntry | null = null;
  let bestScore = 0;

  const consider = (entry: AppEntry, score: number): void => {
    if (score > bestScore) {
      best = entry;
      bestScore = score;
      return;
    }
    if (score < bestScore || !best) return;
    const betterSource = SOURCE_RANK[entry.source] < SOURCE_RANK[best.source];
    const shorterLabel = entry.label.length < best.label.length;
    if (betterSource || (SOURCE_RANK[entry.source] === SOURCE_RANK[best.source] && shorterLabel)) {
      best = entry;
    }
  };

  for (const [variantIndex, variant] of variants.entries()) {
    const penalty = variantIndex * 2;
    const wantedTokens = tokens(variant);
    const synonymTarget = index.synonyms[variant]
      ? normalizeAppQuery(index.synonyms[variant] as string)
      : null;

    for (const entry of index.entries) {
      const entryKeys = [entry.key, ...entry.keys].map(normalizeAppQuery);
      const label = normalizeAppQuery(entry.label);

      if (entryKeys.includes(variant) || label === variant) {
        consider(entry, 100 - penalty);
        continue;
      }
      if (synonymTarget && (entryKeys.includes(synonymTarget) || label === synonymTarget)) {
        consider(entry, 95 - penalty);
        continue;
      }
      if (wantedTokens.length === 0) continue;

      const entryTokens = new Set<string>([
        ...tokens(entry.label),
        ...entryKeys.flatMap((value) => tokens(value)),
      ]);
      if (wantedTokens.every((token) => entryTokens.has(token))) {
        // More words in the entry than the user said means a looser fit.
        const extra = Math.max(0, entryTokens.size - wantedTokens.length);
        consider(entry, 80 - Math.min(30, extra) - penalty);
      }
    }
  }

  return best;
}

interface ShortcutRow {
  name?: string;
  target?: string;
  args?: string;
}

interface AppPathRow {
  name?: string;
  target?: string;
}

interface StartAppRow {
  Name?: string;
  AppID?: string;
}

interface Inventory {
  links?: ShortcutRow[];
  paths?: AppPathRow[];
  apps?: StartAppRow[];
}

/**
 * One PowerShell call returns all three inventories. `WScript.Shell` is the
 * only reliable way to read a shortcut target without a native module.
 */
const INVENTORY_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$links = @()
$shell = New-Object -ComObject WScript.Shell
$roots = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:PROGRAMDATA\\Microsoft\\Windows\\Start Menu\\Programs")
foreach ($root in $roots) {
  foreach ($file in (Get-ChildItem -Path $root -Recurse -Filter *.lnk -ErrorAction SilentlyContinue)) {
    $shortcut = $shell.CreateShortcut($file.FullName)
    $links += [pscustomobject]@{ name = $file.BaseName; target = $shortcut.TargetPath; args = $shortcut.Arguments }
  }
}
$paths = @()
foreach ($hive in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  foreach ($key in (Get-ChildItem -Path $hive -ErrorAction SilentlyContinue)) {
    $value = (Get-ItemProperty -Path $key.PSPath -ErrorAction SilentlyContinue).'(default)'
    if ($value) { $paths += [pscustomobject]@{ name = $key.PSChildName; target = $value } }
  }
}
$apps = @(Get-StartApps | Select-Object Name, AppID)
[pscustomobject]@{ links = @($links); paths = @($paths); apps = @($apps) } | ConvertTo-Json -Depth 4 -Compress
`;

const SKIP_LINK = /uninstall|readme|help|website|manual|release notes|documentation|licen[cs]e|repair|setup|installer/i;

function splitArgs(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const value = match[1] ?? match[2] ?? "";
    // Shortcut bookkeeping, not something the app needs at launch.
    if (value.startsWith("--source-shortcut-location")) continue;
    if (value) out.push(value);
  }
  return out;
}

function imageOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
}

/** Build the index from a raw inventory; exported so tests can feed fixtures. */
export function indexFromInventory(inventory: Inventory): AppIndex {
  const index = builtinIndex();
  const seen = new Set(index.entries.map((entry) => normalizeAppQuery(entry.key)));

  const add = (entry: AppEntry): void => {
    const normalizedKey = normalizeAppQuery(entry.key);
    if (!normalizedKey || seen.has(normalizedKey)) return;
    seen.add(normalizedKey);
    index.entries.push(entry);
  };

  for (const link of inventory.links ?? []) {
    const name = link.name?.trim();
    const target = link.target?.trim();
    if (!name || !target || SKIP_LINK.test(name)) continue;
    if (!/\.exe$/i.test(target)) continue;
    const image = imageOf(target);
    add({
      key: name.toLowerCase(),
      label: name,
      kind: "exe",
      exe: target,
      args: splitArgs(link.args),
      image,
      source: "start-menu",
      keys: [name, name.replace(/\s+\d+(\.\d+)*$/, ""), image.replace(/\.exe$/i, "")],
    });
  }

  for (const app of inventory.apps ?? []) {
    const name = app.Name?.trim();
    const appId = app.AppID?.trim();
    if (!name || !appId) continue;
    if (/\.exe$/i.test(appId)) {
      const image = imageOf(appId);
      add({
        key: name.toLowerCase(),
        label: name,
        kind: "exe",
        exe: appId,
        image,
        source: "start-apps",
        keys: [name, image.replace(/\.exe$/i, "")],
      });
      continue;
    }
    add({
      key: name.toLowerCase(),
      label: name,
      kind: "aumid",
      aumid: appId,
      source: "start-apps",
      keys: [name],
    });
  }

  for (const row of inventory.paths ?? []) {
    const name = row.name?.trim();
    const target = row.target?.trim();
    if (!name || !target || !/\.exe$/i.test(target)) continue;
    const image = imageOf(target);
    add({
      key: name.replace(/\.exe$/i, "").toLowerCase(),
      label: name.replace(/\.exe$/i, ""),
      kind: "exe",
      exe: target,
      image,
      source: "app-paths",
      keys: [name.replace(/\.exe$/i, ""), image.replace(/\.exe$/i, "")],
    });
  }

  return index;
}

async function readInventory(): Promise<Inventory> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", INVENTORY_SCRIPT],
    { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const text = stdout.trim();
  if (!text) return {};
  return JSON.parse(text) as Inventory;
}

let cachedIndex: AppIndex | null = null;
let cachedAt = 0;
let inflight: Promise<AppIndex> | null = null;
const INDEX_TTL_MS = 10 * 60 * 1000;

/**
 * The machine index, built once and reused. A failed scan still yields the
 * builtin set: "open chrome" must not depend on PowerShell being healthy.
 */
export async function appIndex(): Promise<AppIndex> {
  if (cachedIndex && Date.now() - cachedAt < INDEX_TTL_MS) return cachedIndex;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const index = indexFromInventory(await readInventory());
      cachedIndex = index;
      cachedAt = Date.now();
      return index;
    } catch (error) {
      console.warn("app index scan failed:", (error as Error).message);
      const fallback = builtinIndex();
      cachedIndex = fallback;
      // Retry sooner than a successful scan so a transient failure heals.
      cachedAt = Date.now() - INDEX_TTL_MS + 60_000;
      return fallback;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Warm the index without blocking boot; failures are logged, never fatal. */
export function warmAppIndex(): void {
  void appIndex()
    .then((index) => console.log(`app index ready: ${index.entries.length} entries`))
    .catch((error: unknown) => console.warn("app index warm failed:", error));
}

export function resetAppIndex(): void {
  cachedIndex = null;
  cachedAt = 0;
  inflight = null;
}
