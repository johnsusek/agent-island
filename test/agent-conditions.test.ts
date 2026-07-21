// Agent-to-agent conditions: the `colocated` selector/condition can now filter
// candidates with a `where` predicate and search a `range`, so a rule can bind
// to "another agent within N tiles whose <stock> ..." - the primitive behind
// contagion, combat, and other inter-agent dynamics. Tested at the kernel level
// (raw worlds + `step`) so the matching logic is isolated from the host.

import assert from "node:assert/strict";
import test from "node:test";

import {
  step,
  stock,
  type Entity,
  type KernelWorld,
  type Rule,
} from "../src/rules/kernel.js";

// Two entities at given positions, plus the required world singleton. Each agent
// carries an `infection` and `health` stock so rules can read/adjust them.
function worldWith(
  agents: { id: string; x: number; y: number; infection?: number }[],
  extraTags: Record<string, string[]> = {},
): KernelWorld {
  let entities: Record<string, Entity> = {
    world: { id: "world", tags: ["world"], stocks: {} },
  };
  for (let a of agents)
    entities[a.id] = {
      id: a.id,
      tags: ["agent", ...(extraTags[a.id] ?? [])],
      stocks: {
        infection: stock(a.infection ?? 0, 0, 100),
        health: stock(100, 0, 100),
      },
      pos: { x: a.x, y: a.y },
    };
  return { tick: 0, entities };
}

function infectionOf(world: KernelWorld, id: string) {
  return world.entities[id].stocks.infection.value;
}

// Contagion: an agent sharing a tile with an *infected other* catches it. The
// `where` predicate reads the candidate's infection, not the binding agent's.
const CONTAGION: Rule = {
  id: "contagion",
  phase: "threshold",
  each: { tag: "agent" },
  when: {
    colocated: {
      tag: "agent",
      where: { cmp: "gt", left: { stock: "infection" }, right: 0 },
    },
  },
  do: [{ adjust: { target: "infection", by: 1 } }],
};

test("a where-filtered colocated condition spreads infection to the healthy agent only", () => {
  // Carrier (infection 10) and a healthy agent share the origin tile.
  let world = worldWith([
    { id: "carrier", x: 0, y: 0, infection: 10 },
    { id: "healthy", x: 0, y: 0, infection: 0 },
  ]);

  step(world, [CONTAGION]);

  // The healthy agent saw an infected *other* and caught it (+1). The carrier
  // looked for another infected agent, found none (other:true excludes self,
  // and the healthy one was still at 0 this tick), so it did not climb.
  assert.equal(infectionOf(world, "healthy"), 1, "caught it from the carrier");
  assert.equal(infectionOf(world, "carrier"), 10, "carrier unchanged");
});

test("range 0 (the default) does not reach an adjacent tile; range 1 does", () => {
  let near: Rule = {
    id: "near-infected",
    phase: "threshold",
    each: { tag: "agent" },
    when: {
      colocated: {
        tag: "agent",
        where: { cmp: "gt", left: { stock: "infection" }, right: 0 },
        range: 1,
      },
    },
    do: [{ adjust: { target: "infection", by: 1 } }],
  };

  // Carrier at origin, healthy agent one tile away (chebyshev 1).
  let world = worldWith([
    { id: "carrier", x: 0, y: 0, infection: 10 },
    { id: "healthy", x: 1, y: 0, infection: 0 },
  ]);

  // Default range (0) on CONTAGION can't bridge the gap.
  step(world, [CONTAGION]);
  assert.equal(infectionOf(world, "healthy"), 0, "range 0 stays on-tile");

  // range:1 reaches the neighbour.
  step(world, [near]);
  assert.equal(infectionOf(world, "healthy"), 1, "range 1 reaches adjacent");
});

test("the `of` selector binds to the matched other, so an effect can hit it (combat)", () => {
  // A predator on the prey's tile drains the *prey's* health via `of`.
  let attack: Rule = {
    id: "maul",
    phase: "threshold",
    each: { tag: "predator" },
    when: { colocated: { tag: "prey" } },
    do: [
      {
        adjust: {
          target: "health",
          by: -5,
          of: { colocated: { tag: "prey" } },
        },
      },
    ],
  };
  let world = worldWith(
    [
      { id: "wolf", x: 2, y: 2 },
      { id: "deer", x: 2, y: 2 },
    ],
    { wolf: ["predator"], deer: ["prey"] },
  );

  step(world, [attack]);

  assert.equal(world.entities.deer.stocks.health.value, 95, "the prey is hurt");
  assert.equal(world.entities.wolf.stocks.health.value, 100, "predator intact");
});

test("other:false lets an agent match itself (range includes its own tile)", () => {
  // A self-including match: every agent whose own infection > 0 worsens. With
  // other:true (the default) this would never fire - the agent can't be its own
  // colocated "other".
  let fester: Rule = {
    id: "fester",
    phase: "threshold",
    each: { tag: "agent" },
    when: {
      colocated: {
        tag: "agent",
        other: false,
        where: { cmp: "gt", left: { stock: "infection" }, right: 0 },
      },
    },
    do: [{ adjust: { target: "infection", by: 1 } }],
  };
  let world = worldWith([{ id: "sick", x: 0, y: 0, infection: 5 }]);

  step(world, [fester]);

  assert.equal(infectionOf(world, "sick"), 6, "matched itself and worsened");
});

test("the bare-tag selector shorthand still resolves (backward compatible)", () => {
  // `of: {colocated: "prey"}` (a bare NameRef) must behave exactly like the
  // object form `of: {colocated: {tag: "prey"}}`.
  let attack: Rule = {
    id: "maul-short",
    phase: "threshold",
    each: { tag: "predator" },
    when: { colocated: { tag: "prey" } },
    do: [{ adjust: { target: "health", by: -5, of: { colocated: "prey" } } }],
  };
  let world = worldWith(
    [
      { id: "wolf", x: 0, y: 0 },
      { id: "deer", x: 0, y: 0 },
    ],
    { wolf: ["predator"], deer: ["prey"] },
  );

  step(world, [attack]);

  assert.equal(world.entities.deer.stocks.health.value, 95, "shorthand worked");
});
