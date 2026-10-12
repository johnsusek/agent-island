// The `move` effect: the kernel's only way to relocate an entity, the structural
// primitive behind a roaming predator. A transition rule steps an entity by a
// signed (dx, dy); the destination is bounds-checked against the installed
// terrain lookup so an off-map step is dropped rather than written. Tested at the
// kernel level (raw worlds + runRulesForTick) so the movement logic is isolated
// from the host's grid.

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
} from "../src/kernel.js";

// A lone predator on a tile, plus the required world singleton. `paces` is the
// step counter a patrol rule reads to flip its heading.
function world(x = 5, y = 5): KernelWorld {
  return {
    tick: 0,
    entities: {
      world: { id: "world", tags: ["world"], stocks: {} },
      wolf: {
        id: "wolf",
        tags: ["predator"],
        stocks: { paces: stock(0, 0, 1_000_000) },
        pos: { x, y },
        action: null,
      },
    },
  };
}

// A bounded 11x11 grid: on-map tiles read "plains", everything else undefined
// (the off-map signal the move effect's bounds guard keys on).
const grid11: TerrainLookup = (x, y) =>
  x >= 0 && y >= 0 && x < 11 && y < 11 ? "plains" : undefined;

function step(w: KernelWorld, rules: Rule[]) {
  let before = beginTick(w);
  return runRulesForTick(w, rules, before, [], grid11);
}

// Step east one tile every tick.
const roamEast: Rule = {
  id: "roam-east",
  phase: "transition",
  each: { tag: "predator" },
  when: { cmp: "gte", left: { tick: true }, right: 0 },
  do: [{ move: { dx: 1, dy: 0 } }],
};

test("a transition rule steps an entity across the grid", () => {
  let w = world(5, 5);
  step(w, [roamEast]);
  assert.deepEqual(w.entities.wolf.pos, { x: 6, y: 5 });
  step(w, [roamEast]);
  assert.deepEqual(w.entities.wolf.pos, { x: 7, y: 5 });
});

test("an off-map step is dropped, not written", () => {
  // Start hard against the east edge; the next eastward step leaves the grid.
  let w = world(10, 5);
  step(w, [roamEast]);
  assert.deepEqual(
    w.entities.wolf.pos,
    { x: 10, y: 5 },
    "stayed put at the edge",
  );
});

test("back-and-forth patrol drives its heading off a step counter", () => {
  // Heading is +1 for the first 4 of every 8 paces, then -1 — a 4-tile beat
  // back and forth, expressed with mod/if and no position read.
  let patrol: Rule = {
    id: "patrol",
    phase: "transition",
    each: { tag: "predator" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [
      {
        move: {
          dx: {
            if: [
              { cmp: "lt", left: { mod: [{ stock: "paces" }, 8] }, right: 4 },
              1,
              -1,
            ],
          },
          dy: 0,
        },
      },
      { adjust: { target: "paces", by: 1 } },
    ],
  };

  let w = world(5, 5);
  let xs: number[] = [];
  for (let i = 0; i < 8; i++) {
    step(w, [patrol]);
    xs.push(w.entities.wolf.pos!.x);
  }
  // +1,+1,+1,+1 then -1,-1,-1,-1 : 5 -> 9 -> back to 5.
  assert.deepEqual(xs, [6, 7, 8, 9, 8, 7, 6, 5]);
});

test("the seeded random walk is deterministic for a given seed and tick", () => {
  let randomWalk: Rule = {
    id: "roam",
    phase: "transition",
    each: { tag: "predator" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [
      {
        move: {
          dx: { round: { rand: [-1, 1, "x"] } },
          dy: { round: { rand: [-1, 1, "y"] } },
        },
      },
    ],
  };

  let a = world(5, 5);
  a.seed = 42;
  let b = world(5, 5);
  b.seed = 42;
  for (let i = 0; i < 10; i++) {
    step(a, [randomWalk]);
    step(b, [randomWalk]);
  }
  assert.deepEqual(a.entities.wolf.pos, b.entities.wolf.pos);
});

test("a move effect is rejected in a buffered threshold phase", () => {
  assert.throws(
    () =>
      validateRule({
        id: "bad-move",
        phase: "threshold",
        each: { tag: "predator" },
        do: [{ move: { dx: 1, dy: 0 } }],
      } as Rule),
    /structural effects.*move.*cannot run in a buffered/,
  );
});

// --- moveToward: the homing counterpart to move ---------------------------

// A wolf and a stationary prey entity the chase rules home on.
function chaseWorld(
  wolf: { x: number; y: number },
  prey: { x: number; y: number },
): KernelWorld {
  let w = world(wolf.x, wolf.y);
  w.entities.prey = {
    id: "prey",
    tags: ["agent"],
    stocks: {},
    pos: { ...prey },
    action: null,
  };
  return w;
}

// Chase a fixed target by id, one step per tick.
const huntPrey: Rule = {
  id: "hunt-prey",
  phase: "transition",
  each: { tag: "predator" },
  when: { cmp: "gte", left: { tick: true }, right: 0 },
  do: [{ moveToward: { target: "prey" } }],
};

test("moveToward closes chebyshev distance by 1 per step and stops on arrival", () => {
  let w = chaseWorld({ x: 0, y: 0 }, { x: 3, y: 5 });
  let path: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 6; i++) {
    step(w, [huntPrey]);
    path.push({ ...w.entities.wolf.pos! });
  }
  // Diagonal while both axes differ, then straight down the remaining axis;
  // the sixth tick is a no-op because the wolf already stands on the prey.
  assert.deepEqual(path, [
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: 3 },
    { x: 3, y: 4 },
    { x: 3, y: 5 },
    { x: 3, y: 5 },
  ]);
});

