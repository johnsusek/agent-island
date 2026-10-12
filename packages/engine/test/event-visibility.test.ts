import assert from "node:assert/strict";
import test from "node:test";

import { createWorld } from "../src/engine.js";
import type { Scenario } from "../src/scenario.js";

// The whole point of these tests is the DEFAULT: a witnessed or world event
// reaches a character only if they were the actor, stood within SIGHT (the
// audience stamp), or the event explicitly opted into colony-wide reach with
// `global`. If someone ever reverts visibleTo to a blanket `return true`, the
// "unmarked event stays local" assertions below fail - that is the guardrail.
//
// visibleTo is a pure function of the event's own fields (type, agentId,
// audience, global, target), so no spatial setup is needed: synthetic events
// exercise the gate directly.
function emptyWorld() {
  let scenario: Scenario = {
    name: "visibility-probe",
    spawn: { x: 1, y: 1 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    rules: [],
  };
  return createWorld(scenario);
}

function ev(fields: Record<string, unknown>) {
  return { seq: 1, tick: 1, ...fields } as any;
}

test("a witnessed deed defaults to local: only the actor and the audience see it", () => {
  let world = emptyWorld();
  let chopped = ev({ type: "chopped", agentId: "ara", audience: ["cass"] });

  assert.equal(
    world.visibleTo(chopped, "ara"),
    true,
    "the actor sees own deed",
  );
  assert.equal(
    world.visibleTo(chopped, "cass"),
    true,
    "a character within SIGHT (in the audience) sees it",
  );
  assert.equal(
    world.visibleTo(chopped, "bren"),
    false,
    "a distant character, not in the audience, does not see it",
  );
});

test("an empty audience means nobody-but-the-actor, not everybody", () => {
  let world = emptyWorld();
  // Acted alone, no one within SIGHT: the deed is the actor's alone.
  let solo = ev({ type: "gathered", agentId: "ara", audience: [] });
  assert.equal(world.visibleTo(solo, "ara"), true);
  assert.equal(world.visibleTo(solo, "bren"), false);
});

test("an unmarked world event (no actor, no audience) reaches no character", () => {
  let world = emptyWorld();
  // The flipped default: an actorless event that forgot to opt in is scoped to
  // nobody rather than silently broadcast to the whole colony.
  let orphan = ev({ type: "winter_arrived" });
  assert.equal(world.visibleTo(orphan, "ara"), false);
  assert.equal(world.visibleTo(orphan, "bren"), false);
});

test("`global` is the opt-in that restores colony-wide reach", () => {
  let world = emptyWorld();
  let season = ev({ type: "winter_arrived", global: true });
  assert.equal(world.visibleTo(season, "ara"), true);
  assert.equal(world.visibleTo(season, "bren"), true);

  // A positioned victory still reaches everyone once it opts in, even though its
  // audience would otherwise scope it to the winner's tile.
  let victory = ev({
    type: "victory",
    agentId: "ara",
    audience: [],
    global: true,
  });
  assert.equal(world.visibleTo(victory, "bren"), true);
});
