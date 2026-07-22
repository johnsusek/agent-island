// Inscribe (engine.inscribe): the durable member of the speak family. A
// character writes a sign on the tile they stand on; the words outlive the
// writer and are served only from arm's reach, as a live sighting. These tests
// pin the properties that make writing a real epistemic channel: unsigned
// text (the sign never names its author), witnesses who see the act but not
// the words, overwrite-by-anyone, one writing per tick, and the DSL/GM seams
// (spawn effect and GM fixtures carrying pre-written text).

import test from "node:test";
import assert from "node:assert/strict";
import {
  beginTick,
  runRulesForTick,
  type KernelWorld,
  type Rule,
  type TerrainLookup,
} from "../src/rules/kernel.js";
import { SIGHT } from "../src/rules/space.js";
import type { WorldEngine } from "../src/rules/engine.js";
import { describeSense } from "../src/sense-prose.js";
import { makeSurvivalEngine, placeAt, runToIdle } from "./helpers.js";

// A minimal multi-tick, ground-holding build action - survival.json's own
// build_shelter moved to its own test fixture, so the two occupancy tests
// below (which only care about a spawn-with-blocking-occupancy action, not
// shelters specifically) mint an equivalent rule inline instead.
function addBuildRule(engine: WorldEngine) {
  engine.addRule({
    id: "build_shelter",
    kind: "action",
    duration: 8,
    requires: { cmp: "gte", left: { stock: "wood" }, right: 4 },
    requireReason: "need 4 carried wood",
    do: [
      { adjust: { target: "wood", by: -4 } },
      {
        spawn: {
          kind: "shelter",
          idPrefix: "shelter",
          tags: [],
          occupancy: "blocking",
        },
      },
    ],
    emit: { type: "shelter_complete" },
  });
}

// Displace an agent `dist` tiles along the x axis from `from`, leaning toward
// whichever side of the map actually has that much room.
function placeAway(
  engine: WorldEngine,
  id: string,
  from: { x: number; y: number },
  dist: number,
) {
  let width = engine.getMap().width;
  let x = from.x + dist < width ? from.x + dist : from.x - dist;
  placeAt(engine, id, x, from.y);
}

test("inscribe raises an unsigned sign on the writer's tile", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let here = engine.getObservation(ara).you.position;

  let result = engine.inscribe(ara, "the well is northeast");
  assert.equal(result.ok, true);
  assert.equal(result.rewrote, false);

  let snap = engine.snapshot();
  let sign = snap.world.entities[result.sign];
  assert.equal(sign.kind, "sign");
  assert.equal(
    sign.occupancy,
    "tile",
    "a sign is on the map and reserves its ground, but never blocks a route - characters walk and stand on it",
  );
  assert.equal(sign.text, "the well is northeast");
  assert.deepEqual(sign.pos, { x: here.x, y: here.y });
  // Unsigned: the entity records no author field anywhere.
  assert.ok(!("author" in sign), "the sign carries no attribution");

  // Writing is world state: it rides the snapshot like any entity.
  engine.restore(snap);
  assert.equal(
    engine.snapshot().world.entities[result.sign].text,
    "the well is northeast",
  );
});

test("adjacent characters read the words; farther sight shows only the sign", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  let cy = engine.addAgent("Cy").id;
  let here = engine.getObservation(ara).you.position;
  let { sign } = engine.inscribe(ara, "the river floods in spring");
  placeAt(engine, bo, here.x + 1, here.y); // arm's reach: reads
  placeAt(engine, cy, here.x + 3, here.y); // in sight, out of reach: sees only
  engine.tick(); // let the moved characters perceive their new surroundings

  let atSign = (r: any) => r.inSight.find((t: any) => t.name === sign);
  let boView = engine.sense(bo, "situation");
  assert.equal(atSign(boView)?.inscription, "the river floods in spring");
  assert.match(
    describeSense(boView),
    /reads: "the river floods in spring"/,
    "the prose quotes the sign verbatim",
  );

  let cyView = engine.sense(cy, "situation");
  assert.ok(atSign(cyView), "the sign itself is visible at distance");
  assert.equal(
    atSign(cyView).inscription,
    undefined,
    "the words are served only from arm's reach",
  );
  assert.doesNotMatch(describeSense(cyView), /floods in spring/);

  // The writer reads their own sign from on top of it.
  assert.equal(
    atSign(engine.sense(ara, "situation"))?.inscription,
    "the river floods in spring",
  );
});

