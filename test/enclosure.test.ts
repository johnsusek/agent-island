// The enclosure scenario: a regrowing meadow commons plus property
// technology. Booted on the real world file, these pin its core: stakes carry
// the builder's name, fences block routes, stepping onto someone else's staked
// ground is a global event (but not onto your own), anyone can pull a claim up
// in public, a petition takes its time and carries its words to the court,
// and the meadow regrows from what is left but dies when grazed bare.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWorld } from "@agent-island/engine/engine";
import {
  createScenarioStore,
  scenarioBootScenario,
  scenarioFromWorldFile,
} from "../packages/mcp/src/index.js";
import { placeAt as restorePlace, runToIdle } from "./helpers.js";

let dir = new URL("../config/scenarios", import.meta.url).pathname;
let base = scenarioFromWorldFile(
  JSON.parse(
    readFileSync(new URL("../config/config.json", import.meta.url), "utf8"),
  ),
  "config.json",
);
let enclosure = createScenarioStore(dir, dir).load("enclosure");

type Engine = ReturnType<typeof createWorld>;
type Pos = { x: number; y: number };

function boot(names: string[]) {
  let engine = createWorld(scenarioBootScenario(base, enclosure));
  engine.applyOverlay(enclosure.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

// Teleport through snapshot/restore (helpers' placeAt). A captured overlay
// does not carry the scenario's describeEvent templates, so a restore drops
// them; lay them back on so the event prose under test is the scenario's.
function placeAt(engine: Engine, id: string, x: number, y: number) {
  restorePlace(engine, id, x, y);
  engine.applyOverlay({
    ...engine.snapshot().overlay,
    describeEvent: enclosure.overlay.describeEvent,
  } as Parameters<Engine["applyOverlay"]>[0]);
}

function entities(engine: Engine) {
  return engine.getEntities() as Record<string, any>;
}

function ofKind(engine: Engine, kind: string) {
  return Object.values(entities(engine)).filter((e) => e.kind === kind);
}

function gap(a: Pos, b: Pos) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// A straight east-west run of open plains with nothing standing within a tile
// of it, nearest the spawn - a quiet strip of ground to stage a scene on.
function openStrip(engine: Engine, length: number): Pos[] {
  let map = engine.getMap();
  let terrain = new Map(
    map.tiles.map((t: any) => [`${t.x},${t.y}`, t.terrain as string]),
  );
  let placed = Object.values(entities(engine))
    .filter((e) => e.pos)
    .map((e) => e.pos as Pos);
  let clear = (p: Pos) =>
    terrain.get(`${p.x},${p.y}`) === "plains" &&
    placed.every((q) => gap(p, q) > 1);
  let starts = map.tiles
    .map((t: any) => ({ x: t.x, y: t.y }))
    .sort((a: Pos, b: Pos) => gap(a, map.spawn) - gap(b, map.spawn));
  for (let start of starts) {
    let strip = Array.from({ length }, (_, i) => ({
      x: start.x + i,
      y: start.y,
    }));
    let rows = [-1, 0, 1].flatMap((dy) =>
      strip.map((p) => ({ x: p.x, y: p.y + dy })),
    );
    if (rows.every(clear)) return strip;
  }
  throw new Error(`no open strip of ${length} tiles`);
}

function events(engine: Engine, type: string) {
  return engine.recentEvents().filter((e: any) => e.type === type);
}

test("the meadow country starts with grass patches and a posted rule", () => {
  let { engine, ids } = boot(["Ara"]);
  let meadows = ofKind(engine, "meadow");
  assert.equal(meadows.length, 10, `${meadows.length} meadows`);
  for (let m of meadows) assert.ok(m.stocks.grass.value >= 5);
  let situation = JSON.stringify(engine.sense(ids[0], "situation"));
  assert.match(situation, /Bare ground stays bare/);
});

test("a stake carries its builder's name; a fence does too and holds the tile", () => {
  let { engine, ids } = boot(["Ara"]);
  let [ara] = ids;
  let [a, b] = openStrip(engine, 2);
  placeAt(engine, ara, a.x, a.y);
  engine.setStock(ara, "wood", 3);
  engine.commitIntent(ara, { type: "stake" });
  runToIdle(engine, ara);
  let [stake] = ofKind(engine, "stake");
  assert.ok(stake.tags.includes(ara), "the stake carries Ara's id");
  assert.ok(stake.tags.includes("claim"));
  assert.equal(stake.occupancy, "tile");
  assert.deepEqual(stake.pos, a);
  assert.equal(entities(engine)[ara].stocks.wood.value, 2, "a stake costs 1");

  placeAt(engine, ara, b.x, b.y);
  engine.commitIntent(ara, { type: "wall" });
  runToIdle(engine, ara);
  let [wall] = ofKind(engine, "wall");
  assert.ok(wall.tags.includes(ara), "the fence carries Ara's id");
  assert.equal(wall.occupancy, "blocking");
  assert.equal(entities(engine)[ara].stocks.wood.value, 0, "a fence costs 2");
  assert.equal(events(engine, "trespass").length, 0, "own ground is no crime");
});

test("a fence blocks the way: travellers route around it", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  let strip = openStrip(engine, 7);
  let fenceAt = strip[3];
  placeAt(engine, ara, fenceAt.x, fenceAt.y);
  engine.setStock(ara, "wood", 2);
  engine.commitIntent(ara, { type: "wall" });
  runToIdle(engine, ara);
  placeAt(engine, ara, strip[3].x, strip[3].y - 3);
  let [wall] = ofKind(engine, "wall");
  assert.deepEqual(wall.pos, fenceAt);

  engine.spawnEntity({
    id: "far-post",
    kind: "sign",
    tags: ["sign"],
    pos: strip[6],
    occupancy: "tile",
    text: "the far side",
  });
  placeAt(engine, bo, strip[0].x, strip[0].y);
  engine.commitIntent(bo, { type: "travel", location: "far-post" });
  let trail: Pos[] = [];
  for (let i = 0; i < 40 && entities(engine)[bo].action; i += 1) {
    engine.tick();
    trail.push({ ...entities(engine)[bo].pos });
  }
  assert.ok(
    trail.every((p) => gap(p, fenceAt) > 0),
    "Bo never set foot on the fence",
  );
  assert.ok(
    trail.some((p) => p.y !== fenceAt.y),
    "the straight line was blocked, so the route bent",
  );
  assert.ok(gap(entities(engine)[bo].pos, strip[6]) <= 1, "and Bo arrived");
});

test("stepping onto someone else's staked ground is heard by all; your own is not", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  let strip = openStrip(engine, 6);
  placeAt(engine, ara, strip[0].x, strip[0].y);
  engine.commitIntent(ara, { type: "stake" });
  runToIdle(engine, ara);
  let [stake] = ofKind(engine, "stake");
  // Ara walks off and back onto her own claim: nothing to report.
  engine.commitIntent(ara, { type: "explore", direction: "east" });
  for (let i = 0; i < 3; i += 1) engine.tick();
  engine.commitIntent(ara, { type: "travel", location: stake.id });
  runToIdle(engine, ara);
  assert.ok(gap(entities(engine)[ara].pos, stake.pos) <= 1);
  assert.equal(events(engine, "trespass").length, 0, "own ground is no crime");

  // Bo walks up to it: the whole country hears.
  placeAt(engine, ara, strip[0].x, strip[0].y - 4);
  placeAt(engine, bo, strip[5].x, strip[5].y);
  engine.commitIntent(bo, { type: "travel", location: stake.id });
  runToIdle(engine, bo);
  let trespass = events(engine, "trespass");
  assert.equal(trespass.length, 1, "one incursion, one report");
  assert.equal(trespass[0].agentId, bo);
  assert.equal(trespass[0].global, true);
  assert.match(
    trespass[0].text ?? "",
    /Bo has stepped onto ground someone else/,
  );
});

