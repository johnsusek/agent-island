// The chronicler and clerk persona files parse as scheduled director seats.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { directorWake, parsePersona } from "../scripts/crew-policy.mjs";

function persona(name) {
  let url = new URL(`../scripts/agents/directors/${name}.md`, import.meta.url);
  return parsePersona(readFileSync(url, "utf8"));
}

test("the chronicler is a scheduled director every 150 ticks", () => {
  let { meta, body } = persona("chronicler");
  assert.equal(meta.model, "haiku");
  assert.equal(meta.effort, "medium");
  assert.deepEqual(directorWake(meta), {
    events: [],
    everyTicks: 150,
    minIntervalMs: null,
  });
  assert.match(body, /edit_entity/);
  assert.match(body, /monument/);
});

test("the clerk still parses as a scheduled director", () => {
  let { meta } = persona("clerk");
  assert.equal(directorWake(meta).everyTicks, 200);
});
