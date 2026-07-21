// End-to-end proof that the engine installs the passability oracle the kernel's
// `moveToward` fix consults: a chasing creature on a real map routes around an
// impassable tile instead of phasing through it. The kernel unit tests
// (movement-effect.test.ts) cover the slide logic; this one guards the wiring -
// that the engine actually hands its grid passability to runRulesForTick.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/rules/engine.js";
import type { Scenario } from "../src/rules/scenario.js";

// A predator chases the nearest character one step per tick.
function hunterScenario(): Scenario {
  return {
    name: "hunter-demo",
    spawn: { x: 2, y: 2 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    worldgen: { width: 8, height: 8, seed: 1, defaultTerrain: "plains" },
    rules: [
      {
        id: "hunt",
        phase: "transition",
        each: { tag: "predator" },
        when: { colocated: { tag: "agent", range: 9 } },
        do: [
          {
            moveToward: {
              target: {
                colocated: { tag: "agent", range: 9, pick: "nearest" },
              },
            },
          },
        ],
      },
    ],
  };
}

test("a hunting entity slides around impassable terrain instead of through it", () => {
  let engine = createWorld(hunterScenario());
  engine.addAgent("Hero"); // lands on spawn (2,2)
  // A wall on the diagonal between the wolf (4,4) and its prey to the NW.
  engine.registerTerrain("wall", { passable: false });
  engine.setTerrainTiles([{ x: 3, y: 3 }], "wall");
  engine.spawnEntity({ id: "wolf", tags: ["predator"], pos: { x: 4, y: 4 } });

  engine.tick();

  let wolf = engine.getEntities()["wolf"];
  assert.deepEqual(
    wolf.pos,
    { x: 3, y: 4 },
    "slid to the open axis, never onto the wall tile",
  );
});

test("with no wall the same hunt takes the direct diagonal - the wall is what diverts it", () => {
  let engine = createWorld(hunterScenario());
  engine.addAgent("Hero");
  engine.spawnEntity({ id: "wolf", tags: ["predator"], pos: { x: 4, y: 4 } });

  engine.tick();

  let wolf = engine.getEntities()["wolf"];
  assert.deepEqual(wolf.pos, { x: 3, y: 3 }, "unobstructed diagonal step");
});