test("anyone may pull up a claim, in public", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  let strip = openStrip(engine, 3);
  placeAt(engine, ara, strip[0].x, strip[0].y);
  engine.commitIntent(ara, { type: "stake" });
  runToIdle(engine, ara);
  let [stake] = ofKind(engine, "stake");
  placeAt(engine, ara, strip[0].x, strip[0].y - 4);
  placeAt(engine, bo, strip[1].x, strip[1].y);
  engine.commitIntent(bo, { type: "pull_up", target: stake.id });
  runToIdle(engine, bo);
  assert.equal(ofKind(engine, "stake").length, 0, "the stake is gone");
  let [pulled] = events(engine, "pulled_up");
  assert.equal(pulled.agentId, bo);
  assert.equal(pulled.global, true);
});

test("a petition takes five ticks and carries the complaint to the court", () => {
  let { engine, ids } = boot(["Ara"]);
  let [ara] = ids;
  let complaint = "Bo pulled up my stake by the north meadow; I ask for 2 wood";
  engine.commitIntent(ara, { type: "petition", complaint });
  for (let i = 0; i < 4; i += 1) engine.tick();
  assert.equal(events(engine, "petition").length, 0, "still writing");
  engine.tick();
  let [petition] = events(engine, "petition");
  assert.ok(petition, "the petition was filed");
  assert.equal(petition.agentId, ara);
  assert.equal(petition.global, true);
  assert.ok(petition.text?.includes(complaint), petition.text);
});

test("the meadow regrows from what is left, but grazed bare it is dead", () => {
  let { engine, ids } = boot(["Ara"]);
  let [ara] = ids;
  let [meadow, other] = ofKind(engine, "meadow");
  engine.setStock(other.id, "grass", 5);
  for (let i = 0; i < 20; i += 1) engine.tick();
  let regrown = entities(engine)[other.id].stocks.grass.value;
  assert.ok(regrown > 5.5, `half a meadow regrew to ${regrown}`);

  // Graze a nearly bare patch to nothing.
  placeAt(engine, ara, meadow.pos.x + 1, meadow.pos.y);
  engine.setStock(meadow.id, "grass", 2);
  engine.setStock(ara, "forage", 0);
  engine.commitIntent(ara, { type: "graze" });
  runToIdle(engine, ara);
  assert.equal(entities(engine)[ara].stocks.forage.value, 2);
  let dead = entities(engine)[meadow.id];
  assert.equal(dead.kind, "bare", "grazed bare, it is bare ground");
  assert.ok(!dead.tags.includes("meadow"));
  for (let i = 0; i < 50; i += 1) engine.tick();
  assert.equal(entities(engine)[meadow.id].stocks.grass.value, 0, "for good");
  let again = engine.commitIntent(ara, { type: "graze" }) as any;
  assert.notEqual(
    again.action?.params?.location,
    meadow.id,
    "the dead patch is no longer somewhere to graze",
  );

  engine.commitIntent(ara, { type: "eat" });
  engine.tick();
  assert.equal(entities(engine)[ara].stocks.forage.value, 1);
});
