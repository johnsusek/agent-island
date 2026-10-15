// The three-tools scenarios: a one-room camp where fish, firewood and water
// are plentiful but each can only be produced with its tool in hand, and there
// are fewer tools than people. Booted on the real world file, these pin the
// core: no rod, no fishing; a rod lent hand to hand lets the borrower fish;
// tools fall to the floor when their holder dies; the vitals drain and kill.
// The market variant adds a constant-product trading post.

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
let store = createScenarioStore(dir, dir);

const PLAYERS = ["Ara", "Bo", "Cy", "Di", "Ed", "Fen", "Gil"];

function boot(name: "three-tools" | "three-tools-market", names = PLAYERS) {
  let scenario = store.load(name);
  let engine = createWorld(scenarioBootScenario(base, scenario));
  engine.applyOverlay(scenario.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

type Engine = ReturnType<typeof createWorld>;

function entities(engine: Engine) {
  return engine.getEntities() as Record<string, any>;
}

function held(engine: Engine, id: string): string[] {
  return engine.getObservation(id).you.held.map((h: any) => h.id);
}

function stockOf(engine: Engine, id: string, name: string): number {
  return entities(engine)[id].stocks[name].value;
}

function pickUp(engine: Engine, id: string, item: string) {
  engine.commitIntent(id, { type: "pick_up", item });
}

test("a room with more people than tools", () => {
  let { engine, ids } = boot("three-tools");
  let tools = Object.values(entities(engine)).filter((e) =>
    e.tags.includes("portable"),
  );
  assert.deepEqual(tools.map((t) => t.kind).sort(), [
    "axe",
    "axe",
    "bucket",
    "bucket",
    "rod",
    "rod",
  ]);
  assert.ok(tools.length < ids.length, "fewer tools than players");
  let names = engine
    .getObservation(ids[0])
    .availableActions.map((a: any) => a.name);
  assert.ok(!names.includes("explore"), "a room has nowhere to go");
});

test("fishing without a rod is refused; with a rod it lands fish", () => {
  let { engine, ids } = boot("three-tools");
  let [ara] = ids;
  assert.throws(
    () => engine.commitIntent(ara, { type: "fish" }),
    /fishing rod in your hand/,
  );

  pickUp(engine, ara, "rod-1");
  assert.deepEqual(held(engine, ara), ["rod-1"]);
  engine.commitIntent(ara, { type: "fish" });
  for (let i = 0; i < 5; i += 1) engine.tick();
  assert.equal(stockOf(engine, ara, "fish"), 2, "slow work: nothing yet");
  engine.tick();
  assert.equal(stockOf(engine, ara, "fish"), 3, "2 at start + 1 landed");

  // The rod does not chop wood.
  assert.throws(
    () => engine.commitIntent(ara, { type: "chop" }),
    /axe in your hand/,
  );
});

test("a lent rod goes into the borrower's hand, everyone sees, and they can fish", () => {
  let { engine, ids } = boot("three-tools");
  let [ara, bo] = ids;
  pickUp(engine, ara, "rod-1");
  engine.commitIntent(ara, { type: "lend", item: "rod-1", to: "Bo" });
  engine.tick();
  assert.deepEqual(held(engine, ara), []);
  assert.deepEqual(held(engine, bo), ["rod-1"]);
  let lent = engine.recentEvents().find((e: any) => e.type === "lent");
  assert.ok(lent, "the hand-off is an event");
  assert.match(lent!.text ?? "", /rod-1/);

  assert.throws(() => engine.commitIntent(ara, { type: "fish" }));
  engine.commitIntent(bo, { type: "fish" });
  for (let i = 0; i < 6; i += 1) engine.tick();
  assert.equal(stockOf(engine, bo, "fish"), 3);
});

test("vitals drain, eating restores, and running dry kills", () => {
  let { engine, ids } = boot("three-tools");
  let [ara] = ids;
  for (let i = 0; i < 10; i += 1) engine.tick();
  for (let v of ["satiation", "warmth", "hydration"])
    assert.equal(stockOf(engine, ara, v), 95, `${v} drained 0.5/tick`);

  engine.commitIntent(ara, { type: "burn" });
  engine.tick();
  assert.equal(stockOf(engine, ara, "firewood"), 1);
  assert.equal(
    stockOf(engine, ara, "warmth"),
    99.5,
    "burning warms (+20, capped at 100), then this tick's chill",
  );

  engine.setStock(ara, "hydration", 0.5); // crosses to 0 this tick
  engine.setStock(ara, "health", 4);
  engine.tick();
  assert.ok(
    engine.recentEvents().some((e: any) => e.type === "parched"),
    "the thirst alarm fired",
  );
  for (let i = 0; i < 3; i += 1) engine.tick();
  assert.equal(engine.isAlive(ara), false, "thirst killed");
});

test("a dead holder's tool drops to the floor for anyone to take", () => {
  let { engine, ids } = boot("three-tools");
  let [ara, bo] = ids;
  pickUp(engine, ara, "axe-1");
  assert.deepEqual(held(engine, ara), ["axe-1"]);
  engine.setStock(ara, "health", 0);
  engine.tick();
  assert.equal(engine.isAlive(ara), false);
  let axe = entities(engine)["axe-1"];
  assert.equal(axe.heldBy, undefined, "no longer held");
  assert.ok(axe.pos, "back on the floor");
  pickUp(engine, bo, "axe-1");
  assert.deepEqual(held(engine, bo), ["axe-1"], "looted from the dead");
});

test("market: constant-product payout, cheaper for what it holds a lot of", () => {
  let { engine, ids } = boot("three-tools-market");
  let [ara, bo] = ids;
  engine.setStock("exchange", "fish", 40);
  engine.setStock("exchange", "firewood", 10);
  engine.setStock("exchange", "water", 20);
  engine.setStock(ara, "fish", 4);
  engine.setStock(ara, "water", 0);
  engine.setStock(bo, "firewood", 4);
  engine.setStock(bo, "water", 0);

  // The post holds 40 fish: 4 fish buy floor(4*20/(40+4)) = 1 water.
  engine.commitIntent(ara, {
    type: "trade",
    give: "fish",
    get: "water",
    amount: 4,
  });
  engine.tick();
  assert.equal(stockOf(engine, ara, "fish"), 0);
  assert.equal(stockOf(engine, ara, "water"), 1);
  assert.equal(stockOf(engine, "exchange", "fish"), 44);
  assert.equal(stockOf(engine, "exchange", "water"), 19);

  // It holds only 10 firewood: 4 firewood buy floor(4*19/(10+4)) = 5 water.
  engine.commitIntent(bo, {
    type: "trade",
    give: "firewood",
    get: "water",
    amount: 4,
  });
  engine.tick();
  assert.equal(stockOf(engine, bo, "firewood"), 0);
  assert.equal(stockOf(engine, bo, "water"), 5);
  assert.equal(stockOf(engine, "exchange", "firewood"), 14);
  assert.equal(stockOf(engine, "exchange", "water"), 14);
});

test("market: a trade that would pay nothing, or that you cannot cover, is refused", () => {
  let { engine, ids } = boot("three-tools-market");
  let [ara] = ids;
  engine.setStock("exchange", "fish", 40);
  engine.setStock("exchange", "firewood", 10);
  engine.setStock(ara, "fish", 2);
  // floor(1*10/(40+1)) = 0 firewood for one fish.
  assert.throws(
    () =>
      engine.commitIntent(ara, {
        type: "trade",
        give: "fish",
        get: "firewood",
        amount: 1,
      }),
    /pay you nothing/,
  );
  // Ara has 2 fish, not 3.
  assert.throws(
    () =>
      engine.commitIntent(ara, {
        type: "trade",
        give: "fish",
        get: "water",
        amount: 3,
      }),
    /do not have that many/,
  );
  assert.equal(stockOf(engine, ara, "fish"), 2, "nothing changed hands");
});
