import assert from "node:assert/strict";
import { hasTag } from "../src/rules/kernel.js";
import test from "node:test";

import { normalizeId, type WorldEngine } from "../src/rules/engine.js";
import {
  makeSurvivalEngine as survival,
  placeAt,
  runToIdle,
} from "./helpers.js";

function tickN(engine: WorldEngine, n: number) {
  for (let i = 0; i < n; i += 1) engine.tick();
}

// Production no longer hands a fresh character a known food source — it must
// explore to find one. A blind sweep would starve the character before it found
// anything, so the test scaffold beelines: it reads the nearest food tile off the
// omniscient map and explores straight at it until the token enters the agent's
// fog, returning the nearest one it then knows. Bounded, so a stuck search fails
// loudly instead of hanging.
function discoverFood(engine: WorldEngine, id: string, safety = 15) {
  // Skip food within sight of spawn (SIGHT 12): callers rely on the destination
  // being a wild source beyond the spawn reveal, reached only by exploring.
  let start = engine.getObservation(id).you.position;
  let foodTiles = engine
    .getMapTokens()
    .filter(
      (t) =>
        !!t.token &&
        hasTag(t.token, "food") &&
        Math.max(Math.abs(t.x - start.x), Math.abs(t.y - start.y)) > 12,
    );
  let farFood = new Set(foodTiles.map((t) => t.token!.name));
  let nearestKnown = () =>
    engine
      .getObservation(id)
      .known.locations.filter((l) => farFood.has(l.name))
      .sort((a, b) => a.distance - b.distance)[0];
  // Eight compass steps, so a blocked beeline (water across the straight line)
  // can detour around instead of dead-ending.
  let steps: [string, number, number][] = [
    ["north", 0, -1],
    ["south", 0, 1],
    ["east", 1, 0],
    ["west", -1, 0],
    ["northeast", 1, -1],
    ["northwest", -1, -1],
    ["southeast", 1, 1],
    ["southwest", -1, 1],
  ];
  for (let i = 0; i < safety; i += 1) {
    let known = nearestKnown();
    if (known) return known;
    let me = engine.getObservation(id).you.position;
    let target = foodTiles
      .map((t) => ({
        t,
        d: Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y)),
      }))
      .sort((a, b) => a.d - b.d)[0];
    if (!target) break;
    // Try the directions that land us closest to the target first, skipping any
    // the engine rejects (impassable water or the map edge).
    let ranked = steps
      .map(([dir, dx, dy]) => ({
        dir,
        d: Math.max(
          Math.abs(me.x + dx - target.t.x),
          Math.abs(me.y + dy - target.t.y),
        ),
      }))
      .sort((a, b) => a.d - b.d);
    let stepped = false;
    for (let { dir } of ranked) {
      let accepted = false;
      try {
        accepted = engine.commitIntent(id, {
          type: "explore",
          direction: dir,
        }).accepted;
      } catch {
        continue; // blocked - try the next-best direction
      }
      if (accepted) {
        runToIdle(engine, id);
        stepped = true;
        break;
      }
    }
    if (!stepped) break;
  }
  throw new Error(`agent ${id} never discovered a food source`);
}

// An existing token the agent has NOT yet discovered — for asserting the fog gate.
function hiddenToken(engine: WorldEngine, id: string): string {
  let known = new Set(
    engine.getObservation(id).known.locations.map((l) => l.name),
  );
  let tile = engine
    .getMapTokens()
    .find((t) => t.token && !known.has(t.token.name));
  if (!tile?.token) throw new Error("no undiscovered token on the map");
  return tile.token.name;
}

test("agents can be added at any time and spawn at the same clearing at the current tick", () => {
  let engine = survival();
  engine.addAgent("Ara");
  tickN(engine, 40);
  engine.addAgent("Bren");

  let bren = engine.getObservation("bren");
  assert.equal(bren.you.id, "bren");
  assert.equal(bren.you.ticksLived, 0);
  assert.equal(bren.tick, 40);
  // Ara stands at the spawn camp, where the ledger lists the newcomer.
  let ara = engine.getObservation("ara");
  assert.equal(ara.you.ticksLived, 40);
  assert.equal(ara.colony.atLedger, true, "the camp ledger sits at spawn");
  assert.ok(ara.colony.roster!.some((other) => other.name === "Bren"));
});

test("names normalize to handles and must be unique", () => {
  let engine = survival();
  assert.equal(normalizeId("Ara The Bold"), "ara-the-bold");
  engine.addAgent("Ara");
  assert.throws(() => engine.addAgent("ARA"), /taken/);
  assert.throws(() => engine.addAgent("bad name!"), /1 to 20/);
});

