import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTag,
  beginTick,
  commit,
  runRulesForTick,
  step,
  stock,
  type KernelWorld,
  type FlowRule,
  type Modifier,
  type DerivedRule,
  type ThresholdRule,
} from "../src/rules/kernel.js";
import {
  advanceSpace,
  chebyshev,
  commitMove,
  knownTokens,
  knows,
  makeSpace,
  revealAt,
  spawn,
  worldgenWithTerrainPolicy,
  type Space,
} from "../src/rules/space.js";
import { dirToward, makeSurvivalEngine, runToIdle } from "./helpers.js";

// A neutral world stock with its own draining flow, used to exercise the kernel's
// channel-modifier machinery without leaning on any one scenario rule. Append
// `reserveDrains` to the rule list and the stock bleeds 1/tick on "reserve.decay".
const reserveDrains: FlowRule = {
  id: "reserve-drains",
  phase: "flow",
  target: "reserve",
  rate: -1,
  channel: "reserve.decay",
};

// A calendar, derived from the world clock. Not part of the base game — these
// exercise the kernel's derived-stock phase; append them and seed a `season`
// stock to turn the seasons on.
const calendarDay: DerivedRule = {
  id: "calendar-day",
  phase: "derived",
  target: "day",
  value: { mod: [{ tick: true }, 360] },
};
const calendarSeason: DerivedRule = {
  id: "calendar-season",
  phase: "derived",
  target: "season",
  value: { floor: { div: [{ mod: [{ tick: true }, 360] }, 90] } },
};

// The kind of modifier a GM would inject: when the derived season says winter,
// the reserve drains twice as fast. Self-activating — the calendar condition just
// starts holding on the winter ticks. Not part of the base game; append it to
// the rule list to turn the seasons on.
const winterChill: Modifier = {
  id: "winter-chill",
  kind: "modifier",
  channel: "reserve.decay",
  op: "scale",
  value: 2,
  when: { cmp: "eq", left: { stock: "season", of: "world" }, right: 3 },
};

const WINTER = 3; // season index: spring=0, summer=1, autumn=2, winter=3

import {
  addAgent,
  findToken,
  makeSurvivalSpace,
  makeSurvivalWorld,
  spawnAgent,
  survivalRules,
} from "./helpers.js";

// The nearest token of a tag to spawn — the one spawnAgent reveals.
function nearestTokenToSpawn(space: Space, tag: string) {
  let s = space.grid.spawn;
  let token = space.grid.tokens
    .filter((g) => hasTag(g, tag))
    .sort(
      (a, b) => chebyshev(s.x, s.y, a.x, a.y) - chebyshev(s.x, s.y, b.x, b.y),
    )[0];
  if (!token) throw new Error(`no ${tag} token on the grid`);
  return token;
}

// Drive the same tick order as the host: start tick, advance space, run rules.
function spatialStep(world: KernelWorld, space: Space) {
  let before = beginTick(world);
  let events = advanceSpace(space, world, []);
  return runRulesForTick(world, survivalRules, before, events);
}

test("flows drift each tick: hunger rises", () => {
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");

  for (let t = 1; t <= 3; t += 1) step(world, survivalRules);
  // Compare within epsilon: three 0.1 drifts accumulate float error.
  assert.ok(Math.abs(ara.stocks.hunger.value - 0.3) < 1e-9, "hunger +0.1/tick");
});

test("a neglected agent runs a full life to death, then is tagged out of the living", () => {
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");

  // The slower need rates mean neglect kills via the cold: warmth bottoms out
  // first (cold is the fastest need at person scale) and freezing damage
  // finishes the character within a few hundred ticks.
  let died = -1;
  for (let t = 1; t <= 800 && died < 0; t += 1)
    if (step(world, survivalRules).some((e) => e.type === "died")) died = t;

  assert.ok(died > 0, "the agent died of neglect");
  assert.equal(ara.stocks.health.value, 0, "health bottomed out");
  assert.equal(hasTag(ara, "agent"), false, "drops the agent tag");
  assert.equal(hasTag(ara, "dead"), true, "tagged dead");
});