test("anyone may overwrite: rewriting replaces the words in place", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  let here = engine.getObservation(ara).you.position;

  let first = engine.inscribe(ara, "all is well");
  // Ara moves on; Bo steps onto the sign and rewrites it.
  placeAway(engine, ara, here, 4);
  placeAt(engine, bo, here.x, here.y);
  let second = engine.inscribe(bo, "beware the eastern woods");
  assert.equal(second.sign, first.sign, "same sign, new words");
  assert.equal(second.rewrote, true);

  let entities = engine.snapshot().world.entities;
  assert.equal(entities[first.sign].text, "beware the eastern woods");
  assert.equal(
    Object.values(entities).filter((e: any) => e.kind === "sign").length,
    1,
    "rewrite mints no second sign",
  );
});

test("one writing per tick; the budget resets when the world advances", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.inscribe(ara, "first words");
  assert.throws(() => engine.inscribe(ara, "second words"), /already written/);
  engine.tick();
  assert.equal(engine.inscribe(ara, "second words").ok, true);
});

test("a tile owned by another token refuses writing", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let patch: any = Object.values(engine.snapshot().world.entities).find(
    (e: any) => e.kind === "food" && e.pos,
  );
  assert.ok(patch, "survival scatters food");
  placeAt(engine, ara, patch.pos.x, patch.pos.y);
  assert.throws(
    () => engine.inscribe(ara, "this patch is mine"),
    /already stands here/,
  );
});

test("inscriptions are bounded and non-empty", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  assert.throws(() => engine.inscribe(ara, "x".repeat(301)), /1 to 300/);
  assert.throws(() => engine.inscribe(ara, "   "), /1 to 300/);
});

test("witnesses in sight see the act but never the words", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  let cy = engine.addAgent("Cy").id;
  let here = engine.getObservation(ara).you.position;
  placeAway(engine, bo, here, SIGHT); // at the edge: witnesses
  placeAway(engine, cy, here, SIGHT + 1); // one past it: doesn't

  let before = engine.cursor();
  engine.inscribe(ara, "the well is poisoned");

  let boSaw = engine
    .visibleEventsSince(bo, before)
    .filter((e) => e.type === "inscribed");
  assert.equal(boSaw.length, 1, "a watcher sees the writing happen");
  assert.match(boSaw[0].text!, /Ara/, "the act is attributed to its witness");
  assert.doesNotMatch(
    boSaw[0].text!,
    /poisoned/,
    "the words never ride the event - reading takes walking up",
  );
  assert.equal(
    engine.visibleEventsSince(cy, before).filter((e) => e.type === "inscribed")
      .length,
    0,
    "beyond sight the act goes unseen",
  );
});

test("a sign holds its ground: builds are refused on it, and allowed off it", () => {
  let engine = makeSurvivalEngine();
  addBuildRule(engine);
  let ara = engine.addAgent("Ara").id;
  let snap = engine.snapshot();
  snap.world.entities[ara].stocks.wood = { value: 10, min: 0, max: 25 };
  engine.restore(snap);
  let here = engine.getObservation(ara).you.position;

  engine.inscribe(ara, "this ground is claimed");
  // build_shelter carries no colocated-token guard of its own (only "no
  // shelter underfoot"), so this pins the kernel's exclusive-ground backstop:
  // refused at commit time, before the build's time or wood is spent.
  assert.throws(
    () => engine.commitIntent(ara, { type: "build_shelter" }),
    /holds this ground/,
  );
  assert.ok(
    !engine.getObservation(ara).you.action,
    "no action started - nothing was spent walking into the refusal",
  );

  // One step off the sign, the same build commits fine.
  placeAt(engine, ara, here.x + 1, here.y);
  let committed = engine.commitIntent(ara, { type: "build_shelter" });
  assert.equal(committed.accepted, true);
  assert.equal(committed.approaching, false, "committed in place, not walking");
});

