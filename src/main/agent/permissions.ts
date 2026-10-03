import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { IPC, type PermissionRequestPayload } from "../ipc/channels";
import { getConfig, updateConfig } from "../config/store";
import type { ActionRisk, PermissionRequester } from "../../skills/types";
import { decidePermission, grantsSession } from "./permission-policy";

export type PermissionDecision = "allow_once" | "always" | "deny" | "never";

// Auto-deny a prompt the user never answers, so a tool loop can't hang forever
// (e.g. the renderer is killed mid-prompt, or the user walks away).
const PERMISSION_TIMEOUT_MS = 120_000;

const pending = new Map<string, (decision: PermissionDecision) => void>();

// Skills approved for safe_reversible actions under the `session` profile.
// Lives for the app process only — never persisted.
const appSessionAllow = new Set<string>();

/** How prompts are surfaced. The main process wires this to the dedicated
 *  always-on-top permission popup so a prompt is visible regardless of the main
 *  window's state — and answering it never disturbs the main window's layout. */
export interface PermissionUi {
  /** Show a prompt (create/raise the popup, send the request to it). */
  present: (req: PermissionRequestPayload) => void;
  /** A prompt settled (answered, timed out, or window died) — let the popup
   *  drop it, and the popup hosts can hide once `pendingPermissions()` is 0. */
  dismiss: (id: string) => void;
}

let permissionUi: PermissionUi | null = null;
export function setPermissionUi(ui: PermissionUi) {
  permissionUi = ui;
}

/** Number of prompts still awaiting an answer (drives popup show/hide). */
export function pendingPermissions(): number {
  return pending.size;
}

/** Called by the IPC handler when the renderer answers a permission prompt. */
export function resolvePermission(id: string, decision: PermissionDecision) {
  const resolve = pending.get(id);
  if (!resolve) return;
  pending.delete(id);
  resolve(decision);
}

/**
 * Build a permission requester bound to the chat request's renderer. The
 * `sessionAllow` set is per-requester (i.e. per user command): an "Allow once"
 * approval covers the rest of that command's multi-step tool loop, so a single
 * task (e.g. a computer-use session) doesn't re-prompt on every action. A new
 * command builds a fresh requester, so the grant doesn't silently persist.
 */
export function makePermissionRequester(sender: WebContents): PermissionRequester {
  const sessionAllow = new Set<string>();
  return (skillId, label, detail, risk: ActionRisk = "always_ask") =>
    new Promise<boolean>((resolve) => {
      const { permissions, profile } = getConfig().skills;
      const verdict = decidePermission({
        risk,
        profile: profile ?? "ask",
        standing: permissions[skillId],
        commandGrant: sessionAllow.has(skillId),
        sessionGrant: appSessionAllow.has(skillId),
      });
      if (verdict === "allow") return resolve(true);
      if (verdict === "deny") return resolve(false);

      if (sender.isDestroyed()) return resolve(false);

      const id = randomUUID();
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const onDestroyed = () => settle("deny");
      // Settle exactly once and tear down all handlers, so the request can't
      // hang or leak its resolver in `pending` if the window dies or the user
      // never answers.
      const settle = (decision: PermissionDecision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        if (!sender.isDestroyed()) {
          sender.off("destroyed", onDestroyed);
          // Timestamp only (latency telemetry) — never the prompt content.
          sender.send(IPC.permissionSettled, Date.now());
        }
        // Drop the prompt from the popup (no-op if the user just answered it).
        permissionUi?.dismiss(id);
        const allowed = decision === "allow_once" || decision === "always";
        if (allowed) {
          sessionAllow.add(skillId);
          if (grantsSession(risk, getConfig().skills.profile ?? "ask")) {
            appSessionAllow.add(skillId);
          }
        }
        resolve(allowed);
      };

      pending.set(id, settle);
      sender.once("destroyed", onDestroyed);
      timer = setTimeout(() => {
        console.warn(
          `[opendex] permission prompt for "${skillId}" auto-denied after ${PERMISSION_TIMEOUT_MS}ms with no answer`,
        );
        settle("deny");
      }, PERMISSION_TIMEOUT_MS);
      // Surface the prompt in the dedicated always-on-top popup so it can't be
      // missed (the main window may be hidden, in notch, or behind the app the
      // agent is driving) — without disturbing the main window's layout.
      permissionUi?.present({ id, skillId, label, detail });
    });
}

/** Persist a remembered decision, then resolve the pending request. */
export function recordAndResolve(
  id: string,
  skillId: string,
  decision: PermissionDecision,
) {
  if (decision === "always" || decision === "never") {
    const permissions = { ...getConfig().skills.permissions, [skillId]: decision };
    updateConfig({ skills: { permissions } });
  }
  resolvePermission(id, decision);
}