test("watch rules fire once, on the crossing — not every tick after", () => {
  // Seed a nearly-starved agent so the hunger edge triggers inside a short
  // window, and assert the alert appears on exactly one tick, not every tick.
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.hunger = stock(98);

  let byTick: Record<string, number[]> = {};
  for (let t = 1; t <= 24; t += 1)
    for (let e of step(world, survivalRules)) (byTick[e.type] ??= []).push(t);

  // hunger 98 + 0.1/tick crosses 100 on tick 21 (float drift on the 0.1 sum
  // leaves tick 20 a hair under): starving fires then, only then.
  assert.deepEqual(
    byTick.starving,
    [21],
    "starving fires once at the crossing",
  );
});

test("gather fills the scenario from the source underfoot; eat then eases hunger", () => {
  let world = makeSurvivalWorld();
  let bo = addAgent(world, "bo");
  let foodToken = findToken(world, "food");
  bo.pos = { ...foodToken.pos! }; // standing on a wild food source

  for (let t = 1; t <= 50; t += 1) step(world, survivalRules); // hunger climbs
  let hungry = bo.stocks.hunger.value;
  let atCommit = foodToken.stocks.food.value;

  // Gather moves food from the source into Bo's scenario (bounded by scenario headroom;
  // the scenario starts empty with room for 12, and the source holds less, so the
  // whole reserve comes across bar the trickle it regrows mid-work).
  assert.equal(commit(world, survivalRules, "bo", "gather").ok, true);
  for (let t = 1; t <= 2; t += 1) step(world, survivalRules);
  let carried = bo.stocks.food.value;
  assert.ok(carried > 0, "the scenario now holds gathered food");
  assert.ok(
    foodToken.stocks.food.value < atCommit,
    "and the source was drawn down",
  );

  // Eat spends one ration from the scenario and eases hunger, wherever Bo stands.
  assert.equal(commit(world, survivalRules, "bo", "eat").ok, true);
  for (let t = 1; t <= 2; t += 1) step(world, survivalRules);
  assert.equal(
    bo.stocks.food.value,
    carried - 1,
    "one ration eaten from the scenario",
  );
  assert.ok(bo.stocks.hunger.value < hungry, "hunger dropped");
});

test("an action fizzles at completion if its precondition lapsed mid-work", () => {
  // A tree token holds the wood a `chop` draws down. Run chop in isolation so the
  // emptied-mid-work window stays open (survival's tree-felled rule would clear a
  // spent tree, a separate concern); felled wood never regrows, unlike food.
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  let chopOnly = survivalRules.filter((r) => r.id === "chop");
  let stand = {
    id: "tree",
    tags: ["tree", "wood"],
    occupancy: "tile" as const,
    stocks: { wood: stock(1, 0, 9999) }, // one tree left
    pos: { ...ara.pos! },
    action: null,
  };
  world.entities["tree"] = stand;

  assert.equal(
    commit(world, chopOnly, "ara", "chop").ok,
    true,
    "commits while timber still stands",
  );
  // Another logger fells the last of the wood before this chop completes.
  stand.stocks.wood = stock(0, 0, 9999);
  let events: string[] = [];
  for (let t = 1; t <= 4; t += 1)
    for (let e of step(world, chopOnly)) events.push(e.type);

  assert.ok(events.includes("action_failed"), "fizzles when the trees ran dry");
  assert.equal(stand.stocks.wood.value, 0, "no wood conjured");
  assert.equal(ara.stocks.wood.value, 0, "the actor gained nothing");
});

