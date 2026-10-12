import test from "node:test";
import { hasTag } from "@agent-island/core/kernel";
import assert from "node:assert/strict";

import type { WorldEngine } from "@agent-island/engine/engine";
import { makeSurvivalEngine, placeAt, TEST_SPAWN } from "./helpers.js";

function setAgentStock(
  engine: WorldEngine,
  id: string,
  name: string,
  value: number,
) {
  let snapshot = engine.snapshot();
  snapshot.world.entities[id].stocks[name].value = value;
  engine.restore(snapshot);
}

// Advance the world a bounded number of ticks, stopping early once `done` holds.
function tickUntil(engine: WorldEngine, done: () => boolean, safety = 60) {
  for (let i = 0; i < safety && !done(); i += 1) engine.tick();
}

function firstTokenPos(engine: WorldEngine, tag: string) {
  let snap = engine.snapshot();
  let token = Object.values(snap.world.entities).find(
    (e) => e.occupancy !== undefined && hasTag(e, tag) && e.pos,
  );
  if (!token?.pos) throw new Error(`no positioned token tagged "${tag}"`);
  return token.pos;
}

test("a give order from across the map walks to the target and hands off on arrival", () => {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  let receiver = engine.addAgent("Bo").id;
  setAgentStock(engine, giver, "food", 8);
  setAgentStock(engine, receiver, "food", 0);
  // Stand them well apart on the open spawn clearing.
  placeAt(engine, giver, TEST_SPAWN.x - 4, TEST_SPAWN.y);
  placeAt(engine, receiver, TEST_SPAWN.x + 4, TEST_SPAWN.y);

  let before = engine.cursor();
  let result = engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "food" }],
  });

  // The hand-off is deferred: no transfer yet, the giver is now travelling.
  assert.equal(result.order?.status, "running");
  assert.equal(engine.getObservation(giver).you.stocks.food.value, 8);
  assert.equal(engine.getObservation(receiver).you.stocks.food.value, 0);

  tickUntil(
    engine,
    () => engine.getObservation(receiver).you.stocks.food.value > 0,
  );

  // Once the giver reaches the receiver, the surplus actually moves.
  assert.equal(engine.getObservation(receiver).you.stocks.food.value, 8);
  assert.equal(engine.getObservation(giver).you.stocks.food.value, 0);
  let gave = engine.getEventsSince(before).find((e) => e.type === "given");
  assert.ok(gave, "a given event should fire on arrival");
});

test("a give order with an empty pack blocks immediately instead of walking", () => {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  engine.addAgent("Bo");
  setAgentStock(engine, giver, "food", 0);
  placeAt(engine, giver, TEST_SPAWN.x - 4, TEST_SPAWN.y);
  placeAt(engine, "bo", TEST_SPAWN.x + 4, TEST_SPAWN.y);

  let result = engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "food" }],
  });
  assert.equal(result.order?.status, "blocked");
  assert.match(result.order?.reason ?? "", /no food to give/i);
  // No approach was started.
  assert.equal(engine.getObservation(giver).you.action, null);
});

test("a chop order auto-approaches a tree it cannot yet reach", () => {
  let engine = makeSurvivalEngine();
  let chopper = engine.addAgent("Cyra").id;
  let tree = firstTokenPos(engine, "wood");
  // Stand two tiles off the tree - out of chop range - and let the character
  // perceive it, then order a chop and watch it close the gap on its own.
  placeAt(engine, chopper, tree.x + 2, tree.y);
  engine.tick(); // perceive surroundings from the new position

  let before = engine.cursor();
  engine.setOrder(chopper, { kind: "sequence", steps: [{ type: "chop" }] });
  tickUntil(engine, () =>
    engine.getEventsSince(before).some((e) => e.type === "chopped"),
  );

  let chopped = engine.getEventsSince(before).find((e) => e.type === "chopped");
  assert.ok(chopped, "the character should have walked over and chopped");
  let here = engine.getObservation(chopper).you.position;
  assert.ok(
    Math.max(Math.abs(here.x - tree.x), Math.abs(here.y - tree.y)) <= 1,
    "the character should end within chop range of the tree",
  );
});
