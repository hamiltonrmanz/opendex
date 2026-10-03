import { test } from "node:test";
import assert from "node:assert/strict";
import { ReflexLedger } from "./ledger";

test("claim matches normalized input exactly once", () => {
  const l = new ReflexLedger(1000, () => 0);
  l.record("openApp", { name: "Spotify" });
  assert.equal(l.claim("openApp", { name: " spotify " }), true);
  assert.equal(l.claim("openApp", { name: "spotify" }), false);
});

test("different tool or input does not match", () => {
  const l = new ReflexLedger(1000, () => 0);
  l.record("openApp", { name: "Notes" });
  assert.equal(l.claim("openApp", { name: "Mail" }), false);
  assert.equal(l.claim("openUrl", { name: "Notes" }), false);
});

test("entries expire", () => {
  let t = 0;
  const l = new ReflexLedger(1000, () => t);
  l.record("openApp", { name: "Notes" });
  t = 1001;
  assert.equal(l.claim("openApp", { name: "Notes" }), false);
});

test("release makes a recorded action claimable again by nobody", () => {
  const l = new ReflexLedger(1000, () => 0);
  l.record("openApp", { name: "Notes" });
  l.release("openApp", { name: "Notes" });
  assert.equal(l.claim("openApp", { name: "Notes" }), false);
});
