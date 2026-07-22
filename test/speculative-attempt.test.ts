import test from "node:test";
import assert from "node:assert/strict";

import { assertSpeculative, makeSurvivalEngine } from "./helpers.js";

// Speculative physics (docs/speculative-physics.md): an agent trying a verb
// no currently-loaded rule defines gets a soft in-fiction refusal instead of
// a thrown error, and the attempt is journaled for a synthesis seat to read.

test("an unrecognized verb is a soft in-fiction refusal, not a throw", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  let result = engine.commitIntent(ara, {
    type: "drink_water",
    expectation: "I expect my thirst to ease",
  });

  assertSpeculative(result);
  assert.equal(result.verb, "drink_water");
  assert.match(result.message, /Nothing happens/);

  let events = engine.recentEvents();
  let attempt = events.find((e) => e.type === "speculative_attempt");
  assert.ok(attempt, "the attempt was journaled");
  assert.equal(attempt!.agentId, ara);
  assert.equal(attempt!.verb, "drink_water");
  assert.equal(attempt!.expectation, "I expect my thirst to ease");
});

test("a speculative attempt is private to the actor, like other action lifecycle events", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;

  engine.commitIntent(ara, { type: "drink_water" });
  let event = engine
    .recentEvents()
    .find((e) => e.type === "speculative_attempt")!;

  assert.ok(engine.visibleTo(event, ara));
  assert.ok(!engine.visibleTo(event, bo));
});

test("a known action never falls into the speculative path", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  let result = engine.commitIntent(ara, { type: "rest" });
  assert.ok(result.accepted);
});

test("repeated attempts across distinct agents cluster by verb for the GM feed", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;

  engine.commitIntent(ara, {
    type: "scoop_water",
    expectation: "quench my thirst",
    from: "river",
  });
  engine.commitIntent(bo, { type: "scoop_water" });
  engine.commitIntent(ara, { type: "summon_infinite_food" });

  let clusters = engine.getSpeculativeAttempts();
  let scoop = clusters.find((c) => c.verb === "scoop_water")!;
  assert.equal(scoop.count, 2);
  assert.deepEqual([...scoop.distinctActors].sort(), [ara, bo].sort());
  assert.deepEqual(scoop.expectations, ["quench my thirst"]);
  assert.deepEqual(scoop.sampleArgs, [{ from: "river" }]);

  let summon = clusters.find((c) => c.verb === "summon_infinite_food")!;
  assert.equal(summon.count, 1);
  assert.equal(summon.distinctActors.length, 1);

  // Sorted by attempt count, most-attempted verb first.
  assert.equal(clusters[0].verb, "scoop_water");
});

test("ratifying a verb with aliases answers every synonym that was tried", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  // The thrash the first genesis run produced: one concept, many words.
  for (let verb of ["chip_stone", "quarry_stone", "extract_stone"]) {
    assertSpeculative(engine.commitIntent(ara, { type: verb }));
  }

  engine.addRule({
    id: "mine_stone",
    kind: "action",
    duration: 1,
    description: "Chip stone loose from the ground.",
    aliases: ["chip_stone", "quarry_stone", "extract_stone"],
    do: [{ adjust: { target: "wood", by: 1 } }],
  } as never);

  // Every word the characters guessed now lands on the one real action.
  for (let verb of ["mine_stone", "chip_stone", "extract_stone"]) {
    assert.ok(engine.commitIntent(ara, { type: verb }).accepted, verb);
    engine.tick();
  }
});

// The second half of the loop: an attempt is a standing wish, so minting the
// verb has to reach the people who made it. Without this a granted wish sits
// undiscovered - genesis run 5d121c3a ratified build_tower after three
// petitions and it was then never used once, because nobody told the petitioner.

test("minting a verb wakes the agents who attempted it, without replaying the action", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;

  assertSpeculative(engine.commitIntent(ara, { type: "raise_tower" }));

  let result = engine.addRule({
    id: "raise_tower",
    kind: "action",
    duration: 1,
    description: "Raise a tower.",
    do: [{ adjust: { target: "wood", by: -1 } }],
  } as never);

  assert.deepEqual(result.redeemed, [ara], "only the attempter is redeemed");

  let realized = engine
    .recentEvents()
    .find((e) => e.type === "speculation_realized")!;
  assert.ok(realized, "the redemption is journaled");
  assert.equal(realized.agentId, ara);
  assert.equal(realized.verb, "raise_tower");
  assert.ok(engine.visibleTo(realized, ara));
  assert.ok(!engine.visibleTo(realized, bo), "private to the wisher");

  // Woken, not acted for: forming the intent again is the character's call.
  assert.ok(
    !engine
      .recentEvents()
      .some(
        (e) => e.type === "action_started" && e.text?.includes("raise_tower"),
      ),
    "the action was not replayed on the agent's behalf",
  );
});

