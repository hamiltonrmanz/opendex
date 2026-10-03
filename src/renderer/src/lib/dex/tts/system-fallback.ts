import { pickSystemVoice, type SystemVoiceOptions } from "../speech-engine";
import type { FallbackVoice } from "./types";

/** Offline fallback: the OS voice (macOS `say` voices via SpeechSynthesis). */
export class SystemFallbackVoice implements FallbackVoice {
  constructor(private readonly opts: () => SystemVoiceOptions) {}

  speak(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const options = this.opts();
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickSystemVoice(options);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.rate = options.rate;
      u.pitch = options.pitch;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  stop(): void {
    window.speechSynthesis.cancel();
  }
}