test("travel walks the grid tile by tile to a discovered token", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();
  addAgent(world, "ara");
  spawnAgent(space, "ara");

  let foodToken = nearestTokenToSpawn(space, "food");
  let kr = commitMove(space, world, "ara", "travel", {
    location: foodToken.name,
  });
  assert.equal(kr.ok, true);

  // Walk the whole trip. Terrain can make a tile take several ticks to cross, so
  // count the tiles actually stepped onto (position changes) separately from the
  // ticks elapsed — energy is charged per tile, the clock runs per tick.
  let arrived = false;
  let tilesWalked = 0;
  let movedEvents = 0;
  let prev = { ...world.entities.ara.pos };
  for (let t = 1; t <= kr.endsInTicks!; t += 1) {
    let events = spatialStep(world, space);
    let now = world.entities.ara.pos!;
    if (now.x !== prev.x || now.y !== prev.y) {
      tilesWalked += 1;
      prev = { ...now };
    }
    movedEvents += events.filter((event) => event.type === "moved").length;
    if (events.some((event) => event.type === "arrived")) arrived = true;
  }

  assert.ok(arrived, "the trip completes with an arrival");
  assert.ok(
    kr.endsInTicks! >= tilesWalked,
    "the trip takes at least one tick per tile (more across slow terrain)",
  );
  assert.deepEqual(
    world.entities.ara.pos,
    { x: foodToken.x, y: foodToken.y },
    "standing on the food token",
  );
  assert.equal(
    world.entities.ara.stocks.energy.value,
    100 - tilesWalked * 0.5,
    "0.5 energy per tile walked",
  );
  assert.equal(movedEvents, tilesWalked, "movement emits one event per tile");
});

test("terrain slows movement: a costly tile takes its enter cost in ticks to cross", () => {
  // A five-tile corridor with a hill (enter cost 3) in the middle, a goal at the
  // far end. Travel must dwell on the hill, so the trip is longer in ticks than in
  // tiles, but the agent still steps onto exactly four tiles.
  let space = makeSpace(
    { x: 0, y: 0 },
    worldgenWithTerrainPolicy(
      {
        width: 5,
        height: 1,
        defaultTerrain: "plains",
        tokens: [{ name: "goal", tags: [], occupancy: "tile", x: 4, y: 0 }],
      },
      { hills: { moveCost: 3 } },
    ),
  );
  space.grid.tiles[0][2].terrain = "hills";
  let world = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };
  spawn(space, "ara", 0, { radius: 5 }); // reveal the whole corridor incl. the goal

  let kr = commitMove(space, world, "ara", "travel", { location: "goal" });
  assert.equal(kr.ok, true);
  // 1 (x1) + 3 (hill at x2) + 1 (x3) + 1 (x4) = 6 ticks for 4 tiles.
  assert.equal(kr.endsInTicks, 6);

  let onHillFor = 0;
  let arrivedTick: number | null = null;
  let tilesWalked = 0;
  let prevX = 0;
  for (let t = 1; t <= kr.endsInTicks!; t += 1) {
    world.tick = t;
    let events = advanceSpace(space, world, []);
    let x = world.entities.ara.pos.x;
    if (x !== prevX) {
      tilesWalked += 1;
      prevX = x;
    }
    if (x === 2) onHillFor += 1;
    if (events.some((e) => e.type === "arrived")) arrivedTick = t;
  }

  assert.equal(world.entities.ara.pos.x, 4, "reached the goal");
  assert.equal(arrivedTick, 6, "arrival lands on the sixth tick");
  assert.equal(tilesWalked, 4, "four tiles stepped onto");
  assert.equal(onHillFor, 1, "the hill is a single tile, occupied once");
});

test("travel to a token on impassable ground routes to the bank beside it", () => {
  // The dock sits on impassable water at (3,0). It is meant to be worked from
  // the shore, and draw-style actions only ask you to stand adjacent - so
  // travel must route to the nearest tile you can stand on, not fail because the
  // token's own tile can never be entered (the old behavior).
  let space = makeSpace(
    { x: 0, y: 0 },
    worldgenWithTerrainPolicy(
      {
        width: 4,
        height: 1,
        defaultTerrain: "plains",
        tokens: [
          {
            name: "dock",
            tags: [],
            occupancy: "tile",
            x: 3,
            y: 0,
            terrain: "water",
          },
        ],
      },
      { water: { passable: false } },
    ),
  );
  let world = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };
  spawn(space, "ara", 0, { tokens: ["dock"] });

  let ok = commitMove(space, world, "ara", "travel", { location: "dock" });
  assert.equal(
    ok.ok,
    true,
    "travel to a dockside token is planned, not denied",
  );
  let landing = space.moves.get("ara")?.path.at(-1);
  assert.ok(landing, "a path was planned");
  assert.equal(
    `${landing!.x},${landing!.y}`,
    "2,0",
    "the trip ends on the plains tile beside the dock, never on the water itself",
  );
});

