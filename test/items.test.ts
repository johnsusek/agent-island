// Items, containers, carrying, and "using" — proving the colony-sim fundamentals
// fall out of the existing scalar-stock model once the kernel can (a) transfer
// into a destination stock an entity has never held, as long as the ruleset has
// declared that resource somewhere (see setKnownStocks in kernel.ts - the
// closed-namespace guard), so a character can receive a resource type its
// template never listed without every fresh name being mistaken for a typo, and
// (b) spawn/destroy entities, so a rule can drop a crate, raise a campfire, or
// consume a one-shot. `adjust`/`set` are strict everywhere, by contrast: an
// increment or assignment names an exact target the rule author chose, so a
// missing one is treated as the authoring error it almost always is (see
// "adjust rejects a stock the entity was never given" below) rather than
// silently minted. No per-instance item identity is involved: an item is a
// count in a stock, an inventory is an entity's stocks, a container is just
// another entity, and a recipe is a multi-effect action.

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTag,
  commit,
  step,
  stock,
  type Entity,
  type KernelWorld,
  type Rule,
} from "@agent-island/core/kernel";
import { knownTokens, syncTokens, tileAt } from "@agent-island/core/space";
import { createWorld } from "@agent-island/engine/engine";
import {
  makeSurvivalSpace,
  makeSurvivalWorld,
  spawnAgent,
  TEST_SPAWN,
  makeSurvivalEngine,
  survivalScenario,
} from "./helpers.js";

// The camp cluster now occupies several tiles beside spawn, so a test that
// conjures a structure next to spawn must pick a tile whose token slot is free.
function freeTileBeside(
  engine: ReturnType<typeof createWorld>,
  spawn: { x: number; y: number },
): { x: number; y: number } {
  let tiles = engine.getMap().tiles;
  let occupied = new Set(engine.getMapTokens().map((t) => `${t.x},${t.y}`));
  for (let dy = -1; dy <= 1; dy += 1)
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      let x = spawn.x + dx;
      let y = spawn.y + dy;
      let tile = tiles.find((t: any) => t.x === x && t.y === y);
      if (tile && !occupied.has(`${x},${y}`)) return { x, y };
    }
  throw new Error("no free tile beside spawn");
}

// A bare world: the required "world" singleton plus a character standing at the
// origin with nothing in its (empty) inventory. No stock vocabulary is passed
// to the kernel calls here (unlike a real engine, which always passes one - see
// engine.ts syncKnownStocks), so writes run in the lenient "no registry
// configured" mode.
function makeWorld(): KernelWorld {
  let entities: Record<string, Entity> = {
    world: { id: "world", tags: ["world"], stocks: {} },
    ara: {
      id: "ara",
      tags: ["agent"],
      stocks: {},
      pos: { x: 0, y: 0 },
      action: null,
    },
  };
  return { tick: 0, entities };
}

// Drive a committed action to completion (every action below is duration 1),
// returning the tick's events so a caller can inspect a rule_error.
function finish(world: KernelWorld, rules: Rule[]) {
  return step(world, rules);
}

// forage: carry an item into your own inventory.
const forage: Rule = {
  id: "forage",
  kind: "action",
  duration: 1,
  do: [{ adjust: { target: "berries", by: 5 } }],
};

test("carrying: adjust rejects a stock the entity was never given", () => {
  let world = makeWorld();
  assert.ok(!("berries" in world.entities.ara.stocks), "starts with none");

  // Committing only checks `requires` (forage has none); the missing stock
  // surfaces when the body actually runs, at completion.
  assert.equal(commit(world, [forage], "ara", "forage").ok, true);
  let events = finish(world, [forage]);

  let err = events.find((e) => e.type === "rule_error");
  assert.ok(err, "a rule_error was recorded instead of a silent mint");
  assert.equal(
    world.entities.ara.stocks.berries,
    undefined,
    "no phantom stock was created",
  );
});

test("carrying: an action fills an inventory stock the entity already declares", () => {
  let world = makeWorld();
  // "berries" must already exist - see the strict-write doctrine above - so
  // declare it (at zero) the way a real template or a prior spawn would.
  world.entities.ara.stocks.berries = stock(0, 0, 9999);

  assert.equal(commit(world, [forage], "ara", "forage").ok, true);
  finish(world, [forage]);

  assert.equal(world.entities.ara.stocks.berries.value, 5, "5 berries carried");
});

