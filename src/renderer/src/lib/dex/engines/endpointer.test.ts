import { test } from "node:test";
import assert from "node:assert/strict";
import { Endpointer, type EndpointPhase } from "./endpointer";

const V = 0.12; // clearly voiced
const Q = 0.004; // quiet room
type Seg = [kind: "v" | "s", frames: number, level?: number];

function run(ep: Endpointer, segs: Seg[]): EndpointPhase[] {
  const phases: EndpointPhase[] = [];
  for (const [k, n, lvl] of segs) {
    for (let i = 0; i < n; i++) phases.push(ep.push(k === "v" ? (lvl ?? V) : (lvl ?? Q)));
  }
  return phases;
}
const ms = (frames: number) => frames * 32;

// A "word" = 5 voiced frames + 2 unvoiced (a ~64ms gap, below pause threshold).
const word = (gap = 4): Seg[] => [["v", 5], ["s", gap]];
const words = (n: number, gap?: number): Seg[] => Array.from({ length: n }, () => word(gap)).flat();

test("noise alone never becomes an utterance", () => {
  const ep = new Endpointer();
  run(ep, [["s", 200, 0.012]]);
  assert.equal(ep.hasSpeech, false);
  assert.equal(ep.phase, "waiting");
  assert.equal(ep.ended, false);
});

test("phase walks speaking -> finalizing -> ended", () => {
  const ep = new Endpointer();
  run(ep, [["s", 12], ...words(8)] as Seg[]);
  const after = run(ep, [["s", 60]]);
  assert.ok(after.includes("finalizing"));
  assert.equal(after.at(-1), "ended");
  assert.ok(after.indexOf("finalizing") < after.indexOf("ended"));
});

test("a thinking pause mid-sentence does not end the turn (interruption path)", () => {
  const ep = new Endpointer();
  run(ep, [["s", 12], ...words(6)] as Seg[]);
  const pause = run(ep, [["s", 22]]); // ~704ms of silence
  assert.notEqual(pause.at(-1), "ended");
  assert.ok(pause.includes("finalizing"));
  const resume = run(ep, [["v", 5]]);
  assert.equal(resume.at(-1), "speaking"); // resumed -> not committed
  assert.equal(ep.ended, false);
});

test("target silence is never below 1.4x the longest pause, and never above the cap", () => {
  const ep = new Endpointer();
  run(ep, [["s", 12], ...words(5), ["s", 25], ["v", 5]] as Seg[]); // 800ms pause
  assert.ok(ep.targetSilenceMs >= 800 * 1.4 - 1 || ep.targetSilenceMs === 1400);
  assert.ok(ep.targetSilenceMs <= 1400);
  const ep2 = new Endpointer();
  run(ep2, [["s", 12], ["v", 5], ["s", 80], ["v", 5]] as Seg[]); // 2.5s pause
  assert.equal(ep2.targetSilenceMs, 1400);
});

test("fast talkers end sooner than slow talkers (monotonic in rate)", () => {
  const fast = new Endpointer();
  run(fast, [["s", 12], ...Array.from({ length: 14 }, () => [["v", 3], ["s", 3]] as Seg[]).flat()] as Seg[]);
  const slow = new Endpointer();
  run(slow, [["s", 12], ...Array.from({ length: 4 }, () => [["v", 9], ["s", 12]] as Seg[]).flat()] as Seg[]);
  assert.ok(fast.speechRate !== null && slow.speechRate !== null);
  assert.ok(fast.speechRate! > slow.speechRate!);
  assert.ok(fast.targetSilenceMs < slow.targetSilenceMs);
});

test("quiet speaker is heard adaptively but not by the fixed threshold", () => {
  const quiet: Seg[] = [["s", 12], ["v", 20, 0.02], ["s", 5]];
  const adaptive = new Endpointer();
  run(adaptive, quiet);
  assert.equal(adaptive.hasSpeech, true);
  const fixed = new Endpointer({ adaptive: false });
  run(fixed, quiet);
  assert.equal(fixed.hasSpeech, false);
});

test("a noisy room raises the threshold so steady noise isn't speech", () => {
  const ep = new Endpointer();
  run(ep, [["s", 40, 0.017]]); // floor seeds near 0.017 -> threshold clamps up
  assert.ok(ep.speechRmsThreshold > 0.02);
  run(ep, [["s", 100, 0.017]]);
  assert.equal(ep.hasSpeech, false);
});

test("non-adaptive mode is exactly the legacy fixed silence", () => {
  const ep = new Endpointer({ adaptive: false, fixedSilenceMs: 1000 });
  run(ep, [["v", 20]]);
  assert.equal(ep.targetSilenceMs, 1000);
  const phases = run(ep, [["s", 40]]); // 1280ms
  const endedAt = phases.indexOf("ended") + 1;
  assert.ok(ms(endedAt) >= 1000 && ms(endedAt) < 1000 + 32 * 2);
});

test("ended is sticky", () => {
  const ep = new Endpointer({ adaptive: false });
  run(ep, [["v", 20], ["s", 40]]);
  assert.equal(ep.ended, true);
  assert.equal(ep.push(V), "ended");
});
