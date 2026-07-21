// The sense verb: one tool, seven decision-shaped questions, answered from
// the asking character's own knowledge. And one renderer family shared between
// sense output and the wake report, so a character learns a single format.

import assert from "node:assert/strict";
import test from "node:test";

import { createColony } from "../src/coordinator.js";
import { describeSense, renderWake } from "../src/sense-prose.js";

function withColony(fn: (colony: any) => void | Promise<void>) {
  let colony = createColony({
    statePath: null,
    rulesPath: null,
    waitTimeoutMs: 2000,
    scenarios: ["survival"],
  });
  colony.start();
  colony.connect("s");
  return Promise.resolve(fn(colony)).finally(() => colony.stop());
}

test("sense modes answer with marked, mode-shaped payloads", () =>
  withColony((colony) => {
    colony.join("s", "Ara");

    let situation = colony.sense("s", "situation");
    assert.equal(situation.sense, "situation");
    assert.equal(situation.you.name, "Ara");
    assert.ok(situation.here.terrain);

    let surroundings = colony.sense("s", "surroundings");
    assert.equal(surroundings.sense, "surroundings");
    assert.ok(Array.isArray(surroundings.grid.rows));
    assert.ok(Array.isArray(surroundings.grid.legend));
    assert.ok(Array.isArray(surroundings.inSight));

    let atlas = colony.sense("s", "atlas");
    assert.equal(atlas.sense, "atlas");
    assert.ok(atlas.coverage > 0 && atlas.coverage < 1);

    let frontier = colony.sense("s", "frontier");
    assert.equal(frontier.sense, "frontier");
    assert.ok(frontier.nearestUnseen, "a fresh character has unseen ground");

    // find and route demand their argument.
    assert.throws(() => colony.sense("s", "find"), /what/);
    assert.throws(() => colony.sense("s", "route"), /to/);
    assert.throws(() => colony.sense("s", "elsewhere"), /Unknown sense mode/);

    let find = colony.sense("s", "find", "food");
    assert.equal(find.sense, "find");
    assert.ok(Array.isArray(find.matches));
    assert.ok(Array.isArray(find.unsearched));
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

test("sense prose: envelope first, provenance shown, closure lines present", () =>
  withColony((colony) => {
    colony.join("s", "Ara");

    let situation = describeSense(colony.sense("s", "situation"));
    assert.match(situation, /^Tick \d+\. You are Ara/);
    assert.match(situation, /pressing/i, "situation closes with a status line");

    let surroundings = describeSense(colony.sense("s", "surroundings"));
    assert.match(surroundings, /Sight \(\d+x\d+, north up, you @ center\):/);
    assert.match(surroundings, /Key: @ you, /);
    assert.match(surroundings, /blank = off-map\./);

    let frontier = describeSense(colony.sense("s", "frontier"));
    assert.match(frontier, /Your atlas covers \d+% of walkable ground\./);

    let find = describeSense(colony.sense("s", "find", "food"));
    assert.match(find, /food/);

    // No coordinates anywhere in character-facing prose.
    for (let text of [situation, surroundings, frontier, find])
      assert.doesNotMatch(text, /\d+\s*,\s*\d+/, "prose never leaks x,y");
  }));

test("a remembered place wears its age in atlas prose", () => {
  let rendered = describeSense({
    sense: "atlas",
    tick: 100,
    coverage: 0.4,
    locations: [
      {
        name: "river-grove",
        tags: ["token", "wood"],
        distance: 9,
        direction: "southeast",
        lastSeenTicksAgo: 40,
      },
    ],
  });
  assert.match(rendered, /river-grove/);
  assert.match(rendered, /seen 40 ticks ago/);
});

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
