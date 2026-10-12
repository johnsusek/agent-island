// The `reveal` effect: the kernel's one perception primitive, so scenarios can
// author perception verbs (survey actions, watchtowers, bought maps) as
// content instead of engine features. The kernel stays fog-ignorant - it
// resolves who learns (`to`), where (`around`), and how far (`radius`), then
// hands the write to a host-installed Revealer.

import test from "node:test";
import assert from "node:assert/strict";
import { validateRule, type Rule } from "@agent-island/core/kernel";
import type { WorldEngine } from "../src/rules/engine.js";
import { makeSurvivalEngine } from "./helpers.js";

test("a reveal effect is structural: rejected in a buffered threshold phase", () => {
  let rule = {
    id: "leaky-map",
    phase: "threshold",
    when: { cmp: "gte", left: { stock: "hunger" }, right: 0 },
    do: [{ reveal: { radius: 3 } }],
  } as unknown as Rule;
  assert.throws(() => validateRule(rule), /structural effects .*reveal/);
});

// Place a token `dist` tiles along x from `from` on whichever side is on-map.
function conjureAway(
  engine: WorldEngine,
  id: string,
  from: { x: number; y: number },
  dist: number,
) {
  let width = engine.getMap().width;
  let x = from.x + dist < width ? from.x + dist : from.x - dist;
  engine.spawnEntity({
    id,
    tags: ["landmark"],
    occupancy: "tile",
    pos: { x, y: from.y },
  });
  return { x, y: from.y };
}

test("a scenario-authored survey action reveals fog through the kernel effect", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let here = engine.getObservation(ara).you.position;

  // A cairn 15 tiles out: beyond ordinary sight (12), within the survey (18).
  conjureAway(engine, "far-cairn", here, 15);
  assert.equal(
    engine
      .getObservation(ara)
      .known.locations.some((l: any) => l.name === "far-cairn"),
    false,
    "the cairn starts unknown",
  );

  engine.addRule({
    id: "survey",
    kind: "action",
    duration: 2,
    description: "Study the surrounding land from where you stand.",
    params: [],
    do: [{ reveal: { radius: 18 } }],
  });
  let committed = engine.commitIntent(ara, { type: "survey" });
  assert.equal(committed.accepted, true);
  for (let i = 0; i < 3; i += 1) engine.tick();

  assert.equal(
    engine
      .getObservation(ara)
      .known.locations.some((l: any) => l.name === "far-cairn"),
    true,
    "surveying revealed the cairn to the surveyor",
  );
});

test("reveal is per-agent: the surveyor learns, bystanders don't", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  let here = engine.getObservation(ara).you.position;
  conjureAway(engine, "lone-obelisk", here, 15);

  engine.addRule({
    id: "survey",
    kind: "action",
    duration: 1,
    description: "Study the surrounding land from where you stand.",
    params: [],
    do: [{ reveal: { radius: 18 } }],
  });
  engine.commitIntent(ara, { type: "survey" });
  for (let i = 0; i < 2; i += 1) engine.tick();

  assert.equal(
    engine
      .getObservation(ara)
      .known.locations.some((l: any) => l.name === "lone-obelisk"),
    true,
    "ara surveyed and knows",
  );
  assert.equal(
    engine
      .getObservation(bo)
      .known.locations.some((l: any) => l.name === "lone-obelisk"),
    false,
    "bo stood by and doesn't",
  );
});
