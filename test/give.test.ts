import test from "node:test";
import assert from "node:assert/strict";

import type { WorldEngine } from "../src/rules/engine.js";
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

function stockMax(engine: WorldEngine, id: string, name: string) {
  return engine.getObservation(id).you.stocks[name].max;
}

// Advance the world a bounded number of ticks, stopping early once `done` holds.
function tickUntil(engine: WorldEngine, done: () => boolean, safety = 60) {
  for (let i = 0; i < safety && !done(); i += 1) engine.tick();
}

test("characters give stockpilable resources on the same tile", () => {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  let receiver = engine.addAgent("Bo").id;
  setAgentStock(engine, giver, "food", 3);
  setAgentStock(engine, receiver, "food", 1);

  let before = engine.cursor();
  engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "food" }],
  });
  engine.tick();

  assert.equal(engine.getOrder(giver).order?.status, "completed");
  assert.equal(engine.getObservation(giver).you.stocks.food.value, 0);
  assert.equal(engine.getObservation(receiver).you.stocks.food.value, 4);
  assert.ok(engine.getEventsSince(before).some((e) => e.type === "given"));
});

test("giving respects inventory bounds and rejects personal gauges", () => {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  let receiver = engine.addAgent("Bo").id;
  setAgentStock(engine, giver, "food", 2);
  setAgentStock(
    engine,
    receiver,
    "food",
    stockMax(engine, receiver, "food") - 1,
  );

  // Only what fits in the receiver's pack moves; the rest stays carried.
  engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "food" }],
  });
  engine.tick();
  assert.equal(engine.getOrder(giver).order?.status, "completed");
  assert.equal(engine.getObservation(giver).you.stocks.food.value, 1);
  assert.equal(
    engine.getObservation(receiver).you.stocks.food.value,
    stockMax(engine, receiver, "food"),
  );

  // A personal gauge is not a stockpilable item, so the order can't start.
  let gauge = engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "health" }],
  });
  assert.equal(gauge.order?.status, "blocked");
  assert.match(gauge.order?.reason ?? "", /not a valid item/);
});

test("give is a durable order: it walks to the recipient and hands off", () => {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  let receiver = engine.addAgent("Bo").id;
  setAgentStock(engine, giver, "food", 8);
  setAgentStock(engine, receiver, "food", 0);
  placeAt(engine, giver, TEST_SPAWN.x - 4, TEST_SPAWN.y);
  placeAt(engine, receiver, TEST_SPAWN.x + 4, TEST_SPAWN.y);
  engine.tick(); // perceive surroundings from the new positions

  let before = engine.cursor();
  engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "food" }],
  });
  tickUntil(
    engine,
    () => engine.getObservation(receiver).you.stocks.food.value > 0,
  );

  // The whole surplus (above the floor) moves once the giver arrives.
  assert.equal(engine.getObservation(receiver).you.stocks.food.value, 8);
  assert.equal(engine.getObservation(giver).you.stocks.food.value, 0);
  assert.ok(
    engine.getEventsSince(before).some((e) => e.type === "given"),
    "a given event should fire on arrival",
  );
});

test("an adjacent give order hands off at once and completes", () => {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  let receiver = engine.addAgent("Bo").id;
  setAgentStock(engine, giver, "food", 5);
  setAgentStock(engine, receiver, "food", 1);
  placeAt(engine, giver, TEST_SPAWN.x, TEST_SPAWN.y);
  placeAt(engine, receiver, TEST_SPAWN.x + 1, TEST_SPAWN.y);

  engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "food" }],
  });
  engine.tick();

  assert.equal(engine.getObservation(receiver).you.stocks.food.value, 6);
  assert.equal(engine.getObservation(giver).you.stocks.food.value, 0);
  assert.equal(engine.getOrder(giver).order?.status, "completed");
});

test("give is advertised as an available action to a character carrying goods", () => {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  engine.addAgent("Bo");
  setAgentStock(engine, giver, "food", 3);

  let give = engine
    .getObservation(giver)
    .availableActions.find((a) => a.name === "give");
  assert.ok(give, "give should be listed");
  assert.equal(give.applicable, true);
});
