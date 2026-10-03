import { TtsPlayer } from "./tts-player";
import { StreamingTtsPlayer } from "./tts/streaming-player";
import { IpcTtsProvider } from "./tts/ipc-provider";
import { createAudioSink } from "./tts/audio-sinks";
import { SystemFallbackVoice } from "./tts/system-fallback";

// Common interface for spoken output, so the orchestrator (use-dex) is
// agnostic to whether audio comes from ElevenLabs (main process) or the OS's
// built-in speech synthesis (renderer Web Speech).
export interface SpeechEngine {
  enqueue(text: string): void;
  stop(): void;
  unlock(): void;
  readonly isSpeaking: boolean;
}

export interface SpeechEngineCallbacks {
  onStateChange: (speaking: boolean) => void;
  onAudioBlocked: () => void;
  /** Fires when a queued chunk actually *starts* being spoken (not when it's
   *  enqueued). Lets the UI track spoken progress, which lags the model's much
   *  faster token stream. */
  onChunkStart?: (text: string) => void;
}

export interface SystemVoiceOptions {
  voiceURI: string | null;
  rate: number;
  pitch: number;
}

export type SpeechEngineKind = "elevenlabs" | "system";

export function pickSystemVoice(opts: SystemVoiceOptions): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (opts.voiceURI) {
    const match = voices.find((v) => v.voiceURI === opts.voiceURI);
    if (match) return match;
  }
  // Prefer an English voice if no explicit choice.
  return voices.find((v) => v.lang?.startsWith("en")) ?? voices[0] ?? null;
}

/**
 * System TTS via the renderer's SpeechSynthesis API. Sentences are spoken in
 * order; speaking-state is tracked so the orchestrator's state machine behaves
 * the same as with ElevenLabs. No audio-unlock gesture is needed.
 */
export class SystemSpeechEngine implements SpeechEngine {
  private pending = 0;
  private speaking = false;
  private stopped = false;

  constructor(
    private readonly cb: SpeechEngineCallbacks,
    private opts: SystemVoiceOptions,
  ) {}

  /** Apply new voice settings to a live engine (no rebuild needed — the next
   *  utterance picks them up). Lets settings changes take effect mid-session. */
  setOptions(opts: SystemVoiceOptions) {
    this.opts = opts;
  }

  private pickVoice(): SpeechSynthesisVoice | null {
    return pickSystemVoice(this.opts);
  }

  enqueue(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.stopped = false;

    const utterance = new SpeechSynthesisUtterance(trimmed);
    const voice = this.pickVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = this.opts.rate;
    utterance.pitch = this.opts.pitch;

    this.pending += 1;
    if (!this.speaking) {
      this.speaking = true;
      this.cb.onStateChange(true);
    }

    const settle = () => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0 && !this.stopped) {
        this.speaking = false;
        this.cb.onStateChange(false);
      }
    };
    utterance.onstart = () => this.cb.onChunkStart?.(trimmed);
    utterance.onend = settle;
    utterance.onerror = settle;

    window.speechSynthesis.speak(utterance);
  }

  stop() {
    this.stopped = true;
    this.pending = 0;
    window.speechSynthesis.cancel();
    if (this.speaking) {
      this.speaking = false;
      this.cb.onStateChange(false);
    }
  }

  // No-op: SpeechSynthesis doesn't require an audio-unlock gesture.
  unlock() {}

  get isSpeaking() {
    return this.speaking || this.pending > 0;
  }
}

export interface CreateSpeechEngineOptions {
  kind: SpeechEngineKind;
  callbacks: SpeechEngineCallbacks;
  system: SystemVoiceOptions;
  /** ElevenLabs only: stream audio as generated, with system-voice fallback. */
  streaming?: boolean;
  /** Live system-voice settings for the fallback (read at speak time). */
  getSystemVoice?: () => SystemVoiceOptions;
}

export function createSpeechEngine(opts: CreateSpeechEngineOptions): SpeechEngine {
  if (opts.kind === "system") {
    return new SystemSpeechEngine(opts.callbacks, opts.system);
  }
  if (opts.streaming) {
    const getVoice = opts.getSystemVoice ?? (() => opts.system);
    return new StreamingTtsPlayer(opts.callbacks, {
      provider: new IpcTtsProvider(),
      sink: createAudioSink(),
      fallback: new SystemFallbackVoice(getVoice),
      onError: (err, text) =>
        console.warn("[opendex tts] stream failed, using fallback:", err, `(${text.length} chars)`),
    });
  }
  return new TtsPlayer(opts.callbacks);
}
