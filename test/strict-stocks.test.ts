// The closed stock namespace (see kernel.ts requireStock/StockVocabulary):
// adjust/set/transfer.source may only write a stock the target entity already
// carries; transfer.destination may still mint a fresh stock, but only for a
// name the ruleset has declared somewhere (the known-stock registry). This is
// the fix for run 3's phantom-stock bug, where a rule that meant
// `{of:"self"}` wrote `{target:"self"}` instead and silently minted a stock
// literally named "self" on every agent.

import assert from "node:assert/strict";
import test from "node:test";

import {
  commit,
  step,
  stock,
  type Entity,
  type KernelWorld,
  type Rule,
  type StockVocabulary,
} from "../src/rules/kernel.js";
import { makeSurvivalEngine } from "./helpers.js";

// A bare world with an actor and a target entity, both starting with no
// stocks - the kernel-level scaffold, mirroring items.test.ts's makeWorld.
function makeBareWorld(): KernelWorld {
  let entities: Record<string, Entity> = {
    world: { id: "world", tags: ["world"], stocks: {} },
    ara: {
      id: "ara",
      tags: ["agent"],
      stocks: {},
      pos: { x: 0, y: 0 },
      action: null,
    },
    crate: { id: "crate", tags: ["container"], stocks: {} },
  };
  return { tick: 0, entities };
}

test("kernel: adjust rejects the run-3 regression (target meant to be of)", () => {
  let world = makeBareWorld();
  world.entities.ara.stocks.gold = stock(10, 0, 9999);
  // The authoring slip: "self" was meant to go in `of`, not `target`.
  let mistake: Rule = {
    id: "mistake",
    kind: "action",
    duration: 1,
    do: [{ adjust: { target: "self", by: -1 } }],
  };

  assert.equal(commit(world, [mistake], "ara", "mistake").ok, true);
  let events = step(world, [mistake]);

  let err = events.find((e) => e.type === "rule_error");
  assert.ok(err, "a rule_error was recorded instead of a silent mint");
  assert.match(err!.text ?? "", /no stock "self"/);
  assert.equal(
    world.entities.ara.stocks.self,
    undefined,
    "no phantom 'self' stock exists on the actor",
  );
  assert.equal(world.entities.ara.stocks.gold.value, 10, "gold is untouched");
});

test("kernel: set rejects a missing target the same way adjust does", () => {
  let world = makeBareWorld();
  let rule: Rule = {
    id: "reset_mood",
    kind: "action",
    duration: 1,
    do: [{ set: { target: "mood", to: 0 } }],
  };

  assert.equal(commit(world, [rule], "ara", "reset_mood").ok, true);
  let events = step(world, [rule]);
  let err = events.find((e) => e.type === "rule_error");
  assert.ok(err, "a rule_error was recorded");
  assert.equal(world.entities.ara.stocks.mood, undefined);
});

test("kernel: transfer still vivifies a fresh destination for a known resource", () => {
  let world = makeBareWorld();
  let vocab: StockVocabulary = { known: new Set(["wood"]) };
  world.entities.ara.stocks.wood = stock(5, 0, 9999);
  let depositWood: Rule = {
    id: "deposit_wood",
    kind: "action",
    duration: 1,
    do: [
      {
        transfer: {
          from: { stock: "wood", of: "self" },
          to: { stock: "wood", of: "crate" },
          amount: 5,
        },
      },
    ],
  };

  assert.equal(
    commit(
      world,
      [depositWood],
      "ara",
      "deposit_wood",
      {},
      undefined,
      undefined,
      vocab,
    ).ok,
    true,
  );
  step(world, [depositWood], vocab);

  assert.equal(world.entities.ara.stocks.wood.value, 0);
  assert.equal(
    world.entities.crate.stocks.wood.value,
    5,
    "a known resource still vivifies its first destination",
  );
});

test("kernel: transfer refuses to vivify a destination for an unregistered name", () => {
  let world = makeBareWorld();
  // "gold" is deliberately absent
  let vocab: StockVocabulary = { known: new Set(["wood"]) };
  world.entities.ara.stocks.gold = stock(3, 0, 9999);
  let depositGold: Rule = {
    id: "deposit_gold",
    kind: "action",
    duration: 1,
    do: [
      {
        transfer: {
          from: { stock: "gold", of: "self" },
          to: { stock: "gold", of: "crate" },
          amount: 1,
        },
      },
    ],
  };

  assert.equal(
    commit(
      world,
      [depositGold],
      "ara",
      "deposit_gold",
      {},
      undefined,
      undefined,
      vocab,
    ).ok,
    true,
  );
  let events = step(world, [depositGold], vocab);

  let err = events.find((e) => e.type === "rule_error");
  assert.ok(err, "an unregistered destination name is rejected");
  assert.match(err!.text ?? "", /"gold" is not a known resource/);
  assert.equal(
    world.entities.crate.stocks.gold,
    undefined,
    "no phantom stock was minted",
  );
  assert.equal(world.entities.ara.stocks.gold.value, 3, "nothing moved");
});

