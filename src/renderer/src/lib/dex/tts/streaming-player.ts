import type { SpeechEngine, SpeechEngineCallbacks } from "../speech-engine";
import type { AudioClip, AudioSink, FallbackVoice, TtsStreamProvider } from "./types";

// Streaming TTS engine. Per sentence: the provider stream is opened immediately
// (so later sentences prefetch while earlier ones play) and bytes are buffered;
// playback is strictly in order, and the *current* sentence starts playing on
// its first bytes instead of waiting for the whole clip.
//
// Failure policy: a provider error before any audio for a sentence falls back to
// the offline voice for that sentence; an error after audio has started just
// ends that clip (we can't un-speak half a sentence). Cancellation (`stop`) is
// immediate and total: abort every open stream, cancel the playing clip, stop
// the fallback voice, drop the queue.

interface Item {
  text: string;
  controller: AbortController;
  buf: Uint8Array[];
  done: boolean;
  error: unknown;
  wake: (() => void) | null;
}

export interface StreamingPlayerDeps {
  provider: TtsStreamProvider;
  sink: AudioSink;
  fallback?: FallbackVoice;
  onError?: (err: unknown, text: string) => void;
}

export class StreamingTtsPlayer implements SpeechEngine {
  private queue: Item[] = [];
  private all = new Set<Item>();
  private gen = 0;
  private pumping = false;
  private speaking = false;
  private clip: AudioClip | null = null;
  private blocked = false;

  constructor(
    private readonly cb: SpeechEngineCallbacks,
    private readonly deps: StreamingPlayerDeps,
  ) {}

  get isSpeaking(): boolean {
    return this.speaking || this.queue.length > 0;
  }

  enqueue(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const item: Item = {
      text: trimmed,
      controller: new AbortController(),
      buf: [],
      done: false,
      error: null,
      wake: null,
    };
    this.queue.push(item);
    this.all.add(item);
    void this.fetch(item);
    void this.pump();
  }

  stop(): void {
    this.gen++;
    for (const item of this.all) {
      item.controller.abort();
      item.wake?.();
    }
    this.all.clear();
    this.queue = [];
    this.clip?.cancel();
    this.clip = null;
    this.deps.fallback?.stop();
    this.blocked = false;
    if (this.speaking) {
      this.speaking = false;
      this.cb.onStateChange(false);
    }
  }

  unlock(): void {
    this.blocked = false;
    this.clip?.unlock();
  }

  // ---- internals ---------------------------------------------------------

  private async fetch(item: Item): Promise<void> {
    try {
      for await (const chunk of this.deps.provider.open(item.text, item.controller.signal)) {
        if (item.controller.signal.aborted) break;
        item.buf.push(chunk);
        item.wake?.();
      }
    } catch (err) {
      if (!item.controller.signal.aborted) item.error = err;
    } finally {
      item.done = true;
      item.wake?.();
    }
  }

  /** Resolve once `ready()` holds (or the item settles / the player is stopped). */
  private wait(item: Item, ready: () => boolean, gen: number): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (gen !== this.gen || ready() || item.done) {
          item.wake = null;
          resolve();
        }
      };
      item.wake = check;
      check();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    const gen = this.gen;
    try {
      while (this.queue.length > 0 && gen === this.gen) {
        const item = this.queue.shift()!;
        if (!this.speaking) {
          this.speaking = true;
          this.cb.onStateChange(true);
        }
        await this.play(item, gen);
        this.all.delete(item);
      }
    } finally {
      this.pumping = false;
      if (gen === this.gen && this.queue.length === 0 && this.speaking) {
        this.speaking = false;
        this.cb.onStateChange(false);
      } else if (gen !== this.gen && this.queue.length > 0) {
        // stop() raced with a fresh enqueue made after it — pick that up.
        void this.pump();
      }
    }
  }

  private async play(item: Item, gen: number): Promise<void> {
    await this.wait(item, () => item.buf.length > 0, gen);
    if (gen !== this.gen) return;

    if (item.buf.length === 0) {
      // Nothing arrived: the provider failed or returned empty.
      if (item.error !== null) this.deps.onError?.(item.error, item.text);
      await this.speakFallback(item.text, gen);
      return;
    }

    const clip = this.deps.sink.createClip({
      onFirstAudio: () => {
        if (gen === this.gen) this.cb.onChunkStart?.(item.text);
      },
      onBlocked: () => {
        this.blocked = true;
        this.cb.onAudioBlocked();
      },
    });
    this.clip = clip;

    let sent = 0;
    while (gen === this.gen) {
      while (sent < item.buf.length) clip.append(item.buf[sent++]);
      if (item.done) break;
      await this.wait(item, () => sent < item.buf.length, gen);
    }
    if (gen !== this.gen) return; // stop() already cancelled the clip

    if (item.error !== null) this.deps.onError?.(item.error, item.text);
    clip.end();
    await clip.finished;
    if (this.clip === clip) this.clip = null;
  }

  private async speakFallback(text: string, gen: number): Promise<void> {
    const fb = this.deps.fallback;
    if (!fb || gen !== this.gen) return;
    this.cb.onChunkStart?.(text);
    try {
      await fb.speak(text);
    } catch {
      // Offline voice failing must not wedge the queue.
    }
  }
}
