import { planReflex, type ReflexPlan } from "./plan";
import type { ReflexLedger } from "./ledger";

export interface ReflexActResult {
  started: boolean;
  tool?: string;
  reason?: "no_plan" | "tool_unavailable" | "denied_or_failed";
}

/**
 * Execute the reflex action for a Jev label, if (and only if) it maps to a fixed
 * plan. `run` must go through the normal permission gate (it is the registry's
 * wrapped tool), so profiles and standing decisions all still apply.
 *
 * The ledger records the intent *before* running so a concurrent full model run
 * doesn't prompt for / repeat the same action while our prompt is open; it is
 * released if the action is denied or fails so the model can still try.
 */
export async function actOnReflex(
  choice: string,
  transcript: string,
  run: (plan: ReflexPlan) => Promise<unknown> | undefined,
  ledger: ReflexLedger,
): Promise<ReflexActResult> {
  const plan = planReflex(choice, transcript);
  if (!plan) return { started: false, reason: "no_plan" };

  ledger.record(plan.tool, plan.input);
  let result: unknown;
  try {
    const pending = run(plan);
    if (pending === undefined) {
      ledger.release(plan.tool, plan.input);
      return { started: false, tool: plan.tool, reason: "tool_unavailable" };
    }
    result = await pending;
  } catch {
    ledger.release(plan.tool, plan.input);
    return { started: false, tool: plan.tool, reason: "denied_or_failed" };
  }
  if (result && typeof result === "object" && "error" in result) {
    ledger.release(plan.tool, plan.input);
    return { started: false, tool: plan.tool, reason: "denied_or_failed" };
  }
  return { started: true, tool: plan.tool };
}
