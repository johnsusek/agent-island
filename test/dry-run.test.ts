import assert from "node:assert/strict";
import test from "node:test";

import type { WorldEngine } from "../src/rules/engine.js";
import { createColony } from "../src/coordinator.js";
import { makeSurvivalEngine, survivalBoot } from "./helpers.js";

function survival(): WorldEngine {
  return makeSurvivalEngine();
}

// Reads a stock no character has, so it throws for every bound agent on every
// tick - the canonical "GM typo'd a stock name" failure.
const BROKEN_WATCH = {
  id: "broken",
  description: "test: reads a stock that doesn't exist",
  phase: "watch",
  each: { tag: "agent" },
  when: { cmp: "lte", left: { stock: "mana" }, right: 25 },
  emit: { type: "chill" },
} as const;

// A well-formed flow that visibly fires from tick one.
const DRAIN_ENERGY = {
  id: "tired",
  description: "test: energy drains each tick",
  phase: "flow",
  each: { tag: "agent" },
  target: "energy",
  rate: -2,
} as const;

test("a rule that throws in simulation comes back as a warning naming the failure", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({ ...BROKEN_WATCH });

  let report = engine.dryRunRule("broken");

  assert.equal(report.ticks, 50);
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0], /mana/);
  assert.match(report.warnings[0], /recurred/);
});

test("a healthy firing rule reports no warnings and no inert note", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({ ...DRAIN_ENERGY });

  let report = engine.dryRunRule("tired");

  assert.deepEqual(report.warnings, []);
  assert.ok(
    !report.notes.some((n) => n.includes("no observable effect")),
    `an every-tick drain must register as having fired: ${report.notes}`,
  );
});

test("a rule bound to a tag nothing carries is flagged idle and inert", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({
    id: "dragon-fire",
    phase: "flow",
    each: { tag: "dragon" },
    target: "health",
    rate: -5,
  });

  let report = engine.dryRunRule("dragon-fire");

  assert.deepEqual(report.warnings, []);
  assert.ok(report.notes.some((n) => n.includes('tag "dragon"')));
  assert.ok(report.notes.some((n) => n.includes("no observable effect")));
});

test("an action rule gets an availability sweep instead of a tick simulation", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({
    id: "sacrifice",
    kind: "action",
    duration: 1,
    requires: { cmp: "gte", left: { stock: "gold" }, right: 10 },
    requireReason: "you need 10 gold",
    do: [{ adjust: { target: "morale", by: 5 } }],
  });

  let report = engine.dryRunRule("sacrifice");

  assert.equal(report.ticks, 0, "action bodies only run on commit - no sim");
  assert.deepEqual(report.warnings, []);
  let sweep = report.notes.find((n) => n.startsWith('action "sacrifice"'));
  assert.ok(sweep, `expected an availability note, got: ${report.notes}`);
  assert.match(sweep!, /0 of 1 agents/);
});

// Genesis run 5d121c3a: establish_settlement had an empty body. Characters ran
// it, the log said they had built, and the world ended with 32 outcrops and not
// one structure - so they told each other about settlements that were not
// there. An empty body is the one such failure the engine can see without
// reading meaning into a verb's name; the rest is the director's judgment.

// Genesis run cc3d1956 shipped two of these on the strength of a warning alone
// - `enter-shelter` and `warm-by-fire`, both `do: []` - so the empty body is now
// refused at add time rather than reported after the fact. The dry-run lint
// stays for rules that arrive by other doors (a scenario file), but the GM
// cannot mint one.
test("an action with an empty body is refused at add time", () => {
  let engine = survival();
  engine.addAgent("Ada");

  assert.throws(
    () =>
      engine.addRule({
        id: "establish_settlement",
        kind: "action",
        duration: 5,
        do: [],
      }),
    /empty body/,
  );
});

// Genesis run 7a04489e: build_shelter was minted as `adjust wood by -3` and
// nothing else, under a description promising a hearth. Cygnus paid 3 wood, the
// order reported completed, and the world ended with 32 outcrops and no hearth -
// the same failure as the empty body, wearing a cost so it no longer looks empty.

test("an action whose body only spends is warned about", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({
    id: "build_lodge",
    kind: "action",
    duration: 10,
    requires: { cmp: "gte", left: { stock: "wood" }, right: 3 },
    do: [{ adjust: { target: "wood", by: -3 } }],
  });

  assert.ok(
    engine
      .dryRunRule("build_lodge")
      .warnings.some((w) => w.includes("only spends")),
  );
});

// The check reads shape, not stock names: thirst falling is what `drink` is for.
// Its tone is the only thing telling the two subtractions apart.

test("an action that only relieves a down-tone gauge is not warned about", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({
    id: "sip",
    kind: "action",
    duration: 1,
    do: [{ adjust: { target: "thirst", by: -45 } }],
  });

  assert.deepEqual(engine.dryRunRule("sip").warnings, []);
});

test("a spawn of an undrawn kind is warned about", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({
    id: "build_cairn",
    kind: "action",
    duration: 5,
    do: [{ spawn: { kind: "dropped_stone", tags: [], occupancy: "tile" } }],
  });

  assert.ok(
    engine
      .dryRunRule("build_cairn")
      .warnings.some((w) => w.includes("no sprite")),
  );
});

test("dry-running leaves the live world untouched", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({ ...DRAIN_ENERGY });
  let tickBefore = engine.currentTick();
  let energyBefore = engine.getObservation("ada").you.stocks.energy?.value;

  engine.dryRunRule("tired");

  assert.equal(engine.currentTick(), tickBefore);
  assert.equal(
    engine.getObservation("ada").you.stocks.energy?.value,
    energyBefore,
  );
});

test("add_rule and tweak_rule surface the dry-run report through the coordinator", () => {
  let colony = createColony({ waitTimeoutMs: 500, ...survivalBoot });
  colony.connect("c1");
  colony.connect("gm");
  try {
    colony.join("c1", "Ara");
    colony.joinAsGm("gm");

    let added = colony.gmAddRule("gm", { ...BROKEN_WATCH });
    assert.ok(added.dryRun, "add_rule result carries the report");
    assert.ok(added.dryRun.warnings.length >= 1);
    assert.match(added.dryRun.warnings[0], /mana/);

    // Repointing the watch at a stock every character has clears the warning.
    let patched = colony.gmPatchRule("gm", "broken", {
      when: { cmp: "lte", left: { stock: "energy" }, right: 1000 },
    });
    assert.ok(patched.dryRun, "tweak_rule result carries the report");
    assert.deepEqual(patched.dryRun.warnings, []);
  } finally {
    colony.stop();
  }
});
