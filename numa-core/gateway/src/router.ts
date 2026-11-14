import { type AppIndex, builtinIndex, resolveFromIndex } from "./apps.ts";

export interface RouteMatch {
  toolId: string;
  input: Record<string, unknown>;
  matched: string;
}

/**
 * Deterministic fast lane. Obvious commands must never wait for a model, and
 * the UI must not decide what a phrase means — routing lives in the core.
 *
 * The target is resolved against the machine index, so "open minecraft" routes
 * to whatever the user actually installed. The route carries the resolved key,
 * never the raw phrase: the tool then has nothing left to guess.
 */
const OPEN_VERB =
  /^(?:open|launch|start|run|pull|bring|fire|go\s+to)\s+(?:up\s+)?(?:the\s+|a\s+|an\s+|my\s+|our\s+)?(.+)$/;

const TRAILING_NOISE = /\s+(?:app|application|for\s+me|please|now)$/;

/** "youtube.com", "github.com/orgs" — a site, not an installed app. */
const DOMAIN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/i;

/**
 * Speech arrives with the way people ask: "hey numa, can you open chrome".
 * Strip that wrapper before looking for the verb; anything left over simply
 * does not match, which keeps real questions on the coding lane.
 */
const LEADING_NOISE = /^(?:hey\s+)?numa[,\s]+|^(?:can|could|would|will)\s+you\s+|^please\s+|^numa[,\s]+/;

export function routeText(text: string, index: AppIndex = builtinIndex()): RouteMatch | null {
  let normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,]+$/g, "")
    .replace(/\s+/g, " ");

  for (let strip = LEADING_NOISE.exec(normalized); strip; strip = LEADING_NOISE.exec(normalized)) {
    normalized = normalized.slice(strip[0].length).trim();
  }

  const open = OPEN_VERB.exec(normalized);
  if (!open) return null;

  let target = (open[1] ?? "").trim();
  while (TRAILING_NOISE.test(target)) target = target.replace(TRAILING_NOISE, "").trim();
  if (!target) return null;

  const entry = resolveFromIndex(target, index);
  if (entry) {
    return {
      toolId: "app.launch",
      input: { app: entry.key },
      matched: `app.launch:${entry.key}`,
    };
  }
  if (DOMAIN.test(target)) {
    return { toolId: "app.launch", input: { app: target }, matched: "app.launch:url" };
  }
  return null;
}