test("travel to a token walled off by impassable ground still reports no route", () => {
  // Dock on water at (2,0) with water at (1,0) too: from the plains at (0,0)
  // there is no passable tile touching the dock, so the trip is genuinely
  // unreachable and must be denied rather than routed onto impassable ground.
  let space = makeSpace(
    { x: 0, y: 0 },
    worldgenWithTerrainPolicy(
      {
        width: 3,
        height: 1,
        defaultTerrain: "plains",
        tokens: [
          {
            name: "dock",
            tags: [],
            occupancy: "tile",
            x: 2,
            y: 0,
            terrain: "water",
          },
        ],
      },
      { water: { passable: false } },
    ),
  );
  space.grid.tiles[0][1].terrain = "water";
  let world = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };
  spawn(space, "ara", 0, { tokens: ["dock"] });

  let denied = commitMove(space, world, "ara", "travel", { location: "dock" });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /no route/i);
});

test("travel follows a token that creeps while it stays in sight, then lands on it", () => {
  // A travel path is snapshotted when the order is set. A moving goal - a
  // creeping flame - drifts off it, so the walker must re-aim each tick while it
  // can still see the token. Here the spark starts two tiles east, edges further
  // out of reach as the walker closes, then settles - and the walker chases it
  // down and arrives on its resting tile rather than the stale original spot.
  let space = makeSpace(
    { x: 0, y: 0 },
    { width: 8, height: 1, defaultTerrain: "plains" },
  );
  let world = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };
  space.grid.tokens.push({
    name: "spark",
    tags: ["flame"],
    occupancy: "tile",
    x: 2,
    y: 0,
  });
  spawn(space, "ara", 0, { radius: 8 });

  let kr = commitMove(space, world, "ara", "travel", { location: "spark" });
  assert.equal(kr.ok, true);
  assert.equal(
    kr.endsInTicks,
    2,
    "the snapshot aims at the spark's first spot",
  );
  let spark = space.grid.tokens.find((t) => t.name === "spark")!;

  // The spark keeps ahead for the first couple of ticks (still within sight),
  // then holds at (5,0). Move it after each step so the walker re-aims.
  let creeps = new Map([
    [1, 4],
    [2, 5],
  ]);
  let arrivedTick: number | null = null;
  for (let t = 1; t <= 8 && arrivedTick === null; t += 1) {
    world.tick = t;
    let events = advanceSpace(space, world, []);
    if (events.some((e) => e.type === "arrived")) arrivedTick = t;
    let creep = creeps.get(t);
    if (creep !== undefined) spark.x = creep;
  }

  assert.equal(world.entities.ara.pos.x, 5, "the walker chased the spark down");
  assert.equal(
    `${world.entities.ara.pos.x},${world.entities.ara.pos.y}`,
    `${spark.x},${spark.y}`,
    "and finished standing on the flame, not its stale snapshot at (2,0)",
  );
  assert.ok(
    arrivedTick !== null && arrivedTick > 2,
    "arrival came later than the original two-tick plan, proving it re-aimed",
  );
});

test("travel resolves a terrain kind to the nearest known tile of it, when no token has that name", () => {
  // Forest here is bare terrain with no token name attached - travel("forest")
  // has nothing to look up in space.grid.tokens, so it must fall back to the
  // team-shared fog to find where the colony has ever seen that terrain.
  let space = makeSpace(
    { x: 0, y: 0 },
    { width: 7, height: 1, defaultTerrain: "plains" },
  );
  space.grid.tiles[0][5].terrain = "forest";
  let world = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };
  spawn(space, "ara", 0, { radius: 6 }); // reveal the whole corridor

  let kr = commitMove(space, world, "ara", "travel", { location: "forest" });
  assert.equal(kr.ok, true);
  assert.equal(kr.endsInTicks, 5);

  for (let t = 1; t <= kr.endsInTicks!; t += 1) advanceSpace(space, world, []);
  assert.deepEqual(
    world.entities.ara.pos,
    { x: 5, y: 0 },
    "walked to the forest tile despite it having no token name",
  );
});