test("an agent spawns perceiving only its surroundings — food is found by exploring", () => {
  let engine = survival();
  engine.addAgent("ara");
  // Nothing is handed to a fresh character beyond what it can see: the only food
  // known at spawn is what falls inside the spawn reveal (SIGHT), never a source
  // from across the map.
  assert.ok(
    engine
      .getObservation("ara")
      .known.locations.filter((l) => hasTag(l, "food"))
      .every((l) => l.distance <= 12),
    "only food within sight is known at spawn",
  );
  // Exploring reveals one, and the far sources stay fogged until discovered.
  let found = discoverFood(engine, "ara");
  assert.ok(hasTag(found, "food"), "exploring discovers a food source");
  let totalFood = engine
    .getMapTokens()
    .filter((t) => !!t.token && hasTag(t.token, "food")).length;
  let knownFood = engine
    .getObservation("ara")
    .known.locations.filter((l) => hasTag(l, "food")).length;
  assert.ok(totalFood > knownFood, "far food sources stay fogged");
});

test("the observation lists available actions so they stay discoverable", () => {
  let engine = survival();
  engine.addAgent("vale"); // spawns in the open, not on a food source
  let actions = engine.getObservation("vale").availableActions;
  let byName = Object.fromEntries(actions.map((a) => [a.name, a]));
  assert.ok(byName.eat, "eat is listed");
  // A fresh character carries no food, so eat doesn't apply yet; rest, which
  // works anywhere, does.
  assert.equal(byName.eat.applicable, false);
  assert.equal(byName.rest.applicable, true);
});

test("only actionable entries carry the heavy schema", () => {
  let engine = survival();
  engine.addAgent("vale"); // empty scenario: eat inapplicable, rest applicable
  let byName = Object.fromEntries(
    engine.getObservation("vale").availableActions.map((a) => [a.name, a]),
  );
  // An applicable action ships its full schema so it can be ordered right away.
  assert.equal(byName.rest.applicable, true);
  assert.ok(byName.rest.params, "applicable action keeps params");
  assert.ok(byName.rest.description, "applicable action keeps description");
  // An inapplicable action drops the heavy schema (params/options) but still
  // earns its description inside the teaching window (the first observation),
  // so a character learns what a verb it cannot use yet actually does.
  assert.equal(byName.eat.applicable, false);
  assert.equal(
    byName.eat.params,
    undefined,
    "inapplicable action drops params",
  );
  assert.ok(
    byName.eat.description,
    "inapplicable action keeps its description in the teaching window",
  );
});

test("you can only travel to a token you've discovered", () => {
  let engine = survival();
  engine.addAgent("ara");
  let dest = discoverFood(engine, "ara").name;
  assert.throws(
    () =>
      engine.commitIntent("ara", {
        type: "travel",
        location: hiddenToken(engine, "ara"),
      }),
    /discovered/,
  );
  assert.doesNotThrow(() =>
    engine.commitIntent("ara", { type: "travel", location: dest }),
  );
});

test("travel is a path that moves the agent tile by tile to arrival", () => {
  let engine = survival();
  engine.addAgent("ara");
  let dest = discoverFood(engine, "ara").name;

  let started = engine.commitIntent("ara", { type: "travel", location: dest });
  assert.ok(started.accepted, "travel is a known action");
  assert.ok(started.duration > 0, "travel takes at least one tick");

  tickN(engine, 1);
  let midway = engine.getObservation("ara");
  assert.notEqual(midway.you.at, dest, "not yet arrived");

  let arrived = runToIdle(engine, "ara");
  assert.equal(arrived.you.at, dest);
  assert.ok(engine.recentEvents().some((e) => e.type === "arrived"));
});

test("committing a new action abandons unfinished travel", () => {
  let engine = survival();
  engine.addAgent("ara");
  let dest = discoverFood(engine, "ara").name;
  engine.commitIntent("ara", { type: "travel", location: dest });
  tickN(engine, 1);
  let underway = engine.getObservation("ara");
  engine.commitIntent("ara", { type: "rest" });

  assert.notEqual(underway.you.at, dest);
  assert.ok(
    engine.recentEvents().some((event) => event.type === "action_abandoned"),
  );
});

test("gather takes food from the source into the pack; eat then works anywhere", () => {
  let engine = survival();
  engine.addAgent("ara");
  // Can't eat out in the open with an empty scenario - food comes from the scenario now,
  // not straight off the land.
  assert.throws(
    () => engine.commitIntent("ara", { type: "eat" }),
    /carrying food/,
  );

  let dest = discoverFood(engine, "ara");
  engine.commitIntent("ara", { type: "travel", location: dest.name });
  runToIdle(engine, "ara");
  assert.equal(engine.getObservation("ara").you.at, dest.name, "on the source");

  let remainingAtSource = () => {
    let loc = engine
      .getObservation("ara")
      .known.locations.find((l) => l.name === dest.name)!;
    if (!("remaining" in loc) || typeof loc.remaining !== "number")
      throw new Error("source carries no reserve");
    return loc.remaining;
  };
  let before = remainingAtSource();

  // Gather draws the source down and fills the scenario.
  engine.commitIntent("ara", { type: "gather" });
  runToIdle(engine, "ara");
  assert.ok(
    before - remainingAtSource() > 0.5,
    "gathering drew the source down",
  );
  assert.ok(
    engine.getObservation("ara").you.stocks.food.value > 0,
    "the scenario now holds gathered food",
  );

  // Eat now works away from any source, straight from the scenario.
  let satiationBefore = engine.getObservation("ara").you.stocks.satiation.value;
  let carriedBefore = engine.getObservation("ara").you.stocks.food.value;
  engine.commitIntent("ara", { type: "eat" });
  runToIdle(engine, "ara");
  assert.ok(
    engine.getObservation("ara").you.stocks.satiation.value > satiationBefore,
    "hunger eased by eating from the scenario",
  );
  assert.ok(
    engine.getObservation("ara").you.stocks.food.value < carriedBefore,
    "a ration left the scenario",
  );
});

