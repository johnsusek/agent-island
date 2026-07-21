// Hardening guards on the GM mutation surface: add_rule rejects an unrecognized
// phase/kind up front (so a typo can't slip in and later throw mid-tick, pausing
// the shared clock), and remove_rule refuses to delete a baseline rule (the
// scenario's core loop), steering the GM to tweak_rule instead.

import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, type WorldEngine } from "../src/rules/engine.js";
import { scenario } from "../src/rules/config.js";
import { makeSurvivalEngine } from "./helpers.js";

function fresh(): WorldEngine {
  return makeSurvivalEngine();
}

test("add_rule accepts a well-formed rule", () => {
  let engine = fresh();
  assert.deepEqual(
    engine.addRule({
      id: "gm-test-flow",
      phase: "flow",
      each: { tag: "agent" },
      target: "hunger",
      rate: 0,
    } as any),
    { id: "gm-test-flow" },
  );
});

test("add_rule rejects a rule with no phase or kind", () => {
  let engine = fresh();
  assert.throws(
    () => engine.addRule({ id: "gm-no-dispatch", target: "hunger" } as any),
    /needs a "phase" .* or a "kind"/,
  );
});

test("add_rule rejects an unknown phase", () => {
  let engine = fresh();
  assert.throws(
    () =>
      engine.addRule({
        id: "gm-bad-phase",
        phase: "flowx",
        target: "hunger",
        rate: 1,
      } as any),
    /unknown phase "flowx"/,
  );
});

test("add_rule rejects an unknown kind", () => {
  let engine = fresh();
  assert.throws(
    () => engine.addRule({ id: "gm-bad-kind", kind: "actionx" } as any),
    /unknown kind "actionx"/,
  );
});

test("remove_rule refuses a baseline rule and points at tweak_rule", () => {
  // The shipped game has no baseline rules anymore (everything rides the
  // scenarios, which ARE removable), so the guard is probed with a synthetic
  // scenario that authors one rule of its own.
  let engine = createWorld({
    ...scenario,
    rules: [
      {
        id: "bedrock",
        phase: "flow",
        each: { tag: "agent" },
        target: "hunger",
        rate: 0.1,
      },
    ],
  });
  assert.throws(() => engine.removeRule("bedrock"), /baseline rule|tweak_rule/);
  // Still present afterward.
  assert.ok(engine.getRules().some((r) => r.id === "bedrock"));
});

test("remove_rule still removes a GM-added rule", () => {
  let engine = fresh();
  engine.addRule({
    id: "gm-temporary",
    phase: "flow",
    each: { tag: "agent" },
    target: "hunger",
    rate: 0,
  } as any);
  assert.deepEqual(engine.removeRule("gm-temporary"), { id: "gm-temporary" });
  assert.ok(!engine.getRules().some((r) => r.id === "gm-temporary"));
});

// Rule-algebra pacing fields (priority/chance/cooldown/conflict, Phase 3 of
// the v2 plan). A bad value here would otherwise be a silent no-op or a
// NaN-poisoned noise draw at tick time rather than a caught authoring error,
// so add_rule validates them up front like every other rule-shape guard.

test("add_rule accepts a rule with valid pacing fields", () => {
  let engine = fresh();
  assert.deepEqual(
    engine.addRule({
      id: "gm-paced-threshold",
      phase: "threshold",
      priority: 5,
      chance: 0.25,
      cooldown: 10,
      conflict: "highest",
      do: [{ adjust: { target: "hunger", by: -1 } }],
    } as any),
    { id: "gm-paced-threshold" },
  );
});

test("add_rule rejects a non-finite priority", () => {
  let engine = fresh();
  assert.throws(
    () =>
      engine.addRule({
        id: "gm-bad-priority",
        phase: "flow",
        target: "hunger",
        rate: 0,
        priority: NaN,
      } as any),
    /"priority" must be a finite number/,
  );
});

test("add_rule rejects a chance outside [0,1]", () => {
  let engine = fresh();
  assert.throws(
    () =>
      engine.addRule({
        id: "gm-bad-chance",
        phase: "threshold",
        chance: 1.5,
        do: [],
      } as any),
    /"chance" must be a number between 0 and 1/,
  );
});

test("add_rule rejects chance/cooldown on a derived rule — the calendar must recompute every tick", () => {
  let engine = fresh();
  assert.throws(
    () =>
      engine.addRule({
        id: "gm-bad-derived-chance",
        phase: "derived",
        target: "day",
        value: { tick: true },
        chance: 0.5,
      } as any),
    /"chance" only applies to a flow\/threshold\/watch\/transition\/event rule/,
  );
  assert.throws(
    () =>
      engine.addRule({
        id: "gm-bad-derived-cooldown",
        phase: "derived",
        target: "day",
        value: { tick: true },
        cooldown: 5,
      } as any),
    /"cooldown" only applies to a flow\/threshold\/watch\/transition\/event rule/,
  );
});

test("add_rule rejects a negative cooldown", () => {
  let engine = fresh();
  assert.throws(
    () =>
      engine.addRule({
        id: "gm-bad-cooldown",
        phase: "watch",
        when: { cmp: "gte", left: { stock: "hunger", of: "world" }, right: 1 },
        emit: { type: "test" },
        cooldown: -1,
      } as any),
    /"cooldown" must be a non-negative number of ticks/,
  );
});

test("add_rule rejects conflict on a non-threshold rule", () => {
  let engine = fresh();
  assert.throws(
    () =>
      engine.addRule({
        id: "gm-bad-conflict-phase",
        phase: "flow",
        target: "hunger",
        rate: 0,
        conflict: "highest",
      } as any),
    /"conflict" only applies to a "threshold" rule/,
  );
});

test("add_rule rejects an unknown conflict policy", () => {
  let engine = fresh();
  assert.throws(
    () =>
      engine.addRule({
        id: "gm-bad-conflict-value",
        phase: "threshold",
        conflict: "middle",
        do: [],
      } as any),
    /unknown conflict policy "middle"/,
  );
});
