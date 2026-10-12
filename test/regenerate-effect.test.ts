// The `regenerate` effect: the "next floor" primitive. A rule rerolls the whole
// map from a seed, and - unlike an operator reset - the live run is carried
// forward: living characters keep their tags and stocks and land on the fresh
// spawn, the world entity keeps its stocks (so the counter that drove the reroll
// survives it), the tick clock and rule set persist, and every other entity is
// rebuilt by worldgen. Driven through the full engine (createWorld) because the
// reroll is an engine operation over worldgen and the spatial grid, not pure
// kernel arithmetic.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/rules/engine.js";
import { hasTag, validateRule } from "@agent-island/core/kernel";
import type { Scenario } from "../src/rules/scenario.js";
import type { Rule } from "@agent-island/core/kernel";

// A one-floor dungeon: a fixed `grove` token to prove tokens reroll, and a
// world-scoped `descend` lever a transition rule consumes to request a reroll
// seeded by the current `floor`. The lever self-clears so the reroll fires once.
function floorScenario(): Scenario {
  return {
    name: "regen-demo",
    spawn: { x: 3, y: 3 },
    agentTemplate: {
      tags: ["agent"],
      stocks: { gold: { value: 0, min: 0, max: 999, icon: "two-coins" } },
    },
    worldgen: {
      width: 12,
      height: 12,
      seed: 1,
      defaultTerrain: "plains",
      tokens: [
        {
          name: "grove",
          tags: ["wood"],
          occupancy: "tile",
          x: 8,
          y: 8,
          stocks: { wood: { value: 5, min: 0, max: 5, icon: "wood-pile" } },
        },
      ],
    },
    rules: [
      {
        id: "descend",
        phase: "transition",
        each: { tag: "world" },
        when: { cmp: "gte", left: { stock: "descend" }, right: 1 },
        do: [
          { set: { target: "descend", to: 0 } },
          { regenerate: { seed: { stock: "floor" } } },
        ],
      },
    ],
  };
}

test("regenerate rerolls the map and carries living characters forward", () => {
  let engine = createWorld(floorScenario());
  let ara = engine.addAgent("Ara").id;
  // Ara banks some gold; the world tracks which floor it is on.
  engine.setStock(ara, "gold", 7);
  engine.setStock("world", "floor", 2, { min: 0, max: 99 }, { icon: "stairs" });
  // Drain the grove and drop a foreign entity, so the reroll has something to
  // prove: the grove must come back full (rebuilt, not the drained carry-over)
  // and the boulder must be gone (not an agent, not the world, not worldgen).
  engine.setStock("grove", "wood", 0);
  engine.spawnEntity({
    id: "boulder",
    tags: ["obstacle"],
    pos: { x: 1, y: 1 },
  });

  let revBefore = engine.terrainRevision();

  // Pull the lever and tick: the transition consumes it and requests the reroll.
  engine.setStock(
    "world",
    "descend",
    1,
    { min: 0, max: 9 },
    { icon: "down-arrow" },
  );
  let { tick } = engine.tick();
  let ents = engine.getEntities();

  // The clock kept running - a reroll is not a reset back to tick 0.
  assert.equal(tick, 1);

  // Ara survives with her gold and her agent tag.
  assert.ok(ents[ara], "Ara carried forward");
  assert.ok(hasTag(ents[ara], "agent"), "still an agent");
  assert.equal(ents[ara].stocks.gold.value, 7, "gold carried forward");

  // World stocks persist - the floor counter that seeded the reroll survives it,
  // and the lever cleared itself so the reroll fires only once.
  assert.equal(ents["world"].stocks.floor.value, 2);
  assert.equal(ents["world"].stocks.descend.value, 0, "the lever reset itself");

  // Everything else rerolls: the foreign entity is gone, the token is rebuilt
  // full rather than the drained one being carried across.
  assert.equal(ents["boulder"], undefined, "non-worldgen entities are cleared");
  assert.equal(
    ents["grove"].stocks.wood.value,
    5,
    "tokens reroll from worldgen",
  );

  // The map changed under everyone.
  assert.ok(engine.terrainRevision() > revBefore, "map revision advanced");

  // A loud line lands in the GM feed, and Ara stands exactly on the new spawn.
  let gm = engine
    .recentGmEvents()
    .find((event) => event.kind === "world_regenerated");
  assert.ok(gm, "a world_regenerated event was logged");
  let detail = gm!.detail as { seed: number; spawn: { x: number; y: number } };
  assert.equal(detail.seed, 2, "rerolled from the floor-number seed");
  assert.deepEqual(ents[ara].pos, detail.spawn, "landed on the new spawn");
});

test("a regenerate effect is rejected in a buffered threshold phase", () => {
  assert.throws(
    () =>
      validateRule({
        id: "bad-regen",
        phase: "threshold",
        each: { tag: "world" },
        do: [{ regenerate: { seed: 1 } }],
      } as Rule),
    /structural effects.*regenerate.*cannot run in a buffered/,
  );
});
