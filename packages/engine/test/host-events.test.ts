// Host events reach event rules: speech, gifts, joins and votes happen outside
// the rules, and are queued for the next tick so a scenario can react to them
// with `phase: "event", on: "<type>"`. These pin that each one fires once,
// binds to its actor, carries its args, and is not logged a second time.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "../src/engine.js";
import type { Scenario } from "../src/scenario.js";

function room(): Scenario {
  return {
    name: "room",
    spawn: { x: 0, y: 0 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    worldgen: { width: 1, height: 1, seed: 1, defaultTerrain: "plains" },
    rules: [],
  };
}

function counter(engine: ReturnType<typeof createWorld>, stock: string) {
  engine.setStockDefault(stock, {
    value: 0,
    min: 0,
    max: 1000,
    role: "stat",
    icon: "bell",
  });
}

function stockOf(
  engine: ReturnType<typeof createWorld>,
  id: string,
  s: string,
) {
  return engine.getObservation(id).you.stocks[s].value;
}

test("speaking fires an `on: said` rule once, on the speaker", () => {
  let engine = createWorld(room());
  counter(engine, "noise");
  engine.addRule({
    id: "speech-is-loud",
    phase: "event",
    on: "said",
    do: [{ adjust: { target: "noise", by: 1 } }],
  });
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;

  engine.speak(ara, "hello");
  engine.speak(ara, "anyone?");
  assert.equal(stockOf(engine, ara, "noise"), 0, "nothing until the tick runs");
  engine.tick();
  assert.equal(stockOf(engine, ara, "noise"), 2);
  assert.equal(stockOf(engine, bo, "noise"), 0);
  engine.tick();
  assert.equal(stockOf(engine, ara, "noise"), 2, "each event fires once");
  assert.equal(
    engine.recentEvents().filter((e) => e.type === "said").length,
    2,
    "host events are not logged again",
  );
});

test("a gift's target, amount and resource reach the rule", () => {
  let engine = createWorld(room());
  engine.setStockDefault("fish", {
    value: 4,
    min: 0,
    max: 10,
    role: "pack",
    icon: "fish-bucket",
  });
  counter(engine, "standing");
  engine.addRule({
    id: "generosity",
    phase: "event",
    on: "given",
    when: { cmp: "gte", left: { arg: "amount" }, right: 2 },
    do: [
      {
        adjust: {
          target: "standing",
          of: { arg: "target" },
          by: { arg: "amount" },
        },
      },
    ],
  });
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;

  engine.commitIntent(ara, {
    type: "give",
    target: "Bo",
    item: "fish",
    amount: 1,
  });
  engine.tick();
  assert.equal(stockOf(engine, bo, "standing"), 0, "one fish is under the bar");
  engine.commitIntent(ara, {
    type: "give",
    target: "Bo",
    item: "fish",
    amount: 2,
  });
  engine.tick();
  assert.equal(stockOf(engine, bo, "standing"), 2);
});

test("joining fires `on: joined` on the newcomer, and votes carry their choice", () => {
  let engine = createWorld(room());
  counter(engine, "hollow");
  counter(engine, "dissent");
  engine.addRule({
    id: "the-first-is-hollow",
    phase: "event",
    on: "joined",
    when: { cmp: "eq", left: { count: { tag: "hollow-marked" } }, right: 0 },
    do: [
      { set: { target: "hollow", to: 1 } },
      { tag: { add: "hollow-marked" } },
    ],
  });
  engine.addRule({
    id: "dissent-is-noted",
    phase: "event",
    on: "voted",
    when: {
      cmp: "eq",
      left: { lookup: { on: "choice", table: { no: 1 } } },
      right: 1,
    },
    do: [{ adjust: { target: "dissent", by: 1 } }],
  });
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  let cy = engine.addAgent("Cy").id;
  engine.tick();
  assert.equal(stockOf(engine, ara, "hollow"), 1);
  assert.equal(stockOf(engine, bo, "hollow"), 0);

  engine.propose(ara, "Share the catch.");
  engine.vote(bo, 1, "no");
  engine.vote(cy, 1, "yes");
  engine.tick();
  assert.equal(stockOf(engine, bo, "dissent"), 1);
  assert.equal(stockOf(engine, cy, "dissent"), 0);
});
