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
import { assertValidRule } from "../src/rule-schema.js";

// The kind selector's contract: `tag` is the loose form (matches the name in
// either slot - kind or tags), `kind` is the strict form (the entity IS that
// kind; a tag carrying the name doesn't count). These tests build tiny bare
// worlds with one entity per slot arrangement so each form's reach is exact.
function makeWorld(...entities: Entity[]): KernelWorld {
  let all: Record<string, Entity> = {
    world: { id: "world", tags: ["world"], stocks: { seen: stock(0) } },
  };
  for (let e of entities) all[e.id] = e;
  return { tick: 0, seed: 7, entities: all };
}

function thing(
  id: string,
  slots: { kind?: string; tags?: string[] },
  pos = { x: 5, y: 5 },
): Entity {
  return {
    id,
    kind: slots.kind,
    tags: slots.tags ?? [],
    stocks: { marker: stock(0) },
    pos,
    action: null,
  };
}

function marker(world: KernelWorld, id: string): number {
  return world.entities[id].stocks.marker.value;
}

// A rule that stamps every bound self, so a selector's reach is readable off
// the marker stocks afterwards.
function stampRule(each: unknown): Rule {
  return {
    id: "stamp",
    phase: "transition",
    each,
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [{ adjust: { target: "marker", by: 1 } }],
  } as Rule;
}

test("each kind is strict: a tag carrying the name does not bind", () => {
  let world = makeWorld(
    thing("is-wolf", { kind: "wolf" }),
    thing("wears-wolf", { tags: ["wolf"] }),
  );
  step(world, [stampRule({ kind: "wolf" })]);
  assert.equal(marker(world, "is-wolf"), 1, "the kind-wolf binds");
  assert.equal(marker(world, "wears-wolf"), 0, "the tag carrier does not");
});

test("each tag stays loose, and tag+kind together demand both", () => {
  let world = makeWorld(
    thing("is-wolf", { kind: "wolf" }),
    thing("wears-wolf", { tags: ["wolf"] }),
    thing("alpha", { kind: "wolf", tags: ["alpha"] }),
  );
  step(world, [stampRule({ tag: "wolf" })]);
  assert.equal(marker(world, "is-wolf"), 1, "tag matches the kind slot");
  assert.equal(marker(world, "wears-wolf"), 1, "tag matches the tags slot");
  assert.equal(marker(world, "alpha"), 1, "alpha IS a wolf, so it binds too");

  step(world, [stampRule({ tag: "alpha", kind: "wolf" })]);
  assert.equal(marker(world, "alpha"), 2, "both slots satisfied binds");
  assert.equal(marker(world, "is-wolf"), 1, "kind alone fails the tag half");
});

test("the kind condition is strict where the tag condition is loose", () => {
  let world = makeWorld(
    thing("is-wolf", { kind: "wolf" }),
    thing("wears-wolf", { tags: ["wolf"] }),
  );
  let sniff = (id: string, when: unknown): Rule =>
    ({
      id,
      phase: "transition",
      each: { tag: "wolf" },
      when,
      do: [{ adjust: { target: "marker", by: 1 } }],
    }) as Rule;
  step(world, [sniff("by-kind", { kind: "wolf" })]);
  assert.equal(marker(world, "is-wolf"), 1);
  assert.equal(marker(world, "wears-wolf"), 0, "kind cond skips the carrier");

  step(world, [sniff("by-tag", { tag: "wolf" })]);
  assert.equal(marker(world, "is-wolf"), 2, "tag cond matches the kind slot");
  assert.equal(marker(world, "wears-wolf"), 1);
});

test("colocated kind targets identity, not tag dressing", () => {
  let world = makeWorld(
    thing("actor", { tags: ["agent"] }, { x: 5, y: 5 }),
    thing("shrine", { kind: "shrine" }, { x: 5, y: 5 }),
    thing("decoy", { tags: ["shrine"] }, { x: 5, y: 5 }),
  );
  let bless: Rule = {
    id: "bless",
    phase: "transition",
    each: { tag: "agent" },
    when: { colocated: { kind: "shrine" } },
    do: [
      {
        adjust: {
          target: "marker",
          of: { colocated: { kind: "shrine" } },
          by: 1,
        },
      },
    ],
  } as Rule;
  step(world, [bless]);
  assert.equal(marker(world, "shrine"), 1, "the true shrine is adjusted");
  assert.equal(marker(world, "decoy"), 0, "the tagged decoy is not");
});

test("aggregates take a kind domain, including a dynamic {nameOf} one", () => {
  let world = makeWorld(
    thing("alpha", { kind: "wolf", tags: ["predator"] }),
    thing("wears-wolf", { tags: ["wolf"] }),
    thing("banner-1", { kind: "alpha" }),
    thing("banner-2", { kind: "alpha" }),
  );
  let censusRules: Rule[] = [
    {
      id: "census",
      phase: "transition",
      when: { cmp: "gte", left: { tick: true }, right: 0 },
      do: [{ set: { target: "seen", to: { count: { kind: "wolf" } } } }],
    } as Rule,
    // Each predator counts the entities whose KIND is its own id - the
    // ownership idiom carried over to the strict slot.
    {
      id: "banners",
      phase: "transition",
      each: { tag: "predator" },
      when: { cmp: "gte", left: { tick: true }, right: 0 },
      do: [
        {
          set: {
            target: "marker",
            to: { count: { kind: { nameOf: "self" } } },
          },
        },
      ],
    } as Rule,
  ];
  step(world, censusRules);
  assert.equal(
    world.entities.world.stocks.seen.value,
    1,
    "count{kind} sees only the true wolf",
  );
  assert.equal(marker(world, "alpha"), 2, "two banners carry alpha's kind");
});

test("an each with neither tag nor kind is rejected at add time", () => {
  assert.throws(
    () => validateRule({ id: "r", phase: "flow", each: {} } as Rule),
    /"each" needs a "tag" or a "kind"/,
  );
  validateRule({ id: "r", phase: "flow", each: { kind: "wolf" } } as Rule);
});

test("the schema rejects empty matchers and a tag+kind cond", () => {
  let base = {
    id: "r",
    description: "x",
    phase: "transition",
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: [],
  };
  assert.throws(() =>
    assertValidRule({ ...base, each: {} } as unknown as Rule),
  );
  assert.throws(() =>
    assertValidRule({
      ...base,
      when: { colocated: { range: 1 } },
    } as unknown as Rule),
  );
  assert.throws(() =>
    assertValidRule({
      ...base,
      when: { tag: "wolf", kind: "wolf" },
    } as unknown as Rule),
  );
  assertValidRule({
    ...base,
    each: { kind: "wolf" },
    when: { kind: "wolf" },
  } as unknown as Rule);
});
