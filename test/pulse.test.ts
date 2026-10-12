// The GM's tension digest (read by a resident director): getPulse() derives deaths, stock trends, chat
// volume, and the flatline detector from state the engine already keeps. These
// tests drive a tiny world tick by tick at the engine level, plus one
// coordinator-level check that inspect_world exposes the section.

import assert from "node:assert/strict";
import test from "node:test";

import { createColony } from "./helpers.js";
import { createWorld } from "@agent-island/engine/engine";
import type { Scenario } from "@agent-island/engine/scenario";
import { declareProgress } from "./helpers.js";

// Progress ticks up each turn; at `killAt` a transition rule removes every
// agent (destroying an agent's entity is how death happens mechanically).
function pulseScenario(killAt: number): Scenario {
  return {
    name: "pulse-demo",
    spawn: { x: 1, y: 1 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    rules: [
      { id: "progress", phase: "flow", target: "progress", rate: 1 },
      {
        id: "cull",
        phase: "transition",
        each: { tag: "agent" },
        when: {
          cmp: "gte",
          left: { stock: "progress", of: "world" },
          right: killAt,
        },
        do: [{ destroy: { of: "self" } }],
      },
    ],
  };
}

test("pulse counts deaths, stock trends, chat, and GM actions", () => {
  let engine = declareProgress(createWorld(pulseScenario(4)));
  engine.addAgent("Ara");
  engine.addAgent("Bel");

  engine.tick();
  engine.speak("ara", "hello out there");
  engine.tick();

  let early = engine.getPulse();
  assert.equal(early.population, 2);
  assert.equal(early.deathsInWindow, 0);
  assert.equal(early.ticksSinceLastDeath, null);
  assert.equal(early.chatInWindow, 1);
  assert.equal(early.ticksSinceLastGmAction, null);
  assert.equal(early.stockTrends.progress.now, 2);
  assert.ok(early.stockTrends.progress.delta >= 1, "progress trended up");

  // gm_joined is bookkeeping, not an action - the pulse must ignore it.
  engine.recordGm("gm_joined", "a director took the GM seat");
  assert.equal(engine.getPulse().ticksSinceLastGmAction, null);
  engine.recordGm("entity_spawned", "spawned an obelisk");
  assert.equal(engine.getPulse().ticksSinceLastGmAction, 0);

  // Tick past the cull: both agents die on the same tick.
  engine.tick();
  engine.tick();
  let after = engine.getPulse();
  assert.equal(after.population, 0);
  assert.equal(after.deathsInWindow, 2);
  assert.equal(after.ticksSinceLastDeath, 0);

  // A window that excludes the deaths stops counting them, while
  // ticksSinceLastDeath still reports the absolute distance.
  engine.tick();
  engine.tick();
  let narrow = engine.getPulse(1);
  assert.equal(narrow.deathsInWindow, 0);
  assert.equal(narrow.ticksSinceLastDeath, 2);
});

test("ticksSinceLastDecisionEvent tracks the flatline", () => {
  let engine = declareProgress(createWorld(pulseScenario(1000)));
  engine.addAgent("Ara");
  engine.speak("ara", "a decision-worthy word");
  engine.tick();
  engine.tick();
  engine.tick();
  // The speak (and the join before it) were the last decision-wake events.
  let pulse = engine.getPulse();
  assert.equal(typeof pulse.ticksSinceLastDecisionEvent, "number");
  assert.ok(
    pulse.ticksSinceLastDecisionEvent! >= 2,
    "quiet ticks accumulate on the flatline detector",
  );
});

test("inspect_world exposes the pulse as an include section", () => {
  let colony = createColony({
    engine: declareProgress(createWorld(pulseScenario(1000))),
  });
  colony.start();
  colony.connect("gm");
  try {
    colony.joinAsGm("gm");
    let inspection = colony.gmInspect("gm", { include: ["pulse"] }) as any;
    assert.equal(typeof inspection.pulse.population, "number");
    assert.equal(typeof inspection.pulse.window, "number");
    assert.ok("stockTrends" in inspection.pulse);
  } finally {
    colony.stop();
  }
});
