// The commons example (examples/commons) booted the way a library user would:
// from its own world file and scenarios folder, through package APIs only.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createWorld } from "@agent-island/engine/engine";

import {
  createColony,
  createScenarioStore,
  renderWake,
  scenarioBootScenario,
  scenarioFromWorldFile,
} from "../src/index.js";

let dir = new URL("../examples/commons/", import.meta.url).pathname;
let base = scenarioFromWorldFile(
  JSON.parse(readFileSync(`${dir}world.json`, "utf8")),
  "world.json",
);
let commons = createScenarioStore(`${dir}scenarios`, `${dir}scenarios`).load(
  "commons",
);

test("a character in the commons sees the bay and can fish and eat", async () => {
  let colony = createColony({
    baseScenario: base,
    scenariosDir: `${dir}scenarios`,
    scenarios: ["commons"],
    waitTimeoutMs: 2000,
  });
  colony.start();
  colony.connect("a");
  try {
    let joined = colony.join("a", "Ara");
    assert.match(
      renderWake(joined),
      /The world holds: fish in the bay 30\/40\./,
      "the shared stock is in the character's own prose",
    );

    colony.act("a", { type: "fish" });
    let change = await colony.waitForChange("a");
    while (change.observation.you.action)
      change = await colony.waitForChange("a");
    assert.equal(change.observation.you.stocks.fish.value, 2);

    colony.act("a", { type: "eat" });
    change = await colony.waitForChange("a");
    while (change.observation.you.action)
      change = await colony.waitForChange("a");
    assert.equal(change.observation.you.stocks.fish.value, 1);
  } finally {
    colony.stop();
  }
});

// Drive four villagers for a whole season with a fixed policy, straight on the
// engine: each idle villager picks its next action from what it can see.
function season(policy: (v: { sat: number; fish: number }) => string | null) {
  let engine = createWorld(scenarioBootScenario(base, commons));
  engine.applyOverlay(commons.overlay);
  let ids = ["Ara", "Bo", "Cy", "Di"].map((name) => {
    engine.addAgent(name);
    return name.toLowerCase();
  });
  for (let tick = 0; tick < 305; tick += 1) {
    let entities = engine.getEntities() as Record<string, any>;
    for (let id of ids) {
      let villager = entities[id];
      if (!villager.tags.includes("agent") || villager.action) continue;
      let pick = policy({
        sat: villager.stocks.satiation.value,
        fish: villager.stocks.fish.value,
      });
      if (pick)
        try {
          engine.commitIntent(id, { type: pick });
        } catch {
          // the bay is empty: nothing to do but wait
        }
    }
    engine.tick();
  }
  let entities = engine.getEntities() as Record<string, any>;
  return {
    alive: ids.filter((id) => entities[id].tags.includes("agent")).length,
    bay: entities.world.stocks.school.value,
    events: engine.recentEvents(5000).map((event: any) => event.type),
  };
}

// Hoarding is a one-time grab, but it drags the bay below the level where it
// can regrow as fast as the village eats, and an empty bay never comes back.
test("keeping a full basket empties the bay for good and starves the village", () => {
  let result = season(({ sat, fish }) =>
    sat < 60 && fish > 0 ? "eat" : "fish",
  );
  assert.equal(result.bay, 0, "the collapse is final");
  assert.ok(result.events.includes("collapse"));
  assert.equal(result.alive, 0);
  assert.ok(!result.events.includes("victory"));
});

test("fishing only when hungry keeps the bay alive and wins the season", () => {
  let result = season(({ sat, fish }) =>
    sat < 60 ? (fish > 0 ? "eat" : "fish") : null,
  );
  assert.ok(result.bay > 10, `the bay holds ${result.bay}`);
  assert.equal(result.alive, 4);
  assert.ok(result.events.includes("victory"));
});
