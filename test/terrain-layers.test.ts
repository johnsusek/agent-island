// The layered terrain recipe: a WorldGen's terrainLayers stack paints ordered
// generator passes (fill / island / maze / noise / blobs) over the base fill,
// each optionally masked to the terrains it may overwrite, with per-layer seed
// streams so tuning one layer never reshuffles another, and an optional
// connect pass that carves corridors until every passable tile is reachable.
// The legacy defaultTerrain+blobs recipe must keep producing byte-identical
// maps - the golden test pins that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertValidConnect,
  assertValidTerrainLayers,
  expandWorldGen,
  makeSpace,
  paintedTiles,
  pickSpawn,
  type Tile,
  type WorldGen,
} from "@agent-island/core/space";
import { scenario } from "../src/config.js";
import { scenarioBootScenario } from "../src/coordinator-scenarios.js";
import { createWorld } from "@agent-island/engine/engine";
import { createScenarioStore, type ScenarioFile } from "../src/scenarios.js";

function rows(tiles: Tile[][], letters: Record<string, string>): string[] {
  return tiles.map((row) =>
    row.map((tile) => letters[tile.terrain] ?? "?").join(""),
  );
}

function terrainSet(tiles: Tile[][], terrain: string): Set<string> {
  let out = new Set<string>();
  tiles.forEach((row, y) =>
    row.forEach((tile, x) => {
      if (tile.terrain === terrain) out.add(`${x},${y}`);
    }),
  );
  return out;
}

// Count 8-direction connected components of passable tiles - the same
// adjacency movement uses, so one component means everywhere is walkable.
function passableComponents(tiles: Tile[][], impassable: Set<string>): number {
  let height = tiles.length;
  let width = tiles[0].length;
  let seen = new Set<string>();
  let open = (x: number, y: number) =>
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < height &&
    !impassable.has(tiles[y][x].terrain);
  let count = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (!open(x, y) || seen.has(`${x},${y}`)) continue;
      count += 1;
      let queue = [{ x, y }];
      seen.add(`${x},${y}`);
      while (queue.length > 0) {
        let current = queue.pop()!;
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            let nx = current.x + dx;
            let ny = current.y + dy;
            if (open(nx, ny) && !seen.has(`${nx},${ny}`)) {
              seen.add(`${nx},${ny}`);
              queue.push({ x: nx, y: ny });
            }
          }
      }
    }
  return count;
}

// --- Legacy back-compat ---------------------------------------------------

test("the legacy blobs recipe still paints the exact same map", () => {
  // Golden fixture captured from the pre-layers painter: same gen, same seed,
  // same rows, same scattered tokens, same spawn. If this test moves, existing
  // scenario maps changed under their authors' feet.
  let gen: WorldGen = {
    width: 21,
    height: 21,
    seed: 7,
    defaultTerrain: "plains",
    blobs: [
      { terrain: "forest", density: 2, maxRadius: 2 },
      { terrain: "water", density: 0.7, maxRadius: 2 },
    ],
    impassable: ["water"],
    tokenScatter: [
      {
        namePrefix: "grove",
        tags: ["wood"],
        occupancy: "tile",
        count: 4,
        onTerrain: ["forest"],
        minSpacing: 2,
        stocks: { wood: { value: [10, 20] } },
      },
    ],
  };
  let spawn = pickSpawn(gen);
  assert.deepEqual(spawn, { x: 16, y: 18 });
  let expanded = expandWorldGen(gen, spawn);
  let space = makeSpace(spawn, expanded);
  assert.deepEqual(
    rows(space.grid.tiles, { plains: ".", forest: "f", water: "w" }),
    [
      "fff..........wwwww...",
      "fff..........wwwww...",
      "fff..........wwwww...",
      "fff....fffff.wwwwfff.",
      ".fffffffffff..ffffff.",
      ".fffffffffff..ffffff.",
      ".fffffffffff..fff....",
      ".fffffffffff.........",
      ".fffffffff...........",
      ".............fffff...",
      ".............fffff...",
      ".........wwwwfffffwww",
      ".........wwwww....www",
      ".........wwwww....www",
      ".........wwwww....www",
      ".........wwwww....www",
      ".....................",
      ".....................",
      ".....................",
      ".....fff.............",
      ".....fff.............",
    ],
  );
  assert.deepEqual(
    expanded.tokens?.map((t) => [t.x, t.y, t.stocks?.wood.value]),
    [
      [16, 5, 11],
      [16, 11, 14],
      [4, 6, 15],
      [13, 10, 18],
    ],
  );
});