test("travel to a terrain kind fails clearly when the colony hasn't seen any tile of it", () => {
  let space = makeSpace(
    { x: 0, y: 0 },
    { width: 7, height: 1, defaultTerrain: "plains" },
  );
  let world = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };

  let denied = commitMove(space, world, "ara", "travel", {
    location: "forest",
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /no known location/i);
});

test("explore with a terrain hint stops at the first matching tile instead of walking the full stretch", () => {
  // Without the hint, explore always strikes the full EXPLORE_TILES stretch (or
  // until it hits impassable ground) - it would sail straight past this forest
  // tile at x=3 to x=6. The hint should stop it the moment it steps onto forest.
  let space = makeSpace(
    { x: 0, y: 0 },
    { width: 7, height: 1, defaultTerrain: "plains" },
  );
  space.grid.tiles[0][3].terrain = "forest";
  let world = {
    tick: 0,
    entities: {
      ara: {
        id: "ara",
        tags: ["agent"],
        stocks: {},
        pos: { x: 0, y: 0 },
        action: null,
      },
    },
  };

  let kr = commitMove(space, world, "ara", "explore", {
    direction: "east",
    terrain: "forest",
  });
  assert.equal(kr.ok, true);
  assert.equal(
    kr.endsInTicks,
    3,
    "stops the tick it reaches the forest tile, not the full stretch",
  );

  for (let t = 1; t <= kr.endsInTicks!; t += 1) advanceSpace(space, world, []);
  assert.deepEqual(
    world.entities.ara.pos,
    { x: 3, y: 0 },
    "lands on the forest tile instead of overshooting it",
  );
});

test("scan occupies the agent, then reveals a line of fog ahead", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();
  addAgent(world, "ara");
  spawnAgent(space, "ara");

  let { x: sx, y: sy } = space.grid.spawn;
  let farNorth = sy - 14; // up the north line: past sight (12), within scan (16)
  assert.equal(
    knows(space, "ara", sx, farNorth),
    false,
    "far north starts in fog",
  );

  let r = commitMove(space, world, "ara", "scan", { direction: "north" });
  assert.equal(r.endsInTicks, 6, "scan occupies six ticks");

  let events: string[] = [];
  for (let t = 1; t <= 6; t += 1)
    for (let e of spatialStep(world, space)) events.push(e.type);

  assert.deepEqual(
    world.entities.ara.pos,
    { x: sx, y: sy },
    "scanning doesn't move you",
  );
  assert.ok(events.includes("scanned"), "completes with a scan event");
  assert.equal(
    knows(space, "ara", sx, farNorth),
    true,
    "the north line is now revealed",
  );
});

test("travel is rejected for places you haven't discovered", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();
  addAgent(world, "ara");
  spawnAgent(space, "ara"); // reveals the spawn surroundings + nearest food only

  // A real token the agent hasn't seen yet — rejected because it's still fogged.
  let hidden = space.grid.tokens.find((s) => !knows(space, "ara", s.x, s.y));
  assert.ok(hidden, "the map has an undiscovered token to test against");
  let denied = commitMove(space, world, "ara", "travel", {
    location: hidden!.name,
  });
  assert.equal(denied.ok, false);
  assert.equal(world.entities.ara.action, null, "no trip committed");
});

