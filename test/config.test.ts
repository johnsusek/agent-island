import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadGraphicsConfig, loadRuleset } from "../src/rules/config.js";

test("loads a ruleset and stamps a spawn", () => {
  let directory = mkdtempSync(path.join(tmpdir(), "agent-island-ruleset-"));
  let rulesetPath = path.join(directory, "ruleset.json");

  writeFileSync(
    rulesetPath,
    JSON.stringify({
      name: "test",
      width: 7,
      height: 5,
      defaultTerrain: "plains",
    }),
  );

  let scenario = loadRuleset(rulesetPath);
  assert.equal(scenario.name, "test");
  assert.equal(scenario.worldgen?.width, 7);
  assert.deepEqual(scenario.rules, [], "the world file authors no rules");
  // The loader rolls a spawn from the ruleset's worldgen.
  assert.ok(
    Number.isInteger(scenario.spawn.x) && Number.isInteger(scenario.spawn.y),
    "a spawn tile is stamped onto the scenario",
  );
});

test("a world file that tries to author rules is rejected at load", () => {
  let directory = mkdtempSync(path.join(tmpdir(), "agent-island-ruleset-"));
  let rulesetPath = path.join(directory, "world.json");
  writeFileSync(
    rulesetPath,
    JSON.stringify({ name: "test", rules: [], width: 5, height: 5 }),
  );
  assert.throws(() => loadRuleset(rulesetPath), /scenario/);
});

test("loads graphics separately from world generation", () => {
  let directory = mkdtempSync(path.join(tmpdir(), "agent-island-graphics-"));
  let rulesetPath = path.join(directory, "world.json");
  writeFileSync(
    rulesetPath,
    JSON.stringify({
      width: 5,
      height: 5,
      graphics: { scale: 3 },
    }),
  );

  let scenario = loadRuleset(rulesetPath);
  assert.equal("graphics" in (scenario.worldgen ?? {}), false);
  assert.deepEqual(loadGraphicsConfig(rulesetPath), { scale: 3 });
});

test("graphics.packs is rejected - sprites live inline in visuals now", () => {
  let directory = mkdtempSync(path.join(tmpdir(), "agent-island-graphics-"));
  let rulesetPath = path.join(directory, "world.json");
  writeFileSync(
    rulesetPath,
    JSON.stringify({
      width: 5,
      height: 5,
      graphics: { scale: 3, packs: { kenney: "/assets/kenney/pack.json" } },
    }),
  );
  assert.throws(() => loadGraphicsConfig(rulesetPath), /unknown key "packs"/);
});
