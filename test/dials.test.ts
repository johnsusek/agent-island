// The dials scenarios: a fishing village governed by three world policy dials
// (quota, tax, ration). In `dials` anyone may turn a dial, but only at the
// assembly stone while a majority of the living stand around it; in
// `dials-motions` the same village has no dial verbs at all (the Clerk carries
// out passed motions). Booted on the real world file, these pin the quorum
// gate, the clamped world stocks, the quota-gated catch, the exact tax split,
// and the rations.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWorld } from "@agent-island/engine/engine";
import {
  createScenarioStore,
  scenarioBootScenario,
  scenarioFromWorldFile,
} from "../packages/mcp/src/index.js";
import { placeAt } from "./helpers.js";

let dir = new URL("../config/scenarios", import.meta.url).pathname;
let base = scenarioFromWorldFile(
  JSON.parse(
    readFileSync(new URL("../config/config.json", import.meta.url), "utf8"),
  ),
  "config.json",
);
let store = createScenarioStore(dir, dir);
let dials = store.load("dials");
let motions = store.load("dials-motions");

type Engine = ReturnType<typeof createWorld>;

function boot(names: string[], scenario = dials) {
  let engine = createWorld(scenarioBootScenario(base, scenario));
  engine.applyOverlay(scenario.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

function entities(engine: Engine) {
  return engine.getEntities() as Record<string, any>;
}

function world(engine: Engine, stock: string) {
  return entities(engine).world.stocks[stock].value as number;
}

function mine(engine: Engine, id: string, stock: string) {
  return entities(engine)[id].stocks[stock].value as number;
}

function stone(engine: Engine) {
  return entities(engine)["assembly-stone"].pos as { x: number; y: number };
}

// A shore tile at least `min` steps from the stone, optionally beside water.
function shoreTile(engine: Engine, min: number, besideWater: boolean) {
  let map = engine.getMap();
  let at = new Map(map.tiles.map((t) => [`${t.x},${t.y}`, t.terrain]));
  let s = stone(engine);
  let taken = new Set(
    Object.values(entities(engine))
      .filter((e) => e.pos)
      .map((e) => `${e.pos.x},${e.pos.y}`),
  );
  for (let tile of map.tiles) {
    if (tile.terrain !== "shore" || taken.has(`${tile.x},${tile.y}`)) continue;
    if (Math.max(Math.abs(tile.x - s.x), Math.abs(tile.y - s.y)) < min)
      continue;
    let wet = false;
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1)
        if (at.get(`${tile.x + dx},${tile.y + dy}`) === "water") wet = true;
    if (wet === besideWater) return tile;
  }
  throw new Error("no such shore tile");
}

function sendAway(engine: Engine, id: string) {
  let tile = shoreTile(engine, 3, false);
  placeAt(engine, id, tile.x, tile.y);
}

function action(engine: Engine, id: string, name: string) {
  let obs = engine.getObservation(id) as any;
  return obs.availableActions.find((a: any) => a.name === name);
}

test("the village boots on an island around the assembly stone", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy"]);
  let terrains = new Set(engine.getMap().tiles.map((t) => t.terrain));
  assert.deepEqual([...terrains].sort(), ["shore", "water"]);
  assert.equal(engine.getMap().width, 20);
  let obs = engine.getObservation(ids[0]) as any;
  for (let dial of ["quota", "tax", "ration", "granary", "bay"])
    assert.equal(obs.display[dial].scope, "world");
  assert.equal(obs.world.stocks.quota.value, 30);
});

test("a dial turns only at the stone with a majority of the living there", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy"]);
  let [ara, bo, cy] = ids;

  // Ara alone at the stone: one of three is no majority.
  sendAway(engine, bo);
  sendAway(engine, cy);
  assert.throws(
    () => engine.commitIntent(ara, { type: "raise_tax" }),
    /more than half of the living/,
  );
  assert.equal(world(engine, "tax"), 10);

  // Bo comes back: two of three is a majority, and the dial moves by 10.
  let s = stone(engine);
  placeAt(engine, bo, s.x - 1, s.y);
  engine.commitIntent(ara, { type: "raise_tax" });
  engine.tick();
  assert.equal(world(engine, "tax"), 20);
  let turned = engine.recentEvents().find((e) => e.type === "tax_raised");
  assert.ok(turned, "the turn is announced");
  assert.equal((turned as any).global, true);
  assert.ok(
    engine
      .visibleEventsSince(cy, 0)
      .some((e: any) => e.type === "tax_raised" && /Ara/.test(e.text ?? "")),
    "even a villager away from the stone hears who turned it",
  );

  // Cy, away from the stone, cannot turn it even though a majority stands there.
  let cyRaise = action(engine, cy, "raise_quota");
  assert.equal(cyRaise.applicable, false);
});