test("per-agent vision: one character's discovery stays their own", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();
  addAgent(world, "ara");
  addAgent(world, "bo");
  spawnAgent(space, "ara");
  spawnAgent(space, "bo");

  // A real token neither character has discovered yet - fogged for both.
  let hidden = space.grid.tokens.find(
    (s) => !knows(space, "ara", s.x, s.y) && !knows(space, "bo", s.x, s.y),
  );
  assert.ok(hidden, "the map has an undiscovered token to test against");

  // Ara alone lights it up (as if she scanned or a GM revealed it to her).
  revealAt(space, "ara", { x: hidden!.x, y: hidden!.y }, world.tick);

  // The discovery is Ara's, not the colony's: Ara knows the tile, sees the
  // token, and can commit a trip; Bo has none of that until he sees it himself
  // or is told about it.
  assert.ok(knows(space, "ara", hidden!.x, hidden!.y), "ara knows the tile");
  assert.ok(
    knownTokens(space, "ara", world.entities.ara.pos!, world.tick).some(
      (s) => s.name === hidden!.name,
    ),
    "the token is in ara's known tokens",
  );
  assert.equal(
    knows(space, "bo", hidden!.x, hidden!.y),
    false,
    "bo still has the tile in fog",
  );
  assert.equal(
    knownTokens(space, "bo", world.entities.bo.pos!, world.tick).some(
      (s) => s.name === hidden!.name,
    ),
    false,
    "ara's discovery is not in bo's known tokens",
  );
  let denied = commitMove(space, world, "bo", "travel", {
    location: hidden!.name,
  });
  assert.equal(denied.ok, false, "bo can't travel to a place he hasn't seen");
  let trip = commitMove(space, world, "ara", "travel", {
    location: hidden!.name,
  });
  assert.equal(trip.ok, true, "ara can travel to her own discovery");
});

test("the calendar derives a season from the tick, and winter self-activates", () => {
  let world = makeSurvivalWorld();
  world.entities.world.stocks.reserve = stock(200, 0, 9999);
  world.entities.world.stocks.day = stock(0, 0, 360);
  world.entities.world.stocks.season = stock(0, 0, 3);
  let rules = [
    ...survivalRules,
    calendarDay,
    calendarSeason,
    reserveDrains,
    winterChill,
  ];

  let seasonAt: Record<number, number> = {};
  for (let t = 1; t <= 360; t += 1) {
    step(world, rules);
    if ([90, 180, 270, 360].includes(t))
      seasonAt[t] = world.entities.world.stocks.season.value;
  }
  assert.deepEqual(
    seasonAt,
    { 90: 1, 180: 2, 270: 3, 360: 0 },
    "spring->summer->autumn->winter->wrap",
  );

  let winterWorld = makeSurvivalWorld();
  winterWorld.entities.world.stocks.reserve = stock(9999, 0, 9999);
  winterWorld.entities.world.stocks.day = stock(0, 0, 360);
  winterWorld.entities.world.stocks.season = stock(0, 0, 3);
  for (let t = 1; t <= 269; t += 1) step(winterWorld, rules); // tick 269, autumn
  assert.equal(
    winterWorld.entities.world.stocks.season.value,
    2,
    "tick 269 is autumn",
  );
  winterWorld.entities.world.stocks.reserve = stock(50, 0, 9999);
  step(winterWorld, rules); // tick 270 — winter begins
  assert.equal(winterWorld.entities.world.stocks.season.value, WINTER);
  assert.equal(
    winterWorld.entities.world.stocks.reserve.value,
    48,
    "winter doubles reserve decay: -2",
  );
});

test("a modifier reshapes a flow with no rule change", () => {
  let world = makeSurvivalWorld();
  world.entities.world.stocks.reserve = stock(90, 0, 100);

  let harshWinter: Modifier = {
    id: "deep-winter",
    kind: "modifier",
    channel: "reserve.decay",
    op: "scale",
    value: 3,
  };

  step(world, [...survivalRules, reserveDrains, harshWinter]);
  // Base decay of 1, scaled x3 by the modifier: 90 -> 87.
  assert.equal(world.entities.world.stocks.reserve.value, 87);
});

// Rule-algebra pacing (Phase 3 of the v2 plan): priority, chance, cooldown,
// and threshold set-conflict policy - all optional and additive, so every
// test above this point (none of which touches these fields) is the control
// group proving the defaults reproduce the historical behavior exactly.