test("explore strikes into the unknown and reveals new ground", () => {
  let engine = survival();
  engine.addAgent("ara");
  let knownBefore = engine.getObservation("ara").known.locations.length;

  engine.commitIntent("ara", { type: "explore", direction: "south" });
  let here = engine.getObservation("ara").you.position;
  runToIdle(engine, "ara");
  let moved = engine.getObservation("ara").you.position;

  assert.notDeepEqual({ x: here.x, y: here.y }, { x: moved.x, y: moved.y });
  assert.ok(engine.getObservation("ara").known.locations.length >= knownBefore);
});

test("whisper means leaning in: same tile works, at range it is refused", () => {
  let engine = survival();
  let { id: ara } = engine.addAgent("ara");
  engine.addAgent("bren");
  let here = engine.getObservation(ara).you.position;
  placeAt(engine, "bren", here.x, here.y);

  engine.whisper("ara", "Bren", "Meet at the meadow.");
  assert.ok(
    engine
      .recentEvents()
      .some((e) => e.type === "whispered" && e.target === "bren"),
  );

  // Leaning in reaches the adjacent tile (WHISPER_RANGE 1), but no further.
  placeAt(engine, "bren", here.x + 1, here.y);
  engine.whisper("ara", "Bren", "Meet at the meadow.");
  assert.ok(
    engine
      .recentEvents()
      .some((e) => e.type === "whispered" && e.target === "bren"),
  );

  placeAt(engine, "bren", here.x + 2, here.y);
  assert.throws(
    () => engine.whisper("ara", "Bren", "Meet at the meadow."),
    /too far away to whisper/,
  );
  assert.throws(() => engine.whisper("ara", "nobody", "hi"), /No agent/);
});

test("speak carries within earshot only", () => {
  let engine = survival();
  let { id: ara } = engine.addAgent("ara");
  engine.addAgent("bren"); // shares ara's tile
  engine.addAgent("cyd"); // out of earshot
  let here = engine.getObservation(ara).you.position;
  placeAt(engine, "cyd", here.x + 10, here.y);

  engine.speak("ara", "food's scarce!");
  let said = engine.recentEvents().find((e) => e.type === "said");
  assert.ok(said);
  assert.deepEqual(said.audience, ["bren"]);
});

test("speak and whisper are free and never interrupt an action in progress", () => {
  let engine = survival();
  engine.addAgent("ara");
  engine.addAgent("bren"); // in earshot, sharing the spawn tile
  // Rest is a multi-tick action that keeps Ara occupied while we check
  // speaking neither passes time nor interrupts it.
  engine.commitIntent("ara", { type: "rest" });
  let before = engine.getObservation("ara");

  let said = engine.speak("ara", "headed out to forage");
  assert.deepEqual(said.heardBy, ["bren"]);
  let after = engine.getObservation("ara");
  assert.equal(after.tick, before.tick); // no time passed
  assert.equal(after.you.action!.type, "rest"); // still resting
  assert.ok(engine.recentEvents().some((e) => e.type === "said"));
});

test("a neglected agent dies but the world keeps running", () => {
  let engine = survival();
  engine.addAgent("ara");
  // Neglect kills within the safety window: satiation runs out around tick
  // 500 and then health drains, so death lands around ~550 ticks.
  let safety = 0;
  while (engine.isAlive("ara") && safety < 800) {
    engine.tick();
    safety += 1;
  }
  assert.equal(engine.isAlive("ara"), false);
  assert.ok(engine.recentEvents().some((event) => event.type === "died"));
  assert.doesNotThrow(() => engine.tick());
});

test("events carry a monotonic sequence usable as a cursor", () => {
  let engine = survival();
  let cursor = engine.cursor();
  engine.addAgent("ara");
  tickN(engine, 3);
  let since = engine.getEventsSince(cursor);
  assert.ok(since.length > 0);
  assert.ok(since.every((event) => event.seq >= cursor));
  assert.equal(engine.getEventsSince(engine.cursor()).length, 0);
});

test("identical inputs produce identical worlds (replayable)", () => {
  function run() {
    let engine = survival();
    engine.addAgent("ara");
    engine.addAgent("bren");
    engine.commitIntent("ara", { type: "explore", direction: "north" });
    engine.commitIntent("bren", { type: "explore", direction: "south" });
    tickN(engine, 6);
    return JSON.stringify(engine.getAdminState());
  }
  assert.equal(run(), run());
});

test("world generation is deterministic across worlds", () => {
  let a = survival();
  let b = survival();
  assert.equal(JSON.stringify(a.getMap()), JSON.stringify(b.getMap()));
});
