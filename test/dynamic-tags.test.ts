// Dynamic tags: every tag position except a rule's `each` selector accepts,
// besides a literal, `{arg}` (an action argument) or `{nameOf: <EntitySel>}`
// (an entity's id resolved at evaluation time). `{nameOf: "self"}` is the
// ownership primitive - a spawn tagged with its builder's id makes "my
// stashes" an ordinary tag query - and `{arg}` lets one rule parameterized
// over a team replace a mirror-image pair. Tested at the kernel level so the
// resolution semantics (always against the acting/evaluating self, never the
// entity an effect's `of` targets) are pinned in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasTag,
  commit,
  step,
  stock,
  type KernelWorld,
  type Rule,
} from "../src/rules/kernel.js";

// Two characters on separate tiles, each carrying gold.
function world(): KernelWorld {
  return {
    tick: 0,
    entities: {
      world: { id: "world", tags: ["world"], stocks: {} },
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: { gold: stock(5, 0, 100), score: stock(0, 0, 1000) },
        pos: { x: 2, y: 2 },
        action: null,
      },
      bek: {
        id: "bek",
        tags: ["agent"],
        stocks: { gold: stock(5, 0, 100), score: stock(0, 0, 1000) },
        pos: { x: 8, y: 8 },
        action: null,
      },
    },
  };
}

// An action that raises a stash on the builder's tile, branded with the
// builder's own id via {nameOf: "self"}.
const buildStash: Rule = {
  id: "build_stash",
  kind: "action",
  duration: 1,
  do: [
    {
      spawn: {
        tags: ["stash", { nameOf: "self" }],
        at: "self",
        stocks: { gold: { value: 0, max: 500 } },
      },
    },
  ],
};

test("a spawn tagged {nameOf: self} carries its builder's id", () => {
  let w = world();
  commit(w, [buildStash], "ara", "build_stash");
  step(w, [buildStash]);
  let stash = w.entities["stash-1"];
  assert.ok(stash, "the stash spawned under the auto-id of its first tag");
  assert.deepEqual(stash.tags, ["stash", "ara"]);
  assert.deepEqual(stash.pos, { x: 2, y: 2 });
});

test("an aggregate over {nameOf: self} totals only the evaluating agent's stashes", () => {
  let w = world();
  // Two stashes each, hand-placed: ara holds 7 total, bek holds 11.
  w.entities["s1"] = {
    id: "s1",
    tags: ["stash", "ara"],
    stocks: { gold: stock(3, 0, 500) },
    pos: { x: 2, y: 3 },
  };
  w.entities["s2"] = {
    id: "s2",
    tags: ["stash", "ara"],
    stocks: { gold: stock(4, 0, 500) },
    pos: { x: 3, y: 2 },
  };
  w.entities["s3"] = {
    id: "s3",
    tags: ["stash", "bek"],
    stocks: { gold: stock(11, 0, 500) },
    pos: { x: 8, y: 9 },
  };
  let scoreRule: Rule = {
    id: "stash-score",
    phase: "derived",
    each: { tag: "agent" },
    target: "score",
    value: { sum: { tag: { nameOf: "self" }, stock: "gold" } },
  };
  step(w, [scoreRule]);
  assert.equal(w.entities.ara.stocks.score.value, 7);
  assert.equal(w.entities.bek.stocks.score.value, 11);
});

test("a tag condition with {nameOf} resolves against the evaluating self, not `of`", () => {
  let w = world();
  // One stash on ara's tile, owned by bek: the ownership gate must fail for
  // ara (the stash lacks HER name) even though the stash itself is `of`.
  w.entities["s1"] = {
    id: "s1",
    tags: ["stash", "bek"],
    stocks: { gold: stock(0, 0, 500) },
    pos: { x: 2, y: 2 },
  };
  let claimOwn: Rule = {
    id: "mark-owner-present",
    phase: "transition",
    each: { tag: "agent" },
    when: {
      all: [
        { colocated: { tag: "stash" } },
        { tag: { nameOf: "self" }, of: { colocated: "stash" } },
      ],
    },
    do: [{ set: { target: "score", to: 1 } }],
    emit: { type: "owner_home" },
  };
  step(w, [claimOwn]);
  assert.equal(w.entities.ara.stocks.score.value, 0, "not ara's stash");
  // Walk bek onto the stash: the same rule now passes for him.
  w.entities.bek.pos = { x: 2, y: 2 };
  step(w, [claimOwn]);
  assert.equal(w.entities.bek.stocks.score.value, 1, "bek owns it");
});

test("a colocated selector with a {nameOf} tag binds the actor's own stash", () => {
  let w = world();
  w.entities["mine"] = {
    id: "mine",
    tags: ["stash", "ara"],
    stocks: { gold: stock(0, 0, 500) },
    pos: { x: 2, y: 2 },
  };
  w.entities["theirs"] = {
    id: "theirs",
    tags: ["stash", "bek"],
    stocks: { gold: stock(0, 0, 500) },
    pos: { x: 2, y: 2 },
  };
  let deposit: Rule = {
    id: "deposit",
    kind: "action",
    duration: 1,
    requires: {
      colocated: { tag: { nameOf: "self" }, where: { tag: "stash" } },
    },
    do: [
      {
        transfer: {
          from: { stock: "gold" },
          to: { stock: "gold", of: { colocated: { tag: { nameOf: "self" } } } },
          amount: { stock: "gold" },
        },
      },
    ],
  };
  commit(w, [deposit], "ara", "deposit");
  step(w, [deposit]);
  assert.equal(w.entities["mine"].stocks.gold.value, 5, "into ara's stash");
  assert.equal(w.entities["theirs"].stocks.gold.value, 0, "not bek's");
  assert.equal(w.entities.ara.stocks.gold.value, 0);
});

test("a tag effect with {arg} lets one action serve every team", () => {
  let w = world();
  let joinTeam: Rule = {
    id: "join_team",
    kind: "action",
    duration: 1,
    params: [{ name: "team", type: "enum", values: ["crimson", "azure"] }],
    do: [{ tag: { add: { arg: "team" } } }],
  };
  commit(w, [joinTeam], "ara", "join_team", { team: "crimson" });
  commit(w, [joinTeam], "bek", "join_team", { team: "azure" });
  step(w, [joinTeam]);
  assert.ok(hasTag(w.entities.ara, "crimson"));
  assert.ok(hasTag(w.entities.bek, "azure"));
  assert.ok(!hasTag(w.entities.ara, "azure"));
});

test("a tag effect branding `of` with {nameOf: self} names the actor, not the target", () => {
  let w = world();
  w.entities.bek.pos = { x: 2, y: 2 };
  let brand: Rule = {
    id: "brand-neighbour",
    phase: "transition",
    each: { tag: "agent" },
    when: {
      all: [
        { colocated: { tag: "agent" } },
        // Only ara acts, so the assertion below is single-sourced.
        { cmp: "gte", left: { stock: "gold" }, right: 5 },
      ],
    },
    do: [
      {
        tag: { of: { colocated: "agent" }, add: { nameOf: "self" } },
      },
      { adjust: { target: "gold", by: -5 } },
    ],
    emit: { type: "branded" },
  };
  // Drop bek's gold below the gate so only ara fires this tick.
  w.entities.bek.stocks.gold.value = 0;
  step(w, [brand]);
  assert.ok(
    hasTag(w.entities.bek, "ara"),
    "bek now carries ara's name, not his own",
  );
  assert.ok(!hasTag(w.entities.ara, "bek"));
});
