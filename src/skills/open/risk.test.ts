import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_COMMANDS, openPathRisk, openUrlRisk, type PathProbe } from "./risk";

const probe = (dirs: string[], links: Record<string, string> = {}): PathProbe => ({
  home: "/Users/h",
  realpath: (p) => {
    const r = links[p] ?? p;
    if (r !== "/Users/h" && !dirs.includes(r) && !r.endsWith(".txt")) throw new Error("ENOENT");
    return r;
  },
  isDirectory: (p) => dirs.includes(p) || p === "/Users/h",
});

test("folders under $HOME are safe_reversible; files and outsiders ask", () => {
  const p = probe(["/Users/h/Projects", "/etc", "/Users/hx"], { "/Users/h/link": "/etc" });
  assert.equal(openPathRisk("/Users/h/Projects", p), "safe_reversible");
  assert.equal(openPathRisk("/Users/h", p), "safe_reversible");
  assert.equal(openPathRisk("/Users/h/notes.txt", p), "always_ask"); // a file
  assert.equal(openPathRisk("/etc", p), "always_ask"); // outside home
  assert.equal(openPathRisk("/Users/hx", p), "always_ask"); // prefix-sibling of home
  assert.equal(openPathRisk("/Users/h/link", p), "always_ask"); // symlink out
  assert.equal(openPathRisk("/Users/h/missing", p), "always_ask"); // unresolvable
  assert.equal(openPathRisk("relative/dir", p), "always_ask");
  assert.equal(openPathRisk(undefined, p), "always_ask");
});

test("http(s) and mailto relax; other schemes ask", () => {
  assert.equal(openUrlRisk("https://example.com"), "safe_reversible");
  assert.equal(openUrlRisk("mailto:a@b.co"), "safe_reversible");
  assert.equal(openUrlRisk("file:///etc/passwd"), "always_ask");
  assert.equal(openUrlRisk("javascript:alert(1)"), "always_ask");
  assert.equal(openUrlRisk(42), "always_ask");
});

test("agent commands are the fixed enum literals", () => {
  assert.deepEqual(AGENT_COMMANDS, { claude: "claude", codex: "codex" });
});
