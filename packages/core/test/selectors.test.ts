import assert from "node:assert/strict";
import test from "node:test";

import {
  step,
  stock,
  validateRule,
  type Entity,
  type KernelWorld,
  type Rule,
} from "../src/kernel.js";

// Selector tests want total control over entity insertion order (the
// deterministic tie-break every pick falls back to), so they build tiny bare
// worlds instead of the survival scenario.
function makeWorld(...entities: Entity[]): KernelWorld {
  let all: Record<string, Entity> = {
    world: { id: "world", tags: ["world"], stocks: {} },
  };
  for (let e of entities) all[e.id] = e;
  return { tick: 0, seed: 7, entities: all };
}

function agent(
  id: string,
  pos: { x: number; y: number },
  stocks: Record<string, number> = {},
): Entity {
  let s: Record<string, ReturnType<typeof stock>> = {};
  for (let [name, value] of Object.entries(stocks)) s[name] = stock(value);
  return { id, tags: ["agent"], stocks: s, pos, action: null };
}

function wolf(id: string, pos: { x: number; y: number }): Entity {
  return { id, tags: ["predator"], stocks: {}, pos, action: null };
}

function health(world: KernelWorld, id: string): number {
  return world.entities[id].stocks.health.value;
}

// A wolf-bites-someone transition, parameterized by how it picks its victim.
function biteRule(pick?: unknown): Rule {
  return {
    id: "bite",
    phase: "transition",
    each: { tag: "predator" },
    when: { colocated: { tag: "agent", range: 3 } },
    do: [
      {
        adjust: {
          target: "health",
          of: {
            colocated: { tag: "agent", range: 3, ...(pick ? { pick } : {}) },
          },
          by: -5,
        },
      },
    ],
  } as Rule;
}

test("without pick, the first match in insertion order is chosen (the historical default)", () => {
  let world = makeWorld(
    wolf("wolf", { x: 5, y: 5 }),
    agent("far", { x: 7, y: 5 }, { health: 50 }),
    agent("close", { x: 6, y: 5 }, { health: 50 }),
  );
  step(world, [biteRule()]);
  assert.equal(health(world, "far"), 45, "insertion order picks far first");
  assert.equal(health(world, "close"), 50);
});

test("pick nearest chooses by chebyshev distance, not insertion order", () => {
  let world = makeWorld(
    wolf("wolf", { x: 5, y: 5 }),
    agent("far", { x: 7, y: 5 }, { health: 50 }),
    agent("close", { x: 6, y: 5 }, { health: 50 }),
  );
  step(world, [biteRule("nearest")]);
  assert.equal(health(world, "close"), 45);
  assert.equal(health(world, "far"), 50);
});

test("pick lowest targets the weakest candidate; highest the strongest", () => {
  let world = makeWorld(
    wolf("wolf", { x: 5, y: 5 }),
    agent("sturdy", { x: 5, y: 5 }, { health: 50 }),
    agent("frail", { x: 6, y: 5 }, { health: 10 }),
  );
  step(world, [biteRule({ lowest: "health" })]);
  assert.equal(health(world, "frail"), 5, "the weakest takes the bite");
  assert.equal(health(world, "sturdy"), 50);

  let world2 = makeWorld(
    wolf("wolf", { x: 5, y: 5 }),
    agent("frail", { x: 6, y: 5 }, { health: 10 }),
    agent("sturdy", { x: 5, y: 5 }, { health: 50 }),
  );
  step(world2, [biteRule({ highest: "health" })]);
  assert.equal(health(world2, "sturdy"), 45, "the strongest takes the bite");
  assert.equal(health(world2, "frail"), 10);
});

test("pick random is a seeded draw: the same world replays to the same victim", () => {
  let world = makeWorld(
    wolf("wolf", { x: 5, y: 5 }),
    agent("a", { x: 5, y: 5 }, { health: 50 }),
    agent("b", { x: 5, y: 6 }, { health: 50 }),
    agent("c", { x: 6, y: 5 }, { health: 50 }),
  );
  let rules = [biteRule({ random: ["hunt"] })];
  let replay = structuredClone(world);
  step(world, rules);
  step(replay, rules);

  let bitten = ["a", "b", "c"].filter((id) => health(world, id) < 50);
  assert.equal(bitten.length, 1, "exactly one victim");
  for (let id of ["a", "b", "c"])
    assert.equal(health(replay, id), health(world, id), "replay matches");
});

