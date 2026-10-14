// The exodus scenario: a gate that opens only when half the living stand at
// it, dropping everyone onto a freshly rolled floor. Booted on the real world
// file, these pin the quorum, the reroll's carry-over (people and packs cross;
// signs do not), the new floor's own gate and bushes, and regrowth slowing
// with depth.

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
let exodus = createScenarioStore(dir, dir).load("exodus");

function boot(names: string[]) {
  let engine = createWorld(scenarioBootScenario(base, exodus));
  engine.applyOverlay(exodus.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  // Test-only porter: anyone tagged "porter" is set down beside the gate.
  engine.addRule({
    id: "test-porter",
    phase: "transition",
    each: { tag: "porter" },
    when: { colocated: { kind: "gate", range: 99 } },
    do: [
      { moveTo: { to: { colocated: { kind: "gate", range: 99 } } } },
      { tag: { remove: "porter" } },
    ],
  });
  return { engine, ids };
}

type Engine = ReturnType<typeof createWorld>;

function entities(engine: Engine) {
  return engine.getEntities() as Record<string, any>;
}

function ofKind(engine: Engine, kind: string) {
  return Object.values(entities(engine)).filter((e) => e.kind === kind);
}

function gap(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function floor(engine: Engine) {
  return entities(engine).world.stocks.floor.value;
}

function regenerated(engine: Engine) {
  return engine.recentGmEvents().filter((e) => e.kind === "world_regenerated");
}

function carryToGate(engine: Engine, id: string) {
  engine.editEntity(id, { addTags: ["porter"] });
  engine.tick();
  let gate = ofKind(engine, "gate")[0];
  assert.ok(gap(entities(engine)[id].pos, gate.pos) <= 1, "set at the gate");
}

test("one gate stands away from spawn, among bushes", () => {
  let { engine, ids } = boot(["Ara"]);
  let gates = ofKind(engine, "gate");
  assert.equal(gates.length, 1);
  assert.ok(gap(gates[0].pos, entities(engine)[ids[0]].pos) >= 9);
  assert.ok(ofKind(engine, "bush").length >= 4);
  assert.equal(floor(engine), 0);
});

test("below half at the gate nothing happens; at half, everyone falls through", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy", "Dee"]);
  let [ara, bo, cy, dee] = ids;
  engine.setStock(ara, "berries", 7);
  engine.inscribe(dee, "We were here first.");
  assert.equal(ofKind(engine, "sign").length, 1);

  carryToGate(engine, ara);
  for (let i = 0; i < 5; i += 1) engine.tick();
  assert.equal(floor(engine), 0, "one of four is not enough");
  assert.equal(regenerated(engine).length, 0);
  assert.ok(
    engine.recentEvents().some((e) => e.type === "gate-stirs"),
    "the gate tells whoever stands at it",
  );

  carryToGate(engine, bo);
  engine.tick();
  assert.equal(floor(engine), 1, "two of four opens it");
  let regen = regenerated(engine);
  assert.equal(regen.length, 1, "exactly one reroll");
  assert.ok(engine.recentEvents().some((e) => e.type === "descent"));

  let spawn = (regen[0].detail as { spawn: { x: number; y: number } }).spawn;
  let now = entities(engine);
  for (let id of [ara, bo, cy, dee]) {
    assert.ok(now[id].tags.includes("agent"), `${id} still living`);
    assert.deepEqual(now[id].pos, spawn, `${id} landed at the new spawn`);
  }
  assert.ok(now[ara].stocks.berries.value >= 6, "Ara's pack crossed");
  assert.equal(ofKind(engine, "sign").length, 0, "the sign stayed behind");
  let gates = ofKind(engine, "gate");
  assert.equal(gates.length, 1, "the new floor has its own gate");
  assert.ok(gap(gates[0].pos, spawn) >= 9, "away from the new spawn");
  assert.ok(ofKind(engine, "bush").length >= 4, "and its own bushes");

  // Everyone stands at spawn, not the gate: no immediate second fall.
  for (let i = 0; i < 10; i += 1) engine.tick();
  assert.equal(floor(engine), 1);
  assert.equal(regenerated(engine).length, 1);
});

test("bushes regrow at half speed two floors down", () => {
  let rateOn = (depth: number) => {
    let { engine } = boot(["Ara"]);
    engine.setStock("world", "floor", depth);
    let bush = ofKind(engine, "bush")[0];
    engine.setStock(bush.id, "berries", 0);
    // Long enough that the read-side rounding (to 0.1) cannot hide the rate.
    for (let i = 0; i < 100; i += 1) engine.tick();
    return entities(engine)[bush.id].stocks.berries.value / 100;
  };
  assert.ok(Math.abs(rateOn(0) - 0.01) < 1e-3, `floor 0: ${rateOn(0)}`);
  assert.ok(Math.abs(rateOn(2) - 0.005) < 1e-3, `floor 2: ${rateOn(2)}`);
});
