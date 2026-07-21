import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { assertValidRule, RuleSchema } from "../src/rules/rule-schema.js";
import { resolveIncludes, rulesetsDirFor } from "../src/scenarios.js";

test("accepts a colocated requires gate written in object form", () => {
  const rule = {
    id: "eat_at_food",
    kind: "action",
    duration: 1,
    requires: { all: [{ colocated: { tag: "food" } }] },
    do: [{ adjust: { target: "hunger", by: -10 } }],
  };
  assert.equal(RuleSchema.safeParse(rule).success, true);
});

test("rejects the bare-tag colocated shorthand inside a Cond (requires/when/fizzleWhen)", () => {
  const rule = {
    id: "eat_at_food_bad",
    kind: "action",
    duration: 1,
    requires: { all: [{ colocated: "food" }] },
    do: [{ adjust: { target: "hunger", by: -10 } }],
  };
  assert.equal(RuleSchema.safeParse(rule).success, false);
});

test("accepts the bare-tag colocated shorthand inside an EntitySel (an effect's `of`)", () => {
  const rule = {
    id: "gather_wood",
    kind: "action",
    duration: 3,
    do: [{ adjust: { target: "wood", of: { colocated: "wood" }, by: -1 } }],
  };
  assert.equal(RuleSchema.safeParse(rule).success, true);
});

test("assertValidRule throws a short, targeted message for the colocated gotcha", () => {
  const rule = {
    id: "eat_at_food_bad",
    kind: "action",
    duration: 1,
    requires: { all: [{ colocated: "food" }] },
    do: [{ adjust: { target: "hunger", by: -10 } }],
  };
  assert.throws(
    () => assertValidRule(rule),
    /requires\.all\.0\.colocated: Invalid input: expected object, received string/,
  );
});

test("assertValidRule throws a targeted message for an unknown phase", () => {
  const rule = { id: "bad_phase", phase: "flowx", target: "wood", rate: 1 };
  assert.throws(() => assertValidRule(rule), /Expected 'derived' \| 'flow'/);
});

test("assertValidRule does not throw for a valid rule", () => {
  const rule = {
    id: "eat_at_food",
    kind: "action",
    duration: 1,
    requires: { all: [{ colocated: { tag: "food" } }] },
    do: [{ adjust: { target: "hunger", by: -10 } }],
  };
  assert.doesNotThrow(() => assertValidRule(rule));
});

test("accepts directional growth gated by the matching map edge", () => {
  let rule = {
    id: "expand-west",
    phase: "transition",
    each: { tag: "world" },
    when: {
      cmp: "gt",
      left: {
        count: {
          tag: "agent",
          where: { atMapEdge: { edge: "west" } },
        },
      },
      right: 0,
    },
    do: [{ growWorld: { by: 3, direction: "west" } }],
  };
  assert.doesNotThrow(() => assertValidRule(rule));
});

test("rejects an unknown map edge", () => {
  let rule = {
    id: "expand-sideways",
    phase: "transition",
    each: { tag: "world" },
    when: { atMapEdge: { edge: "sideways" } },
    do: [{ growWorld: { by: 3, direction: "sideways" } }],
  };
  assert.throws(() => assertValidRule(rule), /north.*east.*south.*west/);
});

test("every rule in every shipped scenario validates against RuleSchema", () => {
  for (const file of readdirSync("config/scenarios")) {
    let scenario = JSON.parse(readFileSync(`config/scenarios/${file}`, "utf8"));
    // Sweep the composed rule set (inline rules plus any pulled in from included
    // rulesets), so extracting rules into a ruleset doesn't blind this guarantee.
    let rules = resolveIncludes(
      scenario,
      rulesetsDirFor("config/scenarios"),
    ).dynamicRules;
    for (let rule of rules) {
      let result = RuleSchema.safeParse(rule);
      assert.equal(
        result.success,
        true,
        `${file} rule "${rule.id}": ${JSON.stringify(result.success ? null : result.error.issues)}`,
      );
    }
  }
});
