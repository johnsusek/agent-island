// Terrain registration: a TerrainSpec declares only ground - passability, move
// cost, and a map tint. The engine expands it at world creation and lets the GM
// register or replace kinds at runtime (registerTerrain), reconciling grid
// policy and replanning any route that crosses a changed kind. Terrain carries no
// per-tile stock of its own; anything harvestable lives on top as a token.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/rules/engine.js";
import { scenario } from "../src/rules/config.js";
import type { Scenario, TerrainSpec } from "../src/rules/scenario.js";

// Terrain placement rides the scenario now, not the world file, so these
// mechanism tests paint the forest/water they register against onto the shared
// canvas themselves rather than inheriting it from config/config.json.
const paintedWorldgen = {
  ...(scenario.worldgen ?? { width: 22, height: 22 }),
  defaultTerrain: "plains",
  blobs: [
    { terrain: "forest", density: 2, maxRadius: 2 },
    { terrain: "water", density: 0.7, maxRadius: 2 },
  ],
};

// The live scenario no longer declares any custom terrain, so these mechanism
// tests start from a bare base and register their own terrain in isolation.
const bareScenario: Scenario = {
  ...scenario,
  worldgen: paintedWorldgen,
  terrainSpecs: {},
};

const FOREST_SPEC: TerrainSpec = {
  passable: false,
  moveCost: 4,
  visual: { color: "#225533", icon: "pine-tree" },
};

function crossingRouteEngine() {
  let routeScenario: Scenario = {
    ...scenario,
    name: "terrain-route-test",
    rules: [],
    spawn: { x: 0, y: 1 },
    worldgen: {
      width: 5,
      height: 3,
      seed: 1,
      defaultTerrain: "plains",
    },
    terrainSpecs: { forest: {} },
  };
  let engine = createWorld(routeScenario);
  let { id: agentId } = engine.addAgent("Walker");
  let snapshot = engine.snapshot();
  snapshot.space.grid.tiles[1][2].terrain = "forest";
  snapshot.world.entities[agentId].pos = { x: 0, y: 1 };
  snapshot.world.entities[agentId].action = {
    type: "travel",
    args: {},
    startTick: 0,
    endTick: 99,
  };
  snapshot.space.moves = [
    [
      agentId,
      {
        path: [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 3, y: 1 },
          { x: 4, y: 1 },
        ],
        index: 0,
        progress: 0,
      },
    ],
  ];
  assert.equal(engine.restore(snapshot), true);
  return { engine, agentId };
}

test("omitted replacement fields restore terrain policy and visuals to defaults", () => {
  let engine = createWorld(bareScenario);
  engine.registerTerrain("forest", {
    passable: false,
    moveCost: 4,
    visual: { color: "#225533", icon: "pine-tree" },
  });
  let applied = engine.snapshot().space.grid;
  assert.ok(applied.impassable.includes("forest"));
  assert.deepEqual(applied.terrainCost, [["forest", 4]]);
  assert.deepEqual(engine.getAdminState().scenario.terrainVisuals.forest, {
    color: "#225533",
    icon: "pine-tree",
  });

  engine.registerTerrain("forest", {});

  let replaced = engine.snapshot().space.grid;
  assert.equal(replaced.impassable.includes("forest"), false);
  assert.equal(
    replaced.terrainCost.some(([name]) => name === "forest"),
    false,
  );
  assert.equal(
    engine.getAdminState().scenario.terrainVisuals.forest,
    undefined,
  );
});

test("a passability replacement replans an active route around the terrain", () => {
  let { engine, agentId } = crossingRouteEngine();

  engine.registerTerrain("forest", { passable: false });

  let snapshot = engine.snapshot();
  let move = new Map(snapshot.space.moves).get(agentId)!;
  assert.ok(
    move.path.every(
      (position) =>
        snapshot.space.grid.tiles[position.y][position.x].terrain !== "forest",
    ),
  );
  assert.ok(snapshot.space.grid.impassable.includes("forest"));
});

test("a movement-cost replacement replans the route and updates its ETA", () => {
  let { engine, agentId } = crossingRouteEngine();

  engine.registerTerrain("forest", { moveCost: 8 });

  let snapshot = engine.snapshot();
  let move = new Map(snapshot.space.moves).get(agentId)!;
  assert.ok(
    move.path.every(
      (position) =>
        snapshot.space.grid.tiles[position.y][position.x].terrain !== "forest",
    ),
  );
  assert.equal(snapshot.world.entities[agentId].action?.endTick, 4);
});

test("a GM-registered terrain rides the overlay and re-projects after reset", () => {
  let engine = createWorld(bareScenario);
  engine.registerTerrain("forest", FOREST_SPEC);

  let overlay = engine.getOverlay();
  assert.deepEqual(
    overlay.terrainSpecs?.forest,
    FOREST_SPEC,
    "the runtime spec is captured in the overlay",
  );

  engine.reset();
  assert.equal(
    engine.snapshot().space.grid.impassable.includes("forest"),
    false,
    "a bare reset drops runtime terrain policy",
  );
  engine.applyOverlay(overlay);
  assert.ok(
    engine.snapshot().space.grid.impassable.includes("forest"),
    "applying the overlay re-installs the terrain policy",
  );
});

test("overlay, reset, and snapshot round trips rebuild the same terrain behavior", () => {
  let engine = createWorld(bareScenario);
  engine.registerTerrain("forest", FOREST_SPEC);
  let overlay = engine.getOverlay();

  engine.reset();
  engine.applyOverlay(overlay);

  let resetSnapshot = engine.snapshot();
  assert.ok(resetSnapshot.space.grid.impassable.includes("forest"));
  assert.ok(
    resetSnapshot.space.grid.terrainCost.some(
      ([name, cost]) => name === "forest" && cost === 4,
    ),
  );
  assert.deepEqual(
    engine.getAdminState().scenario.terrainVisuals.forest,
    FOREST_SPEC.visual,
  );

  let restored = createWorld(bareScenario);
  assert.equal(restored.restore(resetSnapshot), true);
  assert.deepEqual(restored.getTerrainSpecs().forest, FOREST_SPEC);
  assert.deepEqual(
    restored.getAdminState().scenario.terrainVisuals.forest,
    FOREST_SPEC.visual,
  );
});

test("a scenario-declared terrainSpec is expanded at world creation", () => {
  let custom: Scenario = {
    ...scenario,
    worldgen: paintedWorldgen,
    terrainSpecs: { forest: FOREST_SPEC },
  };
  let engine = createWorld(custom);
  let grid = engine.snapshot().space.grid;
  assert.ok(
    grid.impassable.includes("forest"),
    "the declared policy is live without any runtime registration",
  );
  assert.ok(
    grid.terrainCost.some(([name, cost]) => name === "forest" && cost === 4),
  );
});
