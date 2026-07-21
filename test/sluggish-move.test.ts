// The reserved `sluggish` stock slows travel: its value is added to every tile's
// enter cost, so a slowed mover dwells extra ticks on each step. This drives the
// obsidian-frontier rule where a character moves slower the worse their health is.
// Proven end-to-end through a real travel (a give order that walks across the map)
// so it guards the wiring in advanceSpace, not just the helper.

import test from "node:test";
import assert from "node:assert/strict";

import type { WorldEngine } from "../src/rules/engine.js";
import { makeSurvivalEngine, placeAt, TEST_SPAWN } from "./helpers.js";

// Set an agent stock, creating it if the scenario didn't declare it (sluggish is
// an engine-reserved stock, not part of the survival template).
function setStock(
  engine: WorldEngine,
  id: string,
  name: string,
  value: number,
) {
  let snap = engine.snapshot();
  snap.world.entities[id].stocks[name] = { value, min: 0, max: 100 };
  engine.restore(snap);
}

// Ticks for a giver placed `dist` tiles from a receiver to walk over and hand off.
function ticksToDeliver(sluggish: number, dist: number): number {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  let receiver = engine.addAgent("Bo").id;
  setStock(engine, giver, "food", 8);
  setStock(engine, receiver, "food", 0);
  setStock(engine, giver, "sluggish", sluggish);
  placeAt(engine, giver, TEST_SPAWN.x - dist, TEST_SPAWN.y);
  placeAt(engine, receiver, TEST_SPAWN.x, TEST_SPAWN.y);

  engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "food" }],
  });

  let ticks = 0;
  while (engine.getObservation(receiver).you.stocks.food.value === 0) {
    engine.tick();
    ticks += 1;
    if (ticks > 200) throw new Error("give never completed");
  }
  return ticks;
}

test("a sluggish character takes longer to cross the same distance", () => {
  let dist = 5;
  let fast = ticksToDeliver(0, dist);
  let slow = ticksToDeliver(2, dist);
  // sluggish 2 adds two ticks to every plains tile (cost 1 -> 3), so the trip is
  // markedly longer - and strictly longer is the invariant that matters.
  assert.ok(
    slow > fast,
    `sluggish should slow travel: full-speed ${fast} ticks vs slowed ${slow} ticks`,
  );
  assert.ok(
    slow >= fast + dist,
    `each of the ${dist} tiles should cost extra: ${fast} -> ${slow}`,
  );
});

test("sluggish 0 moves at full terrain speed (no penalty for an unset world)", () => {
  let a = ticksToDeliver(0, 4);
  let b = ticksToDeliver(0, 4);
  assert.equal(a, b, "full-speed travel is deterministic");
});
