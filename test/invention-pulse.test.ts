import test from "node:test";
import assert from "node:assert/strict";

import { assertSpeculative, makeSurvivalEngine } from "./helpers.js";

// The invention digest (engine.getInventionPulse / pulse.invention) answers a
// question the tension pulse cannot: is the world still being AUTHORED? Genesis
// cb263000 ran 1,370 ticks of busy travel and chat after the last real attempt,
// and its Directors read that activity as health. These fields are what would
// have shown the flatline instead.

// A minimal action rule an agent can start with no preconditions, so a test can
// register adoption without staging a whole survival chain.
function freeAction(id: string, aliases?: string[]) {
  return {
    id,
    kind: "action",
    duration: 1,
    description: id,
    ...(aliases ? { aliases } : {}),
    do: [{ adjust: { target: "food", by: 1 } }],
  } as never;
}

test("a fresh world reports an empty invention pulse, all quiet", () => {
  let engine = makeSurvivalEngine();
  let inv = engine.getInventionPulse();

  assert.equal(inv.ticksSinceLastSpeculativeAttempt, null);
  assert.equal(inv.ticksSinceLastNounAttempt, null);
  assert.equal(inv.unansweredPetitions, 0);
  assert.equal(inv.oldestPetitionAge, null);
  assert.equal(inv.medianMintLatency, null);
  assert.equal(inv.meanMintLatency, null);
  assert.deepEqual(inv.ruleUseCounts, {});
  assert.deepEqual(inv.unusedRuleIds, []);
});

test("the invention digest rides the main pulse object", () => {
  let engine = makeSurvivalEngine();
  assert.ok("invention" in engine.getPulse(), "pulse carries an invention section");
});

test("an unanswered attempt raises the petition backlog and ages", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  assertSpeculative(engine.commitIntent(ara, { type: "raise_totem" }));
  engine.tick();
  engine.tick();

  let inv = engine.getInventionPulse();
  assert.equal(inv.unansweredPetitions, 1);
  assert.equal(inv.ticksSinceLastSpeculativeAttempt, 2);
  assert.equal(inv.oldestPetitionAge, 2);
});

test("minting a verb clears its petition, resets the mint clock, and records latency", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  assertSpeculative(engine.commitIntent(ara, { type: "raise_totem" }));
  // Let the petition age before the answer arrives.
  for (let i = 0; i < 5; i += 1) engine.tick();

  engine.addRule(freeAction("raise_totem"));

  let inv = engine.getInventionPulse();
  assert.equal(inv.unansweredPetitions, 0, "the ratified verb drops out of the backlog");
  assert.equal(inv.ticksSinceLastMint, 0, "a mint just landed");
  assert.equal(inv.medianMintLatency, 5, "petition-to-rule latency was five ticks");
  assert.equal(inv.meanMintLatency, 5);
});

test("one mint answering a synonym cluster records a single latency, from the oldest attempt", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  assertSpeculative(engine.commitIntent(ara, { type: "cup_water" }));
  engine.tick();
  engine.tick();
  assertSpeculative(engine.commitIntent(ara, { type: "kneel_drink" }));

  engine.addRule(freeAction("drink_deep", ["cup_water", "kneel_drink"]));

  let inv = engine.getInventionPulse();
  // Earliest attempt (cup_water) was two ticks before the second and both were
  // answered together: one sample, measured from the oldest.
  assert.equal(inv.medianMintLatency, 2);
});

test("a rejected attempt is a settled judgment, not an open petition", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  assertSpeculative(engine.commitIntent(ara, { type: "summon_infinite_food" }));
  assert.equal(engine.getInventionPulse().unansweredPetitions, 1);

  engine.rejectSpeculation("summon_infinite_food", "food cannot appear from nothing");
  assert.equal(
    engine.getInventionPulse().unansweredPetitions,
    0,
    "the rejection closes the backlog entry without a mint",
  );
});

test("starting a minted action counts as a use and clears it from the dead list", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.addRule(freeAction("beat_drum"));

  // Age it past the grace window untouched: a stillborn verb surfaces (alongside
  // any scenario affordance no one has exercised either - a dead verb is dead
  // whatever minted it, which is exactly what the Steward wants to see).
  for (let i = 0; i < 101; i += 1) engine.tick();
  assert.ok(
    engine.getInventionPulse().unusedRuleIds.includes("beat_drum"),
    "a minted verb nobody reaches for is a candidate for a missing noun",
  );

  assert.ok(engine.commitIntent(ara, { type: "beat_drum" }).accepted);
  let inv = engine.getInventionPulse();
  assert.equal(inv.ruleUseCounts.beat_drum, 1, "the start was tallied");
  assert.ok(
    !inv.unusedRuleIds.includes("beat_drum"),
    "a used verb is no longer dead",
  );
});

test("aliases collapse onto one canonical use tally", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.addRule(freeAction("forge_tool", ["forge_axe", "smith_tool"]));

  assert.ok(engine.commitIntent(ara, { type: "forge_axe" }).accepted);
  engine.tick();
  assert.ok(engine.commitIntent(ara, { type: "smith_tool" }).accepted);

  assert.equal(
    engine.getInventionPulse().ruleUseCounts.forge_tool,
    2,
    "two synonyms, one tally on the real id",
  );
});

test("a just-minted verb is not flagged dead before anyone could reach it", () => {
  let engine = makeSurvivalEngine();
  engine.addRule(freeAction("weave_basket"));
  engine.tick();

  assert.deepEqual(
    engine.getInventionPulse().unusedRuleIds,
    [],
    "within the grace window it is new, not dead",
  );
});

test("a noun reach registers on the noun clock", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  // A known verb (give is native) aimed at a target the world does not have
  // journals a noun_attempt - the reach for a thing, not just a verb.
  try {
    engine.commitIntent(ara, { type: "give", target: "moon-shard", item: "food" });
  } catch {
    // give still refuses the phantom target; the reach is what we are after.
  }
  let inv = engine.getInventionPulse();
  assert.equal(
    typeof inv.ticksSinceLastNounAttempt,
    "number",
    "the noun reach set the clock",
  );
});

test("use counts and mint latencies survive snapshot restore", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  assertSpeculative(engine.commitIntent(ara, { type: "raise_totem" }));
  engine.tick();
  engine.tick();
  engine.tick();
  engine.addRule(freeAction("raise_totem"));
  assert.ok(engine.commitIntent(ara, { type: "raise_totem" }).accepted);

  let restored = makeSurvivalEngine();
  assert.equal(restored.restore(engine.snapshot()), true);

  let inv = restored.getInventionPulse();
  assert.equal(inv.ruleUseCounts.raise_totem, 1, "the use tally persisted");
  assert.equal(inv.medianMintLatency, 3, "the latency ring persisted");
});
