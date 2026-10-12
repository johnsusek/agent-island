// Held items: discrete item entities a character carries via Entity.heldBy,
// with their own stocks and identity - the counterpart to a fungible stock
// count. Covers the kernel machinery (the `held` selector, the `holds`
// condition, `take`/`release`/`spawn.heldBy` effects, destroy-releases) and
// the host verbs (pick_up/drop, drop-on-death, the Carrying prose).

import assert from "node:assert/strict";
import test from "node:test";

import {
  commit,
  step,
  stock,
  type Entity,
  type KernelWorld,
  type Rule,
} from "@agent-island/core/kernel";
import { describeSense } from "../src/sense-prose.js";
import { makeSurvivalEngine, placeAt, TEST_SPAWN } from "./helpers.js";

// A bare world with a character and a loose axe on the same tile.
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
    axe: {
      id: "axe",
      kind: "axe",
      tags: ["portable"],
      occupancy: "tile",
      stocks: { durability: stock(10, 0, 10) },
      pos: { x: 0, y: 0 },
    },
  };
  return { tick: 0, entities };
}

test("kernel: a take effect moves an item into a hand, off the grid", () => {
  let world = makeWorld();
  let grab: Rule = {
    id: "grab",
    kind: "action",
    duration: 1,
    do: [{ take: { item: "axe" } }],
  };

  assert.equal(commit(world, [grab], "ara", "grab").ok, true);
  step(world, [grab]);

  assert.equal(world.entities.axe.heldBy, "ara", "the axe is now held");
  assert.equal(world.entities.axe.pos, undefined, "and off the grid");
  assert.equal(world.entities.axe.occupancy, undefined, "holding no tile");
});

test("kernel: a held selector resolves the item, and adjusts its own stocks", () => {
  let world = makeWorld();
  world.entities.axe.heldBy = "ara";
  world.entities.axe.pos = undefined;
  delete world.entities.axe.occupancy;

  // An action that reads/writes through `{held}`: chop dulls the held axe.
  let chop: Rule = {
    id: "chop",
    kind: "action",
    duration: 1,
    requires: { holds: { kind: "axe" } },
    do: [
      {
        adjust: { target: "durability", of: { held: { kind: "axe" } }, by: -3 },
      },
    ],
  };

  assert.equal(commit(world, [chop], "ara", "chop").ok, true);
  step(world, [chop]);
  assert.equal(world.entities.axe.stocks.durability.value, 7, "the axe dulled");
});

test("kernel: a holds condition gates on what an entity is carrying", () => {
  let world = makeWorld();
  let chop: Rule = {
    id: "chop",
    kind: "action",
    duration: 1,
    requires: { holds: { kind: "axe" } },
    do: [
      {
        adjust: { target: "durability", of: { held: { kind: "axe" } }, by: -1 },
      },
    ],
  };

  // Axe on the ground, not in hand: the holds gate refuses.
  assert.equal(
    commit(world, [chop], "ara", "chop").ok,
    false,
    "not holding it",
  );

  world.entities.axe.heldBy = "ara";
  world.entities.axe.pos = undefined;
  assert.equal(commit(world, [chop], "ara", "chop").ok, true, "now holding it");
});

test("kernel: a release effect drops a held item back onto the tile", () => {
  let world = makeWorld();
  world.entities.axe.heldBy = "ara";
  world.entities.axe.pos = undefined;
  delete world.entities.axe.occupancy;

  let letGo: Rule = {
    id: "let_go",
    kind: "action",
    duration: 1,
    do: [{ release: { item: "axe" } }],
  };
  assert.equal(commit(world, [letGo], "ara", "let_go").ok, true);
  step(world, [letGo]);

  assert.equal(world.entities.axe.heldBy, undefined, "no longer held");
  assert.deepEqual(world.entities.axe.pos, { x: 0, y: 0 }, "back on the tile");
  assert.equal(world.entities.axe.occupancy, "tile", "re-takes ground");
});

