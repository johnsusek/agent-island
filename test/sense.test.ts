// The sense verb: `situation` answers the asking character's "where am I, how am
// I, what's pressing, what's in sight" from its own knowledge, and `changes`
// reads the session cursor. One renderer family is shared between sense output
// and the wake report, so a character learns a single format.

import assert from "node:assert/strict";
import test from "node:test";

import { createColony } from "../src/coordinator.js";
import { survivalBoot } from "./helpers.js";
import { describeSense, renderWake } from "../src/sense-prose.js";

function withColony(fn: (colony: any) => void | Promise<void>) {
  let colony = createColony({
    statePath: null,
    rulesPath: null,
    waitTimeoutMs: 2000,
    ...survivalBoot,
  });
  colony.start();
  colony.connect("s");
  return Promise.resolve(fn(colony)).finally(() => colony.stop());
}

test("situation carries the envelope, sight map, and live reserves", () =>
  withColony((colony) => {
    colony.join("s", "Ara");

    let situation = colony.sense("s", "situation");
    assert.equal(situation.sense, "situation");
    assert.equal(situation.you.name, "Ara");
    assert.ok(situation.here.terrain);
    assert.ok(Array.isArray(situation.grid.rows));
    assert.ok(Array.isArray(situation.grid.legend));
    assert.ok(Array.isArray(situation.inSight));

    assert.throws(() => colony.sense("s", "elsewhere"), /Unknown sense mode/);
  }));

test("sense changes reads and advances the session cursor", () =>
  withColony((colony) => {
    colony.join("s", "Ara");
    colony.connect("s2");
    colony.join("s2", "Bo");
    colony.sense("s", "changes"); // drain the join backlog

    colony.speak("s2", "anyone need wood?"); // Bo shares Ara's spawn tile
    let changes = colony.sense("s", "changes");
    assert.equal(changes.sense, "changes");
    assert.ok(
      changes.events.some((e: any) => e.type === "said"),
      "the speech since the cursor is delivered",
    );

    let again = colony.sense("s", "changes");
    assert.equal(again.events.length, 0, "the cursor advanced");
  }));

test("sense prose: envelope first, sight map, closure lines present", () =>
  withColony((colony) => {
    colony.join("s", "Ara");

    let situation = describeSense(colony.sense("s", "situation"));
    assert.match(situation, /^Tick \d+\. You are Ara/);
    assert.match(situation, /pressing/i, "situation closes with a status line");
    assert.match(situation, /Sight \(\d+x\d+, north up, you @ center\):/);
    assert.match(situation, /Key: @ you, /);
    assert.match(situation, /blank = off-map\./);

    // No coordinates anywhere in character-facing prose.
    assert.doesNotMatch(situation, /\d+\s*,\s*\d+/, "prose never leaks x,y");
  }));

test("the wake report opens with the same envelope sense situation uses", () =>
  withColony(async (colony) => {
    colony.join("s", "Ara");
    colony.connect("s2");
    colony.join("s2", "Bo");

    let wait = colony.waitForChange("s");
    colony.speak("s2", "fire's low!");
    let wake = await wait;
    let text = renderWake(wake);
    assert.match(text, /^\[changed\] Tick \d+\. You are Ara/);
    assert.match(text, /fire's low!/, "the speech rides the wake digest");
  }));
