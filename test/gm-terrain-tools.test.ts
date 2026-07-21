// The GM's terrain surface (Phase 4): register_terrain / set_terrain, plus
// set_stock_default's icon/color. Engine-level tests cover the mutations and their
// overlay persistence; a coordinator-level test covers GM gating and that the
// pass-throughs land the change and leave an audit trail.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/rules/engine.js";
import { createColony } from "../src/coordinator.js";
import { makeSurvivalEngine } from "./helpers.js";

const LAVA = {
  passable: false,
  visual: { color: "#ff6a00", icon: "lava" },
};

function adminScenario(engine: ReturnType<typeof createWorld>) {
  return engine.getAdminState().scenario as {
    terrainVisuals: Record<string, { color?: string; icon?: string }>;
    kindVisuals: Record<string, { color?: string; icon?: string }>;
  };
}

test("registerTerrain publishes the terrain's color/icon", () => {
  let engine = makeSurvivalEngine();
  engine.registerTerrain("lava", LAVA);
  let sc = adminScenario(engine);
  assert.deepEqual(sc.terrainVisuals.lava, { color: "#ff6a00", icon: "lava" });
});

// A minimal valid 16x16 token sprite (transparent corners).
const HEARTH_SPRITE = {
  size: [16, 16] as [number, number],
  kind: "token" as const,
  palette: { k: "#e8843a" },
  grid: [
    ".".repeat(16),
    ...Array(14).fill("." + "k".repeat(14) + "."),
    ".".repeat(16),
  ],
};

test("registerKindVisual publishes an inline sprite and persists it in the overlay", () => {
  let engine = makeSurvivalEngine();
  engine.registerKindVisual("hearth", {
    sprite: HEARTH_SPRITE,
    icon: "campfire",
    color: "#e8843a",
    label: "campfire",
  });

  let sc = adminScenario(engine);
  assert.deepEqual(sc.kindVisuals.hearth, {
    sprite: HEARTH_SPRITE,
    icon: "campfire",
    color: "#e8843a",
    label: "campfire",
  });
  assert.deepEqual(
    engine.getOverlay().kindVisuals?.hearth,
    sc.kindVisuals.hearth,
  );
});

test("registerKindVisual rejects a malformed inline sprite", () => {
  let engine = makeSurvivalEngine();
  assert.throws(
    () =>
      engine.registerKindVisual("hearth", {
        sprite: { ...HEARTH_SPRITE, grid: HEARTH_SPRITE.grid.slice(0, 3) },
      }),
    /grid is 16x3/,
  );
});

test("set_stock_default's icon/color land in the live kind registry and ride the overlay", () => {
  let engine = makeSurvivalEngine();
  engine.setStockDefault("spice", {
    value: 0,
    icon: "powder",
    color: "#c94f2a",
  });
  let sc = adminScenario(engine);
  assert.deepEqual(sc.kindVisuals.spice, { icon: "powder", color: "#c94f2a" });

  let overlay = engine.getOverlay();
  assert.deepEqual(overlay.kindVisuals?.spice, {
    icon: "powder",
    color: "#c94f2a",
  });

  // Survives a reset when the overlay is re-applied.
  engine.reset();
  assert.equal(
    adminScenario(engine).kindVisuals.spice,
    undefined,
    "bare reset clears it",
  );
  engine.applyOverlay(overlay);
  assert.deepEqual(
    adminScenario(engine).kindVisuals.spice,
    { icon: "powder", color: "#c94f2a" },
    "applying the overlay restores the GM's icon/color",
  );
});

test("terrain movement costs must be positive finite integers", () => {
  let engine = makeSurvivalEngine();
  for (let [index, moveCost] of [0, -1, 1.5, Infinity].entries())
    assert.throws(
      () => engine.registerTerrain(`bad-cost-${index}`, { moveCost }),
      /moveCost must be a finite integer of at least 1/,
    );
});

test("set_terrain rejects an unregistered terrain without changing the map", () => {
  let engine = makeSurvivalEngine();
  let plains = engine.getMap().tiles.find((tile) => tile.terrain === "plains")!;

  assert.throws(
    () => engine.setTerrainTiles([{ x: plains.x, y: plains.y }], "typo"),
    /Unknown terrain "typo"/,
  );
  assert.equal(
    engine
      .getMap()
      .tiles.find((tile) => tile.x === plains.x && tile.y === plains.y)
      ?.terrain,
    "plains",
  );
});

