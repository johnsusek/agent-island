import assert from "node:assert/strict";
import test from "node:test";

import type { WorldEngine } from "../src/rules/engine.js";
import { makeSurvivalEngine } from "./helpers.js";

function survival(): WorldEngine {
  return makeSurvivalEngine();
}

function manaOf(engine: WorldEngine, id: string): number | undefined {
  return engine.getObservation(id).you.stocks.mana?.value;
}

function kindVisualsOf(engine: WorldEngine) {
  return engine.getAdminState().scenario.kindVisuals as Record<
    string,
    { icon?: string; color?: string }
  >;
}

// A flow that drains `mana` each tick. An `adjust` write auto-vivifies its
// target, so a flow alone never throws on a missing stock — it just creates it.
const COLD_FLOW = {
  id: "test-chill-drain",
  description: "test: mana drains each tick",
  phase: "flow",
  each: { tag: "agent" },
  target: "mana",
  rate: -2,
} as const;

// A watch whose condition READS `mana`. Reads are the path that throws on a
// missing stock (and freezes the whole tick) — this is the real crash to guard.
const CHILL_WATCH = {
  id: "chill",
  description: "test: alarm when mana runs low",
  phase: "watch",
  each: { tag: "agent" },
  when: { cmp: "lte", left: { stock: "mana" }, right: 25 },
  emit: { type: "chill" },
} as const;

test("a stock default seeds every character alive when it is set", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addAgent("Pax");

  let result = engine.setStockDefault("mana", {
    value: 100,
    min: 0,
    max: 100,
    icon: "sparkles",
  });

  assert.deepEqual(result.seeded.sort(), ["ada", "pax"]);
  assert.equal(kindVisualsOf(engine).mana?.icon, "sparkles");
  assert.equal(manaOf(engine, "ada"), 100);
  assert.equal(manaOf(engine, "pax"), 100);
});

test("a character who joins AFTER the default spawns with it", () => {
  let engine = survival();
  engine.setStockDefault("mana", {
    value: 100,
    min: 0,
    max: 100,
    icon: "sparkles",
  });
  engine.setStockDefault("rope", {
    value: 0,
    min: 0,
    max: 20,
    icon: "rope-coil",
  });

  engine.addAgent("Newcomer");

  let obs = engine.getObservation("newcomer").you.stocks;
  assert.equal(obs.mana?.value, 100);
  assert.equal(obs.rope?.value, 0);
  assert.equal(obs.rope?.max, 20);
});

test("the default fills gaps only — it never overwrites an existing stock", () => {
  let engine = survival();
  engine.addAgent("Ada");
  // Ada already carries some mana at a different value/bounds.
  engine.setStock("ada", "mana", 30, { min: 0, max: 50 }, { icon: "sparkles" });

  let result = engine.setStockDefault("mana", {
    value: 100,
    min: 0,
    max: 100,
  });

  assert.deepEqual(result.seeded, [], "Ada was not reseeded");
  let s = engine.getObservation("ada").you.stocks.mana;
  assert.equal(s?.value, 30, "her value is untouched");
  assert.equal(s?.max, 50, "her bounds are untouched");
});

test("WITHOUT a default, a rule reading the stock degrades to a rule_error, not a frozen tick", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.addRule({ ...CHILL_WATCH });

  // Fault isolation (#8): the missing-stock read fails the (rule, agent) pair
  // and surfaces a structured rule_error the GM can see, instead of throwing out
  // of the tick and pausing the shared clock for everyone.
  assert.doesNotThrow(() => engine.tick());
  let err = engine.recentEvents().find((e) => e.type === "rule_error");
  assert.ok(err, "a rule_error event was recorded");
  assert.match(err!.text ?? "", /chill/, "the failing rule is named");
  assert.match(err!.text ?? "", /no stock "mana"/, "the cause is reported");
});