// --- The layer stack ------------------------------------------------------

test("a layer stack paints deterministically for a given seed", () => {
  let gen: WorldGen = {
    width: 21,
    height: 21,
    seed: 11,
    defaultTerrain: "water",
    terrainLayers: [
      { terrain: "grass", gen: { island: { size: 0.7, roughness: 0.3 } } },
      {
        terrain: "forest",
        gen: { noise: { scale: 4, above: 0.55 } },
        where: { on: ["grass"] },
      },
    ],
  };
  let first = rows(paintedTiles(gen, 21, 21, "water"), {});
  let second = rows(paintedTiles(gen, 21, 21, "water"), {});
  assert.deepEqual(first, second);
});

test("an island rises from the fill: land at the center, sea at the corners", () => {
  let gen: WorldGen = {
    width: 21,
    height: 21,
    seed: 7,
    defaultTerrain: "water",
    terrainLayers: [
      { terrain: "grass", gen: { island: { size: 0.7, roughness: 0.3 } } },
    ],
  };
  let tiles = paintedTiles(gen, 21, 21, "water");
  assert.equal(tiles[10][10].terrain, "grass");
  for (let [x, y] of [
    [0, 0],
    [20, 0],
    [0, 20],
    [20, 20],
  ])
    assert.equal(tiles[y][x].terrain, "water", `corner ${x},${y} stays sea`);
  let grass = terrainSet(tiles, "grass");
  assert.ok(grass.size > 40, "a real landmass, not a dot");
  assert.ok(grass.size < 21 * 21, "not a flood");
});

test("a where.on mask confines a layer: the maze stands only on the island", () => {
  let islandOnly: WorldGen = {
    width: 21,
    height: 21,
    seed: 7,
    defaultTerrain: "water",
    terrainLayers: [
      { terrain: "grass", gen: { island: { size: 0.75, roughness: 0.3 } } },
    ],
  };
  let withMaze: WorldGen = {
    ...islandOnly,
    terrainLayers: [
      ...islandOnly.terrainLayers!,
      { terrain: "rock", gen: "maze", where: { on: ["grass"] } },
    ],
  };
  let island = paintedTiles(islandOnly, 21, 21, "water");
  let maze = paintedTiles(withMaze, 21, 21, "water");

  let rock = terrainSet(maze, "rock");
  assert.ok(rock.size > 0, "the maze painted walls");
  // Every wall stands where the island-only paint put grass - never on water.
  // This also proves per-layer seed streams: adding the maze layer did not
  // reshuffle what the island layer drew.
  let wasGrass = terrainSet(island, "grass");
  for (let key of rock)
    assert.ok(wasGrass.has(key), `wall at ${key} stands on the island`);
  assert.deepEqual(terrainSet(maze, "water"), terrainSet(island, "water"));
});

test("a maze layer carves corridors between its walls", () => {
  let gen: WorldGen = {
    width: 21,
    height: 21,
    seed: 3,
    defaultTerrain: "floor",
    terrainLayers: [{ terrain: "wall", gen: "maze" }],
    impassable: ["wall"],
  };
  let tiles = paintedTiles(gen, 21, 21, "floor");
  // Cell passages sit on the odd lattice; (1,1) is always a carved cell.
  assert.equal(tiles[1][1].terrain, "floor");
  assert.ok(terrainSet(tiles, "wall").size > 0);
  // A backtracker maze is perfect: every corridor reachable from every other.
  assert.equal(passableComponents(tiles, new Set(["wall"])), 1);
});