test("priority controls run order within a phase, not array position", () => {
  let world = makeSurvivalWorld();
  world.entities.world.stocks.a = stock(0, 0, 9999);
  world.entities.world.stocks.b = stock(0, 0, 9999);
  // Declared in an order that would give the wrong answer if array position
  // decided run order: "derive-b" reads "a" and is listed FIRST, but must
  // actually run SECOND - only priority (10 beats the unset default of 0)
  // guarantees "set-a" runs before it within the same derived phase.
  let deriveB: DerivedRule = {
    id: "derive-b",
    phase: "derived",
    target: "b",
    value: { mul: [{ stock: "a" }, 2] },
  };
  let setA: DerivedRule = {
    id: "set-a",
    phase: "derived",
    target: "a",
    value: 5,
    priority: 10,
  };
  step(world, [...survivalRules, deriveB, setA]);
  assert.equal(world.entities.world.stocks.a.value, 5);
  assert.equal(
    world.entities.world.stocks.b.value,
    10,
    "derive-b read a's freshly-set value because priority, not declaration order, ran set-a first",
  );
});

test("chance is a seeded, reproducible per-tick gate — not every tick, but replayable", () => {
  let pulseRule = (): ThresholdRule => ({
    id: "maybe-pulse",
    phase: "threshold",
    chance: 0.5,
    do: [{ adjust: { target: "pulses", by: 1 } }],
  });

  function fireTicks(): number[] {
    let world = makeSurvivalWorld();
    world.entities.world.stocks.pulses = stock(0, 0, 9999);
    let fired: number[] = [];
    for (let t = 1; t <= 40; t += 1) {
      let before = world.entities.world.stocks.pulses.value;
      step(world, [...survivalRules, pulseRule()]);
      if (world.entities.world.stocks.pulses.value > before) fired.push(t);
    }
    return fired;
  }

  let first = fireTicks();
  let second = fireTicks();
  assert.deepEqual(
    first,
    second,
    "the same (seed, tick, rule id) address rolls the same fire pattern every time",
  );
  assert.ok(
    first.length > 0 && first.length < 40,
    "chance 0.5 gates some ticks but not none or all, over 40 tries",
  );
});

test("cooldown enforces a minimum tick spacing between firings", () => {
  let world = makeSurvivalWorld();
  world.entities.world.stocks.pulses = stock(0, 0, 9999);
  let pulseRule: ThresholdRule = {
    id: "pulse",
    phase: "threshold",
    cooldown: 5,
    do: [{ adjust: { target: "pulses", by: 1 } }],
  };
  let fired: number[] = [];
  for (let t = 1; t <= 30; t += 1) {
    let before = world.entities.world.stocks.pulses.value;
    step(world, [...survivalRules, pulseRule]);
    if (world.entities.world.stocks.pulses.value > before) fired.push(t);
  }
  assert.deepEqual(
    fired,
    [1, 6, 11, 16, 21, 26],
    "fires immediately, then no sooner than every 5th tick after",
  );
});

test("competing threshold sets on the same stock default to 'override': last to run wins", () => {
  let setLow: ThresholdRule = {
    id: "set-low",
    phase: "threshold",
    do: [{ set: { target: "gauge", to: 3 } }],
  };
  let setHigh: ThresholdRule = {
    id: "set-high",
    phase: "threshold",
    do: [{ set: { target: "gauge", to: 9 } }],
  };

  let world = makeSurvivalWorld();
  world.entities.world.stocks.gauge = stock(0, 0, 9999);
  step(world, [...survivalRules, setLow, setHigh]);
  assert.equal(
    world.entities.world.stocks.gauge.value,
    9,
    "set-high, declared later, overrides set-low",
  );

  let flipped = makeSurvivalWorld();
  flipped.entities.world.stocks.gauge = stock(0, 0, 9999);
  step(flipped, [...survivalRules, setHigh, setLow]);
  assert.equal(
    flipped.entities.world.stocks.gauge.value,
    3,
    "with declaration order flipped, set-low now runs last and wins instead",
  );
});