test("steps repeats the walk and still stops early on arrival", () => {
  let w = chaseWorld({ x: 0, y: 0 }, { x: 2, y: 5 });
  let sprint: Rule = {
    id: "sprint",
    phase: "transition",
    each: { tag: "predator" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [{ moveToward: { target: "prey", steps: 3 } }],
  };
  step(w, [sprint]);
  assert.deepEqual(w.entities.wolf.pos, { x: 2, y: 3 });
  step(w, [sprint]);
  // Two more steps reach the prey; the third is dropped on arrival.
  assert.deepEqual(w.entities.wolf.pos, { x: 2, y: 5 });
});

test("the chase idiom: a colocated nearest target, gated by a matching when", () => {
  let chase: Rule = {
    id: "chase-nearest",
    phase: "transition",
    each: { tag: "predator" },
    when: { colocated: { tag: "agent", range: 3 } },
    do: [
      {
        moveToward: {
          target: { colocated: { tag: "agent", range: 3, pick: "nearest" } },
        },
      },
    ],
  };

  // Out of range: the when gate skips the rule - no step, and no rule_error.
  let far = chaseWorld({ x: 5, y: 5 }, { x: 9, y: 5 });
  let events = step(far, [chase]);
  assert.deepEqual(far.entities.wolf.pos, { x: 5, y: 5 });
  assert.equal(events.filter((e) => e.type === "rule_error").length, 0);

  // In range: the wolf steps toward the prey.
  let near = chaseWorld({ x: 5, y: 5 }, { x: 7, y: 5 });
  step(near, [chase]);
  assert.deepEqual(near.entities.wolf.pos, { x: 6, y: 5 });
});

test("a moveToward effect is rejected in a buffered threshold phase", () => {
  assert.throws(
    () =>
      validateRule({
        id: "bad-chase",
        phase: "threshold",
        each: { tag: "predator" },
        do: [{ moveToward: { target: "prey" } }],
      } as Rule),
    /structural effects.*moveToward.*cannot run in a buffered/,
  );
});

// --- moveToward passability: chase around walls, not through them ----------

// Step with a host passability oracle installed: the wolf may only enter an
// on-map tile that isn't in `walls` (the "x,y" impassable set).
function walledStep(w: KernelWorld, rules: Rule[], walls: Set<string>) {
  let before = beginTick(w);
  let passable = (x: number, y: number) =>
    grid11(x, y) !== undefined && !walls.has(`${x},${y}`);
  return runRulesForTick(
    w,
    rules,
    before,
    [],
    grid11,
    undefined,
    undefined,
    passable,
  );
}

test("a chase respects passability instead of phasing through a wall", () => {
  // Prey due east with a wall on the one tile between them: a straight approach
  // has no slide that still closes distance, so the wolf holds at the wall.
  let walls = new Set(["6,5"]);
  let w = chaseWorld({ x: 5, y: 5 }, { x: 7, y: 5 });
  walledStep(w, [huntPrey], walls);
  assert.deepEqual(w.entities.wolf.pos, { x: 5, y: 5 }, "held at the wall");

  // The same world with no oracle installed: the legacy on-map-only guard walks
  // the wolf straight onto the wall tile - the bug this passability check fixes.
  let open = chaseWorld({ x: 5, y: 5 }, { x: 7, y: 5 });
  step(open, [huntPrey]);
  assert.deepEqual(
    open.entities.wolf.pos,
    { x: 6, y: 5 },
    "phases through without the oracle",
  );
});

test("a diagonal blocked by a wall slides along the open axis toward the prey", () => {
  // Target to the SE with a wall on the diagonal tile: the wolf can't cut the
  // corner, so it slides east (the first open single-axis candidate) and keeps
  // closing rather than stopping dead or phasing through.
  let walls = new Set(["6,6"]);
  let w = chaseWorld({ x: 5, y: 5 }, { x: 7, y: 7 });
  walledStep(w, [huntPrey], walls);
  assert.deepEqual(
    w.entities.wolf.pos,
    { x: 6, y: 5 },
    "slid along the wall, not through it",
  );
  // Two more steps clear the wall and reach the prey.
  walledStep(w, [huntPrey], walls);
  walledStep(w, [huntPrey], walls);
  assert.deepEqual(w.entities.wolf.pos, { x: 7, y: 7 });
});

// --- moveTo: absolute teleport, the all-the-way member of the family -------

test("moveTo lands an entity on an absolute coordinate in one step", () => {
  let w = world(5, 5);
  let warp: Rule = {
    id: "warp",
    phase: "transition",
    each: { tag: "predator" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [{ moveTo: { to: { x: 9, y: 2 } } }],
  };
  step(w, [warp]);
  assert.deepEqual(w.entities.wolf.pos, { x: 9, y: 2 });
});

test("moveTo coordinates are expressions, rounded to the tile", () => {
  let w = world(5, 5);
  let warp: Rule = {
    id: "warp-expr",
    phase: "transition",
    each: { tag: "predator" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [{ moveTo: { to: { x: { add: [3, 4] }, y: { div: [13, 2] } } } }],
  };
  step(w, [warp]);
  // 13/2 = 6.5 rounds to 7.
  assert.deepEqual(w.entities.wolf.pos, { x: 7, y: 7 });
});

test("the entity-selector form teleports onto that entity's tile", () => {
  // A portal the wolf warps to by id - the "teleport to the matching exit
  // without hardcoding worldgen coordinates" idiom.
  let w = world(5, 5);
  w.entities.portal = {
    id: "portal",
    tags: ["portal"],
    stocks: {},
    pos: { x: 8, y: 3 },
    action: null,
  };
  let warp: Rule = {
    id: "warp-to-portal",
    phase: "transition",
    each: { tag: "predator" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [{ moveTo: { to: "portal" } }],
  };
  step(w, [warp]);
  assert.deepEqual(w.entities.wolf.pos, { x: 8, y: 3 });
});

test("an off-map moveTo throws as a rule_error and leaves the entity put", () => {
  let w = world(5, 5);
  let warp: Rule = {
    id: "warp-off-map",
    phase: "transition",
    each: { tag: "predator" },
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [{ moveTo: { to: { x: 99, y: 2 } } }],
  };
  let events = step(w, [warp]);
  assert.deepEqual(
    w.entities.wolf.pos,
    { x: 5, y: 5 },
    "unmoved on the bad teleport",
  );
  let errors = events.filter((e) => e.type === "rule_error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].text ?? "", /off the map/);
});

test("a moveTo effect is rejected in a buffered threshold phase", () => {
  assert.throws(
    () =>
      validateRule({
        id: "bad-warp",
        phase: "threshold",
        each: { tag: "predator" },
        do: [{ moveTo: { to: { x: 1, y: 1 } } }],
      } as Rule),
    /structural effects.*moveTo.*cannot run in a buffered/,
  );
});