test("layers draw from independent seed streams", () => {
  let stamps = (noiseScale: number) => {
    let gen: WorldGen = {
      width: 21,
      height: 21,
      seed: 9,
      defaultTerrain: "plains",
      terrainLayers: [
        {
          terrain: "forest",
          gen: { noise: { scale: noiseScale, above: 0.5 } },
        },
        { terrain: "rock", gen: { blobs: { count: 5, maxRadius: 2 } } },
      ],
    };
    return terrainSet(paintedTiles(gen, 21, 21, "plains"), "rock");
  };
  // Retuning layer 0's noise must not move layer 1's blob stamps.
  assert.deepEqual(stamps(3), stamps(6));
});

test("noise thresholds behave: above 2 paints nothing, above 0 paints everything", () => {
  let gen = (above: number): WorldGen => ({
    width: 15,
    height: 15,
    seed: 5,
    defaultTerrain: "plains",
    terrainLayers: [{ terrain: "forest", gen: { noise: { above } } }],
  });
  assert.equal(
    terrainSet(paintedTiles(gen(2), 15, 15, "plains"), "forest").size,
    0,
  );
  assert.equal(
    terrainSet(paintedTiles(gen(0), 15, 15, "plains"), "forest").size,
    15 * 15,
  );
});

// --- The connect pass -----------------------------------------------------

test("connect carves stranded pockets back to the main region", () => {
  let gen: WorldGen = {
    width: 15,
    height: 15,
    seed: 1,
    defaultTerrain: "plains",
    terrainLayers: [
      { terrain: "rock", gen: { noise: { scale: 3, above: 0.45 } } },
    ],
    impassable: ["rock"],
  };
  let split = paintedTiles(gen, 15, 15, "plains");
  assert.ok(
    passableComponents(split, new Set(["rock"])) > 1,
    "this seed strands pockets without connect",
  );
  let joined = paintedTiles({ ...gen, connect: true }, 15, 15, "plains");
  assert.equal(passableComponents(joined, new Set(["rock"])), 1);
});

test("connect: true refuses an impassable fill and asks for a carve terrain", () => {
  let gen: WorldGen = {
    width: 21,
    height: 21,
    seed: 7,
    defaultTerrain: "water",
    terrainLayers: [
      { terrain: "grass", gen: { island: { size: 0.5, roughness: 0.4 } } },
    ],
    impassable: ["water"],
    connect: true,
  };
  assert.throws(() => paintedTiles(gen, 21, 21, "water"), /carve/);
  // Named carve terrain works and keeps the sea everywhere but the corridors.
  let tiles = paintedTiles(
    { ...gen, connect: { carve: "grass" } },
    21,
    21,
    "water",
  );
  assert.equal(passableComponents(tiles, new Set(["water"])), 1);
});

test("connect refuses to carve with an impassable terrain", () => {
  let gen: WorldGen = {
    width: 15,
    height: 15,
    seed: 1,
    defaultTerrain: "plains",
    terrainLayers: [
      { terrain: "rock", gen: { noise: { above: 0.45, scale: 3 } } },
    ],
    impassable: ["rock"],
    connect: { carve: "rock" },
  };
  assert.throws(() => paintedTiles(gen, 15, 15, "plains"), /impassable/);
});

// --- Authoring validation --------------------------------------------------

