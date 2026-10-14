// The fever scenario: an infection you can hide. Booted on the real world
// file, these pin its core: one or two patients zero are chosen quietly; the
// fever spreads only between people standing within a tile, and only by
// chance; a carrier feels nothing until vigor is half gone; bitterleaf grows
// only on highland far from camp, cures the fever, and can be handed over.

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
let fever = createScenarioStore(dir, dir).load("fever");

type Engine = ReturnType<typeof createWorld>;

function boot(names: string[]) {
  let engine = createWorld(scenarioBootScenario(base, fever));
  engine.applyOverlay(fever.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

function entities(engine: Engine) {
  return engine.getEntities() as Record<string, any>;
}

function stock(engine: Engine, id: string, name: string): number {
  return entities(engine)[id].stocks[name].value;
}

// Move an entity through a snapshot (as test/helpers placeAt does). The
// snapshot's overlay drops the scenario's describeEvent prose, so the scenario
// overlay is re-applied after the restore.
function place(engine: Engine, id: string, x: number, y: number) {
  let snap = engine.snapshot();
  snap.world.entities[id].pos = { x, y };
  engine.restore(snap);
  engine.applyOverlay(fever.overlay);
}

// Mark someone a patient zero so the scenario's own seeding stays out of a
// test that infects people by hand.
function seedPatient(engine: Engine, id: string) {
  engine.editEntity(id, { addTags: ["patient"] });
  engine.setStock(id, "infected", 1);
}

function prose(engine: Engine, id: string) {
  return renderCharacterResult(engine.sense(id, "situation"));
}

function gap(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

test("one patient zero in a small camp, two once eight are here, and nobody is told", () => {
  let small = boot(["Ara", "Bo", "Cy", "Di", "Ed", "Fen"]);
  for (let i = 0; i < 80; i += 1) small.engine.tick();
  let patients = small.ids.filter((id) =>
    entities(small.engine)[id].tags.includes("patient"),
  );
  assert.equal(patients.length, 1);
  assert.equal(stock(small.engine, patients[0], "infected"), 1);
  assert.doesNotMatch(prose(small.engine, patients[0]), /feverish/);

  let big = boot(["Ara", "Bo", "Cy", "Di", "Ed", "Fen", "Gil", "Hal"]);
  for (let i = 0; i < 80; i += 1) big.engine.tick();
  assert.equal(
    big.ids.filter((id) => entities(big.engine)[id].tags.includes("patient"))
      .length,
    2,
  );
});

test("the fever spreads only within a tile, and only by chance", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  seedPatient(engine, ara);
  let s = entities(engine)[ara].pos;
  place(engine, ara, s.x, s.y);
  place(engine, bo, s.x + 2, s.y);
  for (let i = 0; i < 150; i += 1) engine.tick();
  assert.equal(stock(engine, bo, "infected"), 0, "two tiles apart is safe");

  place(engine, bo, s.x + 1, s.y);
  engine.tick();
  assert.equal(stock(engine, bo, "infected"), 0, "not caught at once");
  let caughtAt = -1;
  for (let i = 0; i < 300; i += 1) {
    engine.tick();
    if (stock(engine, bo, "infected") >= 1) {
      caughtAt = i;
      break;
    }
  }
  assert.ok(caughtAt > 0, `caught after ${caughtAt} more ticks beside Ara`);
});

test("a carrier feels nothing until half their vigor is gone", () => {
  let { engine, ids } = boot(["Ara"]);
  let ara = ids[0];
  seedPatient(engine, ara);
  engine.setStock(ara, "vigor", 60);
  engine.tick();
  assert.ok(stock(engine, ara, "vigor") < 60, "the fever is draining");
  assert.doesNotMatch(prose(engine, ara), /feverish|burning/);
  assert.ok(
    !engine.recentEvents().some((e: any) => e.type === "vitals_alarm"),
    "no alarm while above half",
  );

  for (let i = 0; i < 40 && stock(engine, ara, "vigor") > 50; i += 1)
    engine.tick();
  engine.tick();
  assert.match(prose(engine, ara), /You feel feverish/);
  let alarm = engine
    .recentEvents()
    .find((e: any) => e.type === "vitals_alarm" && e.agentId === ara);
  assert.match(alarm?.text ?? "", /You feel feverish/);
});

test("bitterleaf grows only on highland, far from camp, and only highland pickers get it", () => {
  let { engine, ids } = boot(["Ara"]);
  let ara = ids[0];
  let map = engine.getMap() as any;
  let terrainAt = (x: number, y: number) =>
    map.tiles.find((t: any) => t.x === x && t.y === y)?.terrain;
  let plants = Object.values(entities(engine)).filter(
    (e) => e.kind === "herbplant",
  );
  assert.ok(plants.length >= 4, `${plants.length} plants`);
  for (let plant of plants) {
    assert.equal(terrainAt(plant.pos.x, plant.pos.y), "highland");
    assert.ok(gap(plant.pos, map.spawn) > 16, "far from camp");
  }

  assert.throws(
    () => engine.commitIntent(ara, { type: "gather_herb" }),
    /up on the highland beside a bitterleaf plant/,
  );
  let plant = plants[0];
  place(engine, ara, plant.pos.x, plant.pos.y + (plant.pos.y > 0 ? -1 : 1));
  engine.commitIntent(ara, { type: "gather_herb" });
  for (let i = 0; i < 4; i += 1) engine.tick();
  assert.equal(stock(engine, ara, "herb"), 1);
});

test("bitterleaf cures, and can be handed to someone else", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  seedPatient(engine, bo);
  engine.setStock(bo, "vigor", 30);
  engine.setStock(ara, "herb", 2);

  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "give", target: bo, item: "herb" }],
  });
  for (let i = 0; i < 20 && stock(engine, bo, "herb") < 1; i += 1)
    engine.tick();
  assert.ok(stock(engine, bo, "herb") >= 1, "the herb changed hands");
  assert.ok(stock(engine, ara, "herb") < 2);

  engine.commitIntent(bo, { type: "take_herb" });
  engine.tick();
  engine.tick();
  assert.equal(stock(engine, bo, "infected"), 0, "cured");
  let low = stock(engine, bo, "vigor");
  for (let i = 0; i < 20; i += 1) engine.tick();
  assert.ok(stock(engine, bo, "vigor") > low, "vigor comes back once cured");
});

test("anyone alive at tick 500 has outlasted the fever", () => {
  let { engine, ids } = boot(["Ara"]);
  for (let i = 0; i < 500; i += 1) {
    if (i % 100 === 0) engine.setStock(ids[0], "satiation", 100);
    engine.tick();
  }
  let win = engine.recentEvents(2000).filter((e: any) => e.type === "victory");
  assert.equal(win.length, 1);
});
