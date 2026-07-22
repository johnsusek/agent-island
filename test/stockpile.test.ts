import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTag,
  commit,
  step,
  stock,
  setStockpilable,
  type Entity,
  type KernelWorld,
} from "../src/rules/kernel.js";
import {
  addAgentTo,
  loadFixtureOverlay,
  makeBareWorld,
  makeSurvivalEngine,
} from "./helpers.js";

const PLAINS = () => "plains";

// Standalone fixture (test/stockpile.json): found_stockpile/deposit/withdraw
// mechanics in isolation, no map or metabolism dragged in from the shared
// survival fixture. The last two tests below still boot makeSurvivalEngine()
// purely for its side effect of installing the *real* shipped scenario's
// stockpilable set (see setStockpilable) - that's the one thing genuinely
// worth testing against the production config rather than this fixture.
let stockpileOverlay = loadFixtureOverlay("stockpile");
let survivalRules = stockpileOverlay.dynamicRules;
function makeSurvivalWorld() {
  return makeBareWorld(stockpileOverlay);
}
function addAgent(world: ReturnType<typeof makeBareWorld>, id: string) {
  return addAgentTo(world, id, stockpileOverlay);
}

// Drive an agent's committed action to completion (bounded).
function finish(world: KernelWorld, id: string) {
  for (let t = 0; t < 10 && world.entities[id]?.action; t += 1)
    step(world, survivalRules);
}

function firstWithTag(world: KernelWorld, tag: string): Entity | undefined {
  return Object.values(world.entities).find((e) => hasTag(e, tag));
}

// Stand a fresh, empty stockpile on an entity's tile - the state after someone
// has run found_stockpile here.
function pileOn(world: KernelWorld, at: Entity): Entity {
  let pile: Entity = {
    id: "pile",
    tags: ["stockpile"],
    occupancy: "tile",
    stocks: {},
    pos: { ...at.pos! },
  };
  world.entities.pile = pile;
  return pile;
}

test("found_stockpile raises a bare shared pile - a deposit conjures the resource stock", () => {
  setStockpilable(["wood"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");

  assert.equal(firstWithTag(world, "stockpile"), undefined, "none to start");
  assert.equal(
    commit(world, survivalRules, "ara", "found_stockpile", {}, PLAINS).ok,
    true,
  );
  finish(world, "ara");

  let pile = firstWithTag(world, "stockpile");
  assert.ok(pile, "a stockpile entity now exists");
  assert.equal(pile!.occupancy, "tile", "takes ground so it hits the map");
  assert.deepEqual(pile!.pos, ara.pos, "sits on the founder's tile");
  assert.deepEqual(pile!.stocks, {}, "starts empty, not wood-flavoured");
});

test("deposit hauls a whole load of the named resource onto a colocated pile", () => {
  setStockpilable(["wood"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.wood = stock(7, 0, 25);
  let pile = pileOn(world, ara);

  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "wood" }, PLAINS).ok,
    true,
    "commits standing on the pile with wood in hand",
  );
  finish(world, "ara");

  assert.equal(ara.stocks.wood.value, 0, "the whole load left the scenario");
  assert.equal(pile.stocks.wood.value, 7, "and landed on the pile");
  assert.equal(pile.stocks.wood.max, 20, "the pile holds at most 20");
});

test("deposit fills only the pile's remaining capacity without losing overflow", () => {
  setStockpilable(["wood"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.wood = stock(9, 0, 25);
  let pile = pileOn(world, ara);
  pile.stocks.wood = stock(17, 0, 20);

  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "wood" }, PLAINS).ok,
    true,
  );
  finish(world, "ara");

  assert.equal(pile.stocks.wood.value, 20);
  assert.equal(ara.stocks.wood.value, 6, "overflow remains in the pack");
});

test("deposit refuses a different resource until the pile is empty", () => {
  setStockpilable(["wood", "food"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.food = stock(5, 0, 12);
  let pile = pileOn(world, ara);
  pile.stocks.wood = stock(4, 0, 20);

  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "food" }, PLAINS).ok,
    false,
  );
  assert.equal(ara.stocks.food.value, 5);
  assert.equal(pile.stocks.food, undefined);

  pile.stocks.wood.value = 0;
  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "food" }, PLAINS).ok,
    true,
    "an empty pile can be repurposed",
  );
});

test("simultaneous deposits cannot mix resource types", () => {
  setStockpilable(["wood", "food"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  let bram = addAgent(world, "bram");
  bram.pos = { ...ara.pos! };
  ara.stocks.wood = stock(5, 0, 25);
  bram.stocks.food = stock(5, 0, 12);
  let pile = pileOn(world, ara);

  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "wood" }, PLAINS).ok,
    true,
  );
  assert.equal(
    commit(world, survivalRules, "bram", "deposit", { item: "food" }, PLAINS)
      .ok,
    true,
  );

  finish(world, "ara");

  let storedTypes = Object.entries(pile.stocks).filter(
    ([, stored]) => stored.value > 0,
  );
  assert.equal(storedTypes.length, 1);
  assert.equal(
    ara.stocks.wood.value + bram.stocks.food.value,
    5,
    "the rejected load remains carried",
  );
});