// Redemption is news, not an alarm: the wake rides on the event's `decision`
// wake alone, so a character hears about it without having their hands stopped.
test("redeeming an attempt leaves a running order alone", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  assertSpeculative(engine.commitIntent(ara, { type: "raise_tower" }));
  engine.setOrder(ara, { kind: "repeat", action: { type: "rest" } });
  engine.tick();

  engine.addRule({
    id: "raise_tower",
    kind: "action",
    duration: 1,
    description: "Raise a tower.",
    do: [{ adjust: { target: "wood", by: -1 } }],
  } as never);

  assert.equal(engine.getOrder(ara).order?.status, "running");
  assert.ok(
    !engine.recentEvents().some((e) => e.type === "action_abandoned"),
    "nothing was abandoned to deliver the news",
  );
  // The news still reaches them: a decision-wake event is what wait_for_change
  // gates on, so it lands without the order having to break.
  let realized = engine
    .recentEvents()
    .find((e) => e.type === "speculation_realized")!;
  assert.equal(realized.wake, "decision");
  assert.ok(engine.visibleTo(realized, ara));
});

test("a synonym aliased on later redeems the attempt that used it", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  engine.addRule({
    id: "mine_stone",
    kind: "action",
    duration: 1,
    description: "Chip stone loose.",
    do: [{ adjust: { target: "wood", by: 1 } }],
  } as never);

  // The word arrives after the rule does - nobody had thought of it yet.
  assertSpeculative(engine.commitIntent(ara, { type: "chip_stone" }));
  engine.patchRule("mine_stone", { aliases: ["chip_stone"] });

  let realized = engine
    .recentEvents()
    .find((e) => e.type === "speculation_realized")!;
  assert.ok(realized, "adding the alias redeems the attempt that used it");
  assert.equal(realized.agentId, ara);
  assert.equal(realized.verb, "chip_stone");
});

test("one wake settles every synonym that agent tried for the same idea", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  for (let verb of ["cup_water", "kneel_drink", "splash_drink"])
    assertSpeculative(engine.commitIntent(ara, { type: verb }));

  engine.addRule({
    id: "drink_deep",
    kind: "action",
    duration: 1,
    description: "Drink.",
    aliases: ["cup_water", "kneel_drink", "splash_drink"],
    do: [{ adjust: { target: "energy", by: 1 } }],
  } as never);

  let realized = engine
    .recentEvents()
    .filter((e) => e.type === "speculation_realized");
  assert.equal(realized.length, 1, "three guesses, one wake");
  assert.equal(realized[0].verb, "splash_drink", "named by the latest guess");
  assert.deepEqual(realized[0].verbs, [
    "cup_water",
    "kneel_drink",
    "splash_drink",
  ]);

  // All three words are spent, so re-sending the alias list wakes nobody.
  engine.patchRule("drink_deep", {
    aliases: ["cup_water", "kneel_drink", "splash_drink", "sip"],
  });
  assert.equal(
    engine.recentEvents().filter((e) => e.type === "speculation_realized")
      .length,
    1,
  );
});

test("an alias redeems the word that was actually tried, and only once", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  assertSpeculative(engine.commitIntent(ara, { type: "quarry_stone" }));

  let added = engine.addRule({
    id: "mine_stone",
    kind: "action",
    duration: 1,
    description: "Chip stone loose.",
    aliases: ["quarry_stone"],
    do: [{ adjust: { target: "wood", by: 1 } }],
  } as never);
  assert.deepEqual(added.redeemed, [ara]);

  let before = engine
    .recentEvents()
    .filter((e) => e.type === "speculation_realized").length;
  // Re-sending the same alias list (how tweak_rule adds stragglers) must not
  // wake anyone a second time for a wish already granted.
  engine.patchRule("mine_stone", { aliases: ["quarry_stone", "chip_stone"] });
  let after = engine
    .recentEvents()
    .filter((e) => e.type === "speculation_realized").length;
  assert.equal(after, before);
});

test("an alias cannot collide with an action name already in use", () => {
  let engine = makeSurvivalEngine();

  assert.throws(
    () =>
      engine.addRule({
        id: "loiter",
        kind: "action",
        duration: 1,
        aliases: ["rest"],
        do: [],
      } as never),
    /already taken by "rest"/,
  );
});

