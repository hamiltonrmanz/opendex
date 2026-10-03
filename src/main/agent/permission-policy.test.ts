import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePermission, grantsSession, resolveRisk, type PolicyInput } from "./permission-policy";

const base: PolicyInput = {
  risk: "safe_reversible",
  profile: "ask",
  standing: undefined,
  commandGrant: false,
  sessionGrant: false,
};
const d = (o: Partial<PolicyInput>) => decidePermission({ ...base, ...o });

test("default ask profile prompts for everything", () => {
  assert.equal(d({}), "prompt");
  assert.equal(d({ risk: "always_ask" }), "prompt");
});

test("standing never always denies, even under persistent", () => {
  assert.equal(d({ standing: "never", profile: "persistent" }), "deny");
  assert.equal(d({ standing: "never", commandGrant: true }), "deny");
});

test("persistent auto-allows only the safe tier", () => {
  assert.equal(d({ profile: "persistent" }), "allow");
  assert.equal(d({ profile: "persistent", risk: "always_ask" }), "prompt");
});

test("session grant is honoured only for safe tier under session profile", () => {
  assert.equal(d({ profile: "session" }), "prompt");
  assert.equal(d({ profile: "session", sessionGrant: true }), "allow");
  assert.equal(d({ profile: "session", sessionGrant: true, risk: "always_ask" }), "prompt");
  assert.equal(d({ profile: "ask", sessionGrant: true }), "prompt");
});

test("per-command grant and explicit always keep existing behaviour", () => {
  assert.equal(d({ commandGrant: true, risk: "always_ask" }), "allow");
  assert.equal(d({ standing: "always", risk: "always_ask" }), "allow");
});

test("only session profile + safe tier remembers an approval", () => {
  assert.equal(grantsSession("safe_reversible", "session"), true);
  assert.equal(grantsSession("always_ask", "session"), false);
  assert.equal(grantsSession("safe_reversible", "ask"), false);
  assert.equal(grantsSession("safe_reversible", "persistent"), false);
});

test("resolveRisk fails closed", () => {
  assert.equal(resolveRisk(undefined, {}), "always_ask");
  assert.equal(resolveRisk("safe_reversible", {}), "safe_reversible");
  assert.equal(resolveRisk(() => { throw new Error("x"); }, {}), "always_ask");
  assert.equal(resolveRisk(() => "bogus" as never, {}), "always_ask");
});
