import assert from "node:assert/strict";
import test from "node:test";

import type { WorldEngine } from "../src/rules/engine.js";
import type { Rule } from "@agent-island/core/kernel";
import { makeSurvivalEngine, survivalScenario } from "./helpers.js";

function runToIdle(engine: WorldEngine, agentId: string) {
  for (let tickIndex = 0; tickIndex < 20; tickIndex += 1) {
    if (!engine.getObservation(agentId).you.action) return;
    engine.tick();
  }
  throw new Error(`${agentId} did not finish its action`);
}

function addAttackRule(engine: WorldEngine) {
  let attack: Rule = {
    id: "attack",
    kind: "action",
    duration: 1,
    params: [
      {
        name: "target",
        type: "entity",
        required: true,
        match: { tag: "predator", range: 1 },
      },
    ],
    do: [{ adjust: { target: "health", of: { arg: "target" }, by: -3 } }],
    emit: { type: "attacked" },
  };
  engine.addRule(attack);
}

function addTrackRule(engine: WorldEngine) {
  let track: Rule = {
    id: "track",
    kind: "action",
    duration: 1,
    params: [
      {
        name: "target",
        type: "entity",
        required: true,
        match: { tag: "predator" },
      },
    ],
    // The body is incidental here - these tests pin param handling, which runs
    // before commit - but an action may not be bodyless, so it marks its quarry.
    do: [{ tag: { add: "tracked", of: { arg: "target" } } }],
  };
  engine.addRule(track);
}

function addLabelRule(engine: WorldEngine) {
  let label: Rule = {
    id: "label",
    kind: "action",
    duration: 1,
    params: [{ name: "text", type: "string", required: true }],
    do: [{ tag: { add: "labelled" } }],
  };
  engine.addRule(label);
}

function addTacticalAttackRule(engine: WorldEngine) {
  let tacticalAttack: Rule = {
    id: "tactical_attack",
    kind: "action",
    duration: 1,
    params: [
      {
        name: "target",
        type: "entity",
        required: true,
        match: { tag: "predator", range: 2 },
      },
      {
        name: "style",
        type: "enum",
        required: true,
        values: ["quick", "heavy"],
      },
    ],
    requires: {
      cmp: "gte",
      left: { stock: "health", of: { arg: "target" } },
      right: { lookup: { on: "style", table: { quick: 1, heavy: 15 } } },
    },
    do: [
      {
        adjust: {
          target: "health",
          of: { arg: "target" },
          by: { lookup: { on: "style", table: { quick: -1, heavy: -5 } } },
        },
      },
    ],
  };
  engine.addRule(tacticalAttack);
}

function spawnTargets(engine: WorldEngine) {
  let spawnPos = survivalScenario.spawn;
  // Fixture predators use a "foe-" prefix so they never collide with the
  // scenario's own scattered "wolf-N" entities, which spawn far from the agent.
  engine.spawnEntity({
    id: "foe-1",
    tags: ["predator"],
    stocks: { health: { value: 10, max: 20 } },
    pos: { x: spawnPos.x + 1, y: spawnPos.y },
  });
  engine.spawnEntity({
    id: "foe-2",
    tags: ["predator"],
    stocks: { health: { value: 10, max: 20 } },
    pos: { x: spawnPos.x + 2, y: spawnPos.y },
  });
  engine.spawnEntity({
    id: "foe-3",
    tags: ["predator"],
    stocks: { health: { value: 10, max: 20 } },
    // Past ordinary sight (12), so it stays off the visible-target default.
    pos: { x: spawnPos.x + 13, y: spawnPos.y },
  });
  engine.spawnEntity({
    id: "crate-1",
    tags: ["container"],
    stocks: {},
    pos: { x: spawnPos.x + 1, y: spawnPos.y },
  });
}

test("entity target params expose valid target id options", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  spawnTargets(engine);
  addAttackRule(engine);

  let attack = engine
    .getObservation("ara")
    .availableActions.find((action) => action.name === "attack");

  assert.ok(attack);
  assert.equal(attack.applicable, true);
  assert.deepEqual(attack.options, [
    {
      id: "foe-1",
      label: "foe-1",
      tags: ["predator"],
      distance: 1,
      direction: "east",
    },
  ]);
});

test("entity target params default to visible targets", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  spawnTargets(engine);
  addTrackRule(engine);

  let track = engine
    .getObservation("ara")
    .availableActions.find((action) => action.name === "track");

  assert.ok(track);
  assert.deepEqual(
    track.options?.map((option) =>
      typeof option === "string" ? option : option.id,
    ),
    ["foe-1", "foe-2"],
  );
});

test("multi-param actions expose options from valid full args", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  spawnTargets(engine);
  addTacticalAttackRule(engine);

  let tacticalAttack = engine
    .getObservation("ara")
    .availableActions.find((action) => action.name === "tactical_attack");

  assert.ok(tacticalAttack);
  assert.equal(tacticalAttack.applicable, true);
  assert.equal(tacticalAttack.options, undefined);
  assert.deepEqual(tacticalAttack.argOptions, [
    { target: "foe-1", style: "quick" },
    { target: "foe-2", style: "quick" },
  ]);
  assert.deepEqual(tacticalAttack.paramOptions?.style, ["quick"]);
  assert.deepEqual(tacticalAttack.paramOptions?.target, [
    {
      id: "foe-1",
      label: "foe-1",
      tags: ["predator"],
      distance: 1,
      direction: "east",
    },
    {
      id: "foe-2",
      label: "foe-2",
      tags: ["predator"],
      distance: 2,
      direction: "east",
    },
  ]);
});

test("entity target params are enforced before commit", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  spawnTargets(engine);
  addAttackRule(engine);

  assert.throws(
    () => engine.commitIntent("ara", { type: "attack" }),
    /needs target/,
  );
  assert.throws(
    () => engine.commitIntent("ara", { type: "attack", target: "foe-2" }),
    /not a valid target/,
  );
  assert.throws(
    () => engine.commitIntent("ara", { type: "attack", target: "crate-1" }),
    /not a valid target/,
  );
});

test("declared string and enum params are enforced before commit and can-start checks", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  spawnTargets(engine);
  addLabelRule(engine);
  addTacticalAttackRule(engine);

  assert.throws(
    () => engine.commitIntent("ara", { type: "label" }),
    /label needs text/,
  );
  assert.throws(
    () => engine.commitIntent("ara", { type: "label", text: 42 }),
    /label text must be text/,
  );
  assert.throws(
    () =>
      engine.commitIntent("ara", {
        type: "tactical_attack",
        target: "foe-1",
      }),
    /tactical_attack needs style/,
  );
  assert.throws(
    () =>
      engine.commitIntent("ara", {
        type: "tactical_attack",
        target: "foe-1",
        style: "reckless",
      }),
    /reckless is not a valid style/,
  );

  let unavailable = engine.setOrder("ara", {
    kind: "repeat",
    action: { type: "rest" },
    until: [{ kind: "action_unavailable", action: { type: "label" } }],
  });
  assert.equal(unavailable.order?.status, "completed");
  assert.equal(unavailable.order?.reason, "action unavailable");
});

test("entity target args resolve to entity ids in rule effects", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  spawnTargets(engine);
  addAttackRule(engine);

  engine.commitIntent("ara", { type: "attack", target: "foe-1" });
  runToIdle(engine, "ara");

  assert.equal(engine.getEntities()["foe-1"].stocks.health.value, 7);
});
