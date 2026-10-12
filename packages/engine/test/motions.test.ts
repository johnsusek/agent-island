// Motions (engine.propose / engine.vote): a formal vote the engine counts, so
// a director acts on a recorded result instead of reading agreement out of
// chat. These pin the counting: majority of the living, early pass and early
// fail, the deadline, changed votes, and the dead dropping out of the count.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/engine.js";
import type { Scenario } from "../src/scenario.js";

function village(names: string[]) {
  let scenario: Scenario = {
    name: "room",
    spawn: { x: 0, y: 0 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    worldgen: { width: 1, height: 1, seed: 1, defaultTerrain: "plains" },
    rules: [],
  };
  let engine = createWorld(scenario);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

function eventsOfType(engine: ReturnType<typeof createWorld>, type: string) {
  return engine.recentEvents().filter((e) => e.type === type);
}

test("a motion passes the moment a majority of the living say yes", () => {
  let { engine, ids } = village(["Ara", "Bo", "Cy", "Di", "Ed"]);
  let [ara, bo, cy] = ids;
  let proposed = engine.propose(ara, "Each of us lands at most 2 fish a day.");
  assert.equal(proposed.outcome, "open");
  assert.equal(proposed.motion.yes, 1, "the proposer's yes counts");

  assert.equal(engine.vote(bo, 1, "yes").outcome, "open");
  let third = engine.vote(cy, 1, "yes");
  assert.equal(third.outcome, "passed");

  let [passed] = eventsOfType(engine, "motion_passed");
  assert.equal(passed.motion, 1);
  assert.equal(passed.message, "Each of us lands at most 2 fish a day.");
  assert.match(passed.text!, /3 yes, 0 no, of 5 living/);
  assert.throws(() => engine.vote(ids[3], 1, "no"), /already passed/);
});

test("a motion fails as soon as a majority can no longer be reached", () => {
  let { engine, ids } = village(["Ara", "Bo", "Cy", "Di"]);
  engine.propose(ids[0], "Close the bay until spring.");
  engine.vote(ids[1], 1, "no");
  assert.equal(engine.vote(ids[2], 1, "no").outcome, "failed");
  assert.equal(eventsOfType(engine, "motion_failed").length, 1);
});

test("an undecided motion fails when voting closes", () => {
  let { engine, ids } = village(["Ara", "Bo", "Cy"]);
  engine.propose(ids[0], "Take turns fishing.");
  for (let i = 0; i < 19; i += 1) engine.tick();
  assert.equal(eventsOfType(engine, "motion_failed").length, 0);
  engine.tick();
  let [failed] = eventsOfType(engine, "motion_failed");
  assert.match(failed.text!, /1 yes, 0 no, of 3 living/);
  assert.deepEqual(engine.getObservation(ids[1]).motions, []);
});

test("a changed vote replaces the old one", () => {
  let { engine, ids } = village(["Ara", "Bo", "Cy", "Di", "Ed"]);
  engine.propose(ids[0], "No fishing below 20 in the bay.");
  engine.vote(ids[1], 1, "no");
  let changed = engine.vote(ids[1], 1, "yes");
  assert.equal(changed.motion.yes, 2);
  assert.equal(changed.motion.no, 0);
  assert.match(
    eventsOfType(engine, "voted").at(-1)!.text!,
    /Bo changes their vote to yes/,
  );
});

test("the majority is of the living: a death can settle a motion", () => {
  let { engine, ids } = village(["Ara", "Bo", "Cy", "Di"]);
  engine.propose(ids[0], "Share the catch evenly.");
  engine.vote(ids[1], 1, "yes");
  // 2 of 4 is not a majority; with Di gone it is 2 of 3.
  engine.setStock(ids[3], "health", 0, { max: 10 }, { icon: "heart-plus" });
  engine.addRule({
    id: "death",
    phase: "transition",
    each: { tag: "agent" },
    when: { cmp: "lte", left: { stock: "health" }, right: 0 },
    do: [{ tag: { remove: "agent", add: "dead" } }],
  } as any);
  engine.tick();
  assert.equal(engine.isAlive(ids[3]), false);
  assert.equal(eventsOfType(engine, "motion_passed").length, 1);
});

test("one open motion per proposer, and only real votes", () => {
  let { engine, ids } = village(["Ara", "Bo", "Cy"]);
  engine.propose(ids[0], "Fish only when hungry.");
  assert.throws(
    () => engine.propose(ids[0], "Something else."),
    /motion 1 is still open/,
  );
  assert.throws(() => engine.vote(ids[1], 1, "maybe"), /"yes" or "no"/);
  assert.throws(() => engine.vote(ids[1], 9, "yes"), /no motion 9/);
});

test("open motions reach everyone, with the reader's own vote", () => {
  let { engine, ids } = village(["Ara", "Bo", "Cy"]);
  engine.propose(ids[0], "Rest the bay every third day.");
  let [proposed] = eventsOfType(engine, "motion_proposed");
  assert.equal(proposed.global, true);
  for (let id of ids) assert.ok(engine.visibleTo(proposed, id));
  let [mine] = engine.sense(ids[0], "situation").motions;
  let [theirs] = engine.getObservation(ids[1]).motions;
  assert.equal(mine.yourVote, "yes");
  assert.equal(theirs.yourVote, null);
  assert.equal(theirs.closesInTicks, 20);
});

test("motions survive a snapshot and restore", () => {
  let { engine, ids } = village(["Ara", "Bo", "Cy"]);
  engine.propose(ids[0], "Keep two fish in reserve.");
  let snap = JSON.parse(JSON.stringify(engine.snapshot()));
  let { engine: other } = village([]);
  assert.ok(other.restore(snap));
  assert.equal(other.vote(ids[1], 1, "yes").outcome, "passed");
});
