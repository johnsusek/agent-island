// Noun speculation (docs/speculative-physics.md): the companion to the verb
// feed. When a character reaches for a THING that doesn't exist - an unknown
// resource on a real verb, or an unknown arg on an unknown verb - the world
// journals a noun-level speculation the Oracle can mint a resource for, while
// still refusing the action itself.

import assert from "node:assert/strict";
import test from "node:test";

import type { WorldEngine } from "../src/rules/engine.js";
import { makeSurvivalEngine } from "./helpers.js";

test("an unknown noun on a known verb journals a noun_attempt and still refuses", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.addAgent("Bo");
  engine.setStock(ara, "food", 3);

  // give is a real verb; "clay" is not a real resource - the order blocks,
  // and the reach is journaled as a noun speculation.
  let result = engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "clay" }],
  });
  assert.equal(result.order?.status, "blocked");

  let nouns = engine.getSpeculativeNouns();
  let clay = nouns.find((n) => n.noun === "clay");
  assert.ok(clay, "clay surfaced as a reached-for noun");
  assert.ok(
    clay!.verbs.includes("give"),
    "the verb it was reached for rode along",
  );
  assert.ok(clay!.distinctActors.includes(ara), "the reacher is recorded");
});

test("known nouns are filtered out - a real resource misused does not surface", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.addAgent("Bo");
  // health IS a real stock (just not givable). It must not appear as an
  // unknown noun - it exists, the verb just rejected it for another reason.
  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "health" }],
  });
  let nouns = engine.getSpeculativeNouns();
  assert.equal(
    nouns.some((n) => n.noun === "health"),
    false,
    "a known stock is never a reached-for noun",
  );

  // ...and the character is never TOLD otherwise. The filter has to run where
  // the event is journaled, not only where the feed is read: "no such thing
  // answers here" about a stock on their own status line is a lie, and one
  // that would then sit in the log forever being rescanned and re-discarded.
  assert.equal(
    engine
      .visibleEventsSince(ara, 0)
      .some((e) => e.type === "noun_attempt" && e.noun === "health"),
    false,
    "no noun_attempt event is raised for a thing that plainly exists",
  );
});

test("a reached-for noun that is really a sentence is not a petition", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  // An unknown verb's args are free text, so they carry prose as often as
  // nouns. A resource the Oracle could mint is a word or two; a clause is
  // not, and clustering it would only bury the real nouns.
  engine.commitIntent(ara, {
    type: "pray",
    to: "the old gods of the mountain",
    expectation: "ask for rain",
  });

  assert.equal(
    engine.getSpeculativeNouns().some((n) => n.noun.includes("gods")),
    false,
    "a sentence fragment is not clustered as a noun",
  );
});

test("nouns are harvested from an unknown verb's args too", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  // smelt is not a verb; "ore" is not a thing. The unknown-verb attempt
  // journals its args, and the noun feed mines "ore" out of them.
  engine.commitIntent(ara, {
    type: "smelt",
    resource: "ore",
    expectation: "turn ore into metal",
  });

  let nouns = engine.getSpeculativeNouns();
  let ore = nouns.find((n) => n.noun === "ore");
  assert.ok(ore, "ore surfaced from the unknown verb's args");
  assert.ok(ore!.verbs.includes("smelt"), "the verb it rode on is recorded");
});

test("the same noun across several verbs clusters into one entry", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.commitIntent(ara, {
    type: "shape",
    material: "clay",
    expectation: "shape clay into a pot",
  });
  engine.commitIntent(ara, {
    type: "fire",
    material: "clay",
    expectation: "fire the clay hard",
  });

  let nouns = engine.getSpeculativeNouns();
  let clay = nouns.find((n) => n.noun === "clay");
  assert.ok(clay, "clay clustered");
  assert.equal(clay!.count, 2, "both reaches counted");
  assert.deepEqual(
    clay!.verbs.sort(),
    ["fire", "shape"],
    "both verbs attached",
  );
});

test("availability probing does not journal noun_attempts", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.addAgent("Bo");
  engine.setStock(ara, "food", 3);

  // Reading observations repeatedly probes action availability with empty and
  // sampled args - none of that should produce noun speculations.
  for (let i = 0; i < 5; i += 1) engine.getObservation(ara);
  engine.tick();
  engine.getObservation(ara);

  assert.equal(
    engine.getSpeculativeNouns().length,
    0,
    "probing surfaced no phantom nouns",
  );
});

test("list_speculative_attempts returns both verb clusters and nouns", async () => {
  let engine: WorldEngine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.commitIntent(ara, {
    type: "weave",
    material: "reeds",
    expectation: "weave reeds into a basket",
  });

  // Exercise the GM feed shape directly off the engine (the coordinator wraps
  // these two into { clusters, nouns }).
  let clusters = engine.getSpeculativeAttempts();
  let nouns = engine.getSpeculativeNouns();
  assert.ok(
    clusters.some((c) => c.verb === "weave"),
    "the verb cluster is present",
  );
  assert.ok(
    nouns.some((n) => n.noun === "reeds"),
    "the noun is present alongside it",
  );
});
