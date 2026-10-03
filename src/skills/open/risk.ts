import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import type { ActionRisk } from "../types";

/** Fixed commands for launchAgentSession. The tool input is an enum key into
 *  this map, so no user or model text can ever reach the shell. */
export const AGENT_COMMANDS = { claude: "claude", codex: "codex" } as const;
export type AgentName = keyof typeof AGENT_COMMANDS;

export interface PathProbe {
  home: string;
  realpath: (p: string) => string;
  isDirectory: (p: string) => boolean;
}

const defaultProbe: PathProbe = {
  home: homedir(),
  realpath: (p) => realpathSync(p),
  isDirectory: (p) => statSync(p).isDirectory(),
};

/** Opening a *folder* under $HOME just shows it in Finder, so it's reversible.
 *  Files (could be scripts / apps), symlinks out of $HOME and anything that
 *  fails to resolve stay `always_ask`. */
export function openPathRisk(path: unknown, probe: PathProbe = defaultProbe): ActionRisk {
  if (typeof path !== "string" || !isAbsolute(path)) return "always_ask";
  try {
    const real = probe.realpath(path);
    const home = probe.realpath(probe.home);
    const inHome = real === home || real.startsWith(home.endsWith(sep) ? home : home + sep);
    return inHome && probe.isDirectory(real) ? "safe_reversible" : "always_ask";
  } catch {
    return "always_ask";
  }
}

/** http(s) opens a page; mailto: only opens a compose window (nothing is sent),
 *  so it joins the relaxed tier too. Everything else is always_ask. */
export function openUrlRisk(url: unknown): ActionRisk {
  return typeof url === "string" && /^(https?|mailto):/i.test(url) ? "safe_reversible" : "always_ask";
}
