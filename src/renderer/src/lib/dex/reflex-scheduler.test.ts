import { test } from "node:test";
import assert from "node:assert/strict";
import { ReflexScheduler, normalizeWords, type ReflexDecisionLike, type TimerApi } from "./reflex-scheduler";

function harness(opts: { choice?: string; mode?: "off" | "observe" | "act" } = {}) {
  let now = 0;
  const pending: Array<{ at: number; fn: () => void; id: number; live: boolean }> = [];
  let nextId = 1;
  const timers: TimerApi = {
    set: (fn, ms) => {
      const t = { at: now + ms, fn, id: nextId++, live: true };
      pending.push(t);
      return t.id;
    },
    clear: (h) => {
      const t = pending.find((p) => p.id === h);
      if (t) t.live = false;
    },
  };
  const sent: string[] = [];
  const dispatched: Array<[string, string]> = [];
  const decisions: string[] = [];
  const superseded: Array<[string, string]> = [];
  let resolveClassify: (() => void) | null = null;
  let held = false;
  const s = new ReflexScheduler({
    timers,
    classify: (text) => {
      sent.push(text);
      const d: ReflexDecisionLike = { choice: opts.choice ?? "open_app", source: "jev" };
      if (!held) return Promise.resolve(d);
      return new Promise((r) => (resolveClassify = () => r(d)));
    },
    dispatch: (c, t) => dispatched.push([c, t]),
    onDecision: (d) => decisions.push(d.choice),
    onSuperseded: (a, b) => superseded.push([a, b]),
  });
  s.setMode(opts.mode ?? "act");
  const advance = async (ms: number) => {
    now += ms;
    for (const t of pending.filter((p) => p.live && p.at <= now)) {
      t.live = false;
      t.fn();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    s, sent, dispatched, decisions, superseded, advance,
    hold: () => (held = true),
    release: async () => { resolveClassify?.(); await Promise.resolve(); await Promise.resolve(); },
  };
}

test("normalizeWords ignores case and punctuation", () => {
  assert.equal(normalizeWords("Open, Spotify!"), "open spotify");
});

test("debounces: rapid partials produce one classification of the latest text", async () => {
  const h = harness();
  h.s.onPartial("open spo");
  await h.advance(100);
  h.s.onPartial("open spot");
  await h.advance(100);
  h.s.onPartial("open spotify");
  await h.advance(349);
  assert.deepEqual(h.sent, []);
  await h.advance(2);
  assert.deepEqual(h.sent, ["open spotify"]);
  assert.deepEqual(h.dispatched, [["open_app", "open spotify"]]);
});

test("too-short partials never reach Jev", async () => {
  const h = harness();
  h.s.onPartial("open");
  await h.advance(1000);
  assert.deepEqual(h.sent, []);
});

test("text sent to Jev is bounded", async () => {
  const h = harness();
  h.s.onPartial("word ".repeat(200));
  await h.advance(400);
  assert.ok(h.sent[0].length <= 200);
});

test("change while classification is in flight drops the stale result", async () => {
  const h = harness();
  h.hold();
  h.s.onPartial("open spotify");
  await h.advance(400);
  assert.equal(h.sent.length, 1);
  h.s.onPartial("open spotify and play jazz"); // material change
  await h.release();
  assert.deepEqual(h.dispatched, []);
  assert.deepEqual(h.decisions, []);
});

test("non-allowlisted labels (type_text, no_action) never dispatch", async () => {
  for (const choice of ["type_text", "no_action", "rm_rf"]) {
    const h = harness({ choice });
    h.s.onPartial("type hello world please");
    await h.advance(400);
    assert.deepEqual(h.dispatched, [], choice);
  }
});

test("observe mode classifies and reports but never dispatches", async () => {
  const h = harness({ mode: "observe" });
  h.s.onPartial("open spotify");
  await h.advance(400);
  assert.deepEqual(h.decisions, ["open_app"]);
  assert.deepEqual(h.dispatched, []);
});

test("off mode does nothing", async () => {
  const h = harness({ mode: "off" });
  h.s.onPartial("open spotify");
  await h.advance(1000);
  assert.deepEqual(h.sent, []);
});

test("dispatches at most once per utterance; later change is superseded, not re-dispatched", async () => {
  const h = harness();
  h.s.onPartial("open spotify");
  await h.advance(400);
  h.s.onPartial("open spotify and play jazz");
  await h.advance(1000);
  assert.equal(h.dispatched.length, 1);
  assert.deepEqual(h.superseded, [["open spotify", "open spotify and play jazz"]]);
  assert.deepEqual(h.s.finalize("Open Spotify and play jazz."), { dispatched: true, superseded: true });
});

test("finalize with same words (diff punctuation) is not superseded; state resets", async () => {
  const h = harness();
  h.s.onPartial("open spotify");
  await h.advance(400);
  assert.deepEqual(h.s.finalize("Open Spotify."), { dispatched: true, superseded: false });
  h.s.onPartial("search for ramen nearby");
  await h.advance(400);
  assert.equal(h.dispatched.length, 2);
});

test("finalize cancels a pending classification", async () => {
  const h = harness();
  h.s.onPartial("open spotify");
  h.s.finalize("open spotify");
  await h.advance(1000);
  assert.deepEqual(h.sent, []);
});
