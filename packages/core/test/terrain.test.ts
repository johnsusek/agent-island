// Terrain-aware conditions: the `nearTerrain` gate reads the host's map grid
// (installed as a TerrainLookup for the kernel call) rather than an entity, so a
// character can act when standing on — or within `range` tiles of — a given
// terrain. The motivating case is drinking beside impassable water.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commit,
  actionApplicable,
  actionUnavailableReason,
  stock,
  type Rule,
  type KernelWorld,
  type TerrainLookup,
} from "../src/kernel.js";

const drinkAtWater: Rule = {
  id: "drink_water_tile",
  kind: "action",
  duration: 1,
  params: [],
  requires: { nearTerrain: { type: "water", range: 1 } },
  requireReason: "must be on or beside open water",
  do: [{ adjust: { target: "thirst", by: -50 } }],
  emit: { type: "drank" },
};

function world(): KernelWorld {
  return {
    tick: 0,
    entities: {
      world: { id: "world", tags: ["world"], stocks: {} },
      ada: {
        id: "ada",
        tags: ["agent"],
        stocks: { thirst: stock(80, 0, 100) },
        pos: { x: 5, y: 5 },
        action: null,
      },
    },
  };
}

// Everything is plains except the one tile this returns "water" for.
const waterAt =
  (wx: number, wy: number): TerrainLookup =>
  (x, y) =>
    x === wx && y === wy ? "water" : "plains";

test("nearTerrain matches an adjacent tile (range 1)", () => {
  // Water one tile east of the actor at (5,5).
  assert.equal(
    actionApplicable(
      world(),
      [drinkAtWater],
      "ada",
      "drink_water_tile",
      {},
      waterAt(6, 5),
    ),
    true,
  );
  let r = commit(
    world(),
    [drinkAtWater],
    "ada",
    "drink_water_tile",
    {},
    waterAt(6, 5),
  );
  assert.equal(r.ok, true);
});

test("nearTerrain matches the actor's own tile too", () => {
  assert.equal(
    actionApplicable(
      world(),
      [drinkAtWater],
      "ada",
      "drink_water_tile",
      {},
      waterAt(5, 5),
    ),
    true,
  );
});

test("nearTerrain rejects terrain beyond range", () => {
  // Water three tiles away — outside the range-1 box.
  assert.equal(
    actionApplicable(
      world(),
      [drinkAtWater],
      "ada",
      "drink_water_tile",
      {},
      waterAt(8, 5),
    ),
    false,
  );
  assert.equal(
    actionUnavailableReason(
      world(),
      [drinkAtWater],
      "ada",
      "drink_water_tile",
      {},
      waterAt(8, 5),
    ),
    "must be on or beside open water",
  );
});

test("nearTerrain throws when no terrain lookup is installed", () => {
  // A rule that reads terrain but a host that never wired one is an authoring/
  // wiring bug, surfaced loudly rather than silently passing or failing the gate.
  assert.throws(
    () =>
      actionApplicable(world(), [drinkAtWater], "ada", "drink_water_tile", {}),
    /terrain lookup/,
  );
});
