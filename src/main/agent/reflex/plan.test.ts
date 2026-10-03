import { test } from "node:test";
import assert from "node:assert/strict";
import { planReflex } from "./plan";

test("open_app plans a bare launch", () => {
  assert.deepEqual(planReflex("open_app", "open Spotify"), { tool: "openApp", input: { name: "Spotify" } });
  assert.deepEqual(planReflex("open_app", "Hey, please launch the Notes app."), {
    tool: "openApp",
    input: { name: "Notes" },
  });
});

test("open_app rejects compound or hostile utterances", () => {
  assert.equal(planReflex("open_app", "open my email and send a message to bob"), null);
  assert.equal(planReflex("open_app", "open spotify then play jazz"), null);
  assert.equal(planReflex("open_app", "open -a Terminal"), null);
  assert.equal(planReflex("open_app", "open ../../etc/passwd"), null);
  assert.equal(planReflex("open_app", "open one two three four"), null);
  assert.equal(planReflex("open_app", "open $(whoami)"), null);
});

test("search plans an https google URL with an encoded query", () => {
  const p = planReflex("search", "search for best ramen in nashville");
  assert.deepEqual(p, {
    tool: "openUrl",
    input: { url: "https://www.google.com/search?q=best%20ramen%20in%20nashville" },
  });
  const q = planReflex("search", "google a&b=c#frag");
  assert.equal(q?.tool, "openUrl");
  assert.ok((q as { input: { url: string } }).input.url.startsWith("https://www.google.com/search?q="));
  assert.ok(!(q as { input: { url: string } }).input.url.includes("#frag"));
});

test("search rejects compound requests", () => {
  assert.equal(planReflex("search", "search for flights and then book the cheapest one"), null);
});

test("type_text, no_action and unknown labels never plan", () => {
  assert.equal(planReflex("type_text", "type hello world"), null);
  assert.equal(planReflex("no_action", "open spotify"), null);
  assert.equal(planReflex("rm_rf", "open spotify"), null);
});

test("label must agree with the words (no cross-planning)", () => {
  assert.equal(planReflex("search", "open spotify"), null);
  assert.equal(planReflex("open_app", "search for spotify"), null);
});

test("empty or oversized input is null", () => {
  assert.equal(planReflex("open_app", "   "), null);
  assert.equal(planReflex("search", "search " + "x".repeat(300)), null);
});
