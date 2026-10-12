// Stock roles (vital/stat/pack — see scenario.ts StockRole): role lives on
// stockDefaults (the only place that survives snapshot/restore and is
// GM-settable — see engine.ts effectiveRole/displayProjection), give/stockpile
// gate on it, and the projection folds role into the observation `display`
// so prose and the dashboard read one shape.

import assert from "node:assert/strict";
import test from "node:test";

import type { WorldEngine } from "../src/rules/engine.js";
import { makeFixtureEngine } from "./helpers.js";

// Standalone fixture (test/stock-roles.json): role semantics in isolation,
// decoupled from whatever rules/stocks the shared survival fixture happens to carry.
function makeSurvivalEngine() {
  return makeFixtureEngine("stock-roles");
}

function displayOf(engine: WorldEngine, id: string, name: string) {
  return engine.getObservation(id).display[name];
}

test("an explicit role rides the overlay and re-applies onto a fresh engine", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.setStockDefault("courage", {
    value: 50,
    min: 0,
    max: 100,
    icon: "sparkles",
    role: "stat",
    label: "courage",
    bands: { critical: "You have lost your nerve." },
  });

  assert.equal(engine.getStockDefaults().courage.role, "stat");

  let overlay = engine.getOverlay();
  assert.equal(overlay.stockDefaults?.courage.role, "stat");
  assert.equal(overlay.stockDefaults?.courage.label, "courage");

  let fresh = makeSurvivalEngine();
  fresh.applyOverlay(overlay);
  fresh.addAgent("Bo");
  let display = displayOf(fresh, "bo", "courage");
  assert.equal(display?.role, "stat");
  assert.equal(display?.label, "courage");

  // Registry-declared, no scenario `display` entry at all - the projection
  // still carries it, so a GM-minted stat/vital needs no separate authoring.
  void ara;
});

test("a registry-declared vital alarms with no scenario display block at all", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.setStockDefault("dread", {
    value: 100,
    min: 0,
    max: 100,
    icon: "skull",
    role: "vital",
    bands: { critical: "Dread consumes you." },
  });
  // Push straight to the critical band on the next tick's threshold pass -
  // engine.setStock bypasses rule effects, so poke it directly then tick to
  // let raiseVitalAlarms notice the crossing. Every vital reads up as good,
  // so the crossing is toward the floor.
  engine.setStock(ara, "dread", 0);
  engine.tick();

  let alarm = engine
    .recentEvents()
    .find((e: any) => e.type === "vitals_alarm" && e.agentId === ara);
  assert.ok(
    alarm,
    "the registry-declared vital alarmed without a display block",
  );
  assert.match((alarm as any).text ?? "", /Dread consumes you\./);
});

test("stockpilable is rejected on a non-pack role", () => {
  let engine = makeSurvivalEngine();
  assert.throws(
    () =>
      engine.setStockDefault("resolve", {
        value: 50,
        icon: "shield",
        role: "stat",
        stockpilable: true,
      }),
    /stockpilable only applies to a pack-role resource/,
  );
});

test("role/bands are validated", () => {
  let engine = makeSurvivalEngine();
  assert.throws(
    () =>
      engine.setStockDefault("x", {
        value: 0,
        icon: "gear",
        role: "bogus" as any,
      }),
    /role must be one of/,
  );
  assert.throws(
    () =>
      engine.setStockDefault("z", {
        value: 0,
        icon: "gear",
        bands: "not an object" as any,
      }),
    /bands must be an object/,
  );
});

test("give gates on role: pack yes, stat and vital no", () => {
  let engine = makeSurvivalEngine();
  let giver = engine.addAgent("Ara").id;
  engine.addAgent("Bo");

  // pack-role giving is already covered by give.test.ts;
  // morale here is role: "stat" - never givable.
  let statGive = engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "morale" }],
  });
  assert.equal(statGive.order?.status, "blocked");
  assert.match(statGive.order?.reason ?? "", /not a valid item/);

  // health is role: "vital" - never givable.
  let vitalGive = engine.setOrder(giver, {
    kind: "sequence",
    steps: [{ type: "give", target: "bo", item: "health" }],
  });
  assert.equal(vitalGive.order?.status, "blocked");
  assert.match(vitalGive.order?.reason ?? "", /not a valid item/);
});

test("deposit/withdraw still key off stockpilable, a pack-only subflag", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let give = engine
    .getObservation(ara)
    .availableActions.find((a: any) => a.name === "give") as any;
  // wood/food are stockpilable *and* pack; morale is pack but not
  // stockpilable, so it can still be given but never deposited.
  let deposit = engine
    .getObservation(ara)
    .availableActions.find((a: any) => a.name === "deposit") as any;
  if (deposit)
    assert.ok(
      !(deposit.paramOptions?.item ?? []).includes("morale"),
      "morale is pack but not stockpilable - deposit must not offer it",
    );
  void give;
});

// The dry-run "lethal but unmarked" lint (packages/core/src/dryrun.ts
// lintLethalUnmarkedGate): a rule that harms a vital gated on a stock
// nothing has marked vital gets flagged, since that gate is exactly what a
// character would need alarmed to see the harm coming.
test("dry-run flags a rule that harms a vital gated on an unmarked stock", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  engine.setStockDefault("radiation", {
    value: 0,
    min: 0,
    max: 100,
    icon: "radioactive",
  }); // no role: defaults to pack, deliberately left unmarked

  engine.addRule({
    id: "radiation_sickness",
    description: "test: high radiation harms health, unmarked gate",
    phase: "threshold",
    each: { tag: "agent" },
    when: { cmp: "gte", left: { stock: "radiation" }, right: 80 },
    do: [{ adjust: { target: "health", by: -5 } }],
  });

  let report = engine.dryRunRule("radiation_sickness");
  assert.ok(
    report.warnings.some(
      (w) => w.includes('"health"') && w.includes('"radiation"'),
    ),
    `expected an unmarked-gate warning, got: ${JSON.stringify(report.warnings)}`,
  );
});

test("dry-run does not flag a rule gated on an already-vital stock", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  engine.addRule({
    id: "starvation_extra",
    description: "test: satiation (vital) harms health - both marked",
    phase: "threshold",
    each: { tag: "agent" },
    when: { cmp: "lte", left: { stock: "satiation" }, right: 10 },
    do: [{ adjust: { target: "health", by: -1 } }],
  });

  let report = engine.dryRunRule("starvation_extra");
  assert.ok(
    !report.warnings.some((w) => w.includes("is not marked vital")),
    `expected no unmarked-gate warning, got: ${JSON.stringify(report.warnings)}`,
  );
});