test("assertValidTerrainLayers rejects the classic authoring slips", () => {
  let bad = (layers: unknown, pattern: RegExp) =>
    assert.throws(() => assertValidTerrainLayers(layers), pattern);
  bad({}, /array/);
  bad([{ terrain: "x", gen: "mase" }], /unknown/);
  bad([{ terrain: "x", gen: { island: {}, maze: {} } }], /exactly one/);
  bad(
    [{ terrain: "x", gen: { blobs: { maxRadius: 2 } } }],
    /count or a density/,
  );
  bad([{ terrain: "x", gen: "fill", where: { on: [] } }], /non-empty/);
  bad([{ terrain: "x", gen: "fill", were: { on: ["y"] } }], /unknown key/);
  bad([{ terrain: "x", gen: { noise: { octaves: 9 } } }], /octaves/);
  bad([{ gen: "fill" }], /terrain/);
  // The good shapes pass.
  assertValidTerrainLayers([
    { terrain: "grass", gen: "island" },
    { terrain: "rock", gen: { maze: {} }, where: { on: ["grass"] } },
    { terrain: "forest", gen: { blobs: { density: 2, maxRadius: 2 } } },
  ]);
  assertValidConnect(true);
  assertValidConnect({ carve: "grass" });
  assert.throws(() => assertValidConnect({ carve: "" }), /connect/);
  assert.throws(() => assertValidConnect("yes"), /connect/);
});

// --- Scenario integration ---------------------------------------------------

function scenarioFile(overlay: Partial<ScenarioFile["overlay"]>): ScenarioFile {
  return {
    name: "layer-test",
    overlay: { dynamicRules: [], removedBaseIds: [], ...overlay },
  };
}

test("a scenario's layer stack shapes the booted world", () => {
  let boot = scenarioBootScenario(
    scenario,
    scenarioFile({
      terrainSpecs: {
        water: { passable: false, visual: { color: "#1b4965" } },
        grass: {},
        rock: { passable: false },
      },
      defaultTerrain: "water",
      terrainLayers: [
        { terrain: "grass", gen: { island: { size: 0.75, roughness: 0.3 } } },
        { terrain: "rock", gen: "maze", where: { on: ["grass"] } },
      ],
      connect: { carve: "grass" },
    }),
  );
  let map = createWorld(boot).getMap();
  let terrains = new Set(map.tiles.map((t) => t.terrain));
  assert.ok(
    terrains.has("water") && terrains.has("grass") && terrains.has("rock"),
  );
  // Spawn landed on walkable ground on the merged map.
  let spawnTile = map.tiles.find(
    (t) => t.x === boot.spawn.x && t.y === boot.spawn.y,
  );
  assert.equal(spawnTile?.terrain, "grass");
});

test("a scenario whose layers paint undefined terrain fails at validation", () => {
  assert.throws(
    () =>
      scenarioBootScenario(
        scenario,
        scenarioFile({
          terrainSpecs: { grass: {} },
          defaultTerrain: "grass",
          terrainLayers: [{ terrain: "lava", gen: "noise" }],
        }),
      ),
    /paints terrain "lava"/,
  );
  // A mask naming an undefined terrain is the same slip.
  assert.throws(
    () =>
      scenarioBootScenario(
        scenario,
        scenarioFile({
          terrainSpecs: { grass: {}, rock: {} },
          defaultTerrain: "grass",
          terrainLayers: [
            { terrain: "rock", gen: "maze", where: { on: ["sand"] } },
          ],
        }),
      ),
    /paints terrain "sand"/,
  );
});

test("the scenario store rejects malformed layers and a blobs/layers double-declare", () => {
  let dir = mkdtempSync(join(tmpdir(), "layers-"));
  try {
    let store = createScenarioStore(dir);
    writeFileSync(
      join(dir, "both.json"),
      JSON.stringify({
        name: "both",
        overlay: {
          dynamicRules: [],
          removedBaseIds: [],
          defaultTerrain: "grass",
          blobs: [{ terrain: "rock", count: 1, maxRadius: 1 }],
          terrainLayers: [{ terrain: "rock", gen: "noise" }],
        },
      }),
    );
    assert.throws(() => store.load("both"), /not both/);
    writeFileSync(
      join(dir, "typo.json"),
      JSON.stringify({
        name: "typo",
        overlay: {
          dynamicRules: [],
          removedBaseIds: [],
          terrainLayers: [{ terrain: "rock", gen: "labyrinth" }],
        },
      }),
    );
    assert.throws(() => store.load("typo"), /preset "labyrinth"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
