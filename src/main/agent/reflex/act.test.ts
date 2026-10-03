import { test } from "node:test";
import assert from "node:assert/strict";
import { actOnReflex } from "./act";
import { ReflexLedger } from "./ledger";

const ledger = () => new ReflexLedger(1000, () => 0);

test("runs the planned tool and leaves the ledger entry for the model run to claim", async () => {
  const l = ledger();
  const calls: unknown[] = [];
  const r = await actOnReflex("open_app", "open Spotify", async (p) => {
    calls.push(p);
    return { ok: true };
  }, l);
  assert.deepEqual(r, { started: true, tool: "openApp" });
  assert.deepEqual(calls, [{ tool: "openApp", input: { name: "Spotify" } }]);
  assert.equal(l.claim("openApp", { name: "spotify" }), true);
});

test("ledger entry exists while the run is still pending (concurrent model run dedupes)", async () => {
  const l = ledger();
  let release!: () => void;
  const p = actOnReflex("open_app", "open Notes", () => new Promise((r) => (release = () => r({ ok: true }))), l);
  assert.equal(l.claim("openApp", { name: "Notes" }), true); // model run claims mid-prompt
  release();
  await p;
});

test("no plan: nothing runs, nothing recorded", async () => {
  const l = ledger();
  let ran = false;
  const r = await actOnReflex("type_text", "type hi there", async () => { ran = true; }, l);
  assert.deepEqual(r, { started: false, reason: "no_plan" });
  assert.equal(ran, false);
});

test("tool unavailable (skill disabled) releases the ledger", async () => {
  const l = ledger();
  const r = await actOnReflex("open_app", "open Notes", () => undefined, l);
  assert.equal(r.reason, "tool_unavailable");
  assert.equal(l.claim("openApp", { name: "Notes" }), false);
});

test("denied or failed releases the ledger so the model can retry", async () => {
  const l = ledger();
  const denied = await actOnReflex("open_app", "open Notes", async () => ({ error: "Permission denied by the user." }), l);
  assert.equal(denied.reason, "denied_or_failed");
  assert.equal(l.claim("openApp", { name: "Notes" }), false);
  const threw = await actOnReflex("open_app", "open Notes", async () => { throw new Error("x"); }, l);
  assert.equal(threw.reason, "denied_or_failed");
});
