import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceSpace,
  commitMove,
  makeSpace,
  spawn,
  worldgenWithTerrainPolicy,
} from "@agent-island/core/space";
import type { Entity, KernelWorld } from "@agent-island/core/kernel";
import { makeSurvivalEngine } from "./helpers.js";

function agentEntity(id: string, x: number, y: number): Entity {
  return { id, tags: ["agent"], stocks: {}, pos: { x, y }, action: null };
}

function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// Walk the world until nobody is mid-trip, or a safety bound trips.
function settle(space: ReturnType<typeof makeSpace>, world: KernelWorld) {
  for (let t = 1; t <= 40; t += 1) {
    world.tick = t;
    advanceSpace(space, world, []);
    if (space.moves.size === 0) return;
  }
  throw new Error("movers never settled");
}

test("two characters heading for one tile end up on separate tiles", () => {
  let space = makeSpace(
    { x: 0, y: 1 },
    worldgenWithTerrainPolicy(
      {
        width: 5,
        height: 3,
        defaultTerrain: "plains",
        tokens: [
          {
            name: "well",
            tags: [],
            occupancy: "tile",
            x: 4,
            y: 1,
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
      ara: agentEntity("ara", 0, 0),
      bo: agentEntity("bo", 0, 2),
    },
  };
  spawn(space, "ara", 0, { tokens: ["well"] });
  spawn(space, "bo", 0, { tokens: ["well"] });

  commitMove(space, world, "ara", "travel", { location: "well" });
  commitMove(space, world, "bo", "travel", { location: "well" });
  settle(space, world);

  let ara = world.entities.ara.pos!;
  let bo = world.entities.bo.pos!;
  assert.notDeepEqual(ara, bo, "no two agents stand on the same tile");
  // Both end at or beside the well (4,1): one on it, the other sidestepped.
  assert.ok(
    chebyshev(ara, { x: 4, y: 1 }) <= 1,
    "ara ends at or beside the well",
  );
  assert.ok(
    chebyshev(bo, { x: 4, y: 1 }) <= 1,
    "bo ends at or beside the well",
  );
});

test("a mover arriving where someone stands sidesteps to an open neighbour", () => {
  let space = makeSpace(
    { x: 0, y: 1 },
    worldgenWithTerrainPolicy(
      {
        width: 5,
        height: 3,
        defaultTerrain: "plains",
        tokens: [
          {
            name: "post",
            tags: [],
            occupancy: "tile",
            x: 3,
            y: 1,
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
      // Bo is idle, planted right on the post's tile.
      bo: agentEntity("bo", 3, 1),
      ara: agentEntity("ara", 0, 1),
    },
  };
  spawn(space, "ara", 0, { tokens: ["post"] });

  commitMove(space, world, "ara", "travel", { location: "post" });
  settle(space, world);

  let ara = world.entities.ara.pos!;
  assert.deepEqual(
    world.entities.bo.pos,
    { x: 3, y: 1 },
    "the idle agent never moves",
  );
  assert.notDeepEqual(
    ara,
    { x: 3, y: 1 },
    "the arriver does not stack onto the standing agent",
  );
  assert.ok(
    chebyshev(ara, { x: 3, y: 1 }) === 1,
    "it settles on a tile beside them",
  );
});

test("characters joining the same clearing fan out onto their own tiles", () => {
  let engine = makeSurvivalEngine();
  let seen = new Set<string>();
  for (let name of ["ara", "bo", "cyd", "del"]) {
    engine.addAgent(name);
    let p = engine.getObservation(name).you.position;
    let k = `${p.x},${p.y}`;
    assert.ok(
      !seen.has(k),
      `${name} spawns on its own tile, not stacked (${k})`,
    );
    seen.add(k);
  }
});
