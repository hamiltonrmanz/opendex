import { ipcMain, type IpcMainEvent, type WebContents } from "electron";
import { IPC } from "../ipc/channels";
import { openSpeechStream } from "./elevenlabs";

// Streaming TTS over IPC. The renderer asks for a sentence by a request id of
// its choosing; main forwards MP3 chunks as they arrive from the provider and
// aborts the upstream HTTP request on cancel (or if the window goes away).
// The API key never leaves main.

const MAX_TEXT = 2000;
const MAX_ID = 64;

const active = new Map<string, AbortController>();
const key = (sender: WebContents, id: string) => `${sender.id}:${id}`;

async function run(sender: WebContents, id: string, text: string) {
  const k = key(sender, id);
  const controller = new AbortController();
  active.set(k, controller);
  const onGone = () => controller.abort();
  sender.once("destroyed", onGone);

  const send = (channel: string, payload?: unknown) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };
  try {
    const stream = await openSpeechStream(text, controller.signal);
    const reader = stream.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (controller.signal.aborted) {
        void reader.cancel().catch(() => {});
        return; // cancelled: the renderer already stopped listening
      }
      if (done) break;
      if (value?.byteLength) send(IPC.ttsStreamChunk(id), value);
    }
    send(IPC.ttsStreamEnd(id));
  } catch (err) {
    if (controller.signal.aborted) return;
    send(IPC.ttsStreamError(id), err instanceof Error ? err.message : String(err));
  } finally {
    active.delete(k);
    if (!sender.isDestroyed()) sender.off("destroyed", onGone);
  }
}

export function registerTtsStreamIpc(): void {
  ipcMain.on(IPC.ttsStreamStart, (event: IpcMainEvent, id: unknown, text: unknown) => {
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID) return;
    if (typeof text !== "string") return;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_TEXT) {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.ttsStreamError(id), "Invalid text for synthesis.");
      }
      return;
    }
    // A reused id replaces (and aborts) the earlier request.
    active.get(key(event.sender, id))?.abort();
    void run(event.sender, id, trimmed);
  });

  ipcMain.on(IPC.ttsStreamCancel, (event: IpcMainEvent, id: unknown) => {
    if (typeof id !== "string") return;
    active.get(key(event.sender, id))?.abort();
  });
}