test("kernel: transfer with a missing source stock reports a clean error", () => {
  let world = makeBareWorld();
  let rule: Rule = {
    id: "deposit_silver",
    kind: "action",
    duration: 1,
    do: [
      {
        transfer: {
          from: { stock: "silver", of: "self" },
          to: { stock: "silver", of: "crate" },
          amount: 1,
        },
      },
    ],
  };

  assert.equal(commit(world, [rule], "ara", "deposit_silver").ok, true);
  let events = step(world, [rule]);
  let err = events.find((e) => e.type === "rule_error");
  assert.ok(err, "a rule_error was recorded");
  assert.match(err!.text ?? "", /entity "ara" has no stock "silver"/);
  assert.equal(world.entities.crate.stocks.silver, undefined);
});

test("engine: set_stock_default admits a name before a rule writes to it", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.setStockDefault("gizmo", {
    value: 0,
    min: 0,
    max: 10,
    icon: "gear",
    color: "#888888",
  });
  engine.addRule({
    id: "gizmo_test",
    kind: "action",
    duration: 1,
    do: [{ adjust: { target: "gizmo", by: 3 } }],
  });
  engine.setOrder(ara, { kind: "sequence", steps: [{ type: "gizmo_test" }] });
  engine.tick();

  assert.equal(engine.getObservation(ara).you.stocks.gizmo?.value, 3);
});

test("engine: a spawn in a non-action rule declares its stocks too", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  // A spawn is legal in any immediate phase, not just an action body, and a
  // nested forEach is legal anywhere a body is. The stock vocabulary has to
  // see both before the rule first fires, or a transfer into the spawned
  // entity's own resource is rejected as a phantom name.
  engine.addRule({
    id: "seed_caches",
    description: "test: a transition rule that spawns a stocked entity",
    phase: "transition",
    each: { tag: "agent" },
    when: { cmp: "gte", left: { stock: "hunger" }, right: 1e9 },
    do: [
      {
        forEach: {
          colocated: { tag: "agent", range: 1 },
          do: [
            {
              spawn: {
                kind: "cache",
                tags: ["portable"],
                stocks: { salt: { value: 5, max: 5 } },
              },
            },
          ],
        },
      },
    ],
  });

  let report = engine.dryRunRule("seed_caches");
  assert.equal(
    report.warnings.some((w) => w.includes('"salt"')),
    false,
    `a nested spawn's own stock is declared, not phantom: ${JSON.stringify(report.warnings)}`,
  );
});

test("engine: dry-run flags a rule that writes to an undeclared stock", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  engine.addRule({
    id: "typo_rule",
    description: "test: adjusts a stock nobody declared",
    phase: "threshold",
    each: { tag: "agent" },
    do: [{ adjust: { target: "stanima", by: -1 } }],
  });

  let report = engine.dryRunRule("typo_rule");
  assert.ok(
    report.warnings.some((w) => w.includes('"stanima"')),
    "the undeclared stock is named in a warning",
  );
});

test("kernel: a vocabulary binds only the call it is passed to", () => {
  // Two worlds in one process: one closed to "wood", one with no registry.
  // The closed world's vocabulary must not leak into the open world's tick.
  let depositGold: Rule = {
    id: "deposit_gold",
    kind: "action",
    duration: 1,
    do: [
      {
        transfer: {
          from: { stock: "gold", of: "self" },
          to: { stock: "gold", of: "crate" },
          amount: 1,
        },
      },
    ],
  };
  let closed = makeBareWorld();
  let open = makeBareWorld();
  closed.entities.ara.stocks.gold = stock(3, 0, 9999);
  open.entities.ara.stocks.gold = stock(3, 0, 9999);
  let vocab: StockVocabulary = { known: new Set(["wood"]) };

  commit(closed, [depositGold], "ara", "deposit_gold");
  commit(open, [depositGold], "ara", "deposit_gold");
  step(closed, [depositGold], vocab);
  step(open, [depositGold]);

  assert.equal(closed.entities.crate.stocks.gold, undefined);
  assert.equal(
    open.entities.crate.stocks.gold?.value,
    1,
    "the open world still vivifies - it never saw the closed world's names",
  );
});