test("kernel: spawn.heldBy crafts an item straight into a hand", () => {
  let world = makeWorld();
  delete world.entities.axe; // start empty-handed
  let craft: Rule = {
    id: "craft_torch",
    kind: "action",
    duration: 1,
    do: [
      {
        spawn: {
          kind: "torch",
          tags: ["portable"],
          heldBy: "self",
          stocks: { fuel: { value: 100, max: 100 } },
        },
      },
    ],
  };

  assert.equal(commit(world, [craft], "ara", "craft_torch").ok, true);
  step(world, [craft]);

  let torch = Object.values(world.entities).find((e) => e.kind === "torch");
  assert.ok(torch, "a torch entity now exists");
  assert.equal(torch!.heldBy, "ara", "crafted into the actor's hand");
  assert.equal(torch!.pos, undefined, "off the grid");
});

test("kernel: destroying a holder releases what it held onto its tile", () => {
  let world = makeWorld();
  world.entities.axe.heldBy = "ara";
  world.entities.axe.pos = undefined;
  delete world.entities.axe.occupancy;

  let vanish: Rule = {
    id: "vanish",
    kind: "action",
    duration: 1,
    do: [{ destroy: { of: "self" } }],
  };
  assert.equal(commit(world, [vanish], "ara", "vanish").ok, true);
  step(world, [vanish]);

  assert.equal(world.entities.ara, undefined, "the holder is gone");
  assert.equal(world.entities.axe.heldBy, undefined, "the axe was released");
  assert.deepEqual(
    world.entities.axe.pos,
    { x: 0, y: 0 },
    "onto the holder's tile",
  );
});

// Taking puts an entity off-grid and reachable only through its holder, so a
// take that would strand something has to be refused where it is attempted.
// These are god-DSL authoring slips rather than player moves, but each one is
// silent and permanent without the guard.
test("kernel: a take that would strand an entity is refused", () => {
  let cases: { id: string; take: Rule; expect: RegExp }[] = [
    {
      id: "take_world",
      take: {
        id: "take_world",
        kind: "action",
        duration: 1,
        do: [{ take: { item: "world" } }],
      },
      expect: /world entity cannot be held/,
    },
    {
      id: "take_self",
      take: {
        id: "take_self",
        kind: "action",
        duration: 1,
        do: [{ take: { item: "self" } }],
      },
      expect: /cannot hold itself/,
    },
  ];

  for (let { id, take, expect } of cases) {
    let world = makeWorld();
    assert.equal(commit(world, [take], "ara", id).ok, true);
    let events = step(world, [take]);
    let err = events.find((e) => e.type === "rule_error");
    assert.ok(err, `${id}: a rule_error was recorded`);
    assert.match(err!.text ?? "", expect);
    assert.equal(
      world.entities.ara.pos !== undefined,
      true,
      `${id}: still on the grid`,
    );
  }
});

test("kernel: a take that would close a holding cycle is refused", () => {
  let world = makeWorld();
  // Ara is already held BY the axe (an odd state, but one a rule can reach).
  // Ara taking the axe back would close the loop and leave both positionless,
  // with nothing on the grid able to reach either again.
  world.entities.ara.heldBy = "axe";
  world.entities.ara.pos = undefined;

  let grab: Rule = {
    id: "grab_back",
    kind: "action",
    duration: 1,
    do: [{ take: { item: "axe" } }],
  };
  assert.equal(commit(world, [grab], "ara", "grab_back").ok, true);
  let events = step(world, [grab]);

  let err = events.find((e) => e.type === "rule_error");
  assert.ok(err, "a rule_error was recorded instead of a silent cycle");
  assert.match(err!.text ?? "", /already held/);
  assert.equal(world.entities.axe.heldBy, undefined, "the cycle never formed");
});

// --- host verbs ---------------------------------------------------------

// Spawn a portable axe fixture beside the spawn tile and return its id.
function spawnAxe(
  engine: ReturnType<typeof makeSurvivalEngine>,
  at: { x: number; y: number },
) {
  engine.spawnEntity({
    id: "axe-1",
    kind: "axe",
    tags: ["portable"],
    occupancy: "tile",
    pos: at,
    icon: "battle-axe",
    color: "#9a7b4f",
  });
  return "axe-1";
}

test("host: pick_up in reach takes the item off the map into the hand", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let p = engine.getObservation(ara).you.position;
  let axe = spawnAxe(engine, { x: p.x + 1, y: p.y });

  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "pick_up", item: axe }],
  });
  engine.tick();

  assert.equal(engine.getOrder(ara).order?.status, "completed");
  let held = engine.getObservation(ara).you.held;
  assert.ok(
    held.some((h: any) => h.id === axe),
    "the axe is now in hand",
  );
  assert.equal(
    engine.getMapTokens().some((t: any) => t.token?.name === axe),
    false,
    "and gone from the map",
  );
});

