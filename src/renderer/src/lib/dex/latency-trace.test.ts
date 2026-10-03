import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_LATENCY, LatencyTrace, formatLatency } from "./latency-trace";

test("marks are offsets from the earliest mark, first write wins", () => {
  const t = new LatencyTrace();
  t.mark("speech_start", 1000);
  t.mark("first_partial", 1300);
  t.mark("first_partial", 9999);
  const s = t.snapshot();
  assert.deepEqual(s.marks, { speech_start: 0, first_partial: 300 });
  assert.equal(s.stage, "first_partial");
  assert.equal(s.totalMs, null);
});

test("out-of-order arrival anchors on earliest timestamp", () => {
  const t = new LatencyTrace();
  t.mark("model_first_token", 2000);
  t.mark("permission_resolved", 1500);
  assert.equal(t.snapshot().marks.permission_resolved, 0);
  assert.equal(t.snapshot().marks.model_first_token, 500);
});

test("first_audio completes the turn and yields totalMs + segments", () => {
  const t = new LatencyTrace();
  t.mark("speech_start", 0);
  t.mark("tts_enqueue", 900);
  t.mark("first_audio", 1250);
  const s = t.snapshot();
  assert.equal(t.complete, true);
  assert.equal(s.totalMs, 1250);
  assert.deepEqual(s.segments, [
    { from: "speech_start", to: "tts_enqueue", ms: 900 },
    { from: "tts_enqueue", to: "first_audio", ms: 350 },
  ]);
  assert.equal(formatLatency(s), "1.3s");
});

test("reset clears the turn; subscribers are notified", () => {
  const t = new LatencyTrace();
  const seen: number[] = [];
  const off = t.subscribe((s) => seen.push(Object.keys(s.marks).length));
  t.mark("speech_start", 1);
  t.reset();
  off();
  t.mark("speech_start", 2);
  assert.deepEqual(seen, [1, 0]);
  assert.equal(t.snapshot().stage, "speech_start");
  assert.equal(new LatencyTrace().snapshot(), EMPTY_LATENCY);
});

test("snapshot never carries free text", () => {
  const t = new LatencyTrace();
  t.mark("speech_start", 0);
  assert.ok(Object.values(t.snapshot().marks).every((v) => typeof v === "number"));
});