// store: move items from your inventory into a colocated container. The
// crate's "berries" stock is conjured on first deposit - a transfer's
// destination still vivifies (see kernel.ts ensureStock), gated on the
// known-stock registry when one is installed; this bare-kernel world never
// installs one (see makeWorld), so it stays lenient here.
const store: Rule = {
  id: "store",
  kind: "action",
  duration: 1,
  requires: { colocated: { tag: "container" } },
  do: [
    {
      transfer: {
        from: { stock: "berries", of: "self" },
        to: { stock: "berries", of: { colocated: "container" } },
        amount: 2,
      },
    },
  ],
};

test("containers: items transfer from inventory into a colocated container entity", () => {
  let world = makeWorld();
  world.entities.crate = {
    id: "crate",
    tags: ["container"],
    stocks: {},
    pos: { x: 0, y: 0 },
  };
  world.entities.ara.stocks.berries = stock(5, 0, 9999);

  assert.equal(commit(world, [store], "ara", "store").ok, true);
  finish(world, [store]);

  assert.equal(
    world.entities.ara.stocks.berries.value,
    3,
    "2 left the scenario",
  );
  assert.equal(world.entities.crate.stocks.berries.value, 2, "2 in the crate");
});

// craft / "use": a recipe is one action whose `do` consumes inputs and produces
// an output. The requires gate is the "you have the ingredients" check.
const cook: Rule = {
  id: "cook",
  kind: "action",
  duration: 1,
  requires: {
    all: [
      { cmp: "gte", left: { stock: "berries" }, right: 2 },
      { cmp: "gte", left: { stock: "sugar" }, right: 1 },
    ],
  },
  do: [
    { adjust: { target: "berries", by: -2 } },
    { adjust: { target: "sugar", by: -1 } },
    { adjust: { target: "jam", by: 1 } },
  ],
};

test("using items / recipes: a multi-effect action consumes inputs and yields an output", () => {
  let world = makeWorld();
  world.entities.ara.stocks.berries = stock(5, 0, 9999);
  world.entities.ara.stocks.sugar = stock(1, 0, 9999);
  // "jam" is an adjust target (strict, never vivifies) - declare it, the way
  // a real recipe's output stock would already ride the character's template.
  world.entities.ara.stocks.jam = stock(0, 0, 9999);

  assert.equal(
    commit(world, [cook], "ara", "cook").ok,
    true,
    "has ingredients",
  );
  finish(world, [cook]);

  assert.equal(world.entities.ara.stocks.berries.value, 3, "2 berries spent");
  assert.equal(world.entities.ara.stocks.sugar.value, 0, "1 sugar spent");
  assert.equal(world.entities.ara.stocks.jam.value, 1, "1 jam produced");

  // With the sugar gone the recipe no longer commits — the gate is the check.
  assert.equal(commit(world, [cook], "ara", "cook").ok, false, "out of sugar");
});

// build: an action that spawns a new entity (a campfire) on the actor's tile,
// where it is immediately colocation-matchable like any token.
const build: Rule = {
  id: "build",
  kind: "action",
  duration: 1,
  do: [
    {
      spawn: {
        idPrefix: "campfire",
        tags: ["structure", "campfire"],
        stocks: { fuel: { value: 0, max: 100 } },
      },
    },
  ],
};

// dismantle: destroy the campfire you're standing on.
const dismantle: Rule = {
  id: "dismantle",
  kind: "action",
  duration: 1,
  requires: { colocated: { tag: "campfire" } },
  do: [{ destroy: { of: { colocated: "campfire" } } }],
};

test("spawn/destroy: a rule raises a structure on a tile, then removes it", () => {
  let world = makeWorld();

  assert.equal(commit(world, [build], "ara", "build").ok, true);
  finish(world, [build]);

  let fire = Object.values(world.entities).find((e) => hasTag(e, "campfire"));
  assert.ok(fire, "a campfire entity now exists");
  assert.equal(fire!.id, "campfire-1", "auto-minted id");
  assert.deepEqual(fire!.pos, { x: 0, y: 0 }, "spawned on the actor's tile");
  assert.equal(fire!.stocks.fuel.value, 0, "with its declared stocks");

  assert.equal(
    commit(world, [dismantle], "ara", "dismantle").ok,
    true,
    "colocated with it",
  );
  finish(world, [dismantle]);
  assert.equal(
    Object.values(world.entities).some((e) => hasTag(e, "campfire")),
    false,
    "the campfire is gone",
  );
});