test("host: take/grab aliases resolve to pick_up", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let p = engine.getObservation(ara).you.position;
  let axe = spawnAxe(engine, { x: p.x + 1, y: p.y });

  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "grab", item: axe }],
  });
  engine.tick();
  assert.equal(engine.getOrder(ara).order?.status, "completed");
  assert.ok(
    engine.getObservation(ara).you.held.some((h: any) => h.id === axe),
    "grab picked it up",
  );
});

test("host: pick_up walks to an out-of-reach item, then takes it", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  placeAt(engine, ara, TEST_SPAWN.x - 4, TEST_SPAWN.y);
  engine.tick(); // perceive from the new position
  let axe = spawnAxe(engine, { x: TEST_SPAWN.x, y: TEST_SPAWN.y });

  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "pick_up", item: axe }],
  });
  for (
    let i = 0;
    i < 40 && engine.getOrder(ara).order?.status === "running";
    i += 1
  )
    engine.tick();

  assert.equal(engine.getOrder(ara).order?.status, "completed");
  assert.ok(
    engine.getObservation(ara).you.held.some((h: any) => h.id === axe),
    "the axe was reached and taken",
  );
});

test("host: drop puts a held item back on the map where the actor stands", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let p = engine.getObservation(ara).you.position;
  let axe = spawnAxe(engine, { x: p.x + 1, y: p.y });
  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "pick_up", item: axe }],
  });
  engine.tick();

  // Now standing wherever the walk ended; drop it there.
  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "drop", item: axe }],
  });
  engine.tick();

  assert.equal(engine.getOrder(ara).order?.status, "completed");
  assert.equal(
    engine.getObservation(ara).you.held.some((h: any) => h.id === axe),
    false,
    "no longer in hand",
  );
  assert.ok(
    engine.getMapTokens().some((t: any) => t.token?.name === axe),
    "back on the map as a token",
  );
});

test("host: a character drops everything they hold when they die", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let p = engine.getObservation(ara).you.position;
  let axe = spawnAxe(engine, { x: p.x + 1, y: p.y });
  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "pick_up", item: axe }],
  });
  engine.tick();
  assert.ok(
    engine.getObservation(ara).you.held.some((h: any) => h.id === axe),
    "holding the axe before death",
  );

  let deathPos = engine.getObservation(ara).you.position;
  // Starve, then bottom out health so the death rule strips the agent tag.
  engine.setStock(ara, "satiation", 0);
  engine.setStock(ara, "health", 0);
  engine.tick();

  assert.equal(engine.isAlive(ara), false, "Ara has died");
  let token = engine.getMapTokens().find((t: any) => t.token?.name === axe);
  assert.ok(token, "the axe dropped to the ground on death");
  assert.equal(token!.x, deathPos.x, "on the corpse's tile (x)");
  assert.equal(token!.y, deathPos.y, "on the corpse's tile (y)");
});

test("host: the Carrying line lists a held item alongside pack figures", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let p = engine.getObservation(ara).you.position;
  let axe = spawnAxe(engine, { x: p.x + 1, y: p.y });
  engine.setStock(ara, "wood", 4);
  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "pick_up", item: axe }],
  });
  engine.tick();

  // The character prose is the whole message - pull it through the same
  // renderer the character tool surface uses.
  let text = describeSense(engine.sense(ara, "situation"));
  assert.match(text, /Carrying:.*axe/, "the held axe is named");
  assert.match(text, /wood 4/, "the pack figure rides the same line");
});

test("snapshot: a held item survives restore", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let p = engine.getObservation(ara).you.position;
  let axe = spawnAxe(engine, { x: p.x + 1, y: p.y });
  engine.setOrder(ara, {
    kind: "sequence",
    steps: [{ type: "pick_up", item: axe }],
  });
  engine.tick();

  let snap = engine.snapshot();
  let fresh = makeSurvivalEngine();
  assert.equal(fresh.restore(snap), true);
  assert.ok(
    fresh.getObservation(ara).you.held.some((h: any) => h.id === axe),
    "the held axe rode the snapshot",
  );
});
