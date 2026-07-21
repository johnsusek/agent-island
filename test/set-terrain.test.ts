// The `setTerrain` effect: the kernel's only way to rewrite a tile's terrain,
// the structural primitive behind terrain that changes at runtime (a chopped-out
// forest becoming plains, a GM painting lava). A transition/action rule writes
// the terrain under an entity's own tile via an installed TerrainWriter; the host
// owns the consequences (passability, route re-planning, the map revision).
//
// The kernel-level tests (raw worlds + runRulesForTick over a mutable grid)
// isolate the effect from the host; the engine-level test proves the whole seam
// end to end - a real forest tile turning to plains and bumping the map revision.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginTick,
  runRulesForTick,
  validateRule,
  stock,
  type Rule,
  type KernelWorld,
  type TerrainLookup,
  type TerrainWriter,
} from "../src/rules/kernel.js";
import { makeSpace, setTerrainAt } from "../src/rules/space.js";
import { makeSurvivalEngine } from "./helpers.js";

// A mutable 11x11 grid backing both the read lookup and the write sink, so a
// setTerrain write is observable and a later nearTerrain read sees it.
function mutableGrid(fill = "forest", w = 11, h = 11) {
  let tiles = new Map<string, string>();
  let k = (x: number, y: number) => `${x},${y}`;
  let inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h;
  let read: TerrainLookup = (x, y) =>
    inBounds(x, y) ? (tiles.get(k(x, y)) ?? fill) : undefined;
  let write: TerrainWriter = (x, y, t) => {
    if (inBounds(x, y)) tiles.set(k(x, y), t);
  };
  return {
    read,
    write,
    at: (x: number, y: number) => tiles.get(k(x, y)) ?? fill,
  };
}

// A lone "grove" carrier (a data-only stock holder) on a tile, plus the world
// singleton. `wood` is the reserve a depletion rule keys off.
function world(x = 5, y = 5): KernelWorld {
  return {
    tick: 0,
    entities: {
      world: { id: "world", tags: ["world"], stocks: {} },
      grove: {
        id: "grove",
        tags: ["carrier", "wood"],
        stocks: { wood: stock(0, 0, 100) },
        pos: { x, y },
        action: null,
      },
    },
  };
}

function step(
  w: KernelWorld,
  rules: Rule[],
  g: ReturnType<typeof mutableGrid>,
) {
  let before = beginTick(w);
  return runRulesForTick(w, rules, before, [], g.read, g.write);
}

// A depleted grove turns its own tile to plains: gate on standing on forest
// (range 0 - the tile itself) with the carrier drained, then rewrite the tile.
const depletes: Rule = {
  id: "forest-depletes",
  phase: "transition",
  each: { tag: "carrier" },
  when: {
    all: [
      { nearTerrain: { type: "forest", range: 0 } },
      { cmp: "lte", left: { stock: "wood" }, right: 0 },
    ],
  },
  do: [{ setTerrain: { to: "plains" } }],
};

test("setTerrain rewrites the terrain under the acting entity", () => {
  let g = mutableGrid("forest");
  let w = world(5, 5);
  step(w, [depletes], g);
  assert.equal(g.at(5, 5), "plains");
});

test("the depletion gate holds until the carrier is drained", () => {
  let g = mutableGrid("forest");
  let w = world(5, 5);
  w.entities.grove.stocks.wood.value = 3; // still has wood
  step(w, [depletes], g);
  assert.equal(g.at(5, 5), "forest", "forest stays while wood remains");
  w.entities.grove.stocks.wood.value = 0;
  step(w, [depletes], g);
  assert.equal(g.at(5, 5), "plains", "turns to plains once drained");
});

