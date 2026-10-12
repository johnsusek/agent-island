// The `growWorld` effect: the safe half of world mutation. A rule extends the
// map's +x/+y frontier by N tiles of blank default terrain - nothing existing is
// touched, so every current tile keeps its coordinate and the new land arrives
// unrevealed (an exploration event for free). `growGrid` is unit-tested against a
// raw grid; the effect is driven end to end through the engine.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/rules/engine.js";
import { growGrid, makeSpace, extendTerrain } from "@agent-island/core/space";
import type { TerrainLayer } from "@agent-island/core/space";
import { validateRule } from "@agent-island/core/kernel";
import type { Scenario } from "../src/rules/scenario.js";
import type { MapEdge, Rule } from "@agent-island/core/kernel";

test("growGrid extends the +x/+y frontier and leaves existing tiles put", () => {
  let space = makeSpace(
    { x: 0, y: 0 },
    { width: 4, height: 4, defaultTerrain: "plains" },
  );
  // Mark an interior tile so we can prove it keeps its coordinate after growth.
  space.grid.tiles[1][2].terrain = "forest";

  let result = growGrid(space.grid, 3);
  assert.deepEqual(result, { width: 7, height: 7, grew: true });
  assert.equal(space.grid.width, 7);
  assert.equal(space.grid.height, 7);
  // Every row is now the new width, and the whole grid is the new height.
  assert.equal(space.grid.tiles.length, 7);
  for (let row of space.grid.tiles) assert.equal(row.length, 7);
  // The marked tile is exactly where it was - growth never renumbers.
  assert.equal(space.grid.tiles[1][2].terrain, "forest");
  // New frontier tiles are blank default fill.
  assert.equal(space.grid.tiles[6][6].terrain, "plains");
  assert.equal(space.grid.tiles[0][6].terrain, "plains");
  assert.equal(space.grid.tiles[6][0].terrain, "plains");
});

test("growGrid is a no-op for a non-positive request - the map never shrinks", () => {
  let space = makeSpace(
    { x: 0, y: 0 },
    { width: 5, height: 5, defaultTerrain: "plains" },
  );
  for (let by of [0, -3]) {
    let result = growGrid(space.grid, by);
    assert.deepEqual(result, { width: 5, height: 5, grew: false });
    assert.equal(space.grid.width, 5);
    assert.equal(space.grid.height, 5);
  }
});

