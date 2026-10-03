import { WebVoiceProcessor } from "@picovoice/web-voice-processor";
import { frameRms } from "./wav";
import { vlog } from "../voice-timing";
import { latencyTrace } from "../latency-trace";
import { endpointState } from "../endpoint-state";
import { Endpointer } from "./endpointer";
import type { CaptureOptions } from "./types";

// Shared mic-capture helper built on WebVoiceProcessor's 16kHz Int16 frames.
// Subscribes a frame sink, applies energy-based endpointing (trailing silence
// after some speech, or a hard timeout), then hands the collected frames to a
// transcriber. Used by every local/cloud STT engine so capture behaves
// identically regardless of backend.

// Energy threshold for counting a frame as speech, and how much speech must
// accumulate before we'll treat the capture as a real utterance. Kept fairly
// strict so ambient noise doesn't trigger a capture (which local Whisper would
// otherwise "hallucinate" text from, causing a runaway follow-up loop).
const SPEECH_RMS = 0.025;
const MIN_SPEECH_FRAMES = 12; // ~0.4s of voiced audio at 16kHz/512

export async function captureUtterance(
  opts: CaptureOptions,
  transcribe: (frames: Int16Array[]) => Promise<string>,
): Promise<string> {
  const frames: Int16Array[] = [];
  const ep = new Endpointer({
    adaptive: opts.adaptive ?? true,
    fixedSpeechRms: SPEECH_RMS,
    fixedSilenceMs: opts.silenceMs,
    minSpeechMs: MIN_SPEECH_FRAMES * 32,
  });
  let markedSpeechStart = false;
  const started = performance.now();
  let done = false;
  endpointState.set("waiting");

  const engine = {
    onmessage: null as ((e: MessageEvent) => void) | null,
    postMessage: (e: { command: string; inputFrame?: Int16Array }) => {
      if (done || e.command !== "process" || !e.inputFrame) return;
      frames.push(e.inputFrame.slice());
      endpointState.set(ep.push(frameRms(e.inputFrame)));
      if (!markedSpeechStart && ep.heardVoice) {
        markedSpeechStart = true;
        latencyTrace.mark("speech_start");
      }
    },
  };

  return new Promise<string>((resolve, reject) => {
    const finish = async (cancelled: boolean) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      endpointState.set("idle");
      try {
        await WebVoiceProcessor.unsubscribe(engine);
      } catch {
        // ignore
      }
      if (cancelled || !ep.hasSpeech) return resolve("");
      try {
        vlog("transcribe:start", { frames: frames.length });
        const transcribeStart = performance.now();
        const text = (await transcribe(frames)).trim();
        vlog("transcribe:done", {
          ms: Math.round(performance.now() - transcribeStart),
          chars: text.length,
        });
        resolve(text);
      } catch (err) {
        reject(err);
      }
    };

    opts.signal?.addEventListener("abort", () => void finish(true), { once: true });

    const poll = setInterval(() => {
      const now = performance.now();
      const elapsed = now - started;
      if (elapsed > opts.hardTimeoutMs) {
        vlog("endpoint:hard-timeout", {
          captureMs: Math.round(elapsed),
          speechMs: ep.speechMs,
        });
        return void finish(false);
      }
      if (ep.hasSpeech) {
        // Heard speech, then enough trailing silence (adaptive or fixed) → end.
        if (ep.ended) {
          vlog("endpoint:silence", {
            adaptive: opts.adaptive ?? true,
            silenceMs: Math.round(ep.targetSilenceMs),
            speechRate: ep.speechRate === null ? null : Number(ep.speechRate.toFixed(1)),
            captureMs: Math.round(elapsed),
            speechMs: ep.speechMs,
          });
          void finish(false);
        }
      } else if (elapsed > opts.noSpeechMs) {
        // Nothing meaningful within the listen window → give up quietly (no
        // transcription) instead of waiting out the hard timeout.
        void finish(true);
      }
    }, 100);

    WebVoiceProcessor.subscribe(engine).catch((err) => {
      clearInterval(poll);
      endpointState.set("idle");
      reject(err);
    });
  });
}

/** Concatenate Int16 frames into a single Float32Array (−1..1) for ML models. */
export function framesToFloat32(frames: Int16Array[]): Float32Array {
  let length = 0;
  for (const f of frames) length += f.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const f of frames) {
    for (let i = 0; i < f.length; i++) out[offset++] = f[i] / 32768;
  }
  return out;
}