test("deposit refuses a vital gauge - a resource the ruleset never marked stockpilable", () => {
  setStockpilable(["wood"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  pileOn(world, ara);
  // Hunger is carried like any stock and Ara has plenty of it, but it is not
  // stockpilable, so deposit must not let it be dumped away for a free reset.
  ara.stocks.hunger = stock(60, 0, 100);

  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "hunger" }, PLAINS)
      .ok,
    false,
    "can't dump a gauge into the pile",
  );
  assert.equal(ara.stocks.hunger.value, 60, "hunger untouched");
});

test("withdraw takes the whole pile when it fits in the scenario", () => {
  setStockpilable(["wood"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.wood = stock(0, 0, 25);
  let pile = pileOn(world, ara);
  pile.stocks.wood = stock(5, 0, 9999);

  assert.equal(
    commit(world, survivalRules, "ara", "withdraw", { item: "wood" }, PLAINS)
      .ok,
    true,
  );
  finish(world, "ara");

  assert.equal(ara.stocks.wood.value, 5, "the whole pile came into the pack");
  assert.equal(pile.stocks.wood.value, 0, "and the pile is empty");
});

test("withdraw takes only what fits and never leaks the overflow", () => {
  setStockpilable(["wood"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.wood = stock(20, 0, 25); // 5 room left under the carry cap
  let pile = pileOn(world, ara);
  pile.stocks.wood = stock(100, 0, 9999);

  assert.equal(
    commit(world, survivalRules, "ara", "withdraw", { item: "wood" }, PLAINS)
      .ok,
    true,
  );
  finish(world, "ara");

  assert.equal(
    ara.stocks.wood.value,
    25,
    "filled to the carry cap, no further",
  );
  assert.equal(pile.stocks.wood.value, 95, "only the 5 that fit left the pile");
  // The whole point of headroom-bounded transfer: nothing vanished.
  assert.equal(
    ara.stocks.wood.value + pile.stocks.wood.value,
    120,
    "wood conserved - the overflow was not destroyed",
  );
});

test("withdraw is refused when the pack is already full", () => {
  setStockpilable(["wood"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.wood = stock(25, 0, 25); // no headroom
  let pile = pileOn(world, ara);
  pile.stocks.wood = stock(40, 0, 9999);

  assert.equal(
    commit(world, survivalRules, "ara", "withdraw", { item: "wood" }, PLAINS)
      .ok,
    false,
    "no room in the scenario, so the take is refused rather than leaking",
  );
  assert.equal(pile.stocks.wood.value, 40, "pile untouched");
});

test("deposit then withdraw round-trips the same wood", () => {
  setStockpilable(["wood"]);
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.wood = stock(9, 0, 25);
  let pile = pileOn(world, ara);

  commit(world, survivalRules, "ara", "deposit", { item: "wood" }, PLAINS);
  finish(world, "ara");
  assert.equal(pile.stocks.wood.value, 9, "the load is on the pile");
  assert.equal(ara.stocks.wood.value, 0, "and out of the scenario");

  commit(world, survivalRules, "ara", "withdraw", { item: "wood" }, PLAINS);
  finish(world, "ara");
  assert.equal(ara.stocks.wood.value, 9, "and comes straight back out");
  assert.equal(pile.stocks.wood.value, 0, "leaving the pile empty");
});

test("food rides the stockpile too, now that it is a carryable resource", () => {
  makeSurvivalEngine(); // installs the real stockpilable set: wood and food
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.food = stock(5, 0, 12); // a scenario of gathered rations
  let pile = pileOn(world, ara);

  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "food" }, PLAINS).ok,
    true,
    "gathered food can be stockpiled",
  );
  finish(world, "ara");
  assert.equal(pile.stocks.food.value, 5, "rations landed on the pile");
  assert.equal(ara.stocks.food.value, 0, "and left the scenario");

  assert.equal(
    commit(world, survivalRules, "ara", "withdraw", { item: "food" }, PLAINS)
      .ok,
    true,
  );
  finish(world, "ara");
  assert.equal(ara.stocks.food.value, 5, "and can be drawn back out to eat");
});

test("wood flows from the scenario flag through the engine into a real deposit", () => {
  // Booting the full layered game installs the stockpilable set from the real
  // config (the survival scenario flags wood) - no hand-set list here.
  makeSurvivalEngine();
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.wood = stock(4, 0, 25);
  pileOn(world, ara);

  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "wood" }, PLAINS).ok,
    true,
    "wood is stockpilable by the scenario's own authoring",
  );
  assert.equal(
    commit(world, survivalRules, "ara", "deposit", { item: "energy" }, PLAINS)
      .ok,
    false,
    "energy, a gauge, is not",
  );
});
