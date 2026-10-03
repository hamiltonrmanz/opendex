/**
 * Jev reflex adapter.
 *
 * This module is intentionally main-process-only. It asks Jev to choose from
 * a closed list of safe reflex labels; it never executes tools and it never
 * accepts an arbitrary tool name from the provider.
 */

export const REFLEX_OPTIONS = {
  no_action: "No immediate desktop action is justified.",
  open_app: "Open a named macOS application or URL.",
  search: "Search the web or the user's approved workspace.",
  type_text: "Type non-sensitive text into the currently focused app.",
} as const;

export type ReflexChoice = keyof typeof REFLEX_OPTIONS;

export interface JevReflexDecision {
  choice: ReflexChoice;
  confidence: number | null;
  probability: number | null;
  source: "jev" | "fallback";
}

interface JevChoiceAnswer {
  choice?: unknown;
  confidence?: unknown;
  probabilities?: Record<string, unknown>;
}

interface JevResponse {
  answers?: Record<string, JevChoiceAnswer>;
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = 1200;

function isReflexChoice(value: unknown): value is ReflexChoice {
  return typeof value === "string" && value in REFLEX_OPTIONS;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function classifyReflex(transcript: string): Promise<JevReflexDecision> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  const fallback: JevReflexDecision = {
    choice: "no_action",
    confidence: null,
    probability: null,
    source: "fallback",
  };

  if (!apiKey || !transcript.trim()) return fallback;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        state: transcript.trim().slice(0, 4000),
        questions: {
          reflex: {
            type: "choice",
            instructions: "Choose the single safest immediate reflex for this spoken request.",
            criteria: REFLEX_OPTIONS,
          },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) return fallback;
    const payload = (await response.json()) as JevResponse;
    const answer = payload.answers?.reflex;
    if (!answer || !isReflexChoice(answer.choice)) return fallback;

    const probability = numberOrNull(answer.probabilities?.[answer.choice]);
    const confidence = numberOrNull(answer.confidence);
    // Fail closed when Jev is uncertain; the host must authorize execution.
    if ((confidence !== null && confidence < 0.7) || (probability !== null && probability < 0.6)) {
      return fallback;
    }

    return { choice: answer.choice, confidence, probability, source: "jev" };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
