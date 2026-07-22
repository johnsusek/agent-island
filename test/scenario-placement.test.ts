// Terrain placement rides the scenario now: a scenario owns not just its terrain
// definitions (terrainSpecs) but where that terrain is painted (defaultTerrain +
// blobs). scenarioBootScenario is the seam that folds a scenario's placement onto the
// shared world-file canvas, stamps identity from the scenario, and refuses a scenario
// that paints terrain it never defined. These lock that contract.

import assert from "node:assert/strict";
import { hasTag } from "../src/rules/kernel.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { scenario } from "../src/rules/config.js";
import { scenarioBootScenario } from "../src/coordinator-scenarios.js";
import { createWorld } from "../src/rules/engine.js";
import { createScenarioStore, type ScenarioFile } from "../src/scenarios.js";
import type { Scenario } from "../src/rules/scenario.js";

function scenarioFile(overlay: Partial<ScenarioFile["overlay"]>): ScenarioFile {
  return {
    name: "test-scenario",
    overlay: { dynamicRules: [], removedBaseIds: [], ...overlay },
  };
}

test("a scenario's placement paints its terrain onto the shared canvas", () => {
  let boot = scenarioBootScenario(
    scenario,
    scenarioFile({
      terrainSpecs: {
        plains: {},
        forest: { moveCost: 2 },
      },
      defaultTerrain: "plains",
      blobs: [{ terrain: "forest", density: 3, maxRadius: 2 }],
    }),
  );
  // Canvas dimensions come from the world file; placement from the scenario.
  assert.equal(boot.worldgen?.width, scenario.worldgen?.width);
  assert.deepEqual(
    boot.worldgen?.blobs?.map((b) => b.terrain),
    ["forest"],
  );
  let forest = createWorld(boot)
    .getMap()
    .tiles.filter((t) => t.terrain === "forest");
  assert.ok(
    forest.length > 0,
    "the scenario's forest blobs actually paint tiles",
  );
});

test("identity is stamped from the active scenario, not the world file", () => {
  let boot = scenarioBootScenario(
    scenario,
    scenarioFile({ defaultTerrain: "plains", terrainSpecs: { plains: {} } }),
  );
  assert.equal(boot.name, "test-scenario");
});

test("a runtime scenario replacement refreshes identity and derived baselines", () => {
  let engine = createWorld(scenario);
  let oldSnapshot = engine.snapshot();
  let nextScenario: Scenario = {
    ...scenario,
    name: "next-game",
    rules: [{ id: "wait", kind: "action", duration: 1, do: [] }],
    agentTemplate: {
      tags: ["agent", "traveler"],
      stocks: { stamina: { value: 12, min: 0, max: 12 } },
    },
  };

  engine.reset({ scenario: nextScenario });
  engine.addAgent("Ada");

  assert.equal(engine.scenarioName, "next-game");
  assert.equal(engine.snapshot().scenario, "next-game");
  assert.equal(engine.getAdminState().scenario.name, "next-game");
  assert.deepEqual(engine.getRuleMeta().baselineIds, ["wait"]);
  assert.ok(hasTag(engine.getEntities().ada, "traveler"));
  assert.equal(engine.getEntities().ada.stocks.stamina.value, 12);
  // stamina is declared only by the agent template, not by a stock registry,
  // so the projection has nothing to say about it - an undeclared stock reads
  // as a plain pack count wherever role is asked for.
  assert.equal(engine.getAdminState().scenario.display.stamina, undefined);
  assert.equal(engine.restore(oldSnapshot), false);
});

test("no active scenario leaves the bare scenario unchanged", () => {
  let boot = scenarioBootScenario(scenario, null);
  assert.equal(boot.name, scenario.name);
  assert.equal(boot.worldgen, scenario.worldgen);
});

test("a scenario that paints terrain it never defined is rejected", () => {
  assert.throws(
    () =>
      scenarioBootScenario(
        scenario,
        scenarioFile({
          terrainSpecs: { plains: {} },
          defaultTerrain: "plains",
          blobs: [{ terrain: "swamp", density: 2, maxRadius: 2 }],
        }),
      ),
    /paints terrain "swamp"/,
  );
});

test("loading a scenario rejects an invalid terrain movement cost", () => {
  let directory = mkdtempSync(
    join(tmpdir(), "agent-island-bad-terrain-scenario-"),
  );
  try {
    writeFileSync(
      join(directory, "bad-cost.json"),
      JSON.stringify({
        name: "bad-cost",
        overlay: {
          dynamicRules: [],
          removedBaseIds: [],
          terrainSpecs: { plains: { moveCost: -1 } },
        },
      }),
    );
    let store = createScenarioStore(directory);
    assert.throws(
      () => store.load("bad-cost"),
      /scenario "bad-cost".*moveCost must be a finite integer of at least 1/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
