import assert from "node:assert/strict";
import test from "node:test";

import type { WorldEngine } from "../src/rules/engine.js";
import { makeSurvivalEngine } from "./helpers.js";

function survival(): WorldEngine {
  return makeSurvivalEngine();
}

function energyOf(engine: WorldEngine, id: string): number | undefined {
  return engine.getObservation(id).you.stocks.energy?.value;
}

// A well-formed flow every agent can run: drains energy each tick.
const DRAIN_ENERGY = {
  id: "tired",
  description: "test: energy drains each tick",
  phase: "flow",
  each: { tag: "agent" },
  target: "energy",
  rate: -2,
} as const;

// A broken rule: its `when` READS a stock the agents don't have, so it throws
// for every bound agent. (A read is the throwing path; a flow `adjust` would
// auto-vivify instead.)
const BROKEN_WATCH = {
  id: "broken",
  description: "test: reads a stock that doesn't exist",
  phase: "watch",
  each: { tag: "agent" },
  when: { cmp: "lte", left: { stock: "mana" }, right: 25 },
  emit: { type: "chill" },
} as const;

test("a broken rule fails its own pairs without stopping a good rule in the same tick", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addAgent("Pax");
  engine.addRule({ ...DRAIN_ENERGY });
  engine.addRule({ ...BROKEN_WATCH });

  assert.doesNotThrow(() => engine.tick());

  // The good flow still applied to BOTH agents even though the broken watch
  // threw on them this tick — isolation contains the failure to its own pair.
  assert.equal(energyOf(engine, "ada"), 98);
  assert.equal(energyOf(engine, "pax"), 98);

  let err = engine.recentEvents().find((e) => e.type === "rule_error");
  assert.ok(err, "the broken rule is reported");
  assert.match(err!.text ?? "", /broken/);
});

test("a broken all-agents rule reports once per tick, not once per agent", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addAgent("Pax");
  engine.addAgent("Bo");
  engine.addRule({ ...BROKEN_WATCH });

  engine.tick();

  let errors = engine
    .recentEvents()
    .filter((e) => e.type === "rule_error" && e.text?.includes("broken"));
  assert.equal(
    errors.length,
    1,
    "three agents, one identical failure — collapsed to a single event",
  );
});

test("rule_error reaches the GM log but no character's observe stream", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({ ...BROKEN_WATCH });

  engine.tick();

  // The GM dashboard reads the global log: the error is there.
  assert.ok(
    engine.recentEvents().some((e) => e.type === "rule_error"),
    "GM sees the rule_error",
  );
  // A character's perception stream is filtered by visibleTo: the error is not.
  let seen = engine.visibleEventsSince("ada", 0);
  assert.equal(
    seen.some((e) => e.type === "rule_error"),
    false,
    "the character never perceives an engine diagnostic",
  );
});
