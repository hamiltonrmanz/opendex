import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamingTtsPlayer } from "./streaming-player";
import type { AudioClip, AudioClipHooks, AudioSink, FallbackVoice, TtsStreamProvider } from "./types";

const tick = () => new Promise((r) => setTimeout(r, 0));
const bytes = (n: number) => new Uint8Array([n]);

/** A provider whose per-text streams the test drives by hand. */
class FakeProvider implements TtsStreamProvider {
  /** Simulate a misbehaving provider that never reacts to its abort signal. */
  ignoreAbort = false;
  streams = new Map<string, { push(b: Uint8Array): void; end(): void; fail(e: unknown): void; signal: AbortSignal }>();
  opened: string[] = [];
  open(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    this.opened.push(text);
    const q: Uint8Array[] = [];
    let ended = false;
    let error: unknown = null;
    let wake: (() => void) | null = null;
    const poke = () => wake?.();
    this.streams.set(text, {
      push: (b) => { q.push(b); poke(); },
      end: () => { ended = true; poke(); },
      fail: (e) => { error = e; ended = true; poke(); },
      signal,
    });
    signal.addEventListener("abort", () => { if (!this.ignoreAbort) { ended = true; poke(); } });
    return {
      [Symbol.asyncIterator]: () => ({
        async next() {
          for (;;) {
            if (q.length) return { value: q.shift()!, done: false };
            if (error) throw error;
            if (ended) return { value: undefined, done: true };
            await new Promise<void>((r) => (wake = r));
          }
        },
      }),
    };
  }
}

class FakeClip implements AudioClip {
  appended: number[] = [];
  ended = false;
  cancelled = false;
  unlocked = 0;
  private resolve!: (r: "ended" | "cancelled") => void;
  finished = new Promise<"ended" | "cancelled">((r) => (this.resolve = r));
  constructor(readonly hooks: AudioClipHooks, readonly index: number) {}
  append(c: Uint8Array) {
    if (this.appended.length === 0) this.hooks.onFirstAudio(); // audible on first bytes
    this.appended.push(c[0]);
  }
  end() { this.ended = true; }
  cancel() { this.cancelled = true; this.resolve("cancelled"); }
  unlock() { this.unlocked++; }
  finishPlayback() { this.resolve("ended"); }
}
class FakeSink implements AudioSink {
  clips: FakeClip[] = [];
  createClip(h: AudioClipHooks) { const c = new FakeClip(h, this.clips.length); this.clips.push(c); return c; }
}

function setup(withFallback = false) {
  const provider = new FakeProvider();
  const sink = new FakeSink();
  const states: boolean[] = [];
  const chunkStarts: string[] = [];
  let blocked = 0;
  const spoken: string[] = [];
  let fbStopped = 0;
  const fallback: FallbackVoice = { speak: async (t) => { spoken.push(t); }, stop: () => { fbStopped++; } };
  const errors: string[] = [];
  const p = new StreamingTtsPlayer(
    { onStateChange: (s) => states.push(s), onAudioBlocked: () => blocked++, onChunkStart: (t) => chunkStarts.push(t) },
    { provider, sink, fallback: withFallback ? fallback : undefined, onError: (_e, t) => errors.push(t) },
  );
  return { p, provider, sink, states, chunkStarts, spoken, errors, get blocked() { return blocked; }, get fbStopped() { return fbStopped; } };
}

test("first audio plays on the first bytes, before the stream finishes", async () => {
  const t = setup();
  t.p.enqueue("Hello there.");
  await tick();
  assert.equal(t.sink.clips.length, 0); // no bytes yet -> nothing created
  t.provider.streams.get("Hello there.")!.push(bytes(1));
  await tick();
  assert.equal(t.sink.clips.length, 1);
  assert.deepEqual(t.sink.clips[0].appended, [1]);
  assert.deepEqual(t.chunkStarts, ["Hello there."]);
  assert.equal(t.sink.clips[0].ended, false); // stream still open
  t.provider.streams.get("Hello there.")!.push(bytes(2));
  t.provider.streams.get("Hello there.")!.end();
  await tick();
  assert.deepEqual(t.sink.clips[0].appended, [1, 2]);
  assert.equal(t.sink.clips[0].ended, true);
});

test("sentences play strictly in order even if a later stream finishes first", async () => {
  const t = setup();
  t.p.enqueue("One.");
  t.p.enqueue("Two.");
  await tick();
  assert.deepEqual(t.provider.opened, ["One.", "Two."]); // prefetch both
  const two = t.provider.streams.get("Two.")!;
  two.push(bytes(20)); two.end();
  await tick();
  assert.equal(t.sink.clips.length, 0); // "Two." must wait its turn
  const one = t.provider.streams.get("One.")!;
  one.push(bytes(10)); one.end();
  await tick();
  assert.equal(t.sink.clips.length, 1);
  assert.deepEqual(t.sink.clips[0].appended, [10]);
  t.sink.clips[0].finishPlayback();
  await tick();
  assert.equal(t.sink.clips.length, 2);
  assert.deepEqual(t.sink.clips[1].appended, [20]);
});

