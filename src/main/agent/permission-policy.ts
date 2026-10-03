import type { ActionRisk, PermissionProfile } from "../../skills/types";

/**
 * Pure permission-gate policy. No electron / config imports so it can be unit
 * tested directly. `makePermissionRequester` feeds it the current state and acts
 * on the verdict.
 *
 * Invariants:
 *  - An explicit standing "never" always wins.
 *  - A profile can only ever relax prompts for `safe_reversible` actions.
 *    `always_ask` actions (shell, messages, purchases, deletion, computer-use,
 *    anything unclassified) are never auto-approved by a profile.
 */

export type PolicyVerdict = "allow" | "deny" | "prompt";

export interface PolicyInput {
  risk: ActionRisk;
  profile: PermissionProfile;
  /** The user's persisted per-skill choice (config.skills.permissions[id]). */
  standing: "ask" | "always" | "never" | undefined;
  /** Approved earlier in this same command's tool loop. */
  commandGrant: boolean;
  /** Approved earlier this app session (only honoured under `session`). */
  sessionGrant: boolean;
}

export function decidePermission(i: PolicyInput): PolicyVerdict {
  if (i.standing === "never") return "deny";
  // An explicit per-skill "always" is the user's own standing decision; it keeps
  // its existing meaning for every risk tier.
  if (i.standing === "always") return "allow";
  if (i.commandGrant) return "allow";

  if (i.risk === "safe_reversible") {
    if (i.profile === "persistent") return "allow";
    if (i.profile === "session" && i.sessionGrant) return "allow";
  }
  return "prompt";
}

/** Should an "Allow once" answer be remembered for the whole app session? */
export function grantsSession(risk: ActionRisk, profile: PermissionProfile): boolean {
  return risk === "safe_reversible" && profile === "session";
}

/** Resolve a tool's declared risk, failing closed to `always_ask`. */
export function resolveRisk(
  declared: ActionRisk | ((input: unknown) => ActionRisk) | undefined,
  input: unknown,
): ActionRisk {
  if (!declared) return "always_ask";
  try {
    const risk = typeof declared === "function" ? declared(input) : declared;
    return risk === "safe_reversible" ? "safe_reversible" : "always_ask";
  } catch {
    return "always_ask";
  }
}
