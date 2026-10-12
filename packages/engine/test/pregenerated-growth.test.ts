// growWorld against a pregenerated map (see scripts/generate-map.ts and
// copyPregeneratedFrontier in packages/core/src/space.ts): growth reveals tiles that
// already exist instead of generating new ones. The payoff over live
// extendTerrain is that grid-scoped layer kinds (blobs, island, maze) survive
// onto a grown frontier - extendTerrain's paintLayer explicitly skips them
// (space.ts's `only` guard), so a live-grown frontier is flat fill even where
// the map recipe says there should be a forest patch. A pregenerated frontier
// has no such gap: it was baked once, over the whole extent, before anyone
// ever walked there.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/engine.js";
import {
  makeSpace,
  paintedTiles,
  pregeneratedRoom,
  pregeneratedTerrainAt,
} from "@agent-island/core/space";
import type { PregeneratedMap, Terrain, Tile } from "@agent-island/core/space";
import type { Scenario } from "../src/scenario.js";

// Encode a freshly painted Tile[][] as a PregeneratedMap, origin pinned at
// (0,0) so its coordinates line up 1:1 with a live grid's starting window.
function encodePregen(
  tiles: Tile[][],
  seed: number,
  origin = { x: 0, y: 0 },
): PregeneratedMap {
  let legend: Record<string, Terrain> = {};
  let charOf = new Map<Terrain, string>();
  let pool = "pwfxyz0123456789abcdeghijklmnoqrstuv";
  for (let row of tiles)
    for (let tile of row)
      if (!charOf.has(tile.terrain)) {
        let char = [...pool].find((c) => !legend[c]);
        if (!char) throw new Error("legend pool exhausted");
        legend[char] = tile.terrain;
        charOf.set(tile.terrain, char);
      }
  return {
    width: tiles[0].length,
    height: tiles.length,
    origin,
    seed,
    legend,
    rows: tiles.map((row) => row.map((t) => charOf.get(t.terrain)!).join("")),
  };
}

// A blob layer on top of a plains fill: grid-scoped (its count/placement
// depend on width*height and local RNG rolls), so it's exactly the kind of
// layer live frontier growth (extendTerrain) cannot continue - the ground
// truth this whole suite is checking against.
function paintFullMap(width: number, height: number, seed: number) {
  let gen = {
    width,
    height,
    seed,
    defaultTerrain: "plains",
    terrainLayers: [
      { terrain: "forest", gen: { blobs: { density: 40, maxRadius: 3 } } },
    ],
  };
  return paintedTiles(gen, width, height, "plains");
}

test("makeSpace slices the initial window from a pregenerated map, verbatim", () => {
  let fullTiles = paintFullMap(40, 40, 7);
  let map = encodePregen(fullTiles, 7);
  // Sanity: this recipe actually paints some forest, or the test proves nothing.
  assert.ok(
    fullTiles.some((row) => row.some((t) => t.terrain === "forest")),
    "test fixture should contain forest",
  );

  let space = makeSpace({ x: 5, y: 5 }, { width: 12, height: 12 }, map);
  for (let y = 0; y < 12; y += 1)
    for (let x = 0; x < 12; x += 1)
      assert.equal(
        space.grid.tiles[y][x].terrain,
        fullTiles[y][x].terrain,
        `(${x},${y}) matches the pregenerated source`,
      );
});