// A GM-minted rule almost never carries a requireReason (genesis run 32d46bd9:
// 0 of 13 did), so a refusal has to be readable straight off the gate or the
// character is left guessing whether the rule is even finished.

test("a refusal reads the requires gate back when no requireReason was written", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  engine.addRule({
    id: "build_log_pile",
    kind: "action",
    duration: 1,
    description: "Stack logs.",
    requires: { cmp: "gte", left: { stock: "wood" }, right: 5 },
    do: [{ adjust: { target: "wood", by: -5 } }],
  } as never);

  assert.throws(
    () => engine.commitIntent(ara, { type: "build_log_pile" }),
    /you need wood at least 5 \(you have 0\)/,
  );
});

test("an author's own requireReason still wins over the derived one", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  engine.addRule({
    id: "build_altar",
    kind: "action",
    duration: 1,
    description: "Raise an altar.",
    requires: { cmp: "gte", left: { stock: "wood" }, right: 5 },
    requireReason: "the stones must be quarried by moonlight",
    do: [{ adjust: { target: "wood", by: -5 } }],
  } as never);

  assert.throws(
    () => engine.commitIntent(ara, { type: "build_altar" }),
    /quarried by moonlight/,
  );
});

test("a colocation gate refuses by naming the place you have to stand", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  engine.addRule({
    id: "drink_deep",
    kind: "action",
    duration: 1,
    description: "Drink.",
    requires: { colocated: { tag: "water_source" } },
    do: [{ adjust: { target: "energy", by: 1 } }],
  } as never);

  assert.throws(
    () => engine.commitIntent(ara, { type: "drink_deep" }),
    /you must be standing on a water_source/,
  );
});

test("reaching for an MCP tool as an order step is corrected, not journaled as speculation", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  let result = engine.commitIntent(ara, { type: "speak", message: "hello" });

  assertSpeculative(result);
  assert.match(result.message, /not an order step/);
  assert.equal(
    engine.getSpeculativeAttempts().length,
    0,
    "a real capability is not demand for a new verb",
  );
});

test("an order stepping into an unrecognized verb continues instead of blocking", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "drink_water" }, { type: "rest" }],
  });
  engine.tick();
  engine.tick();

  let order = engine.getOrder(ara).order;
  assert.notEqual(order?.status, "blocked");
});

// The wisher has to SEE that the world didn't answer. An attempt made as an
// order step used to inherit the step's routine wake, so the wake report folded
// it into "(+n routine)" and reported the order as completed - the agent read
// success and re-ordered a verb that does not exist.
test("an attempt made as an order step still wakes its wisher", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "drink_water" }],
  });

  let attempt = engine
    .recentEvents()
    .find((e) => e.type === "speculative_attempt");
  assert.ok(attempt, "the attempt was journaled");
  assert.equal(
    attempt!.wake,
    "decision",
    "a wish that goes unanswered is decision-grade, never routine churn",
  );
});

// The sibling case: reaching for a tool verb as an order step is a protocol
// slip, and the correction is useless if the actor never reads it.
test("the tool-verb correction wakes the actor too", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  engine.setOrder(ara, { kind: "sequence", steps: [{ type: "speak" }] });

  let note = engine.recentEvents().find((e) => e.type === "order_note");
  assert.ok(note, "the correction was journaled");
  assert.equal(note!.wake, "decision");
});

// Genesis run cc3d1956 reached tick 187 with six minted rules and six "open"
// clusters that were exactly the aliases of those six rules: the log is
// append-only, so a cluster used to outlive its own ratification forever. The
// Oracle had answered everything and was told, every turn, that it had answered
// nothing - a standing invitation to re-mint a settled concept under a synonym.
test("a ratified verb and its aliases drop out of the attempt feed", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  engine.commitIntent(ara, { type: "quarry", expectation: "collect stone" });
  engine.commitIntent(ara, { type: "hew", expectation: "collect stone" });
  engine.commitIntent(ara, { type: "yodel" });

  assert.deepEqual(
    engine
      .getSpeculativeAttempts()
      .map((c) => c.verb)
      .sort(),
    ["hew", "quarry", "yodel"],
  );

  // One law answering both words settles both, not just the one it is named for.
  engine.addRule({
    id: "gather-stone",
    kind: "action",
    aliases: ["quarry", "hew"],
    duration: 1,
    do: [{ adjust: { target: "food", by: 1 } }],
  });

  assert.deepEqual(
    engine.getSpeculativeAttempts().map((c) => c.verb),
    ["yodel"],
    "only the genuinely unanswered verb is still open work",
  );
});
