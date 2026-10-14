// The commons example (examples/commons) booted the way a library user would:
// from its own world file and scenarios folder, through package APIs only.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createWorld } from "@agent-island/engine/engine";

import {
  createColony,
  createScenarioStore,
  renderCharacterResult,
  renderWake,
  scenarioBootScenario,
  scenarioFromWorldFile,
} from "../src/index.js";

let dir = new URL("../examples/commons/", import.meta.url).pathname;
let base = scenarioFromWorldFile(
  JSON.parse(readFileSync(`${dir}world.json`, "utf8")),
  "world.json",
);
let commons = createScenarioStore(`${dir}scenarios`, `${dir}scenarios`).load(
  "commons",
);

test("a character in the commons sees the bay and can fish and eat", async () => {
  let colony = createColony({
    baseScenario: base,
    scenariosDir: `${dir}scenarios`,
    scenarios: ["commons"],
    waitTimeoutMs: 2000,
    // Bo is here only to be someone Ara can give to; he never acts, so keep
    // the turn he stalls short.
    maxWaitMs: 50,
  });
  colony.start();
  colony.connect("a");
  colony.connect("b");
  try {
    colony.join("b", "Bo");
    let joined = colony.join("a", "Ara");
    assert.match(
      renderWake(joined),
      /The world holds: fish in the bay 30\/40\./,
      "the shared stock is in the character's own prose",
    );

    colony.act("a", { type: "fish" });
    let change = await colony.waitForChange("a");
    while (change.observation.you.action)
      change = await colony.waitForChange("a");
    assert.equal(change.observation.you.stocks.fish.value, 2);

    // A one-tile world is a room: no map, no movement verbs, and give
    // offers an amount.
    let prose = renderWake(change);
    assert.doesNotMatch(prose, /Sight \(|travel|explore|scan/);
    assert.match(prose, /give\(target: [^)]*amount\?: number\)/);

    colony.act("a", { type: "eat" });
    change = await colony.waitForChange("a");
    while (change.observation.you.action)
      change = await colony.waitForChange("a");
    assert.equal(change.observation.you.stocks.fish.value, 1);
  } finally {
    colony.stop();
  }
});

// Drive four villagers for a whole season with a fixed policy, straight on the
// engine: each idle villager picks its next action from what it can see.
function season(policy: (v: { sat: number; fish: number }) => string | null) {
  let engine = createWorld(scenarioBootScenario(base, commons));
  engine.applyOverlay(commons.overlay);
  let ids = ["Ara", "Bo", "Cy", "Di"].map((name) => {
    engine.addAgent(name);
    return name.toLowerCase();
  });
  for (let tick = 0; tick < 305; tick += 1) {
    let entities = engine.getEntities() as Record<string, any>;
    for (let id of ids) {
      let villager = entities[id];
      if (!villager.tags.includes("agent") || villager.action) continue;
      let pick = policy({
        sat: villager.stocks.satiation.value,
        fish: villager.stocks.fish.value,
      });
      if (pick)
        try {
          engine.commitIntent(id, { type: pick });
        } catch {
          // the bay is empty: nothing to do but wait
        }
    }
    engine.tick();
  }
  let entities = engine.getEntities() as Record<string, any>;
  return {
    alive: ids.filter((id) => entities[id].tags.includes("agent")).length,
    bay: entities.world.stocks.school.value,
    events: engine.recentEvents(5000).map((event: any) => event.type),
  };
}

// Hoarding is a one-time grab, but it drags the bay below the level where it
// can regrow as fast as the village eats, and an empty bay never comes back.
test("keeping a full basket empties the bay for good and starves the village", () => {
  let result = season(({ sat, fish }) =>
    sat < 60 && fish > 0 ? "eat" : "fish",
  );
  assert.equal(result.bay, 0, "the collapse is final");
  assert.ok(result.events.includes("collapse"));
  assert.equal(result.alive, 0);
  assert.ok(!result.events.includes("victory"));
});

test("fishing only when hungry keeps the bay alive and wins the season", () => {
  let result = season(({ sat, fish }) =>
    sat < 60 ? (fish > 0 ? "eat" : "fish") : null,
  );
  assert.ok(result.bay > 10, `the bay holds ${result.bay}`);
  assert.equal(result.alive, 4);
  assert.ok(result.events.includes("victory"));
});

// The README's quota: a GM tightens the fish action, and the refusal reaches
// the character in the GM's own words.
test("a GM can close the bay with a quota", () => {
  let colony = createColony({
    baseScenario: base,
    scenariosDir: `${dir}scenarios`,
    scenarios: ["commons"],
  });
  colony.connect("a");
  colony.connect("gm");
  try {
    colony.join("a", "Ara");
    colony.joinAsGm("gm");
    colony.gmPatchRule("gm", "fish", {
      requires: {
        all: [
          { cmp: "gte", left: { stock: "school", of: "world" }, right: 35 },
          { cmp: "lt", left: { stock: "fish" }, right: 6 },
        ],
      },
      requireReason: "the council has closed the bay until it holds 35 fish",
    });
    assert.throws(
      () => colony.act("a", { type: "fish" }),
      /the council has closed the bay/,
    );
  } finally {
    colony.stop();
  }
});

// A formal vote end to end: a villager proposes, the others read the motion
// and its tally in their own prose and vote, and the director's wake carries
// the result with the exact wording - nothing inferred from chat.
test("villagers vote on a motion and the director hears the result", async () => {
  let colony = createColony({
    baseScenario: base,
    scenariosDir: `${dir}scenarios`,
    scenarios: ["commons"],
    waitTimeoutMs: 2000,
    maxWaitMs: 50,
  });
  colony.start();
  for (let s of ["a", "b", "c", "gm"]) colony.connect(s);
  try {
    colony.join("a", "Ara");
    colony.join("b", "Bo");
    colony.join("c", "Cy");
    colony.joinAsGm("gm");
    let clerk = colony.waitForWorld("gm", { events: ["motion_passed"] });

    let wording = "Nobody fishes while the bay holds under 20.";
    let proposed = colony.propose("a", wording);
    assert.match(
      renderCharacterResult(proposed),
      /Motion 1 is open \(1 yes, 0 no\); you voted yes\./,
    );

    let bo = await colony.waitForChange("b");
    let prose = renderWake(bo);
    assert.match(prose, /Ara proposes motion 1: "Nobody fishes/);
    assert.match(
      prose,
      /Open motion 1 \(Ara, closes in 20 ticks\): "Nobody fishes[^"]*" - 1 yes, 0 no; you have not voted - vote\(1, yes\|no\)\./,
    );

    let voted = colony.vote("b", 1, "yes");
    assert.match(
      renderCharacterResult(voted),
      /Motion 1 passed \(2 yes, 0 no\)\./,
    );

    let wake = await clerk;
    let [passed] = wake.events;
    assert.equal(passed.type, "motion_passed");
    assert.equal(passed.message, wording);
    assert.match(passed.text, /2 yes, 0 no, of 3 living/);

    // A director that joins later still finds it, in its join inspection.
    colony.connect("gm2");
    let late = colony.joinAsGm("gm2");
    assert.equal(late.motions[0].status, "passed");
    assert.equal(late.motions[0].text, wording);
  } finally {
    colony.stop();
  }
});
