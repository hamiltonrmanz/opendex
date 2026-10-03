// Contracts for streaming TTS. The player (streaming-player.ts) only knows these
// four interfaces, so provider / audio output / offline fallback are swappable
// and the ordering + cancellation logic is testable without audio hardware.

/** Yields encoded audio bytes for one sentence as the provider produces them.
 *  Must stop promptly (and may throw/return) once `signal` aborts. */
export interface TtsStreamProvider {
  open(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export type ClipResult = "ended" | "cancelled";

export interface AudioClipHooks {
  /** Audio is actually audible (first sample playing), not merely buffered. */
  onFirstAudio(): void;
  /** The platform refused to start playback until a user gesture. */
  onBlocked(): void;
}

/** One sentence's playback. Bytes are appended as they arrive; playback begins
 *  as soon as enough has been appended — it does not wait for `end()`. */
export interface AudioClip {
  append(chunk: Uint8Array): void;
  /** No more bytes are coming; resolve `finished` when playback completes. */
  end(): void;
  /** Stop immediately and discard buffered audio. */
  cancel(): void;
  /** Retry playback after `onBlocked` once the user has interacted. */
  unlock(): void;
  readonly finished: Promise<ClipResult>;
}

export interface AudioSink {
  createClip(hooks: AudioClipHooks): AudioClip;
}

/** Offline voice used when the streaming provider fails before any audio. */
export interface FallbackVoice {
  speak(text: string): Promise<void>;
  stop(): void;
}