test("space bridge: syncTokens projects a spawned entity onto the grid and removes a destroyed one", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();
  spawnAgent(space, "ara"); // reveals a radius-3 patch around the spawn clearing
  let { x: cx, y: cy } = TEST_SPAWN;

  // A campfire conjured on an empty, already-revealed tile beside the spawn.
  world.entities.campfire = {
    id: "campfire",
    tags: ["campfire"],
    occupancy: "tile" as const, // takes ground, so it lands on the map
    stocks: {},
    pos: { x: cx + 1, y: cy },
  };
  syncTokens(space, world);

  assert.equal(
    tileAt(space.grid, cx + 1, cy).token?.name,
    "campfire",
    "the tile now carries the token",
  );
  assert.ok(
    knownTokens(space, "ara", { x: cx, y: cy }, 0).some(
      (s) => s.name === "campfire",
    ),
    "and it's discoverable (the tile was revealed at spawn)",
  );

  world.entities.campfire.tags = ["shelter"];
  syncTokens(space, world);
  assert.deepEqual(
    tileAt(space.grid, cx + 1, cy).token?.tags,
    ["shelter"],
    "retagging the entity refreshes the visible token",
  );
  assert.ok(
    knownTokens(space, "ara", { x: cx, y: cy }, 0).some((token) =>
      hasTag(token, "shelter"),
    ),
    "known tokens use the refreshed tags",
  );

  // Razing it removes it from both the grid token list and the tile.
  delete world.entities.campfire;
  syncTokens(space, world);
  assert.equal(tileAt(space.grid, cx + 1, cy).token, null, "tile slot freed");
  assert.equal(
    space.grid.tokens.some((s) => s.name === "campfire"),
    false,
    "dropped from the grid tokens",
  );
});

test("space bridge: one token per tile — a structure on an occupied tile stays off the grid", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();

  // A food source already owns its tile. A totem dropped on top of it.
  let meadow = space.grid.tokens.find((s) => hasTag(s, "food"))!;
  world.entities.totem = {
    id: "totem",
    tags: ["totem"],
    occupancy: "tile",
    stocks: {},
    pos: { x: meadow.x, y: meadow.y },
  };
  syncTokens(space, world);

  assert.equal(
    tileAt(space.grid, meadow.x, meadow.y).token?.name,
    meadow.name,
    "the food source keeps the tile",
  );
  assert.equal(
    space.grid.tokens.some((s) => s.name === "totem"),
    false,
    "the totem isn't separately registered (but still exists as an entity)",
  );
  assert.ok(world.entities.totem, "the entity is untouched");
});

test("host bridge: a GM-conjured structure shows on the map and in known locations", () => {
  let engine = makeSurvivalEngine();
  let { id } = engine.addAgent("Ara"); // at the spawn clearing, perceives radius 3
  let { x, y } = freeTileBeside(engine, survivalScenario.spawn);

  engine.spawnEntity({
    id: "watchtower",
    tags: ["watchtower"],
    occupancy: "tile",
    pos: { x, y },
  });

  let onMap = engine.getMapTokens().find((t) => t.x === x && t.y === y)
    ?.token?.name;
  assert.equal(onMap, "watchtower", "the map renders the new structure");

  assert.ok(
    engine
      .getObservation(id)
      .known.locations.some((l) => l.name === "watchtower"),
    "and the character can see it among known locations",
  );
});

test("GM spawn: occupancy carves a token onto the grid", () => {
  let engine = makeSurvivalEngine();
  let { id } = engine.addAgent("Ara");
  let { x, y } = freeTileBeside(engine, survivalScenario.spawn);

  let result = engine.spawnEntity({
    id: "well",
    occupancy: "tile" as const,
    pos: { x, y },
  });

  assert.equal(result.entity.occupancy, "tile", "the entity takes ground");
  assert.equal(result.onMap, true, "and it lands on the grid");
  assert.ok(
    engine.getObservation(id).known.locations.some((l) => l.name === "well"),
    "the character (standing beside it) can route to it",
  );
});

