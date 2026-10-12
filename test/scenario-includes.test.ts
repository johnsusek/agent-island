import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createScenarioStore } from "@agent-island/mcp/scenarios";

// A scenarios dir with a sibling rulesets dir, populated from {scenarios, rulesets}
// maps of name -> file body. Mirrors the on-disk layout config/scenarios +
// config/rulesets that the store resolves `include` against.
function fixture(files: {
  scenarios: Record<string, unknown>;
  rulesets?: Record<string, unknown>;
}): string {
  let root = mkdtempSync(path.join(tmpdir(), "agent-island-include-"));
  let scenDir = path.join(root, "scenarios");
  let rsDir = path.join(root, "rulesets");
  mkdirSync(scenDir);
  mkdirSync(rsDir);
  for (let [name, body] of Object.entries(files.scenarios))
    writeFileSync(path.join(scenDir, `${name}.json`), JSON.stringify(body));
  for (let [name, body] of Object.entries(files.rulesets ?? {}))
    writeFileSync(path.join(rsDir, `${name}.json`), JSON.stringify(body));
  return scenDir;
}

let flowRule = (id: string, target: string, rate = 0.1) => ({
  id,
  phase: "flow",
  each: { tag: "agent" },
  target,
  rate,
  channel: `${target}.rise`,
});

test("a scenario pulls in an included ruleset's rules", () => {
  let dir = fixture({
    rulesets: {
      metabolism: {
        name: "metabolism",
        overlay: { dynamicRules: [flowRule("hunger-rises", "hunger")] },
      },
    },
    scenarios: {
      game: {
        name: "game",
        include: ["metabolism"],
        overlay: { dynamicRules: [flowRule("thirst-rises", "thirst")] },
      },
    },
  });
  let overlay = createScenarioStore(dir).load("game").overlay;
  assert.deepEqual(
    overlay.dynamicRules.map((r) => r.id),
    ["hunger-rises", "thirst-rises"],
  );
});

test("the scenario wins when it redefines an included rule id", () => {
  let dir = fixture({
    rulesets: {
      metabolism: {
        overlay: { dynamicRules: [flowRule("hunger-rises", "hunger", 0.1)] },
      },
    },
    scenarios: {
      game: {
        name: "game",
        include: ["metabolism"],
        overlay: { dynamicRules: [flowRule("hunger-rises", "hunger", 0.5)] },
      },
    },
  });
  let overlay = createScenarioStore(dir).load("game").overlay;
  assert.equal(overlay.dynamicRules.length, 1);
  assert.equal((overlay.dynamicRules[0] as { rate: number }).rate, 0.5);
});

test("a scenario drops an included rule with removedBaseIds", () => {
  let dir = fixture({
    rulesets: {
      metabolism: {
        overlay: {
          dynamicRules: [
            flowRule("hunger-rises", "hunger"),
            flowRule("thirst-rises", "thirst"),
          ],
        },
      },
    },
    scenarios: {
      game: {
        name: "game",
        include: ["metabolism"],
        overlay: { dynamicRules: [], removedBaseIds: ["thirst-rises"] },
      },
    },
  });
  let overlay = createScenarioStore(dir).load("game").overlay;
  assert.deepEqual(
    overlay.dynamicRules.map((r) => r.id),
    ["hunger-rises"],
  );
});

test("rulesets may include other rulesets (nesting), scenario applies last", () => {
  let dir = fixture({
    rulesets: {
      base: { overlay: { dynamicRules: [flowRule("a", "a")] } },
      mid: {
        include: ["base"],
        overlay: { dynamicRules: [flowRule("b", "b")] },
      },
    },
    scenarios: {
      game: {
        name: "game",
        include: ["mid"],
        overlay: { dynamicRules: [flowRule("c", "c")] },
      },
    },
  });
  let overlay = createScenarioStore(dir).load("game").overlay;
  assert.deepEqual(
    overlay.dynamicRules.map((r) => r.id),
    ["a", "b", "c"],
  );
});

test("supporting fields merge, with the scenario overriding on key clashes", () => {
  let dir = fixture({
    rulesets: {
      metabolism: {
        overlay: {
          dynamicRules: [],
          stockDefaults: { hunger: { min: 0, max: 100, value: 0 } },
          describeEvent: { ate: "from ruleset" },
        },
      },
    },
    scenarios: {
      game: {
        name: "game",
        include: ["metabolism"],
        overlay: {
          dynamicRules: [],
          describeEvent: { ate: "from scenario" },
        },
      },
    },
  });
  let overlay = createScenarioStore(dir).load("game").overlay;
  assert.ok(overlay.stockDefaults?.hunger, "ruleset stock default rides along");
  assert.equal(overlay.describeEvent?.ate, "from scenario");
});

test("an include cycle is a clear load error", () => {
  let dir = fixture({
    rulesets: {
      a: { include: ["b"], overlay: { dynamicRules: [] } },
      b: { include: ["a"], overlay: { dynamicRules: [] } },
    },
    scenarios: {
      game: { name: "game", include: ["a"], overlay: { dynamicRules: [] } },
    },
  });
  assert.throws(() => createScenarioStore(dir).load("game"), /cycle/);
});

test("including an unknown ruleset names the missing file", () => {
  let dir = fixture({
    scenarios: {
      game: { name: "game", include: ["ghost"], overlay: { dynamicRules: [] } },
    },
  });
  assert.throws(
    () => createScenarioStore(dir).load("game"),
    /unknown ruleset "ghost"/,
  );
});

test("a malformed rule in a ruleset fails with the ruleset named", () => {
  let dir = fixture({
    rulesets: {
      broken: {
        overlay: {
          dynamicRules: [{ id: "bad", phase: "flow", each: { tag: "agent" } }],
        },
      },
    },
    scenarios: {
      game: {
        name: "game",
        include: ["broken"],
        overlay: { dynamicRules: [] },
      },
    },
  });
  assert.throws(
    () => createScenarioStore(dir).load("game"),
    /ruleset "broken"/,
  );
});

test("a diamond include merges the shared ruleset exactly once", () => {
  let scatter = { kind: "tree", tags: [], occupancy: "tile", density: 0.1 };
  let dir = fixture({
    rulesets: {
      provisions: {
        overlay: {
          dynamicRules: [flowRule("hunger-rises", "hunger")],
          setup: [{ scatter }],
        },
      },
      foraging: {
        include: ["provisions"],
        overlay: { dynamicRules: [flowRule("forage-drift", "plants")] },
      },
      cooking: {
        include: ["provisions"],
        overlay: { dynamicRules: [flowRule("cook-drift", "meals")] },
      },
    },
    scenarios: {
      game: {
        name: "game",
        // provisions is reachable three ways: directly and through both packs.
        include: ["provisions", "foraging", "cooking"],
        overlay: { dynamicRules: [] },
      },
    },
  });
  let overlay = createScenarioStore(dir).load("game").overlay;
  // Additive setup entries are the tell: a re-merged ruleset would double them.
  assert.equal(overlay.setup?.length, 1);
  assert.deepEqual(
    overlay.dynamicRules.map((r) => r.id),
    ["hunger-rises", "forage-drift", "cook-drift"],
  );
});
