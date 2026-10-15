// The Judge director's persona frontmatter parses into an event-woken seat
// that wakes on petitions, like the Clerk's parses into a scheduled one.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  directorWake,
  parsePersona,
  wakeCadenceTicks,
} from "../scripts/crew-policy.mjs";

test("the judge persona wakes on petitions", () => {
  let source = fs.readFileSync(
    new URL("../scripts/agents/directors/judge.md", import.meta.url),
    "utf8",
  );
  let { meta, body } = parsePersona(source);
  assert.equal(meta.model, "sonnet");
  assert.equal(meta.effort, "medium");
  let wake = directorWake(meta);
  assert.deepEqual(wake.events, ["petition"]);
  assert.equal(wake.everyTicks, null);
  assert.equal(wake.minIntervalMs, 60000);
  assert.equal(wakeCadenceTicks(wake), 0, "event-woken, not scheduled");
  assert.match(body, /^You are the Judge/);
});
