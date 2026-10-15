// The quiet-world scenario: a stalker that wakes only to sound. Booted on the
// real world file, these pin its core: speech pulls the stalker toward the
// speaker, whispers and signs do not, standing beside it hurts and interrupts,
// and berries feed.

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
let quiet = createScenarioStore(dir, dir).load("quiet-world");

function boot(names: string[]) {
  let engine = createWorld(scenarioBootScenario(base, quiet));
  engine.applyOverlay(quiet.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

function entities(engine: ReturnType<typeof createWorld>) {
  return engine.getEntities() as Record<string, any>;
}

function stalker(engine: ReturnType<typeof createWorld>) {
  let found = Object.values(entities(engine)).filter(
    (e) => e.kind === "stalker",
  );
  assert.equal(found.length, 1, "exactly one stalker");
  return found[0];
}

function gap(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

test("the stalker starts far from camp, beside a warning", () => {
  let { engine, ids } = boot(["Ara"]);
  let ara = entities(engine)[ids[0]];
  assert.ok(gap(stalker(engine).pos, ara.pos) >= 12, "out of sight at start");
  let situation = JSON.stringify(engine.sense(ids[0], "situation"));
  assert.match(situation, /Do not call out/);
  let bushes = Object.values(entities(engine)).filter((e) => e.kind === "bush");
  assert.ok(bushes.length >= 8, `${bushes.length} bushes`);
});

test("each word spoken pulls it three steps closer; whispers and signs do not", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  let here = () => entities(engine)[ara].pos;
  let start = gap(stalker(engine).pos, here());

  engine.whisper(ara, "Bo", "quiet now");
  engine.tick();
  let afterWhisper = gap(stalker(engine).pos, here());
  assert.ok(afterWhisper >= start - 1, "a whisper makes no sound");

  engine.speak(ara, "hello?");
  engine.tick();
  let afterWord = gap(stalker(engine).pos, here());
  assert.ok(
    afterWord <= afterWhisper - 2,
    `one word pulled it from ${afterWhisper} to ${afterWord}`,
  );
  assert.ok(bo);
});

test("beside the stalker you are hurt and your hands stop", () => {
  let { engine, ids } = boot(["Ara"]);
  let ara = ids[0];
  for (let i = 0; i < 20; i += 1) {
    if (gap(stalker(engine).pos, entities(engine)[ara].pos) <= 1) break;
    engine.speak(ara, "here!");
    engine.tick();
  }
  assert.ok(gap(stalker(engine).pos, entities(engine)[ara].pos) <= 1);
  engine.tick();
  assert.ok(entities(engine)[ara].stocks.health.value < 100);
  assert.ok(
    engine.recentEvents().some((e) => e.type === "mauled"),
    "the alarm fired",
  );
  for (let i = 0; i < 6; i += 1) engine.tick();
  assert.ok(
    !entities(engine)[ara].tags.includes("agent"),
    "standing still beside it is death",
  );
});

test("berries are picked from a bush and eaten", () => {
  let { engine, ids } = boot(["Ara"]);
  let ara = ids[0];
  // The nearest bush lies just past sight of camp: walk toward it until it
  // is discovered, then travel onto it.
  let me = entities(engine)[ara].pos;
  let bush = Object.values(entities(engine))
    .filter((e) => e.kind === "bush")
    .sort((a, b) => gap(a.pos, me) - gap(b.pos, me))[0];
  let ns = bush.pos.y < me.y ? "north" : bush.pos.y > me.y ? "south" : "";
  let ew = bush.pos.x < me.x ? "west" : bush.pos.x > me.x ? "east" : "";
  engine.commitIntent(ara, { type: "explore", direction: ns + ew || "north" });
  for (let i = 0; i < 10; i += 1) engine.tick();
  engine.commitIntent(ara, { type: "travel", location: bush.id });
  for (let i = 0; i < 200 && entities(engine)[ara].action; i += 1)
    engine.tick();
  engine.commitIntent(ara, { type: "forage" });
  for (let i = 0; i < 3; i += 1) engine.tick();
  assert.equal(entities(engine)[ara].stocks.berries.value, 6);
  engine.commitIntent(ara, { type: "eat" });
  engine.tick();
  assert.equal(entities(engine)[ara].stocks.berries.value, 5);
});
