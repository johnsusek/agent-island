// A scenario's mapSize replaces the world file's canvas: {1,1} plays as a
// room (no movement verbs), and a larger size gives a bigger map.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "@agent-island/engine/engine";
import { scenarioBootScenario } from "../packages/mcp/src/index.js";
import type { ScenarioFile } from "../packages/mcp/src/scenarios.js";
import type { Scenario } from "@agent-island/engine/scenario";

let base: Scenario = {
  name: "base",
  rules: [],
  spawn: { x: 0, y: 0 },
  worldgen: { width: 48, height: 48, seed: 3 },
};

function sized(width: number, height: number): ScenarioFile {
  return {
    name: "sized",
    include: [],
    overlay: {
      dynamicRules: [],
      removedBaseIds: [],
      defaultTerrain: "plains",
      terrainSpecs: { plains: { moveCost: 1 } },
      mapSize: { width, height },
    },
  } as ScenarioFile;
}

test("mapSize {1,1} boots a room with no movement verbs", () => {
  let scenario = sized(1, 1);
  let engine = createWorld(scenarioBootScenario(base, scenario), {
    requireStockIcons: false,
  });
  engine.applyOverlay(scenario.overlay);
  let ara = engine.addAgent("Ara").id;
  let sensed = engine.getObservation(ara) as {
    availableActions: { name: string }[];
  };
  let names = sensed.availableActions.map((a) => a.name);
  assert.ok(!names.includes("travel"), names.join(","));
  assert.ok(names.includes("give"));
});

test("a larger mapSize gives a larger grid than the world file", () => {
  let booted = scenarioBootScenario(base, sized(96, 80));
  assert.equal(booted.worldgen?.width, 96);
  assert.equal(booted.worldgen?.height, 80);
});