test("set_terrain paints a registered terrain onto tiles and bumps the map revision", () => {
  let engine = makeSurvivalEngine();
  engine.registerTerrain("meadow", { visual: { color: "#8ec06c" } });
  let plains = engine.getMap().tiles.find((t) => t.terrain === "plains")!;

  let revBefore = engine.terrainRevision();
  let { changed } = engine.setTerrainTiles(
    [{ x: plains.x, y: plains.y }],
    "meadow",
  );
  assert.equal(changed, 1);
  assert.equal(
    engine.getMap().tiles.find((t) => t.x === plains.x && t.y === plains.y)!
      .terrain,
    "meadow",
  );
  assert.ok(
    engine.terrainRevision() > revBefore,
    "a real paint bumps the map revision",
  );
});

test("painting registered impassable terrain reshapes passability", () => {
  let engine = makeSurvivalEngine();
  engine.registerTerrain("lava", LAVA);
  let plains = engine.getMap().tiles.find((t) => t.terrain === "plains")!;
  engine.setTerrainTiles([{ x: plains.x, y: plains.y }], "lava");
  assert.equal(
    engine.getMap().tiles.find((t) => t.x === plains.x && t.y === plains.y)!
      .terrain,
    "lava",
  );
  assert.ok(
    engine.snapshot().space.grid.impassable.includes("lava"),
    "the painted-in terrain is impassable",
  );
});

test("the GM terrain tools reject a session that has not taken the GM seat", () => {
  let colony = createColony();
  colony.connect("intruder");
  try {
    assert.throws(() => colony.gmRegisterTerrain("intruder", "lava", LAVA));
    assert.throws(() =>
      colony.gmSetTerrain("intruder", [{ x: 0, y: 0 }], "lava"),
    );
  } finally {
    colony.stop();
  }
});

test("a GM registers and paints terrain, and it shows in the world and the audit log", () => {
  let colony = createColony({ waitTimeoutMs: 500 });
  colony.start();
  colony.connect("gm");
  try {
    colony.joinAsGm("gm");
    colony.gmRegisterTerrain("gm", "lava", LAVA);

    let payload = colony.getAdminPayload();
    assert.equal(payload.state.scenario.terrainVisuals.lava.color, "#ff6a00");
    assert.ok(
      payload.gmEventLog.some((e: any) => e.kind === "terrain_registered"),
      "registering leaves a GM audit event",
    );

    let plains = colony
      .getMapPayload()
      .map.tiles.find((t: any) => t.terrain === "plains")!;
    let result = colony.gmSetTerrain(
      "gm",
      [{ x: plains.x, y: plains.y }],
      "lava",
    );
    assert.equal(result.changed, 1);
    assert.equal(
      colony
        .getMapPayload()
        .map.tiles.find((t: any) => t.x === plains.x && t.y === plains.y)!
        .terrain,
      "lava",
      "the painted tile is now lava on the map the dashboard reads",
    );
    assert.ok(
      colony
        .getAdminPayload()
        .gmEventLog.some((e: any) => e.kind === "terrain_painted"),
      "painting leaves a GM audit event",
    );
  } finally {
    colony.stop();
  }
});

// A token sunk in ground nobody can walk onto is reachable only from an
// adjacent bank and can never be stood or built on - almost always a slip.
test("spawning onto impassable terrain is refused unless allowed", () => {
  let engine = makeSurvivalEngine();
  engine.registerTerrain("lava", LAVA);
  let plains = engine.getMap().tiles.find((t) => t.terrain === "plains")!;
  engine.setTerrainTiles([{ x: plains.x, y: plains.y }], "lava");

  assert.throws(
    () =>
      engine.spawnEntity({
        id: "sunken-crate",
        tags: ["token"],
        pos: { x: plains.x, y: plains.y },
      }),
    /lava/,
  );

  let { entity } = engine.spawnEntity({
    id: "lava-shrine",
    tags: ["token"],
    pos: { x: plains.x, y: plains.y },
    allowImpassable: true,
  });
  assert.deepEqual(entity.pos, { x: plains.x, y: plains.y });
});
