// The unseen scenario: spatial social deduction. Booted on the real world
// file, these pin its core: exactly one hollow one is chosen and only their own
// prose says so; devouring works only when alone with the victim; bodies are
// found later by the living; accusations are rate-limited and a majority of
// accusers drives someone out; and driving out the hollow one ends the game.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWorld } from "@agent-island/engine/engine";
import { renderCharacterResult } from "@agent-island/mcp/sense-prose";
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
let unseen = createScenarioStore(dir, dir).load("unseen");

type Engine = ReturnType<typeof createWorld>;

function boot(names: string[]) {
  let engine = createWorld(scenarioBootScenario(base, unseen));
  engine.applyOverlay(unseen.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

function entities(engine: Engine) {
  return engine.getEntities() as Record<string, any>;
}

// Rewrite raw entity state through a snapshot, the way test/helpers placeAt
// does. The snapshot's overlay does not carry the scenario's describeEvent
// prose, so the scenario overlay is re-applied after the restore.
function edit(engine: Engine, fn: (ents: Record<string, any>) => void) {
  let snap = engine.snapshot();
  fn(snap.world.entities);
  engine.restore(snap);
  engine.applyOverlay(unseen.overlay);
}

function place(engine: Engine, id: string, x: number, y: number) {
  edit(engine, (ents) => {
    ents[id].pos = { x, y };
  });
}

function makeHollow(engine: Engine, id: string) {
  edit(engine, (ents) => {
    ents[id].tags.push("hollow");
    ents[id].stocks.humanity.value = 0;
  });
}

function hollowOnes(engine: Engine) {
  return Object.values(entities(engine)).filter((e) =>
    e.tags.includes("hollow"),
  );
}

function prose(engine: Engine, id: string) {
  return renderCharacterResult(engine.sense(id, "situation"));
}

// A spot 20 tiles from spawn on both axes, well past sight (12) and on the map.
function farFrom(p: { x: number; y: number }) {
  return {
    x: p.x < 24 ? p.x + 20 : p.x - 20,
    y: p.y < 24 ? p.y + 20 : p.y - 20,
  };
}

test("exactly one hollow one is chosen once the group has gathered, and only they are told", () => {
  let names = ["Ara", "Bo", "Cy", "Di", "Ed", "Fen", "Gil", "Hal"];
  let { engine, ids } = boot(names);
  for (let i = 0; i < 19; i += 1) engine.tick();
  assert.equal(hollowOnes(engine).length, 0, "nobody before tick 20");
  for (let i = 0; i < 120 && hollowOnes(engine).length === 0; i += 1)
    engine.tick();
  assert.equal(hollowOnes(engine).length, 1);
  for (let i = 0; i < 30; i += 1) engine.tick();
  let chosen = hollowOnes(engine);
  assert.equal(chosen.length, 1, "never a second one");

  let hollow = chosen[0].id;
  assert.match(prose(engine, hollow), /You are hollow/);
  for (let id of ids.filter((i) => i !== hollow))
    assert.doesNotMatch(prose(engine, id), /hollow/);
  assert.ok(
    !engine
      .recentEvents()
      .some((e: any) => /hollow/.test(e.text ?? "") && e.type !== "said"),
    "no event announces the choice",
  );
});

test("devouring is refused with a witness in sight and works when alone", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy"]);
  let [ara, bo, cy] = ids;
  makeHollow(engine, ara);
  let s = entities(engine)[ara].pos;
  place(engine, ara, s.x, s.y);
  place(engine, bo, s.x + 1, s.y);
  place(engine, cy, s.x + 6, s.y);

  assert.throws(
    () => engine.commitIntent(ara, { type: "devour", target: bo }),
    /only the hollow can devour/,
    "Cy can see",
  );
  assert.throws(
    () => engine.commitIntent(bo, { type: "devour", target: ara }),
    /only the hollow can devour/,
    "an innocent cannot",
  );

  let far = farFrom(s);
  place(engine, cy, far.x, far.y);
  edit(engine, (ents) => {
    ents[ara].stocks.satiation.value = 30;
  });
  engine.commitIntent(ara, { type: "devour", target: bo });
  for (let i = 0; i < 3; i += 1) engine.tick();

  let victim = entities(engine)[bo];
  assert.ok(!victim.tags.includes("agent"), "Bo is out of play");
  assert.ok(victim.tags.includes("dead"));
  assert.deepEqual(victim.pos, { x: s.x + 1, y: s.y }, "the body stays put");
  assert.ok(entities(engine)[ara].stocks.satiation.value > 95, "it fed");
  let devoured = engine.recentEvents().find((e: any) => e.type === "devoured");
  assert.match(devoured?.text ?? "", /Ara devours Bo/);
  assert.ok(
    !engine.recentEvents().some((e: any) => e.type === "body_found"),
    "the hollow one standing over it does not count as finding it",
  );

  // The body is found the first time a living innocent comes within 2 tiles.
  place(engine, cy, s.x + 3, s.y);
  engine.tick();
  let found = engine.recentEvents().filter((e: any) => e.type === "body_found");
  assert.equal(found.length, 1);
  assert.match(found[0].text ?? "", /The body of Bo has been found/);
  engine.tick();
  engine.tick();
  assert.equal(
    engine.recentEvents().filter((e: any) => e.type === "body_found").length,
    1,
    "only announced once",
  );
});

test("berries do not feed the hollow one", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  makeHollow(engine, ara);
  edit(engine, (ents) => {
    ents[ara].stocks.satiation.value = 40;
    ents[bo].stocks.satiation.value = 40;
  });
  engine.commitIntent(ara, { type: "eat" });
  engine.commitIntent(bo, { type: "eat" });
  engine.tick();
  engine.tick();
  assert.ok(entities(engine)[ara].stocks.satiation.value < 40);
  assert.ok(entities(engine)[bo].stocks.satiation.value > 55);
});

