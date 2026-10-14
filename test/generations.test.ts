// The generations scenario: lifespans and oral tradition. Booted on the real
// world file, these pin its core: each newcomer draws a different lifespan in
// range, age counts up and kills at the lifespan, the old feel their years,
// and a monument with founding words stands at spawn.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWorld } from "@agent-island/engine/engine";
import {
  createScenarioStore,
  scenarioBootScenario,
  scenarioFromWorldFile,
} from "../packages/mcp/src/index.js";

let dir = new URL("../config/scenarios", import.meta.url).pathname;
let base = scenarioFromWorldFile(
  JSON.parse(
    readFileSync(new URL("../config/config.json", import.meta.url), "utf8"),
  ),
  "config.json",
);
let generations = createScenarioStore(dir, dir).load("generations");

function boot(names: string[]) {
  let engine = createWorld(scenarioBootScenario(base, generations));
  engine.applyOverlay(generations.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

type Engine = ReturnType<typeof createWorld>;

function entities(engine: Engine) {
  return engine.getEntities() as Record<string, any>;
}

test("each newcomer draws their own lifespan between 250 and 450", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy", "Dee", "Eli", "Fen"]);
  engine.tick();
  let spans = ids.map((id) => entities(engine)[id].stocks.lifespan.value);
  for (let span of spans)
    assert.ok(span >= 250 && span <= 450, `lifespan ${span} in range`);
  assert.ok(new Set(spans).size >= 4, `spread: ${spans.join(", ")}`);
  for (let id of ids) assert.equal(entities(engine)[id].stocks.age.value, 1);

  // A later arrival draws on its own tick.
  let gil = engine.addAgent("Gil").id;
  engine.tick();
  let span = entities(engine)[gil].stocks.lifespan.value;
  assert.ok(span >= 250 && span <= 450);
  assert.equal(entities(engine)[gil].stocks.age.value, 1);
});

test("the old feel their years, then die of old age when age reaches lifespan", () => {
  let { engine, ids } = boot(["Ara"]);
  let ara = ids[0];
  engine.tick();
  engine.setStock(ara, "lifespan", 300);
  engine.setStock(ara, "age", 250);
  engine.tick();
  // 49 of 300 years left is ~16%: serious, not yet critical.
  let situation = JSON.stringify(engine.sense(ara, "situation"));
  assert.match(situation, /You are old now/);

  engine.setStock(ara, "age", 297);
  engine.tick();
  assert.ok(entities(engine)[ara].tags.includes("agent"), "298 < 300");
  engine.tick();
  engine.tick();
  let now = entities(engine)[ara];
  assert.ok(!now.tags.includes("agent"), "dead at 300");
  assert.ok(now.tags.includes("dead"));
  let died = engine.recentEvents().filter((e) => e.type === "old-age");
  assert.equal(died.length, 1);
  assert.equal(died[0].global, true);
});

test("a monument with the founding words stands at spawn", () => {
  let { engine, ids } = boot(["Ara"]);
  let monument = entities(engine).monument;
  assert.ok(monument, "monument exists");
  assert.equal(monument.kind, "monument");
  assert.match(monument.text, /Here the first of us settled/);
  let ara = entities(engine)[ids[0]];
  assert.ok(
    Math.max(
      Math.abs(monument.pos.x - ara.pos.x),
      Math.abs(monument.pos.y - ara.pos.y),
    ) <= 1,
    "beside the newcomer",
  );
  let situation = JSON.stringify(engine.sense(ids[0], "situation"));
  assert.match(situation, /Here the first of us settled/);
  // Players cannot write over it; only a director's edit_entity can.
  assert.ok(!monument.tags.includes("sign"));
});
