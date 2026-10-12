// A one-tile world is a single room: everyone shares the tile, so speech and
// reach already work, and the movement verbs and sight grid are left out.
// Also covers give's optional amount, which the commons playtest needed (Ara
// meant to hand over one fish and gave both).

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/engine.js";
import type { Scenario } from "../src/scenario.js";

function roomScenario(width = 1, height = 1): Scenario {
  return {
    name: "room",
    spawn: { x: 0, y: 0 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    worldgen: { width, height, seed: 1, defaultTerrain: "plains" },
    rules: [],
  };
}

// A room whose characters each carry 4 of a 6-fish basket. Fish is registered
// as a carried (pack) resource, which is what give hands over.
function fishingRoom() {
  let engine = createWorld(roomScenario());
  engine.setStockDefault("fish", {
    value: 4,
    min: 0,
    max: 6,
    role: "pack",
    icon: "fish-bucket",
  });
  return engine;
}

function actionNames(engine: ReturnType<typeof createWorld>, id: string) {
  return engine.getObservation(id).availableActions.map((a: any) => a.name);
}

test("a one-tile world is a room: no movement verbs and no sight grid", () => {
  let engine = createWorld(roomScenario());
  let ara = engine.addAgent("Ara").id;
  engine.addAgent("Bo");

  let names = actionNames(engine, ara);
  for (let verb of ["travel", "explore", "scan"])
    assert.ok(!names.includes(verb), `${verb} is not offered in a room`);
  assert.ok(names.includes("give"), "non-spatial verbs stay");
  assert.equal("grid" in engine.getObservation(ara), false);
  assert.equal("grid" in engine.sense(ara, "situation"), false);

  let wider = createWorld(roomScenario(3, 3));
  let cy = wider.addAgent("Cy").id;
  assert.ok(actionNames(wider, cy).includes("explore"), "a 3x3 world is not");
  assert.ok("grid" in wider.getObservation(cy));
});

test("moving in a room is refused in plain words", () => {
  let engine = createWorld(roomScenario());
  let ara = engine.addAgent("Ara").id;
  assert.throws(
    () => engine.commitIntent(ara, { type: "explore", direction: "north" }),
    /nowhere to go: this world is a single place/,
  );
});

test("everyone in a room hears everyone", () => {
  let engine = createWorld(roomScenario());
  let ara = engine.addAgent("Ara").id;
  engine.addAgent("Bo");
  engine.addAgent("Cy");
  let spoke = engine.speak(ara, "Hello, all.") as { heardBy: string[] };
  assert.deepEqual([...spoke.heardBy].sort(), ["Bo", "Cy"]);
});

test("growing a room into a map brings movement back", () => {
  let engine = createWorld({
    ...roomScenario(),
    rules: [
      {
        id: "open-the-doors",
        phase: "transition",
        each: { tag: "world" },
        when: { cmp: "gte", left: { tick: true }, right: 1 },
        do: [{ growWorld: { by: 2, direction: "east" } }],
      },
    ],
  });
  let ara = engine.addAgent("Ara").id;
  assert.ok(!actionNames(engine, ara).includes("explore"));
  engine.tick();
  assert.ok(actionNames(engine, ara).includes("explore"));
});

test("give hands over exactly the amount named", () => {
  let engine = fishingRoom();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;

  // Models often send numbers as text; "1" is accepted as 1.
  engine.commitIntent(ara, {
    type: "give",
    target: "Bo",
    item: "fish",
    amount: "1",
  });
  assert.equal(engine.getObservation(ara).you.stocks.fish.value, 3);
  assert.equal(engine.getObservation(bo).you.stocks.fish.value, 5);

  // No amount keeps the old meaning: as much as the receiver can hold.
  engine.commitIntent(ara, { type: "give", target: "Bo", item: "fish" });
  assert.equal(engine.getObservation(bo).you.stocks.fish.value, 6);
  assert.equal(engine.getObservation(ara).you.stocks.fish.value, 2);
});

test("give refuses an amount that is not a positive whole number", () => {
  let engine = fishingRoom();
  let ara = engine.addAgent("Ara").id;
  engine.addAgent("Bo");
  for (let [amount, reason] of [
    [0, /at least 1/],
    [1.5, /whole number/],
    ["lots", /must be a number/],
  ] as const)
    assert.throws(
      () =>
        engine.commitIntent(ara, {
          type: "give",
          target: "Bo",
          item: "fish",
          amount,
        }),
      reason,
    );
});

test("give's amount is advertised on every look, not just the first", () => {
  let engine = fishingRoom();
  let ara = engine.addAgent("Ara").id;
  engine.addAgent("Bo");
  // A later, slimmed observation (no action details) still carries it.
  let give = engine
    .getObservation(ara, engine.currentTick(), false)
    .availableActions.find((a: any) => a.name === "give");
  assert.ok(give?.params, "give is offered with its params");
  assert.deepEqual(
    give.params.map((p) => [p.name, p.type]),
    [["amount", "number"]],
  );
});