test("one accusation per 40 ticks, and a majority of accusers drives someone out", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy", "Di", "Eve"]);
  let [ara, bo, cy, , eve] = ids;
  makeHollow(engine, eve);

  engine.commitIntent(ara, { type: "accuse", target: eve });
  engine.commitIntent(bo, { type: "accuse", target: eve });
  engine.tick();
  engine.tick();
  let accused = engine.recentEvents().filter((e: any) => e.type === "accused");
  assert.equal(accused.length, 2);
  assert.match(accused[0].text ?? "", /accuses Eve of being hollow/);
  assert.ok(
    entities(engine)[eve].tags.includes("agent"),
    "two of five is not enough",
  );

  assert.throws(
    () => engine.commitIntent(ara, { type: "accuse", target: eve }),
    /accused someone too recently/,
  );

  engine.commitIntent(cy, { type: "accuse", target: eve });
  engine.tick();
  engine.tick();
  let gone = entities(engine)[eve];
  assert.ok(!gone.tags.includes("agent"), "three of five drive her out");
  assert.ok(gone.tags.includes("exiled"));
  let events = engine.recentEvents();
  assert.ok(events.some((e: any) => e.type === "exiled" && /Eve/.test(e.text)));
  assert.ok(
    events.some(
      (e: any) =>
        e.type === "unmasked" && /Eve was the hollow one/.test(e.text),
    ),
  );
  let wins = events.filter((e: any) => e.type === "victory");
  assert.equal(wins.length, 1);
  assert.match(wins[0].text ?? "", /hollow one is gone/);

  // Ara's word carries again after 40 ticks.
  for (let i = 0; i < 40; i += 1) engine.tick();
  engine.commitIntent(ara, { type: "accuse", target: bo });
});

test("accusations fade, so scattered suspicion never drives anyone out", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy", "Di", "Eve"]);
  let [ara, bo, cy, , eve] = ids;
  for (let accuser of [ara, bo, cy]) {
    engine.commitIntent(accuser, { type: "accuse", target: eve });
    for (let i = 0; i < 30; i += 1) engine.tick();
  }
  assert.ok(entities(engine)[eve].tags.includes("agent"));
});

test("the hollow one wins when only one other person is left", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy"]);
  let [ara, bo, cy] = ids;
  makeHollow(engine, ara);
  let s = entities(engine)[ara].pos;
  place(engine, bo, s.x + 1, s.y);
  let far = farFrom(s);
  place(engine, cy, far.x, far.y);
  engine.commitIntent(ara, { type: "devour", target: bo });
  for (let i = 0; i < 3; i += 1) engine.tick();
  let wins = engine.recentEvents().filter((e: any) => e.type === "victory");
  assert.equal(wins.length, 1);
  assert.match(wins[0].text ?? "", /hollow one has won/);
  assert.ok(cy);
});
