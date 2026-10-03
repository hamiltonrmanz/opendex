import type { SkillMeta } from "../types";

export const TOOLS = {
  openUrl: "openUrl",
  openApp: "openApp",
  openPath: "openPath",
  launchAgentSession: "launchAgentSession",
} as const;

export const meta: SkillMeta = {
  id: "open",
  label: "Open apps & URLs",
  description: "Open URLs in the browser, launch apps, open files/folders, and start a Claude/Codex terminal session.",
  sensitive: true,
};
