import type { TranscriptTurn } from "@/lib/dex/state";
import type { ToolInvocation } from "@skills/tool-view";
import { ToolCardLayer } from "@skills/tool-card-layer";

// Bottom-anchored, boxless transcript for the minimal themes' overlay. Newest
// lines sit at the bottom; older ones rise and are clipped + faded by the
// shell's mask. No scrollbar — we just render the most recent turns. A tool
// result renders inline as the trailing item (a card in the thread), so it
// scrolls with the conversation rather than floating over it.
export function OverlayTranscript({
  turns,
  liveCaption,
  toolInvocations = [],
  variant,
}: {
  turns: TranscriptTurn[];
  liveCaption: string;
  toolInvocations?: ToolInvocation[];
  variant: "bubble" | "line";
}) {
  const recent = turns.slice(-8);

  return (
    <div className="flex flex-col justify-end gap-2 text-sm leading-relaxed">
      {recent.map((t) =>
        variant === "bubble" ? (
          <div
            key={t.id}
            className={
              t.role === "user"
                ? "max-w-[80%] self-end rounded-2xl bg-foreground/10 px-4 py-2 text-foreground"
                : "max-w-[85%] self-start text-foreground/85"
            }
          >
            {t.content || "…"}
          </div>
        ) : (
          <div key={t.id} className="flex gap-2">
            <span className={t.role === "user" ? "text-foreground/40" : "text-foreground/30"}>
              {t.role === "user" ? ">" : "·"}
            </span>
            <span className={t.role === "user" ? "text-foreground" : "text-foreground/70"}>
              {t.content || "…"}
            </span>
          </div>
        ),
      )}
      {/* Tool result — inline in the thread, after the latest reply. */}
      <ToolCardLayer
        invocations={toolInvocations}
        surface="main"
        className="max-w-[85%] self-start"
      />
      {liveCaption &&
        (variant === "bubble" ? (
          <div className="max-w-[85%] self-end rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-2 text-cyan-100/90">
            <span className="mr-2 text-[10px] uppercase tracking-wider text-cyan-200/60">live</span>
            {liveCaption}
          </div>
        ) : (
          <div className="flex gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-cyan-100/90">
            <span className="text-cyan-200/60">&gt;</span>
            <span>{liveCaption}</span>
          </div>
        ))}
    </div>
  );
}