test("conflict 'highest' tracks the most extreme competing set regardless of run order, but still yields to a plain 'override'", () => {
  let setLow: ThresholdRule = {
    id: "set-low",
    phase: "threshold",
    do: [{ set: { target: "gauge", to: 3 } }],
  };
  let setHighest: ThresholdRule = {
    id: "set-highest",
    phase: "threshold",
    conflict: "highest",
    do: [{ set: { target: "gauge", to: 9 } }],
  };

  let world = makeSurvivalWorld();
  world.entities.world.stocks.gauge = stock(0, 0, 9999);
  step(world, [...survivalRules, setLow, setHighest]);
  assert.equal(
    world.entities.world.stocks.gauge.value,
    9,
    "9 is more extreme than 3, so 'highest' keeps it even though set-highest ran second",
  );

  let flipped = makeSurvivalWorld();
  flipped.entities.world.stocks.gauge = stock(0, 0, 9999);
  step(flipped, [...survivalRules, setHighest, setLow]);
  assert.equal(
    flipped.entities.world.stocks.gauge.value,
    3,
    "an 'override' set still clobbers a prior 'highest' unconditionally when it runs",
  );
});

// The whole stack end to end through the host: join, the one generic
// commitIntent routing to movement or the kernel, and observe() projecting
// geography + generic stocks with no raw coordinates.
test("a full agent loop runs through commitIntent and observe()", () => {
  let engine = makeSurvivalEngine();
  let { id } = engine.addAgent("Ara");

  // A fresh character knows no food source — it explores to find one, which the
  // engine reports as geography (direction + distance), not coordinates. Beeline
  // toward the nearest food tile (read off the omniscient map) so the character
  // finds it before starving.
  let foodTiles = engine
    .getMapTokens()
    .filter((t) => !!t.token && hasTag(t.token, "food"));
  let foodOf = () =>
    engine
      .getObservation(id)
      .known.locations.filter((l) => hasTag(l, "food") && l.distance > 0)
      .sort((a, b) => a.distance - b.distance)[0];
  let food = foodOf();
  for (let i = 0; i < 15 && !food; i += 1) {
    let me = engine.getObservation(id).you.position;
    let target = foodTiles
      .map((t) => ({
        t,
        d: Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y)),
      }))
      .sort((a, b) => a.d - b.d)[0];
    if (!target) break;
    let dir = dirToward(me, target.t);
    if (!dir) break;
    if (engine.commitIntent(id, { type: "explore", direction: dir }).accepted)
      runToIdle(engine, id);
    food = foodOf();
  }
  assert.ok(
    food && typeof food.direction === "string" && food.distance > 0,
    "exploring discovers a food source, reported as geography",
  );

  // Walk to the food source (movement intent -> space subsystem).
  assert.equal(
    engine.commitIntent(id, { type: "travel", location: food!.name }).accepted,
    true,
  );
  runToIdle(engine, id);
  assert.equal(engine.getObservation(id).you.at, food!.name);

  // The camp farm sits a tile from spawn, so the trip barely raised hunger;
  // let it build so the eat has something to ease.
  for (let t = 0; t < 60; t += 1) engine.tick();

  // Gather from the source into the pack (action intent -> kernel commit), then
  // eat from the scenario.
  let remainingOnToken = () => {
    let loc = engine
      .getObservation(id)
      .known.locations.find((l) => l.name === food!.name)!;
    if (!("remaining" in loc) || typeof loc.remaining !== "number")
      throw new Error("source carries no reserve");
    return loc.remaining;
  };
  let reserveBefore = remainingOnToken();
  assert.equal(engine.commitIntent(id, { type: "gather" }).accepted, true);
  runToIdle(engine, id);
  assert.ok(
    reserveBefore - remainingOnToken() > 0.5,
    "gathering drew the source down",
  );
  assert.ok(
    engine.getObservation(id).you.stocks.food.value > 0,
    "the scenario now holds gathered food",
  );

  let hungryBefore = engine.getObservation(id).you.stocks.hunger.value;
  assert.equal(engine.commitIntent(id, { type: "eat" }).accepted, true);
  runToIdle(engine, id);
  assert.ok(
    engine.getObservation(id).you.stocks.hunger.value < hungryBefore,
    "hunger eased by eating from the scenario",
  );

  let admin = engine.getAdminState();
  assert.equal(admin.population, 1);
});