// The bug this whole `occupancy` field exists to kill: a build that carries no
// self-guard used to spawn structure after structure onto one tile, each one
// silently falling off the grid while the builder was told it succeeded (a live
// world reached five shelters stacked on a sign). Drive one build to completion,
// confirm it actually took the tile, then confirm a second build on the same
// tile is refused before any wood is spent - and that one structure remains.
test("a finished build holds its tile: a second build on it is refused", () => {
  let engine = makeSurvivalEngine();
  addBuildRule(engine);
  let ara = engine.addAgent("Ara").id;
  let snap = engine.snapshot();
  snap.world.entities[ara].stocks.wood = { value: 8, min: 0, max: 25 };
  engine.restore(snap);
  let here = engine.getObservation(ara).you.position;

  assert.equal(
    engine.commitIntent(ara, { type: "build_shelter" }).accepted,
    true,
  );
  runToIdle(engine, ara);

  let shelters = () =>
    Object.values(engine.snapshot().world.entities).filter(
      (e) => e.kind === "shelter",
    );
  assert.equal(shelters().length, 1, "the build produced exactly one shelter");
  let built = shelters()[0];
  assert.deepEqual(built.pos, here, "it stands on the tile Ara built it on");
  assert.equal(built.occupancy, "blocking", "and it takes (holds) the ground");

  // Wood is back up and Ara has not moved, so only the held ground stops a
  // second build - refused at commit, before the 4 wood is spent.
  snap = engine.snapshot();
  snap.world.entities[ara].stocks.wood = { value: 8, min: 0, max: 25 };
  engine.restore(snap);
  assert.throws(
    () => engine.commitIntent(ara, { type: "build_shelter" }),
    /(holds this ground|shelter)/,
  );
  assert.equal(shelters().length, 1, "still exactly one shelter, not stacked");
  assert.equal(
    engine.snapshot().world.entities[ara].stocks.wood.value,
    8,
    "no wood was spent walking into the refusal",
  );
});

test("a GM fixture carries a pre-written inscription", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let here = engine.getObservation(ara).you.position;
  let { entity } = engine.spawnEntity({
    id: "lore-stone",
    kind: "sign",
    pos: { x: here.x, y: here.y },
    occupancy: "tile" as const,
    text: "here fell the first colony",
  });
  assert.equal(entity.text, "here fell the first colony");
  let view: any = engine.sense(ara, "situation");
  assert.equal(
    view.inSight.find((t: any) => t.name === "lore-stone")?.inscription,
    "here fell the first colony",
  );
});

// --- the DSL seam, at the kernel level like the other spawn tests ---------

const grid11: TerrainLookup = (x, y) =>
  x >= 0 && y >= 0 && x < 11 && y < 11 ? "plains" : undefined;

function bareWorld(): KernelWorld {
  return {
    tick: 0,
    entities: { world: { id: "world", tags: ["world"], stocks: {} } },
  };
}

function step(w: KernelWorld, rules: Rule[]) {
  let before = beginTick(w);
  return runRulesForTick(w, rules, before, [], grid11);
}

function seedRule(text: string): Rule {
  return {
    id: "seed-sign",
    phase: "transition",
    when: { cmp: "eq", left: { tick: true }, right: 1 },
    do: [
      {
        spawn: {
          id: "warning-1",
          kind: "sign",
          tags: [],
          occupancy: "tile",
          at: { x: 4, y: 4 },
          text,
        },
      },
    ],
  } as Rule;
}

test("a rule spawns a sign carrying literal text", () => {
  let w = bareWorld();
  step(w, [seedRule("turn back")]);
  assert.equal(w.entities["warning-1"].text, "turn back");
});

test("an over-long spawn inscription surfaces as a rule_error, not an entity", () => {
  let w = bareWorld();
  let events = step(w, [seedRule("x".repeat(301))]);
  assert.ok(events.some((e) => e.type === "rule_error"));
  assert.equal(w.entities["warning-1"], undefined);
});
