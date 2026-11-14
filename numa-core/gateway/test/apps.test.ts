import assert from "node:assert/strict";
import test from "node:test";
import { indexFromInventory, normalizeAppQuery, resolveFromIndex } from "../src/apps.ts";

const inventory = {
  links: [
    { name: "SKlauncher 4.0", target: "C:\\Users\\krish\\AppData\\Local\\Programs\\sklauncher\\sklauncher.exe", args: "" },
    { name: "YouTube Music", target: "C:\\Users\\krish\\AppData\\Local\\Programs\\youtube-music\\YouTube Music.exe", args: "" },
    { name: "Google Chrome", target: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: "--source-shortcut-location=start-menu" },
    { name: "Uninstall Discord", target: "C:\\Program Files\\Discord\\Uninstall.exe", args: "" },
    { name: "Python Manuals", target: "C:\\Python\\Doc\\html\\index.html", args: "" },
  ],
  paths: [{ name: "WinRAR.exe", target: "C:\\Program Files\\WinRAR\\WinRAR.exe" }],
  apps: [
    { Name: "Notepad", AppID: "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
    { Name: "Calculator", AppID: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
    { Name: "File Explorer", AppID: "Microsoft.Windows.Explorer" },
  ],
};

test("the machine inventory becomes a resolvable index", () => {
  const index = indexFromInventory(inventory);
  const keys = index.entries.map((entry) => entry.key);

  assert.ok(keys.includes("sklauncher 4.0"));
  assert.ok(keys.includes("youtube music"));
  assert.ok(keys.includes("winrar"));
  // Uninstall shortcuts and non-executable targets are not apps.
  assert.ok(!keys.some((key) => key.includes("uninstall")));
  assert.ok(!keys.some((key) => key.includes("manual")));
  // Builtins stay, and start-menu wins over the builtin Chrome path.
  assert.equal(resolveFromIndex("chrome", index)?.source, "builtin");
});

test("shortcut bookkeeping arguments are dropped", () => {
  const index = indexFromInventory(inventory);
  const chrome = index.entries.find((entry) => entry.key === "google chrome");
  assert.deepEqual(chrome?.args, []);
});

test("exact, version-stripped and synonym names all resolve", () => {
  const index = indexFromInventory(inventory);

  assert.equal(resolveFromIndex("SKlauncher 4.0", index)?.key, "sklauncher 4.0");
  assert.equal(resolveFromIndex("sklauncher", index)?.key, "sklauncher 4.0");
  assert.equal(resolveFromIndex("minecraft", index)?.key, "sklauncher 4.0");
  assert.equal(resolveFromIndex("ytm", index)?.key, "youtube music");
  assert.equal(resolveFromIndex("you tube music", index)?.key, "youtube music");
});

test("a desktop app beats the website with the same first word", () => {
  const index = indexFromInventory(inventory);
  assert.equal(resolveFromIndex("youtube music", index)?.kind, "exe");
  assert.equal(resolveFromIndex("youtube", index)?.kind, "url");
});

test("store apps resolve to their AUMID", () => {
  const index = indexFromInventory(inventory);
  const calculator = resolveFromIndex("calculator", index);
  assert.equal(calculator?.kind, "aumid");
  assert.equal(calculator?.aumid, "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");

  // Builtins outrank a store alias of the same thing.
  assert.equal(resolveFromIndex("notepad", index)?.source, "builtin");
  assert.equal(resolveFromIndex("file explorer", index)?.source, "builtin");
});

test("registry App Paths entries resolve", () => {
  const index = indexFromInventory(inventory);
  const winrar = resolveFromIndex("winrar", index);
  assert.equal(winrar?.kind, "exe");
  assert.equal(winrar?.image, "WinRAR.exe");
  assert.equal(winrar?.source, "app-paths");
});

test("nonsense resolves to nothing", () => {
  const index = indexFromInventory(inventory);
  assert.equal(resolveFromIndex("", index), null);
  assert.equal(resolveFromIndex("   ", index), null);
  assert.equal(resolveFromIndex("quantum flux capacitor", index), null);
});

test("normalizeAppQuery folds case, punctuation and spacing", () => {
  assert.equal(normalizeAppQuery("  Open   YouTube-Music!! "), "open youtube music");
  assert.equal(normalizeAppQuery("C++ Builder"), "c++ builder");
});
