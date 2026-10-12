// Speak (engine.speak): a free, tick-free shout heard by whoever stands within
// EARSHOT tiles when it is said. Speech has physics under the v2 perception
// split - where characters stand when they talk is a decision - so these tests
// pin the properties that make the channel honest: earshot-bounded reach with
// the audience stamped at the moment of speech, a per-tick send budget, and
// the recent conversation folded into every observation scoped to what that
// character was actually around to hear.

import test from "node:test";
import assert from "node:assert/strict";
import { EARSHOT } from "@agent-island/core/space";
import type { WorldEngine } from "@agent-island/engine/engine";
import { makeSurvivalEngine } from "./helpers.js";

// Teleport an agent to an exact tile via the snapshot/restore seam - the only
// way to set up precise inter-agent distances (explore strides several tiles).
function placeAt(engine: WorldEngine, id: string, x: number, y: number) {
  let snap = engine.snapshot();
  snap.world.entities[id].pos = { x, y };
  engine.restore(snap);
}

// Displace an agent `dist` tiles along the x axis from `from`, leaning toward
// whichever side of the (small) map actually has that much room.
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

test("speak carries EARSHOT tiles: nearby characters hear, distant ones don't", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  let cy = engine.addAgent("Cy").id;
  let here = engine.getObservation(ara).you.position;
  placeAway(engine, bo, here, EARSHOT); // at the edge: hears
  placeAway(engine, cy, here, EARSHOT + 1); // one past it: doesn't

  let before = engine.cursor();
  let result = engine.speak(ara, "regrouping at the hearth");
  assert.deepEqual(result.heardBy, ["Bo"]);

  // The message lands in the speaker's and the hearer's visible streams only.
  for (let [id, count] of [
    [ara, 1],
    [bo, 1],
    [cy, 0],
  ] as const) {
    let seen = engine.visibleEventsSince(id, before);
    assert.equal(
      seen.filter((e) => e.type === "said").length,
      count,
      `${id} ${count ? "hears" : "does not hear"} the message`,
    );
  }
});

test("the audience is stamped at the moment of speech", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  let here = engine.getObservation(ara).you.position;

  let before = engine.cursor();
  engine.speak(ara, "over here");
  // Bo walks out of earshot afterwards; the words were already heard.
  placeAway(engine, bo, here, EARSHOT + 3);
  assert.equal(
    engine.visibleEventsSince(bo, before).filter((e) => e.type === "said")
      .length,
    1,
    "speech heard in the moment isn't unheard by walking away",
  );
});

test("recent conversation is folded into the observation, scoped to earshot", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  let cy = engine.addAgent("Cy").id;
  let here = engine.getObservation(ara).you.position;
  placeAway(engine, cy, here, EARSHOT + 2);

  engine.speak(ara, "wolves to the north");
  engine.speak(bo, "on my way");

  // Bo reads the conversation for free: both messages, oldest-first, attributed.
  let obs = engine.getObservation(bo);
  assert.deepEqual(
    obs.heard.map((m: { from: string; text: string }) => [m.from, m.text]),
    [
      ["Ara", "wolves to the north"],
      ["Bo", "on my way"],
    ],
  );
  // Cy was out of earshot for both: nothing reaches the digest.
  assert.deepEqual(engine.getObservation(cy).heard, []);
});

test("a character may send only a few messages per tick, refilling when the clock advances", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  // Three messages in one tick are allowed; the budget counts down to zero.
  assert.equal(engine.speak(ara, "one").remaining, 2);
  assert.equal(engine.speak(ara, "two").remaining, 1);
  assert.equal(engine.speak(ara, "three").remaining, 0);

  // The fourth in the same frozen moment is refused rather than flooding the feed.
  assert.throws(() => engine.speak(ara, "four"), /at most/);

  // Advancing the world clock refills the allowance - the cap is per tick.
  engine.tick();
  assert.equal(engine.speak(ara, "next tick").remaining, 2);
});

test("speaking to empty air is allowed and reports no listeners", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;

  let result = engine.speak(ara, "hello? anyone?");
  assert.deepEqual(result.heardBy, []);
});
