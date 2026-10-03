import type { AudioClip, AudioClipHooks, AudioSink, ClipResult } from "./types";

// Browser audio output for streaming TTS.
//
// MseAudioSink plays MP3 through a MediaSource as bytes arrive, so audio starts
// on the first chunk. If MediaSource/`audio/mpeg` isn't available, BlobAudioSink
// buffers the sentence and plays it when complete (no first-audio win, same
// behaviour as the non-streaming player). Neither can be exercised without a
// real audio stack, so they are deliberately thin; the ordering/cancel logic
// lives in streaming-player.ts and is unit-tested.

function deferred() {
  let resolve!: (r: ClipResult) => void;
  const promise = new Promise<ClipResult>((r) => (resolve = r));
  return { promise, resolve };
}

class MseClip implements AudioClip {
  private readonly audio = new Audio();
  private readonly ms = new MediaSource();
  private readonly url = URL.createObjectURL(this.ms);
  private sb: SourceBuffer | null = null;
  private readonly queue: Uint8Array[] = [];
  private ending = false;
  private closed = false;
  private playRequested = false;
  private firstFired = false;
  private readonly done = deferred();
  readonly finished = this.done.promise;

  constructor(private readonly hooks: AudioClipHooks) {
    this.audio.src = this.url;
    this.audio.onplaying = () => {
      if (this.firstFired) return;
      this.firstFired = true;
      hooks.onFirstAudio();
    };
    this.audio.onended = () => this.settle("ended");
    this.audio.onerror = () => this.settle("ended"); // never wedge the queue
    this.ms.addEventListener(
      "sourceopen",
      () => {
        if (this.closed) return;
        try {
          this.sb = this.ms.addSourceBuffer("audio/mpeg");
        } catch {
          this.settle("ended");
          return;
        }
        this.sb.addEventListener("updateend", () => this.pump());
        this.pump();
      },
      { once: true },
    );
  }

  append(chunk: Uint8Array): void {
    if (this.closed) return;
    this.queue.push(chunk);
    this.pump();
    this.requestPlay();
  }

  end(): void {
    this.ending = true;
    this.pump();
  }

  unlock(): void {
    this.requestPlay();
  }

  cancel(): void {
    this.settle("cancelled");
  }

  private pump(): void {
    if (this.closed || !this.sb || this.sb.updating) return;
    const next = this.queue.shift();
    if (next) {
      try {
        this.sb.appendBuffer(next as BufferSource);
      } catch {
        this.settle("ended");
      }
      return;
    }
    if (this.ending && this.ms.readyState === "open") {
      try {
        this.ms.endOfStream();
      } catch {
        /* already ended */
      }
    }
  }

  private requestPlay(): void {
    if (this.playRequested || this.closed) return;
    this.playRequested = true;
    this.audio.play().catch((err: unknown) => {
      if ((err as Error)?.name === "NotAllowedError") {
        this.playRequested = false; // retried by unlock()
        this.hooks.onBlocked();
      } else {
        this.settle("ended");
      }
    });
  }

  private settle(result: ClipResult): void {
    if (this.closed) return;
    this.closed = true;
    this.audio.onplaying = null;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    URL.revokeObjectURL(this.url);
    this.done.resolve(result);
  }
}

class BlobClip implements AudioClip {
  private readonly chunks: Uint8Array[] = [];
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private closed = false;
  private ended = false;
  private blockedAudio = false;
  private readonly done = deferred();
  readonly finished = this.done.promise;

  constructor(private readonly hooks: AudioClipHooks) {}

  append(chunk: Uint8Array): void {
    if (!this.closed) this.chunks.push(chunk);
  }

  end(): void {
    if (this.closed || this.ended) return;
    this.ended = true;
    this.url = URL.createObjectURL(new Blob(this.chunks as BlobPart[], { type: "audio/mpeg" }));
    const audio = new Audio(this.url);
    this.audio = audio;
    audio.onplaying = () => this.hooks.onFirstAudio();
    audio.onended = () => this.settle("ended");
    audio.onerror = () => this.settle("ended");
    this.play();
  }

  unlock(): void {
    if (this.blockedAudio) this.play();
  }

  cancel(): void {
    this.settle("cancelled");
  }

  private play(): void {
    this.blockedAudio = false;
    this.audio?.play().catch((err: unknown) => {
      if ((err as Error)?.name === "NotAllowedError") {
        this.blockedAudio = true;
        this.hooks.onBlocked();
      } else {
        this.settle("ended");
      }
    });
  }

  private settle(result: ClipResult): void {
    if (this.closed) return;
    this.closed = true;
    if (this.audio) {
      this.audio.onplaying = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio.src = "";
    }
    if (this.url) URL.revokeObjectURL(this.url);
    this.done.resolve(result);
  }
}

export class MseAudioSink implements AudioSink {
  createClip(hooks: AudioClipHooks): AudioClip {
    return new MseClip(hooks);
  }
}

export class BlobAudioSink implements AudioSink {
  createClip(hooks: AudioClipHooks): AudioClip {
    return new BlobClip(hooks);
  }
}

/** Pick the streaming sink when the platform can decode MP3 via MediaSource. */
export function createAudioSink(): AudioSink {
  const mseOk =
    typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
  return mseOk ? new MseAudioSink() : new BlobAudioSink();
}