test("regression: the default keeps the tick alive for current AND later joiners", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.setStockDefault("mana", {
    value: 100,
    min: 0,
    max: 100,
    icon: "sparkles",
  });
  engine.addRule({ ...CHILL_WATCH });
  engine.addRule({ ...COLD_FLOW });

  // Ada (alive before the rule) ticks fine and her mana drains.
  engine.tick();
  assert.equal(manaOf(engine, "ada"), 98);

  // A character joining mid-game is seeded, so the mana-reading rule does not
  // throw on the very next tick — the exact failure this feature fixes.
  engine.addAgent("Pax");
  assert.equal(manaOf(engine, "pax"), 100);
  assert.doesNotThrow(() => engine.tick());
  assert.equal(manaOf(engine, "pax"), 98);
});

test("defaults survive snapshot/restore and still seed future joiners", () => {
  let a = survival();
  a.addAgent("Ada");
  a.setStockDefault("mana", { value: 100, min: 0, max: 100, icon: "sparkles" });
  a.addRule({ ...COLD_FLOW });
  let snap = a.snapshot();

  let b = survival();
  assert.equal(b.restore(snap), true);
  assert.deepEqual(b.getStockDefaults().mana, {
    value: 100,
    min: 0,
    max: 100,
  });
  // The GM-chosen icon rides the snapshot too, so the restored world shows it.
  assert.equal(kindVisualsOf(b).mana?.icon, "sparkles");
  // Restored world keeps running, and a fresh joiner is still seeded.
  b.addAgent("Pax");
  assert.equal(manaOf(b, "pax"), 100);
  assert.doesNotThrow(() => b.tick());
});

test("introducing a NEW resource without an icon is rejected", () => {
  let engine = survival();
  engine.addAgent("Ada");

  assert.throws(
    () => engine.setStockDefault("mana", { value: 100 }),
    /needs an "icon"/,
    "a per-character default for a new resource demands an icon",
  );
  assert.throws(
    () => engine.setStock("ada", "mood", 50),
    /needs an "icon"/,
    "a new stock on an entity demands an icon",
  );
});

test("an icon must be a game-icons slug, not an emoji or a sentence", () => {
  let engine = survival();
  assert.throws(
    () => engine.setStockDefault("mana", { value: 100, icon: "✨" }),
    /game-icons\.net slug/,
  );
  assert.throws(
    () => engine.setStockDefault("mana", { value: 100, icon: "A Big Icon" }),
    /game-icons\.net slug/,
  );
});

test("updating an already-known resource needs no icon", () => {
  let engine = survival();
  engine.addAgent("Ada");
  // hunger/health are scenario resources already on Ada — no icon required.
  assert.doesNotThrow(() => engine.setStock("ada", "hunger", 80));
  assert.doesNotThrow(() => engine.setStock("ada", "health", 50));
  // Once mana is registered with an icon, later writes don't re-demand one.
  engine.setStockDefault("mana", { value: 100, icon: "sparkles" });
  assert.doesNotThrow(() => engine.setStock("ada", "mana", 40));
});

test("a GM can override a resource's look by passing a new icon", () => {
  let engine = survival();
  engine.addAgent("Ada");
  engine.setStock("ada", "health", 90, undefined, {
    icon: "hearts",
    color: "#7dcf88",
  });
  assert.deepEqual(kindVisualsOf(engine).health, {
    icon: "hearts",
    color: "#7dcf88",
  });
});

test("defaults ride the portable overlay across a world reset", () => {
  let engine = survival();
  engine.setStockDefault("mana", {
    value: 100,
    min: 0,
    max: 100,
    icon: "sparkles",
  });
  let overlay = engine.getOverlay();
  assert.deepEqual(overlay.stockDefaults?.mana, {
    value: 100,
    min: 0,
    max: 100,
  });
  assert.deepEqual(overlay.kindVisuals?.mana, { icon: "sparkles" });

  engine.reset();
  assert.deepEqual(engine.getStockDefaults(), {}, "reset clears defaults");
  assert.equal(
    kindVisualsOf(engine).mana,
    undefined,
    "reset clears runtime icons",
  );

  engine.applyOverlay(overlay);
  engine.addAgent("Ada");
  assert.equal(manaOf(engine, "ada"), 100, "re-applied default seeds joiner");
  assert.deepEqual(
    kindVisualsOf(engine).mana,
    { icon: "sparkles" },
    "the GM icon returns with the overlay",
  );
});
