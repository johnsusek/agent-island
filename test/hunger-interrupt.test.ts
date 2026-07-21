import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { WorldEngine } from "../src/rules/engine.js";
import { resolveIncludes, rulesetsDirFor } from "../src/scenarios.js";
import { makeSurvivalEngine, placeAt, TEST_SPAWN } from "./helpers.js";

// Advance the world a bounded number of ticks, stopping early once `done` holds.
function tickUntil(engine: WorldEngine, done: () => boolean, safety = 30) {
  for (let i = 0; i < safety && !done(); i += 1) engine.tick();
}

// Prime an agent one flow-tick below the starving line, so the next tick's
// hunger rise is the fresh crossing that fires the watch alarm.
function primeStarving(engine: WorldEngine, id: string) {
  engine.setStock(id, "food", 5);
  engine.setStock(id, "hunger", 99.95);
}

// Order a trip long enough to still be in flight when the alarm fires: walk the
// scattered tokens outward from spawn (at least 6 tiles away) and take the
// first one the pathfinder accepts, so a token stranded behind water on some
// seed cannot flake the test.
function orderLongTravel(engine: WorldEngine, id: string) {
  let tokens = engine
    .snapshot()
    .space.grid.tokens.map((t) => ({
      name: t.name,
      dist: Math.max(
        Math.abs(t.x - TEST_SPAWN.x),
        Math.abs(t.y - TEST_SPAWN.y),
      ),
    }))
    .filter((t) => t.dist >= 6)
    .sort((a, b) => a.dist - b.dist);
  for (let target of tokens) {
    engine.setOrder(id, {
      kind: "sequence",
      steps: [{ type: "travel", location: target.name }],
    });
    if (engine.getOrder(id).order?.status === "running") return;
  }
  throw new Error("no reachable travel target found for the test");
}

test("the starving alarm interrupts a busy character and stops their walk", () => {
  let engine = makeSurvivalEngine();
  let id = engine.addAgent("Ara").id;
  placeAt(engine, id, TEST_SPAWN.x, TEST_SPAWN.y);
  primeStarving(engine, id);
  orderLongTravel(engine, id);
  assert.ok(
    engine.getObservation(id).you.action,
    "the trip should be in flight",
  );

  let before = engine.cursor();
  tickUntil(engine, () => engine.getOrder(id).order?.status !== "running");

  let order = engine.getOrder(id).order;
  assert.equal(order?.status, "interrupted");
  assert.match(order?.reason ?? "", /starving/);
  assert.ok(
    !engine.getObservation(id).you.action,
    "the walk should be dropped",
  );
  let types = engine.getEventsSince(before).map((e) => e.type);
  assert.ok(types.includes("starving"));
  assert.ok(types.includes("action_abandoned"));
  assert.ok(types.includes("order_interrupted"));
});

test("the alarm against an idle character wakes without an order to interrupt", () => {
  let engine = makeSurvivalEngine();
  let id = engine.addAgent("Bo").id;
  primeStarving(engine, id);

  let before = engine.cursor();
  engine.tick();

  let events = engine.getEventsSince(before);
  let alarm = events.find((e) => e.type === "starving");
  assert.ok(alarm, "the alarm should still fire");
  assert.notEqual(alarm?.wake, "routine");
  assert.ok(!events.some((e) => e.type === "order_interrupted"));
  assert.ok(!events.some((e) => e.type === "action_abandoned"));
});

test("the latched alarm spares the recovery order and re-arms after eating", () => {
  let engine = makeSurvivalEngine();
  let id = engine.addAgent("Cim").id;
  placeAt(engine, id, TEST_SPAWN.x, TEST_SPAWN.y);
  primeStarving(engine, id);
  engine.tick();
  assert.ok(engine.getObservation(id).you.stocks.hunger.value >= 100 - 1e-9);

  // Recovery while still starving: the latched alarm must not re-trip.
  engine.setOrder(id, { kind: "sequence", steps: [{ type: "eat" }] });
  tickUntil(engine, () => engine.getOrder(id).order?.status !== "running");
  assert.equal(engine.getOrder(id).order?.status, "completed");
  assert.ok(engine.getObservation(id).you.stocks.hunger.value < 100);

  // Back below the line, the alarm re-arms and fires on the next crossing.
  primeStarving(engine, id);
  orderLongTravel(engine, id);
  tickUntil(engine, () => engine.getOrder(id).order?.status !== "running");
  assert.equal(engine.getOrder(id).order?.status, "interrupted");
  assert.match(engine.getOrder(id).order?.reason ?? "", /starving/);
});

test("the shipped packs mark their needs alarms as interrupting", () => {
  let packs: [string, string[]][] = [
    ["survival", ["starving", "parched", "critical"]],
  ];
  for (let [pack, ids] of packs) {
    let parsed = JSON.parse(
      readFileSync(path.resolve(`config/scenarios/${pack}.json`), "utf8"),
    );
    // Resolve includes: the needs alarms (starving/critical) now ride the shared
    // `metabolism` ruleset, so search the composed overlay, not just the inline rules.
    let overlay = resolveIncludes(
      parsed,
      rulesetsDirFor(path.resolve("config/scenarios")),
    );
    for (let ruleId of ids) {
      let rule = overlay.dynamicRules.find((r) => r.id === ruleId) as
        { id: string; emit?: { interrupt?: string } } | undefined;
      assert.ok(
        rule?.emit?.interrupt,
        `${pack}:${ruleId} alarm should stop hands`,
      );
    }
  }
});