// A world with an `expand` lever a transition rule consumes to grow the map by 3.
// The lever self-clears so growth fires once per pull.
function frontierScenario(): Scenario {
  return {
    name: "grow-demo",
    spawn: { x: 2, y: 2 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    worldgen: { width: 8, height: 8, seed: 1, defaultTerrain: "plains" },
    rules: [
      {
        id: "expand",
        phase: "transition",
        each: { tag: "world" },
        when: { cmp: "gte", left: { stock: "expand" }, right: 1 },
        do: [{ set: { target: "expand", to: 0 } }, { growWorld: { by: 3 } }],
      },
    ],
  };
}

test("growWorld extends the map under a live run, unrevealed, nothing displaced", () => {
  let engine = createWorld(frontierScenario());
  let ara = engine.addAgent("Ara").id;
  let araPosBefore = engine.getEntities()[ara].pos;
  let revBefore = engine.terrainRevision();

  engine.setStock("world", "expand", 1, { min: 0, max: 9 }, { icon: "expand" });
  let { tick } = engine.tick();

  // The clock kept running; growth is not a reset.
  assert.equal(tick, 1);
  let map = engine.getMap();
  assert.equal(map.width, 11, "grew by 3 on +x");
  assert.equal(map.height, 11, "grew by 3 on +y");
  // The spawn - and Ara, who never moved - keep their coordinates.
  assert.deepEqual(map.spawn, { x: 2, y: 2 }, "origin anchor unchanged");
  assert.deepEqual(
    engine.getEntities()[ara].pos,
    araPosBefore,
    "Ara undisplaced",
  );
  // The new frontier is real, blank terrain a character can eventually walk.
  let corner = map.tiles.find((t) => t.x === 10 && t.y === 10);
  assert.ok(corner, "the new (10,10) tile exists");
  assert.equal(corner!.terrain, "plains");
  // ...but it belongs to no fog yet: everything Ara knows is inside the old 8x8
  // bounds, so the frontier arrived unrevealed.
  for (let t of engine.getFog().knownByAgent[ara] ?? [])
    assert.ok(t.x < 8 && t.y < 8, `known tile (${t.x},${t.y}) is old ground`);
  // The map revision advanced and a loud line landed in the GM feed.
  assert.ok(engine.terrainRevision() > revBefore, "map revision advanced");
  let gm = engine.recentGmEvents().find((e) => e.kind === "world_grew");
  assert.ok(gm, "a world_grew event was logged");
  assert.deepEqual(gm!.detail, {
    growth: { east: 3, south: 3 },
    width: 11,
    height: 11,
    origin: { x: 0, y: 0 },
  });
});

let edgeCases: {
  direction: MapEdge;
  spawn: { x: number; y: number };
  expected: {
    width: number;
    height: number;
    origin: { x: number; y: number };
    frontier: { x: number; y: number };
  };
}[] = [
  {
    direction: "north",
    spawn: { x: 2, y: 0 },
    expected: {
      width: 6,
      height: 7,
      origin: { x: 0, y: -2 },
      frontier: { x: 2, y: -2 },
    },
  },
  {
    direction: "east",
    spawn: { x: 5, y: 2 },
    expected: {
      width: 8,
      height: 5,
      origin: { x: 0, y: 0 },
      frontier: { x: 7, y: 2 },
    },
  },
  {
    direction: "south",
    spawn: { x: 2, y: 4 },
    expected: {
      width: 6,
      height: 7,
      origin: { x: 0, y: 0 },
      frontier: { x: 2, y: 6 },
    },
  },
  {
    direction: "west",
    spawn: { x: 0, y: 2 },
    expected: {
      width: 8,
      height: 5,
      origin: { x: -2, y: 0 },
      frontier: { x: -2, y: 2 },
    },
  },
];

for (let edgeCase of edgeCases)
  test(`a character reaching the ${edgeCase.direction} edge expands that frontier once`, () => {
    let scenario: Scenario = {
      name: `grow-${edgeCase.direction}`,
      spawn: edgeCase.spawn,
      agentTemplate: { tags: ["agent"], stocks: {} },
      worldgen: {
        width: 6,
        height: 5,
        seed: 1,
        defaultTerrain: "plains",
      },
      rules: [
        {
          id: `grow-${edgeCase.direction}`,
          phase: "transition",
          each: { tag: "world" },
          when: {
            cmp: "gt",
            left: {
              count: {
                tag: "agent",
                where: { atMapEdge: { edge: edgeCase.direction } },
              },
            },
            right: 0,
          },
          do: [
            {
              growWorld: { by: 2, direction: edgeCase.direction },
            },
          ],
        },
      ],
    };
    let engine = createWorld(scenario);
    let agentId = engine.addAgent("Ara").id;
    let position = engine.getEntities()[agentId].pos;

    engine.tick();

    let map = engine.getMap();
    assert.equal(map.width, edgeCase.expected.width);
    assert.equal(map.height, edgeCase.expected.height);
    assert.deepEqual(map.origin, edgeCase.expected.origin);
    assert.deepEqual(engine.getEntities()[agentId].pos, position);
    assert.equal(
      map.tiles.find(
        (tile) =>
          tile.x === edgeCase.expected.frontier.x &&
          tile.y === edgeCase.expected.frontier.y,
      )?.terrain,
      "plains",
    );
    assert.deepEqual(
      engine.getMapRegion(
        edgeCase.expected.frontier.x,
        edgeCase.expected.frontier.y,
        0,
      ).bounds,
      {
        x0: edgeCase.expected.frontier.x,
        y0: edgeCase.expected.frontier.y,
        x1: edgeCase.expected.frontier.x,
        y1: edgeCase.expected.frontier.y,
      },
    );
    for (let tile of engine.getFog().knownByAgent[agentId] ?? []) {
      assert.ok(tile.x >= 0 && tile.x < 6);
      assert.ok(tile.y >= 0 && tile.y < 5);
    }

    let movement = {
      north: { x: 0, y: -1 },
      east: { x: 1, y: 0 },
      south: { x: 0, y: 1 },
      west: { x: -1, y: 0 },
    }[edgeCase.direction];
    assert.equal(
      engine.commitIntent(agentId, {
        type: "explore",
        direction: edgeCase.direction,
      }).accepted,
      true,
    );
    engine.tick();
    assert.deepEqual(engine.getEntities()[agentId].pos, {
      x: position!.x + movement.x,
      y: position!.y + movement.y,
    });
    assert.deepEqual(
      {
        width: engine.getMap().width,
        height: engine.getMap().height,
        origin: engine.getMap().origin,
      },
      {
        width: edgeCase.expected.width,
        height: edgeCase.expected.height,
        origin: edgeCase.expected.origin,
      },
      "the character is inside the new boundary, so growth does not repeat",
    );

    let restored = createWorld(scenario);
    assert.equal(restored.restore(engine.snapshot()), true);
    assert.deepEqual(restored.getMap().origin, edgeCase.expected.origin);
  });

test("canSeeMapEdge grows the map while a character is still `within` tiles from the boundary, not only once they stand on it", () => {
  // Spawn 3 tiles from the east edge of an 8-wide map (edge at x=7), with a
  // canSeeMapEdge gate of within: 5 - wide enough that the character never
  // has to physically touch the edge for growth to fire.
  let scenario: Scenario = {
    name: "grow-early",
    spawn: { x: 4, y: 2 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    worldgen: { width: 8, height: 5, seed: 1, defaultTerrain: "plains" },
    rules: [
      {
        id: "grow-east",
        phase: "transition",
        each: { tag: "world" },
        when: {
          cmp: "gt",
          left: {
            count: {
              tag: "agent",
              where: { canSeeMapEdge: { edge: "east", within: 5 } },
            },
          },
          right: 0,
        },
        do: [{ growWorld: { by: 2, direction: "east" } }],
      },
    ],
  };
  let engine = createWorld(scenario);
  let agentId = engine.addAgent("Ara").id;
  let position = engine.getEntities()[agentId].pos!;
  // 7 - 4 = 3 tiles from the (pre-growth) edge - inside the `within: 5` band,
  // so growth should fire on the very first tick despite Ara not moving.
  assert.equal(7 - position.x, 3);

  engine.tick();

  let map = engine.getMap();
  assert.equal(
    map.width,
    10,
    "grew by 2 on the east edge, before Ara ever reached it",
  );
  assert.deepEqual(
    engine.getEntities()[agentId].pos,
    position,
    "Ara never moved",
  );
});

test("a growWorld effect is rejected in a buffered threshold phase", () => {
  assert.throws(
    () =>
      validateRule({
        id: "bad-grow",
        phase: "threshold",
        each: { tag: "world" },
        do: [{ growWorld: { by: 1 } }],
      } as Rule),
    /structural effects.*growWorld.*cannot run in a buffered/,
  );
});

test("extendTerrain continues the noise field onto a grown frontier", () => {
  // A single noise layer: pure in (seed, world coords), so a tile's terrain is
  // fixed by where it sits in the world, not by the grid's size.
  let terrainLayers: TerrainLayer[] = [
    { terrain: "water", gen: { noise: { scale: 5, above: 0.5, octaves: 2 } } },
  ];
  let recipe = { width: 12, height: 8, seed: 7, defaultTerrain: "plains" };

  // Ground truth: the same recipe born 20 wide from the start.
  let born = makeSpace({ x: 0, y: 0 }, { ...recipe, width: 20, terrainLayers });
  // The real path: born 12 wide, grown east by 8 and repainted.
  let grown = makeSpace({ x: 0, y: 0 }, { ...recipe, terrainLayers });
  growGrid(grown.grid, 8, "east");
  extendTerrain(
    grown.grid,
    { terrainLayers, seed: 7 },
    { x: 0, y: 0, width: 12, height: 8 },
  );

  // Every tile - old interior and new frontier alike - matches the born-large
  // map tile for tile: the frontier is a seamless continuation, not flat fill.
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 20; x += 1)
      assert.equal(
        grown.grid.tiles[y][x].terrain,
        born.grid.tiles[y][x].terrain,
        `(${x},${y}) matches the born-large map`,
      );
  // And the field genuinely painted water past the old edge (not a vacuous match
  // where the frontier happened to be all plains).
  let frontierWater = false;
  for (let y = 0; y < 8; y += 1)
    for (let x = 12; x < 20; x += 1)
      if (grown.grid.tiles[y][x].terrain === "water") frontierWater = true;
  assert.ok(
    frontierWater,
    "the noise field continued water onto the new tiles",
  );
});

test("extendTerrain repaints a west frontier by world coord, interior untouched", () => {
  let terrainLayers: TerrainLayer[] = [
    { terrain: "water", gen: { noise: { scale: 5, above: 0.5, octaves: 2 } } },
  ];
  let space = makeSpace(
    { x: 0, y: 0 },
    { width: 12, height: 8, seed: 7, defaultTerrain: "plains", terrainLayers },
  );
  // Snapshot the painted interior before growing.
  let before = space.grid.tiles.map((row) => row.map((t) => t.terrain));

  growGrid(space.grid, 8, "west"); // origin.x -> -8; interior shifts to local x>=8
  extendTerrain(
    space.grid,
    { terrainLayers, seed: 7 },
    { x: 0, y: 0, width: 12, height: 8 },
  );

  assert.deepEqual(space.grid.origin, { x: -8, y: 0 });
  // The original tiles kept their terrain, now at local x + 8.
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 12; x += 1)
      assert.equal(
        space.grid.tiles[y][x + 8].terrain,
        before[y][x],
        `interior (${x},${y}) preserved after west growth`,
      );
  // The new negative-x frontier is real terrain, not all flat fill.
  let frontierWater = false;
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 8; x += 1)
      if (space.grid.tiles[y][x].terrain === "water") frontierWater = true;
  assert.ok(frontierWater, "the field continued water onto the west frontier");
});

test("growWorld keeps an unpainted registered terrain paintable", () => {
  let engine = createWorld(frontierScenario());
  engine.addAgent("Ara");
  // A plain passable spec (default moveCost, no painted tiles) leaves no trace
  // on the grid itself - only the spec registry knows it exists.
  engine.registerTerrain("meadow", { visual: { color: "#8ec06c" } });

  engine.setStock("world", "expand", 1, { min: 0, max: 9 }, { icon: "expand" });
  engine.tick(); // triggers the growWorld effect, which resets knownTerrains

  let { changed } = engine.setTerrainTiles([{ x: 1, y: 1 }], "meadow");
  assert.equal(changed, 1, "meadow survived the knownTerrains rebuild");
});
