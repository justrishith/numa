import type { PermissionLevel, RiskLevel } from "./db.ts";

export type PolicyDecision = "allow" | "approve" | "deny";

export interface PolicyInput {
  permissionLevel: PermissionLevel;
  risk: RiskLevel;
  approved: boolean;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
}

/**
 * The single place that decides whether an action may run. Tools declare what
 * they need; they never decide for themselves whether they are allowed.
 */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  const { permissionLevel, risk, approved } = input;

  if (permissionLevel === 4) {
    return { decision: "deny", reason: "capability is locked until explicitly enabled" };
  }
  if (approved) {
    return { decision: "allow", reason: "explicitly approved by the user" };
  }
  if (permissionLevel >= 2) {
    return {
      decision: "approve",
      reason: `permission level ${permissionLevel} requires confirmation`,
    };
  }
  if (risk === "high") {
    return { decision: "approve", reason: "high-risk action requires confirmation" };
  }
  return { decision: "allow", reason: "safe reversible action" };
}