test("dials clamp at their ends", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy"]);
  let [ara] = ids;
  for (let i = 0; i < 6; i += 1) {
    engine.commitIntent(ara, { type: "raise_tax" });
    engine.tick();
  }
  assert.equal(world(engine, "tax"), 50, "tax tops out at 50");
  for (let i = 0; i < 3; i += 1) {
    engine.commitIntent(ara, { type: "lower_ration" });
    engine.tick();
  }
  assert.equal(world(engine, "ration"), 0, "ration bottoms out at 0");
  for (let i = 0; i < 4; i += 1) {
    engine.commitIntent(ara, { type: "lower_quota" });
    engine.tick();
  }
  assert.equal(world(engine, "quota"), 0, "quota bottoms out at 0");
});

test("fishing lands 10 and the tax splits it exactly into the granary", () => {
  let { engine, ids } = boot(["Ara"]);
  let [ara] = ids;
  let edge = shoreTile(engine, 0, true);
  placeAt(engine, ara, edge.x, edge.y);
  engine.setStock("world", "ration", 0);
  engine.setStock("world", "tax", 30);
  let bay = world(engine, "bay");
  let granary = world(engine, "granary");

  engine.commitIntent(ara, { type: "fish" });
  engine.tick();
  engine.tick();
  assert.equal(mine(engine, ara, "fish"), 4 + 7, "the fisher keeps 7 of 10");
  assert.equal(world(engine, "granary"), granary + 3, "the granary gets 3");
  assert.equal(mine(engine, ara, "landed"), 0, "the tally is cleared");
  assert.ok(
    world(engine, "bay") < bay - 8,
    "ten fish left the bay (less two ticks of regrowth)",
  );

  // At 0 tax the whole catch is the fisher's.
  engine.setStock("world", "tax", 0);
  let before = world(engine, "granary");
  engine.commitIntent(ara, { type: "fish" });
  engine.tick();
  engine.tick();
  assert.equal(mine(engine, ara, "fish"), 21);
  assert.equal(world(engine, "granary"), before);
});

test("the catch never takes the bay below the quota, and at the quota fishing is refused", () => {
  let { engine, ids } = boot(["Ara"]);
  let [ara] = ids;
  let edge = shoreTile(engine, 0, true);
  placeAt(engine, ara, edge.x, edge.y);
  engine.setStock("world", "ration", 0);
  engine.setStock("world", "tax", 0);
  engine.setStock("world", "quota", 30);
  engine.setStock("world", "bay", 34);
  engine.commitIntent(ara, { type: "fish" });
  engine.tick();
  engine.tick();
  assert.equal(mine(engine, ara, "fish"), 8, "only the 4 above the quota");

  engine.setStock("world", "bay", 30);
  assert.throws(
    () => engine.commitIntent(ara, { type: "fish" }),
    /at or below the quota/,
  );
  engine.setStock("world", "bay", 30.5);
  assert.throws(() => engine.commitIntent(ara, { type: "fish" }));
});

test("rations pay once per 50 ticks and stop when the granary runs dry", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy"]);
  let [ara, bo, cy] = ids;
  engine.setStock("world", "ration", 2);
  engine.setStock("world", "granary", 10);

  engine.tick();
  for (let id of ids) assert.equal(mine(engine, id, "fish"), 6);
  assert.equal(world(engine, "granary"), 4);

  for (let i = 0; i < 48; i += 1) engine.tick();
  for (let id of ids) assert.equal(mine(engine, id, "fish"), 6, "not yet");

  engine.tick();
  engine.tick();
  // The granary held 4: two villagers drew a ration, the third went without.
  let paid = [ara, bo, cy].map((id) => mine(engine, id, "fish"));
  assert.deepEqual(
    paid.sort(),
    [6, 8, 8],
    `second ration day paid ${paid.join(",")}`,
  );
  assert.equal(world(engine, "granary"), 0);
  assert.ok(
    engine.recentEvents().some((e) => e.type === "granary_short"),
    "the shortfall is announced",
  );
  for (let i = 0; i < 60; i += 1) engine.tick();
  assert.equal(world(engine, "granary"), 0);
});

test("dials-motions is the same village with no dial verbs", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy"], motions);
  let names = (engine.getObservation(ids[0]) as any).availableActions.map(
    (a: any) => a.name,
  );
  for (let verb of [
    "raise_quota",
    "lower_quota",
    "raise_tax",
    "lower_tax",
    "raise_ration",
    "lower_ration",
  ])
    assert.ok(!names.includes(verb), `${verb} should not exist`);
  assert.ok(names.includes("fish") && names.includes("eat"));
  assert.throws(() => engine.commitIntent(ids[0], { type: "raise_tax" }));

  // Same economy: identical rules apart from the dial verbs.
  let economy = (s: typeof dials) =>
    s.overlay.dynamicRules
      .filter((r) => !/^(raise|lower)_/.test(r.id))
      .map((r) => JSON.stringify(r));
  assert.deepEqual(economy(motions), economy(dials));
  assert.deepEqual(motions.overlay.worldStocks, dials.overlay.worldStocks);
  assert.match(motions.description ?? "", /formal motion/);

  // A motion is how the village decides; the GM-side change is a set_stock.
  engine.propose(ids[0], "Set the tax to 30.");
  engine.vote(ids[1], 1, "yes");
  assert.ok(engine.recentEvents().some((e) => e.type === "motion_passed"));
});