test("speaking state goes true once and false once when the queue drains", async () => {
  const t = setup();
  t.p.enqueue("A.");
  t.p.enqueue("B.");
  for (const s of ["A.", "B."]) { t.provider.streams.get(s)!.push(bytes(1)); t.provider.streams.get(s)!.end(); }
  await tick();
  t.sink.clips[0].finishPlayback(); await tick();
  t.sink.clips[1].finishPlayback(); await tick();
  assert.deepEqual(t.states, [true, false]);
  assert.equal(t.p.isSpeaking, false);
});

test("stop() mid-stream cancels everything immediately and nothing resumes", async () => {
  const t = setup(true);
  t.p.enqueue("Long one.");
  t.p.enqueue("Next.");
  await tick();
  const s1 = t.provider.streams.get("Long one.")!;
  s1.push(bytes(1));
  await tick();
  t.p.stop();
  assert.equal(t.sink.clips[0].cancelled, true);
  assert.equal(s1.signal.aborted, true);
  assert.equal(t.provider.streams.get("Next.")!.signal.aborted, true);
  assert.equal(t.fbStopped, 1);
  assert.deepEqual(t.states, [true, false]);
  // late bytes after stop are ignored; no new clips
  s1.push(bytes(2)); t.provider.streams.get("Next.")!.push(bytes(9));
  await tick(); await tick();
  assert.equal(t.sink.clips.length, 1);
  assert.deepEqual(t.sink.clips[0].appended, [1]);
  assert.equal(t.p.isSpeaking, false);
});

test("stop() is idempotent and the player is reusable afterwards", async () => {
  const t = setup();
  t.p.stop(); t.p.stop();
  assert.deepEqual(t.states, []);
  t.p.enqueue("After stop.");
  await tick();
  t.provider.streams.get("After stop.")!.push(bytes(7));
  await tick();
  assert.equal(t.sink.clips.length, 1);
  assert.deepEqual(t.sink.clips[0].appended, [7]);
});

test("provider failing before any audio falls back to the offline voice, queue continues", async () => {
  const t = setup(true);
  t.p.enqueue("Fails.");
  t.p.enqueue("Works.");
  await tick();
  t.provider.streams.get("Fails.")!.fail(new Error("401"));
  await tick();
  assert.deepEqual(t.spoken, ["Fails."]);
  assert.deepEqual(t.chunkStarts, ["Fails."]);
  assert.deepEqual(t.errors, ["Fails."]);
  t.provider.streams.get("Works.")!.push(bytes(5)); t.provider.streams.get("Works.")!.end();
  await tick();
  assert.deepEqual(t.sink.clips[0].appended, [5]);
});

test("provider failing before audio with no fallback skips the sentence without wedging", async () => {
  const t = setup(false);
  t.p.enqueue("Fails.");
  t.p.enqueue("Works.");
  await tick();
  t.provider.streams.get("Fails.")!.fail(new Error("boom"));
  t.provider.streams.get("Works.")!.push(bytes(5)); t.provider.streams.get("Works.")!.end();
  await tick();
  assert.equal(t.sink.clips.length, 1);
  assert.deepEqual(t.sink.clips[0].appended, [5]);
});

test("provider failing mid-stream ends that clip (no fallback re-speak)", async () => {
  const t = setup(true);
  t.p.enqueue("Half.");
  await tick();
  const s = t.provider.streams.get("Half.")!;
  s.push(bytes(1));
  await tick();
  s.fail(new Error("dropped"));
  await tick();
  assert.equal(t.sink.clips[0].ended, true);
  assert.deepEqual(t.spoken, []);
  assert.deepEqual(t.errors, ["Half."]);
});

test("empty text is ignored; blocked/unlock are forwarded", async () => {
  const t = setup();
  t.p.enqueue("   ");
  assert.deepEqual(t.provider.opened, []);
  t.p.enqueue("Hi.");
  await tick();
  t.provider.streams.get("Hi.")!.push(bytes(1));
  await tick();
  t.sink.clips[0].hooks.onBlocked();
  assert.equal(t.blocked, 1);
  t.p.unlock();
  assert.equal(t.sink.clips[0].unlocked, 1);
});

test("enqueue right after stop() during a pending pump still plays", async () => {
  const t = setup();
  t.p.enqueue("Old.");
  await tick();
  t.p.stop();
  t.p.enqueue("New.");
  await tick();
  t.provider.streams.get("New.")!.push(bytes(3)); t.provider.streams.get("New.")!.end();
  await tick(); await tick();
  assert.equal(t.sink.clips.length, 1);
  assert.deepEqual(t.sink.clips[0].appended, [3]);
});

test("stop() unwedges the pump even if the provider ignores its abort signal", async () => {
  const t = setup();
  t.provider.ignoreAbort = true;
  t.p.enqueue("Hung.");
  await tick();
  t.p.stop();
  t.provider.ignoreAbort = false;
  t.p.enqueue("Fresh.");
  await tick();
  t.provider.streams.get("Fresh.")!.push(bytes(4)); t.provider.streams.get("Fresh.")!.end();
  await tick(); await tick();
  assert.equal(t.sink.clips.length, 1);
  assert.deepEqual(t.sink.clips[0].appended, [4]);
});
