/**
 * Strict reflex planner. Jev only ever returns a *label*; the host decides what
 * (if anything) that label means. This maps a label + the user's own words to
 * one of two fixed, reversible tool calls, or null. Pure regex — no model output
 * ever becomes a tool name or argument, and anything ambiguous returns null.
 *
 * `type_text` (and any future label) is intentionally unplannable: typing into the
 * focused app is the user's own hotkey dictation, not a reflex.
 */

export type ReflexPlan =
  | { tool: "openApp"; input: { name: string } }
  | { tool: "openUrl"; input: { url: string } }
  | { tool: "launchAgentSession"; input: { agent: "claude" | "codex" } };

const LEAD = String.raw`^(?:(?:hey|please|ok|okay|can you|could you)[,\s]+)*`;
const OPEN_RE = new RegExp(
  LEAD + String.raw`(?:open|launch|start)\s+(?:up\s+)?(?:the\s+)?([a-z0-9][a-z0-9 .&+'-]{0,38}?)(?:\s+(?:app|application))?\s*[.!?]?$`,
  "i",
);
const SEARCH_RE = new RegExp(
  LEAD + String.raw`(?:search(?:\s+the\s+web)?(?:\s+for)?|google|look\s+up)\s+(.{2,120}?)\s*[.!?]?$`,
  "i",
);
// Compound launch: "open terminal and start claude", "start a new codex session".
// The agent is captured from a closed alternation, so only the literal enum value
// "claude" | "codex" ever leaves this file — never the user's words.
const ART = String.raw`(?:a\s+|an\s+|the\s+)?(?:new\s+)?`;
const AGENT = String.raw`(claude(?:\s+code)?|codex)(?:\s+(?:session|code|cli))?`;
const TERM = String.raw`(?:terminal|iterm2?)(?:\s+(?:window|session|tab))?`;
const LAUNCH_VIA_TERM_RE = new RegExp(
  LEAD + String.raw`(?:open|launch|start)\s+(?:up\s+)?${ART}${TERM}\s*(?:,\s*|,?\s*(?:and|then|and\s+then)\s+)(?:start|run|launch|open)\s+(?:up\s+)?${ART}${AGENT}\s*[.!?]?$`,
  "i",
);
const LAUNCH_DIRECT_RE = new RegExp(
  LEAD + String.raw`(?:open|launch|start)\s+(?:up\s+)?${ART}${AGENT}(?:\s+in\s+${ART}${TERM})?\s*[.!?]?$`,
  "i",
);
// Words that mean the utterance is a compound request, not a bare "open X".
const COMPOUND = /\b(and|then|also|to|so|but|with|while|after|before|if)\b/i;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function planOpenApp(text: string): ReflexPlan | null {
  const m = OPEN_RE.exec(text);
  if (!m) return null;
  const name = clean(m[1]);
  const words = name.split(" ");
  if (words.length > 3 || COMPOUND.test(name)) return null;
  // Must start alphanumeric (enforced by the regex) so it can never read as a
  // CLI flag when handed to `open -a`.
  if (!/^[a-z0-9][a-z0-9 .&+'-]*$/i.test(name)) return null;
  return { tool: "openApp", input: { name } };
}

function planAgentLaunch(text: string): ReflexPlan | null {
  const m = LAUNCH_VIA_TERM_RE.exec(text) ?? LAUNCH_DIRECT_RE.exec(text);
  if (!m) return null;
  return {
    tool: "launchAgentSession",
    input: { agent: m[1].toLowerCase().startsWith("codex") ? "codex" : "claude" },
  };
}

function planSearch(text: string): ReflexPlan | null {
  const m = SEARCH_RE.exec(text);
  if (!m) return null;
  const q = clean(m[1]);
  if (q.length < 2 || /[\u0000-\u001f]/.test(q)) return null;
  if (/\b(and then|then)\b/i.test(q)) return null;
  return {
    tool: "openUrl",
    input: { url: `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  };
}

export function planReflex(choice: string, transcript: string): ReflexPlan | null {
  const text = clean(transcript);
  if (!text || text.length > 200) return null;
  switch (choice) {
    // Jev may call "open terminal and start claude" either label; the words decide.
    case "launch_agent":
      return planAgentLaunch(text);
    case "open_app":
      return planAgentLaunch(text) ?? planOpenApp(text);
    case "search":
      return planSearch(text);
    default:
      return null;
  }
}
