import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceSpace,
  commitMove,
  makeSpace,
  passable,
  replanRoutesForSolids,
  spawn,
  syncTokens,
  worldgenWithTerrainPolicy,
} from "../src/space.js";
import type { KernelWorld } from "../src/kernel.js";

// A one-row world of open plains, an agent at the west end. Callers drop tokens
// and drive travel to probe how solidity shapes movement.
function line(width: number): {
  space: ReturnType<typeof makeSpace>;
  world: KernelWorld;
} {
  let space = makeSpace(
    { x: 0, y: 0 },
    worldgenWithTerrainPolicy(
      { width, height: 1, defaultTerrain: "plains" },
      {},
    ),
  );
  let world: KernelWorld = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };
  spawn(space, "ara", 0, {});
  return { space, world };
}

test("a solid token blocks its own tile; an ordinary token does not", () => {
  let { space, world } = line(4);
  assert.equal(passable(space.grid, 2, 0), true, "open ground starts walkable");

  world.entities["wall"] = {
    id: "wall",
    tags: [],
    occupancy: "blocking",
    stocks: {},
    pos: { x: 2, y: 0 },
  };
  world.entities["pile"] = {
    id: "pile",
    tags: [],
    occupancy: "tile",
    stocks: {},
    pos: { x: 3, y: 0 },
  };
  syncTokens(space, world);

  assert.equal(
    passable(space.grid, 2, 0),
    false,
    "the solid token blocks its tile",
  );
  assert.equal(
    passable(space.grid, 3, 0),
    true,
    "a non-solid token leaves its tile walkable",
  );

  // Razing a structure frees its tile the same tick it vanishes.
  delete world.entities["wall"];
  syncTokens(space, world);
  assert.equal(
    passable(space.grid, 2, 0),
    true,
    "removing the solid token frees its tile",
  );
});

test("travel to a solid token routes to the tile beside it, never onto it", () => {
  // The hearth sits on ordinary plains but is solid, so it is worked from an
  // adjacent tile - travel must land beside it, exactly as it does for a token
  // sunk in impassable water.
  let space = makeSpace(
    { x: 0, y: 0 },
    worldgenWithTerrainPolicy(
      {
        width: 4,
        height: 1,
        defaultTerrain: "plains",
        tokens: [
          {
            name: "hearth",
            tags: [],
            occupancy: "blocking",
            x: 3,
            y: 0,
            terrain: "plains",
          },
        ],
      },
      {},
    ),
  );
  let world: KernelWorld = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };
  spawn(space, "ara", 0, { tokens: ["hearth"] });

  let ok = commitMove(space, world, "ara", "travel", { location: "hearth" });
  assert.equal(ok.ok, true, "travel to a solid token is planned, not denied");
  let landing = space.moves.get("ara")?.path.at(-1);
  assert.ok(landing, "a path was planned");
  assert.equal(
    `${landing!.x},${landing!.y}`,
    "2,0",
    "the trip ends beside the hearth, never on the solid tile",
  );
});

test("a solid token spawning on a route reroutes the traveler around it", () => {
  // A 3-row corridor: the agent heads straight east along the middle row; a wall
  // drops onto a tile it was about to cross, so its remaining path must bend.
  let space = makeSpace(
    { x: 0, y: 1 },
    worldgenWithTerrainPolicy(
      { width: 5, height: 3, defaultTerrain: "plains" },
      {},
    ),
  );
  let world: KernelWorld = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 1 },
        action: null,
      },
      goal: {
        id: "goal",
        tags: [],
        occupancy: "tile",
        stocks: {},
        pos: { x: 4, y: 1 },
      },
    },
  };
  spawn(space, "ara", 0, { tokens: ["goal"] });
  syncTokens(space, world);

  commitMove(space, world, "ara", "travel", { location: "goal" });
  // Block a tile the planned route actually crosses (not the start or the goal),
  // so a reroute is both necessary and possible in the open 3-row field.
  let route = space.moves.get("ara")!.path;
  let block = route[Math.floor((route.length - 1) / 2)];
  let blockKey = `${block.x},${block.y}`;

  // syncTokens projects the wall onto the grid; the engine calls
  // replanRoutesForSolids right after (wired at the syncTokens site), which is
  // the unit under test here.
  world.entities["wall"] = {
    id: "wall",
    tags: [],
    occupancy: "blocking",
    stocks: {},
    pos: { x: block.x, y: block.y },
  };
  syncTokens(space, world);
  assert.equal(
    passable(space.grid, block.x, block.y),
    false,
    "the wall blocks its tile",
  );
  replanRoutesForSolids(space, world);
  assert.ok(
    !space.moves
      .get("ara")!
      .path.some((p) => p.x === block.x && p.y === block.y),
    "the rerouted path no longer crosses the walled tile",
  );

  // Walk it out; the agent must reach the goal without ever standing on the
  // walled tile.
  let arrived = false;
  for (let t = 1; t <= 20 && !arrived; t += 1) {
    world.tick = t;
    for (let e of advanceSpace(space, world, []))
      if (e.type === "arrived") arrived = true;
    assert.notEqual(
      `${world.entities.ara.pos!.x},${world.entities.ara.pos!.y}`,
      blockKey,
      "the agent never stands on the solid tile",
    );
  }
  assert.ok(
    arrived,
    "the traveler still reaches the goal, routed around the wall",
  );
});
