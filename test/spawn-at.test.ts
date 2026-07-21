// The literal-coordinate form of a spawn anchor: `at: {x, y}` places the spawn
// on an absolute tile instead of copying an entity's position. Both coordinates
// are expressions, so a world rule can scatter an airdrop with `rand` - and
// because no anchor entity is needed, a world-bound rule (whose self has no
// position) can now conjure positioned entities at all. Off-map coordinates
// throw (surfacing as a rule_error) rather than minting an entity no tile owns.
// Tested at the kernel level, like the move effect, so the placement logic is
// isolated from the host's grid.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginTick,
  runRulesForTick,
  stock,
  type Rule,
  type KernelWorld,
  type TerrainLookup,
} from "../src/rules/kernel.js";

// The world singleton plus one positioned character to anchor-spawn against.
function world(): KernelWorld {
  return {
    tick: 0,
    entities: {
      world: { id: "world", tags: ["world"], stocks: {} },
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: { health: stock(100) },
        pos: { x: 5, y: 5 },
        action: null,
      },
    },
  };
}

// A bounded 11x11 grid, the off-map signal the coordinate bounds check keys on.
const grid11: TerrainLookup = (x, y) =>
  x >= 0 && y >= 0 && x < 11 && y < 11 ? "plains" : undefined;

function step(w: KernelWorld, rules: Rule[]) {
  let before = beginTick(w);
  return runRulesForTick(w, rules, before, [], grid11);
}

// A world-bound rule (no `each`, so self is the positionless world singleton)
// that drops a crate on the given tile on tick 1.
function dropRule(at: unknown): Rule {
  return {
    id: "airdrop",
    phase: "transition",
    when: { cmp: "eq", left: { tick: true }, right: 1 },
    do: [{ spawn: { id: "crate-1", tags: ["crate"], at } }],
  } as Rule;
}

test("a world rule spawns an entity at literal coordinates", () => {
  let w = world();
  step(w, [dropRule({ x: 8, y: 2 })]);
  assert.deepEqual(w.entities["crate-1"].pos, { x: 8, y: 2 });
  assert.deepEqual(w.entities["crate-1"].tags, ["crate"]);
});

test("coordinates are expressions, rounded to the tile", () => {
  let w = world();
  step(w, [dropRule({ x: { add: [3, 4] }, y: { div: [13, 2] } })]);
  // 13/2 = 6.5 rounds to 7.
  assert.deepEqual(w.entities["crate-1"].pos, { x: 7, y: 7 });
});

test("a rand-scattered spawn is deterministic for a given seed", () => {
  let scatter = dropRule({
    x: { round: { rand: [0, 10, "drop-x"] } },
    y: { round: { rand: [0, 10, "drop-y"] } },
  });
  let a = world();
  a.seed = 7;
  let b = world();
  b.seed = 7;
  step(a, [scatter]);
  step(b, [scatter]);
  assert.ok(a.entities["crate-1"].pos, "the crate landed somewhere");
  assert.deepEqual(a.entities["crate-1"].pos, b.entities["crate-1"].pos);
});

test("an off-map coordinate throws as a rule_error and spawns nothing", () => {
  let w = world();
  let events = step(w, [dropRule({ x: 99, y: 2 })]);
  assert.equal(w.entities["crate-1"], undefined);
  let errors = events.filter((e) => e.type === "rule_error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].text ?? "", /off the map/);
});

test("the entity-selector form of at still anchors to that entity's tile", () => {
  let w = world();
  step(w, [dropRule("ara")]);
  assert.deepEqual(w.entities["crate-1"].pos, { x: 5, y: 5 });
});

// An agent-bound rule (self = the positioned character) that drops a crate on
// tick 1 at coordinates the rule computes, so posX/posY resolve to "self".
function dropFromAra(at: unknown): Rule {
  return {
    id: "seed",
    phase: "transition",
    each: { tag: "agent" },
    when: { cmp: "eq", left: { tick: true }, right: 1 },
    do: [{ spawn: { id: "crate-1", tags: ["crate"], at } }],
  } as Rule;
}

test("posX/posY place a spawn relative to an entity's own tile", () => {
  let w = world(); // ara stands at (5, 5)
  step(w, [
    dropFromAra({
      x: { add: [{ posX: "self" }, 2] },
      y: { sub: [{ posY: "self" }, 1] },
    }),
  ]);
  assert.deepEqual(
    w.entities["crate-1"].pos,
    { x: 7, y: 4 },
    "the crate landed two east and one north of ara",
  );
});

test("posX/posY read the position of any selector, not just self", () => {
  let w = world();
  // A world-bound rule (self has no position) can still read ara's tile.
  step(w, [dropRule({ x: { posX: "ara" }, y: { posY: "ara" } })]);
  assert.deepEqual(w.entities["crate-1"].pos, { x: 5, y: 5 });
});

test("posX on a positionless entity throws as a rule_error", () => {
  let w = world();
  let events = step(w, [dropRule({ x: { posX: "world" }, y: 2 })]);
  assert.equal(w.entities["crate-1"], undefined, "nothing spawned");
  let errors = events.filter((e) => e.type === "rule_error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].text ?? "", /no position/);
});

test("skipOffMap turns an off-map spawn into a silent no-op", () => {
  let w = world();
  let events = step(w, [dropRule({ x: 99, y: 2, skipOffMap: true })]);
  assert.equal(w.entities["crate-1"], undefined, "no entity minted off-map");
  let errors = events.filter((e) => e.type === "rule_error");
  assert.equal(errors.length, 0, "and no rule_error - it just skipped");
});

test("skipOffMap still spawns normally when the target is on-map", () => {
  let w = world();
  step(w, [dropRule({ x: 3, y: 4, skipOffMap: true })]);
  assert.deepEqual(
    w.entities["crate-1"].pos,
    { x: 3, y: 4 },
    "an on-map skipOffMap spawn lands like any other",
  );
});

// --- snapToPassable ---------------------------------------------------------

// A passability oracle that walls off the x === 3 column.
const wallAt3 = (x: number, _y: number) => x !== 3;

function stepWithPassable(
  w: KernelWorld,
  rules: Rule[],
  passable: (x: number, y: number) => boolean,
) {
  let before = beginTick(w);
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

test("snapToPassable relocates a blocked landing to the nearest open tile", () => {
  let w = world();
  stepWithPassable(
    w,
    [dropRule({ x: 3, y: 5, snapToPassable: true })],
    wallAt3,
  );
  // Ring 1 around (3,5), scanned row-major, opens at (2,4).
  assert.deepEqual(w.entities["crate-1"].pos, { x: 2, y: 4 });
});

test("snapToPassable leaves an already-open landing alone", () => {
  let w = world();
  stepWithPassable(
    w,
    [dropRule({ x: 8, y: 2, snapToPassable: true })],
    wallAt3,
  );
  assert.deepEqual(w.entities["crate-1"].pos, { x: 8, y: 2 });
});

test("without snapToPassable a blocked landing is taken at face value", () => {
  let w = world();
  stepWithPassable(w, [dropRule({ x: 3, y: 5 })], wallAt3);
  assert.deepEqual(w.entities["crate-1"].pos, { x: 3, y: 5 });
});

test("a fully blocked map surfaces as a rule_error, not an unreachable entity", () => {
  let w = world();
  let events = stepWithPassable(
    w,
    [dropRule({ x: 3, y: 5, snapToPassable: true })],
    () => false,
  );
  assert.equal(w.entities["crate-1"], undefined, "nothing spawned");
  let errors = events.filter((e) => e.type === "rule_error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].text ?? "", /no passable tile/);
});
