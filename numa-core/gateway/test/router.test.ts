import assert from "node:assert/strict";
import test from "node:test";
import { builtinIndex, type AppIndex } from "../src/apps.ts";
import { routeText } from "../src/router.ts";

test("open verbs route to the app tool", () => {
  assert.deepEqual(routeText("open chrome"), {
    toolId: "app.launch",
    input: { app: "chrome" },
    matched: "app.launch:chrome",
  });
  assert.equal(routeText("Launch Google Chrome.")?.input.app, "chrome");
  assert.equal(routeText("  start   the  notepad  ")?.input.app, "notepad");
  assert.equal(routeText("run file explorer")?.input.app, "explorer");
  assert.equal(routeText("pull up task manager")?.input.app, "taskmgr");
  assert.equal(routeText("go to youtube")?.input.app, "youtube");
  // People ask with a wrapper; the verb is still there.
  assert.equal(routeText("hey numa, can you open chrome")?.input.app, "chrome");
  assert.equal(routeText("please open my files")?.input.app, "explorer");
  assert.equal(routeText("could you launch notepad please")?.input.app, "notepad");
});

test("unknown targets and non-commands do not route", () => {
  // No Spotify installed, so the web player is the honest fallback.
  assert.equal(routeText("open spotify")?.input.app, "spotify-web");
  assert.equal(routeText("what is on my screen"), null);
  assert.equal(routeText("chrome"), null);
  assert.equal(routeText(""), null);
  assert.equal(routeText("open the"), null);
  assert.equal(routeText("open the flux capacitor"), null);
  // A name that is a web address is a site, not an app.
  assert.deepEqual(routeText("open youtube.com"), {
    toolId: "app.launch",
    input: { app: "youtube.com" },
    matched: "app.launch:url",
  });
});

test("spoken names use the machine index", () => {
  const index: AppIndex = {
    ...builtinIndex(),
    entries: [
      ...builtinIndex().entries,
      {
        key: "youtube music",
        label: "YouTube Music",
        kind: "exe",
        exe: "C:\\apps\\YouTube Music.exe",
        image: "YouTube Music.exe",
        source: "start-menu",
        keys: ["YouTube Music"],
      },
      {
        key: "sklauncher",
        label: "SKlauncher",
        kind: "exe",
        exe: "C:\\apps\\sklauncher.exe",
        image: "sklauncher.exe",
        source: "start-menu",
        keys: ["SKlauncher", "sklauncher"],
      },
    ],
  };

  assert.deepEqual(routeText("open youtube music", index), {
    toolId: "app.launch",
    input: { app: "youtube music" },
    matched: "app.launch:youtube music",
  });
  assert.equal(routeText("open ytm", index)?.input.app, "youtube music");
  assert.equal(routeText("open minecraft", index)?.input.app, "sklauncher");
  assert.equal(routeText("launch sklauncher 4.0", index)?.input.app, "sklauncher");
});