test("aggregates bound by near/other count the neighbourhood, excluding self", () => {
  // Derived targets must be seeded (writeStock throws on a missing stock).
  let world = makeWorld(
    agent("a", { x: 10, y: 10 }, { neighbors: 0 }),
    agent("b", { x: 10, y: 11 }, { neighbors: 0 }),
    agent("c", { x: 20, y: 20 }, { neighbors: 0 }),
  );
  let neighbors: Rule = {
    id: "neighbors",
    phase: "derived",
    each: { tag: "agent" },
    target: "neighbors",
    value: { count: { tag: "agent", near: 1, other: true } },
  };
  step(world, [neighbors]);
  assert.equal(world.entities.a.stocks.neighbors.value, 1);
  assert.equal(world.entities.b.stocks.neighbors.value, 1);
  assert.equal(world.entities.c.stocks.neighbors.value, 0);
});

test("a near aggregate on the unpositioned world is an authoring error, isolated as rule_error", () => {
  let world = makeWorld(agent("a", { x: 10, y: 10 }));
  let bad: Rule = {
    id: "bad-census",
    phase: "derived",
    target: "crowding",
    value: { count: { tag: "agent", near: 2 } },
  };
  let events = step(world, [bad]);
  let err = events.find((e) => e.type === "rule_error");
  assert.ok(err, "the bad rule is reported, not thrown");
  assert.match(err!.text ?? "", /near/);
});

test("forEach fans an effect out over every match, self rebound to each", () => {
  let world = makeWorld(
    agent("actor", { x: 5, y: 5 }, { morale: 50 }),
    agent("left", { x: 4, y: 5 }, { morale: 50 }),
    agent("right", { x: 6, y: 5 }, { morale: 50 }),
    agent("distant", { x: 9, y: 9 }, { morale: 50 }),
  );
  world.entities.actor.tags.push("cheerleader");
  let cheer: Rule = {
    id: "cheer",
    phase: "transition",
    each: { tag: "cheerleader" },
    when: { colocated: { tag: "agent", range: 1 } },
    do: [
      {
        forEach: {
          colocated: { tag: "agent", range: 1 },
          do: [{ adjust: { target: "morale", by: 3 } }],
        },
      },
    ],
  } as Rule;
  step(world, [cheer]);
  assert.equal(world.entities.left.stocks.morale.value, 53);
  assert.equal(world.entities.right.stocks.morale.value, 53);
  assert.equal(world.entities.distant.stocks.morale.value, 50);
  assert.equal(
    world.entities.actor.stocks.morale.value,
    50,
    "other defaults to true - the actor is not its own audience",
  );
});

test("a numeric forEach runs in a buffered threshold phase", () => {
  let world = makeWorld(
    agent("actor", { x: 5, y: 5 }, { warmth: 10 }),
    agent("near", { x: 5, y: 6 }, { warmth: 10 }),
  );
  world.entities.actor.tags.push("hearthkeeper");
  let radiate: Rule = {
    id: "radiate",
    phase: "threshold",
    each: { tag: "hearthkeeper" },
    when: { colocated: { tag: "agent", range: 1 } },
    do: [
      {
        forEach: {
          colocated: { tag: "agent", range: 1 },
          do: [{ adjust: { target: "warmth", by: 2 } }],
        },
      },
    ],
  } as Rule;
  step(world, [radiate]);
  assert.equal(world.entities.near.stocks.warmth.value, 12);
});

test("validateRule rejects a threshold forEach that hides a structural effect", () => {
  let smite: Rule = {
    id: "smite",
    phase: "threshold",
    each: { tag: "agent" },
    when: { colocated: { tag: "agent", range: 1 } },
    do: [
      {
        forEach: {
          colocated: { tag: "agent", range: 1 },
          do: [{ destroy: {} }],
        },
      },
    ],
  } as Rule;
  assert.throws(() => validateRule(smite), /structural/);
});
