import { test } from "node:test";
import assert from "node:assert/strict";
import { LatencyTrace, formatLatency } from "./latency-trace";

test("session_ready is the headline for an agent-launch turn", () => {
  const t = new LatencyTrace();
  t.mark("speech_start", 0);
  t.mark("jev_decision", 400);
  t.mark("action_start", 450);
  t.mark("session_ready", 1900);
  const s = t.snapshot();
  assert.equal(t.complete, true);
  assert.equal(s.totalMs, 1900);
  assert.equal(formatLatency(s), "1.9s");
  // A later first_audio from the same turn does not replace the headline.
  t.mark("first_audio", 4000);
  assert.equal(t.snapshot().totalMs, 1900);
});