test("GM spawn: reveal:true makes a far token known immediately, otherwise it stays fogged", () => {
  let { x: sx, y: sy } = survivalScenario.spawn;
  // A far, empty tile the character won't have revealed at spawn (radius 3).
  // Discovery needs only fog + a grid token, so passability is irrelevant here.
  let probe = makeSurvivalEngine();
  let occupied = new Set(probe.getMapTokens().map((t) => `${t.x},${t.y}`));
  let far = probe
    .getMap()
    .tiles.find(
      (t) =>
        !occupied.has(`${t.x},${t.y}`) &&
        Math.max(Math.abs(t.x - sx), Math.abs(t.y - sy)) > 4,
    );
  assert.ok(far, "found a far empty tile to plant a token on");

  // Without reveal: on the map, but fogged - the character can't see it yet.
  let hidden = makeSurvivalEngine();
  let a = hidden.addAgent("Ara").id;
  let r1 = hidden.spawnEntity({
    id: "cache",
    occupancy: "tile" as const,
    pos: { x: far!.x, y: far!.y },
  });
  assert.equal(r1.onMap, true);
  assert.deepEqual(r1.revealedTo, [], "reveal not requested");
  assert.equal(
    hidden.getObservation(a).known.locations.some((l) => l.name === "cache"),
    false,
    "a far token stays hidden by fog",
  );

  // With reveal: known to the colony the moment it's placed.
  let shown = makeSurvivalEngine();
  let b = shown.addAgent("Bo").id;
  let r2 = shown.spawnEntity({
    id: "cache",
    occupancy: "tile" as const,
    reveal: true,
    pos: { x: far!.x, y: far!.y },
  });
  assert.deepEqual(r2.revealedTo, [b], "revealed to every character");
  assert.ok(
    shown.getObservation(b).known.locations.some((l) => l.name === "cache"),
    "and the character can now route to it",
  );
});

test("GM spawn: a token on an occupied tile reports onMap:false instead of silently dropping", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  let { x: cx, y: cy } = survivalScenario.spawn;

  engine.spawnEntity({
    id: "first",
    occupancy: "tile" as const,
    pos: { x: cx + 1, y: cy },
  });
  let second = engine.spawnEntity({
    id: "second",
    occupancy: "tile" as const,
    pos: { x: cx + 1, y: cy },
  });

  assert.equal(second.onMap, false, "the tile already showed a token");
  assert.equal(second.entity.id, "second", "but the entity still exists");
  assert.throws(
    () => engine.spawnEntity({ id: "second" }),
    /already exists/,
    "really registered, just not on the map",
  );
});

test("space bridge: a corpse does not become a map token when an agent dies", () => {
  let engine = makeSurvivalEngine();
  let { id } = engine.addAgent("Ara");

  // Starve first so the fed-recovery rule won't heal Ara back above zero, then
  // bottom out health: the death rule strips the "agent" tag next tick.
  engine.setStock(id, "satiation", 0);
  engine.setStock(id, "health", 0);
  engine.tick();

  assert.equal(engine.isAlive(id), false, "Ara has died");
  assert.equal(
    engine.getMapTokens().some((t) => t.token?.name === id),
    false,
    "the corpse is not projected as a token (it lacks the 'token' tag)",
  );
});

test("structural effects in a buffered phase degrade to a rule_error, not a tick crash", () => {
  let world = makeWorld();
  let badFlow: Rule = {
    id: "bad",
    phase: "threshold",
    each: { tag: "agent" },
    do: [{ destroy: { of: "self" } }],
  };
  // The runtime guard still refuses to run a structural effect in a buffered
  // phase, but fault isolation (#8) turns that refusal into a structured
  // rule_error for the offending (rule, entity) pair instead of unwinding the
  // whole tick. (validateRule is the at-add-time gate that normally stops such a
  // rule before it ever ticks; this is the defense-in-depth backstop.)
  let events = step(world, [badFlow]);
  let err = events.find((e) => e.type === "rule_error");
  assert.ok(err, "a rule_error event was recorded");
  assert.equal(err!.args?.rule, "bad", "the failing rule is named");
  assert.match(err!.text ?? "", /structural effects/, "the cause is reported");
});
