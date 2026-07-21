// Seeded noise: the kernel's only randomness, and it is reproducible by design.
// A `noise`/`rand` draw is a pure hash of (world seed, tick, bound entity, salt
// keys) rather than a sequential PRNG, so a snapshot replays the same rolls and
// distinct salt keys give independent streams. These tests pin those properties
// down — they are what make stochastic events (raids, weather) safe to add to a
// world that must save/restore tick-for-tick.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  step,
  stock,
  type Rule,
  type KernelWorld,
} from "../src/rules/kernel.js";

// A world whose `world` singleton carries a `roll` stock we overwrite each tick
// from a derived rule, plus a couple of per-agent entities so we can check that
// the same draw differs by entity id.
function world(seed: number): KernelWorld {
  return {
    tick: 0,
    seed,
    entities: {
      world: {
        id: "world",
        tags: ["world"],
        stocks: {
          roll: stock(0, 0, 1e9),
          a: stock(0, 0, 1e9),
          b: stock(0, 0, 1e9),
        },
      },
      ada: {
        id: "ada",
        tags: ["agent"],
        stocks: { roll: stock(0, 0, 1e9) },
        action: null,
      },
      bram: {
        id: "bram",
        tags: ["agent"],
        stocks: { roll: stock(0, 0, 1e9) },
        action: null,
      },
    },
  };
}

// Drive a world `ticks` ticks and return the world-singleton's `roll` each tick.
function rolls(w: KernelWorld, rule: Rule, ticks: number): number[] {
  let out: number[] = [];
  for (let i = 0; i < ticks; i++) {
    step(w, [rule]);
    out.push(w.entities.world.stocks.roll.value);
  }
  return out;
}

const noiseRoll: Rule = {
  id: "roll",
  phase: "derived",
  target: "roll",
  value: { noise: ["x"] },
};

test("noise is in [0,1)", () => {
  let seq = rolls(world(7), noiseRoll, 200);
  for (let v of seq) assert.ok(v >= 0 && v < 1, `draw ${v} out of [0,1)`);
});

test("noise is deterministic: same seed replays the same sequence", () => {
  let a = rolls(world(7), noiseRoll, 50);
  let b = rolls(world(7), noiseRoll, 50);
  assert.deepEqual(a, b);
});

test("noise varies tick to tick (not a constant)", () => {
  let seq = rolls(world(7), noiseRoll, 50);
  assert.ok(new Set(seq).size > 40, "expected mostly-distinct per-tick draws");
});

test("a different seed yields a different sequence", () => {
  let a = rolls(world(7), noiseRoll, 50);
  let b = rolls(world(8), noiseRoll, 50);
  assert.notDeepEqual(a, b);
});

test("distinct salt keys decorrelate streams on the same tick", () => {
  // Two derived rules on the same world/tick with different keys must (almost
  // always) disagree; identical keys must agree exactly.
  let w = world(7);
  step(w, [
    { id: "a", phase: "derived", target: "a", value: { noise: ["one"] } },
    { id: "b", phase: "derived", target: "b", value: { noise: ["two"] } },
  ]);
  assert.notEqual(
    w.entities.world.stocks.a.value,
    w.entities.world.stocks.b.value,
  );

  let w2 = world(7);
  step(w2, [
    { id: "a", phase: "derived", target: "a", value: { noise: ["same"] } },
    { id: "b", phase: "derived", target: "b", value: { noise: ["same"] } },
  ]);
  assert.equal(
    w2.entities.world.stocks.a.value,
    w2.entities.world.stocks.b.value,
  );
});

test("the same key draws differently per bound entity", () => {
  // A per-agent derived rule: ada and bram share seed/tick/key but differ by id.
  let w = world(7);
  step(w, [
    {
      id: "roll",
      phase: "derived",
      each: { tag: "agent" },
      target: "roll",
      value: { noise: ["x"] },
    },
  ]);
  assert.notEqual(
    w.entities.ada.stocks.roll.value,
    w.entities.bram.stocks.roll.value,
  );
});

test("rand maps a draw into [lo, hi)", () => {
  let w = world(7);
  let seq = rolls(
    w,
    { id: "roll", phase: "derived", target: "roll", value: { rand: [10, 20] } },
    200,
  );
  for (let v of seq) assert.ok(v >= 10 && v < 20, `rand ${v} out of [10,20)`);
  // Not pinned to a bound — a healthy spread across the interval.
  assert.ok(
    Math.max(...seq) > 18 && Math.min(...seq) < 12,
    "rand spread too narrow",
  );
});

test("rand and noise with the same salt are independent streams", () => {
  // rand namespaces its keys under "rand", so a bare noise:["k"] and rand over
  // [0,1) with salt "k" must not coincide.
  let w = world(7);
  step(w, [
    { id: "a", phase: "derived", target: "a", value: { noise: ["k"] } },
    { id: "b", phase: "derived", target: "b", value: { rand: [0, 1, "k"] } },
  ]);
  assert.notEqual(
    w.entities.world.stocks.a.value,
    w.entities.world.stocks.b.value,
  );
});

test("an unseeded world still draws (seed defaults to 0) and stays in range", () => {
  // Pre-RNG snapshots restore without a seed; a missing seed must read as 0, not
  // crash or fall out of [0,1).
  let w: KernelWorld = {
    tick: 0,
    entities: {
      world: {
        id: "world",
        tags: ["world"],
        stocks: { roll: stock(0, 0, 1e9) },
      },
    },
  };
  let seq = rolls(w, noiseRoll, 30);
  for (let v of seq) assert.ok(v >= 0 && v < 1);
});

test("a stochastic threshold fires at roughly its configured rate", () => {
  // The headline use case: a ~10%-per-tick event. Over 2000 ticks the empirical
  // rate should land near 0.1 — proof the draws are uniform enough to drive a
  // storyteller, and that the count is itself deterministic for a given seed.
  let w = world(42);
  let fires = 0;
  let rule: Rule = {
    id: "raid",
    phase: "threshold",
    when: { cmp: "lt", left: { noise: ["raid"] }, right: 0.1 },
    do: [{ adjust: { target: "roll", by: 1 } }],
  };
  for (let i = 0; i < 2000; i++) step(w, [rule]);
  fires = w.entities.world.stocks.roll.value;
  assert.ok(fires > 150 && fires < 250, `expected ~200 fires, got ${fires}`);
});
