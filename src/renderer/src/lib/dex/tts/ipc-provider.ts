import type { TtsStreamProvider } from "./types";

/** Streams a sentence from the main process (ElevenLabs lives there so the key
 *  never reaches the renderer). Aborting `signal` cancels the upstream request. */
export class IpcTtsProvider implements TtsStreamProvider {
  open(text: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]() {
        const queue: Uint8Array[] = [];
        let ended = false;
        let error: Error | null = null;
        let wake: (() => void) | null = null;
        const poke = () => wake?.();

        const cancel = window.opendex.ttsStream(text, {
          onChunk: (b) => {
            queue.push(b);
            poke();
          },
          onEnd: () => {
            ended = true;
            poke();
          },
          onError: (m) => {
            error = new Error(m);
            ended = true;
            poke();
          },
        });
        const onAbort = () => {
          cancel();
          ended = true;
          poke();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });

        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            for (;;) {
              if (queue.length) return { value: queue.shift()!, done: false };
              if (error) throw error;
              if (ended) return { value: undefined, done: true };
              await new Promise<void>((r) => (wake = r));
            }
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            signal.removeEventListener("abort", onAbort);
            cancel();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