test("setTerrain writes another entity's tile via `of`", () => {
  let g = mutableGrid("forest");
  let w = world(5, 5);
  w.entities.gm = {
    id: "gm",
    tags: ["director"],
    stocks: {},
    pos: { x: 1, y: 1 },
    action: null,
  };
  let paint: Rule = {
    id: "paint-grove",
    phase: "transition",
    each: { tag: "director" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [{ setTerrain: { of: "grove", to: "water" } }],
  };
  step(w, [paint], g);
  assert.equal(g.at(5, 5), "water", "wrote the target's tile");
  assert.equal(g.at(1, 1), "forest", "actor's own tile untouched");
});

test("setTerrain with no writer installed surfaces a rule error, not a silent no-op", () => {
  let g = mutableGrid("forest");
  let w = world(5, 5);
  let before = beginTick(w);
  // Install the read lookup but omit the writer.
  let events = runRulesForTick(w, [depletes], before, [], g.read);
  assert.equal(g.at(5, 5), "forest", "no write happened");
  assert.ok(
    events.some((e) => e.type === "rule_error"),
    "the missing writer is reported",
  );
});

test("a setTerrain effect is rejected in a buffered threshold phase", () => {
  assert.throws(
    () =>
      validateRule({
        id: "bad-terrain",
        phase: "threshold",
        each: { tag: "carrier" },
        do: [{ setTerrain: { to: "plains" } }],
      } as Rule),
    /structural effects.*setTerrain.*cannot run in a buffered/,
  );
});

test("engine: a rule's setTerrain rewrites a tile and bumps the map revision", () => {
  // Terrain carries no per-tile stock of its own now, so paint a forest tile by
  // hand and let an ordinary rule deplete it - proving the setTerrain seam end to
  // end (grid rewrite + map-revision bump) without any coupling.
  let engine = makeSurvivalEngine();
  engine.registerTerrain("forest", {});
  let plains = engine.getMap().tiles.find((t) => t.terrain === "plains")!;
  engine.setTerrainTiles([{ x: plains.x, y: plains.y }], "forest");

  // A drained stock holder standing on that forest tile, keyed by the depletes rule.
  engine.spawnEntity({
    id: "grove-1",
    tags: ["carrier"],
    stocks: { wood: { value: 0, min: 0, max: 30 } },
    pos: { x: plains.x, y: plains.y },
  });
  engine.addRule(depletes);

  let revBefore = engine.terrainRevision();
  engine.tick();

  let after = engine
    .getMap()
    .tiles.find((t) => t.x === plains.x && t.y === plains.y)!;
  assert.equal(after.terrain, "plains", "the forest tile became plains");
  assert.ok(
    engine.terrainRevision() > revBefore,
    "the terrain change bumped the map revision so the dashboard refetches",
  );
});

test("engine: a rule effect cannot paint an unregistered terrain", () => {
  let engine = makeSurvivalEngine();
  let { id } = engine.addAgent("Ara");
  let position = engine.getObservation(id).you.position;
  let before = engine
    .getMap()
    .tiles.find(
      (tile) => tile.x === position.x && tile.y === position.y,
    )?.terrain;
  let paintUnknown: Rule = {
    id: "paint-unknown",
    phase: "transition",
    each: { tag: "agent" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [{ setTerrain: { to: "typo-terrain" } }],
  };
  engine.addRule(paintUnknown);

  engine.tick();

  let after = engine
    .getMap()
    .tiles.find(
      (tile) => tile.x === position.x && tile.y === position.y,
    )?.terrain;
  assert.equal(after, before);
  assert.ok(
    engine
      .recentEvents()
      .some(
        (event) =>
          event.type === "rule_error" &&
          event.text?.includes('Unknown terrain "typo-terrain"'),
      ),
  );
});

// --- Passability flips re-plan in-flight travelers -----------------------

// A small open grid where "water" is impassable, so painting a tile water flips
// its passability and should re-route anyone walking through it.
const WATER_GEN = {
  width: 11,
  height: 11,
  defaultTerrain: "plains",
  impassable: ["water"],
};

// A walker mid-route: an agent at `from` with an in-flight straight-line path.
function walker(
  from = { x: 0, y: 5 },
  path = [
    { x: 1, y: 5 },
    { x: 2, y: 5 },
    { x: 3, y: 5 },
  ],
) {
  let space = makeSpace({ x: 0, y: 0 }, WATER_GEN);
  let world: KernelWorld = {
    tick: 0,
    entities: {
      world: { id: "world", tags: ["world"], stocks: {} },
      walker: {
        id: "walker",
        tags: ["agent"],
        stocks: {},
        pos: { ...from },
        action: { type: "travel", args: {}, startTick: 0, endTick: 99 },
      },
    },
  };
  space.moves.set("walker", { path, index: 0, progress: 0 });
  return { space, world };
}

test("blocking a tile on an in-flight route re-plans around it", () => {
  let { space, world } = walker();
  let changed = setTerrainAt(space, world, 2, 5, "water"); // block the middle step
  assert.equal(changed, true);
  let mv = space.moves.get("walker")!;
  assert.ok(mv, "the walker is still travelling");
  assert.ok(
    !mv.path.some((p) => p.x === 2 && p.y === 5),
    "the new route avoids the now-impassable tile",
  );
  assert.equal(
    mv.index,
    0,
    "the re-planned route restarts from the current tile",
  );
  assert.equal(
    world.entities.walker.action?.type,
    "travel",
    "the walker keeps travelling",
  );
});

test("a same-passability change leaves in-flight routes untouched", () => {
  let { space, world } = walker();
  let path = space.moves.get("walker")!.path;
  setTerrainAt(space, world, 2, 5, "forest"); // still passable - no re-plan
  assert.equal(
    space.moves.get("walker")!.path,
    path,
    "a forest-for-plains swap (both passable) doesn't disturb the route",
  );
});

test("blocking an unreachable destination halts the walker cleanly", () => {
  // Goal boxed in on all sides by water: no route remains, so the walker stops
  // rather than stalling forever stepping toward a tile it can never enter.
  let { space, world } = walker({ x: 0, y: 5 }, [{ x: 1, y: 5 }]);
  for (let [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [0, 0],
  ])
    setTerrainAt(space, world, 1 + dx, 5 + dy, "water");
  assert.equal(space.moves.has("walker"), false, "the dead route was dropped");
  assert.equal(
    world.entities.walker.action,
    null,
    "the travel action was cleared so nothing keeps driving it",
  );
});