// A world with an `expand` lever a transition rule consumes to grow east,
// mirroring frontierScenario() in grow-world-effect.test.ts but wired to a
// pregenerated map instead of live terrainLayers.
function pregenScenario(map: PregeneratedMap): Scenario {
  return {
    name: "pregen-demo",
    spawn: { x: 2, y: 2 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    worldgen: { width: 8, height: 8, seed: 7, defaultTerrain: "plains" },
    pregeneratedMap: map,
    rules: [
      {
        id: "expand",
        phase: "transition",
        each: { tag: "world" },
        when: { cmp: "gte", left: { stock: "expand" }, right: 1 },
        do: [
          { set: { target: "expand", to: 0 } },
          { growWorld: { by: 6, direction: "east" } },
        ],
      },
    ],
  };
}

test("growWorld reveals pregenerated tiles, blobs included, with no RNG call", () => {
  let fullTiles = paintFullMap(40, 40, 7);
  let map = encodePregen(fullTiles, 7);

  // Find a forest tile just past the starting 8-wide window's east edge
  // (x in [8, 14)) so growth-by-6 is guaranteed to reach it.
  let target: { x: number; y: number } | undefined;
  for (let y = 0; y < 8 && !target; y += 1)
    for (let x = 8; x < 14 && !target; x += 1)
      if (fullTiles[y][x].terrain === "forest") target = { x, y };
  assert.ok(target, "fixture should have a forest tile just past the frontier");

  let engine = createWorld(pregenScenario(map));
  engine.addAgent("Ara");
  engine.setStock("world", "expand", 1, { min: 0, max: 9 }, { icon: "expand" });
  engine.tick();

  let revealed = engine
    .getMap()
    .tiles.find((t) => t.x === target!.x && t.y === target!.y);
  assert.ok(revealed, "the grown tile exists");
  assert.equal(
    revealed!.terrain,
    "forest",
    "the revealed tile is the pregenerated forest, not flat fill",
  );

  // Every revealed tile - not just the forest one - is a verbatim copy of
  // the pregenerated source, over the whole grown rectangle.
  let map2 = engine.getMap();
  for (let y = 0; y < 8; y += 1)
    for (let x = 8; x < 14; x += 1) {
      let tile = map2.tiles.find((t) => t.x === x && t.y === y);
      assert.equal(tile?.terrain, fullTiles[y][x].terrain, `(${x},${y})`);
    }

  let gm = engine.recentGmEvents().find((e) => e.kind === "world_grew");
  assert.ok(gm, "a world_grew event was logged");
  assert.equal((gm!.detail as { clamped?: boolean }).clamped, undefined);
});

test("growWorld clamps to the pregenerated map's own extent", () => {
  let fullTiles = paintFullMap(40, 40, 7);
  // A small pregenerated map: only 2 tiles of room east of the 8-wide start.
  let map = encodePregen(
    fullTiles.slice(0, 8).map((row) => row.slice(0, 10)),
    7,
  );

  let engine = createWorld(pregenScenario(map));
  engine.addAgent("Ara");
  engine.setStock("world", "expand", 1, { min: 0, max: 9 }, { icon: "expand" });
  engine.tick();

  let mapState = engine.getMap();
  assert.equal(
    mapState.width,
    10,
    "grew only the 2 tiles the pregenerated map had",
  );
  let gm = engine.recentGmEvents().find((e) => e.kind === "world_grew");
  assert.equal((gm!.detail as { clamped?: boolean }).clamped, true);
});

test("pregeneratedRoom reports remaining space in each direction", () => {
  let fullTiles = paintFullMap(20, 20, 3);
  let map = encodePregen(fullTiles, 3, { x: -5, y: -5 });
  let space = makeSpace({ x: 0, y: 0 }, { width: 6, height: 6 }, map);

  // Grid spans world [0,6); map spans world [-5,15).
  assert.deepEqual(pregeneratedRoom(space.grid, map), {
    north: 5,
    west: 5,
    east: 9,
    south: 9,
  });
});

test("pregeneratedTerrainAt returns undefined past the map's extent", () => {
  let fullTiles = paintFullMap(10, 10, 1);
  let map = encodePregen(fullTiles, 1);
  assert.equal(pregeneratedTerrainAt(map, -1, 0), undefined);
  assert.equal(pregeneratedTerrainAt(map, 0, 10), undefined);
  assert.equal(typeof pregeneratedTerrainAt(map, 0, 0), "string");
});
