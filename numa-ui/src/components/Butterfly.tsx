export type ButterflyState =
  | "idle"
  | "listening"
  | "working"
  | "approval"
  | "success"
  | "error";

interface StateTone {
  core: string;
  aura: string;
  label: string;
  caption: string;
}

/**
 * The wings keep the brand gradient at all times. Only the core, aura and
 * label carry state — a butterfly that turns solid green stops being NUMA.
 */
export const STATE_TONE: Record<ButterflyState, StateTone> = {
  idle: {
    core: "#8B7CFF",
    aura: "rgba(124,108,255,0.55)",
    label: "Ready",
    caption: "Standing by",
  },
  listening: {
    core: "#4FE3FF",
    aura: "rgba(79,227,255,0.6)",
    label: "Listening",
    caption: "I'm listening",
  },
  working: {
    core: "#9A8CFF",
    aura: "rgba(139,124,255,0.65)",
    label: "Working",
    caption: "Executing on this machine",
  },
  approval: {
    core: "#FFB84D",
    aura: "rgba(255,184,77,0.6)",
    label: "Needs you",
    caption: "Waiting for your approval",
  },
  success: {
    core: "#4FE0C8",
    aura: "rgba(79,224,200,0.6)",
    label: "Verified",
    caption: "Done and checked",
  },
  error: {
    core: "#FF5C7A",
    aura: "rgba(255,92,122,0.6)",
    label: "Failed",
    caption: "Something went wrong",
  },
};
