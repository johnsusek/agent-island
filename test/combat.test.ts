import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTag,
  commit,
  step,
  stock,
  type Entity,
} from "@agent-island/core/kernel";
import { addAgentTo, loadFixtureOverlay, makeBareWorld } from "./helpers.js";

const PLAINS = () => "plains";

// Standalone fixture (test/combat.json): fight/butcher mechanics in isolation,
// no map or metabolism dragged in from the shared survival fixture.
let combatOverlay = loadFixtureOverlay("combat");
let survivalRules = combatOverlay.dynamicRules;
function makeSurvivalWorld() {
  return makeBareWorld(combatOverlay);
}
function addAgent(world: ReturnType<typeof makeBareWorld>, id: string) {
  return addAgentTo(world, id, combatOverlay);
}

function wolfAt(pos: { x: number; y: number }): Entity {
  return {
    id: "wolf",
    kind: "predator",
    tags: [],
    // "food" mirrors the real predator scatter spec (test/survival.json) -
    // predator-dies `set`s it to 10 on death, which is now strict (see
    // kernel.ts requireStock) and needs the stock declared up front, exactly
    // like a worldgen-scattered wolf carries it from birth.
    stocks: { health: stock(16, 0, 16), food: stock(0, 0, 9999) },
    pos: { ...pos },
    action: null,
  };
}

test("a fight whose beast dies mid-swing fizzles cleanly instead of erroring", () => {
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  world.entities.wolf = wolfAt(ara.pos!);

  assert.equal(
    commit(world, survivalRules, "ara", "fight", {}, PLAINS).ok,
    true,
  );

  // Another fighter (played here by the test) downs the beast before ara's
  // 3-tick swing lands: predator-dies retags it to a carcass, so at completion
  // the fizzle's "no living beast left here" check must catch it - the old
  // stock-read form threw on the vanished selector instead.
  let events = [...step(world, survivalRules)];
  world.entities.wolf.stocks.health.value = 0;
  events.push(...step(world, survivalRules));
  events.push(...step(world, survivalRules));

  assert.ok(
    hasTag(world.entities.wolf, "carcass"),
    "the beast went down before the swing finished",
  );
  let fizzle = events.find((e) => e.type === "action_failed");
  assert.ok(fizzle, "the fight reports a clean fizzle");
  assert.match(fizzle!.text ?? "", /already down/);
  assert.ok(
    !events.some((e) => e.type === "rule_error"),
    `no rule_error: ${JSON.stringify(events.filter((e) => e.type === "rule_error"))}`,
  );
});

// Drive an agent's committed action to completion and let any transition rules
// settle afterwards (bounded).
function settle(world: ReturnType<typeof makeSurvivalWorld>, id: string) {
  for (let t = 0; t < 8 && world.entities[id]?.action; t += 1)
    step(world, survivalRules);
  for (let t = 0; t < 2; t += 1) step(world, survivalRules);
}

test("butchering cuts meat into the pack and clears a stripped carcass", () => {
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.food = stock(0, 0, 12); // empty scenario, room for a full 12
  let wolf = wolfAt(ara.pos!);
  wolf.stocks.health = stock(0, 0, 16); // already down
  world.entities.wolf = wolf;

  // predator-dies turns the beast into a meat-laden carcass.
  step(world, survivalRules);
  assert.ok(hasTag(world.entities.wolf, "carcass"), "now a carcass");
  assert.equal(world.entities.wolf.stocks.food.value, 10, "laden with 10 meat");

  assert.equal(
    commit(world, survivalRules, "ara", "butcher", {}, PLAINS).ok,
    true,
  );
  settle(world, "ara");

  assert.equal(ara.stocks.food.value, 10, "all the meat came into the pack");
  assert.equal(
    world.entities.wolf,
    undefined,
    "the stripped carcass was cleared away",
  );
});

test("butchering is bounded by pack room, leaving meat for the next character", () => {
  let world = makeSurvivalWorld();
  let ara = addAgent(world, "ara");
  ara.stocks.food = stock(9, 0, 12); // only room for 3 more
  let wolf = wolfAt(ara.pos!);
  wolf.stocks.health = stock(0, 0, 16);
  world.entities.wolf = wolf;
  step(world, survivalRules); // -> carcass with 10 meat

  assert.equal(
    commit(world, survivalRules, "ara", "butcher", {}, PLAINS).ok,
    true,
  );
  settle(world, "ara");

  assert.equal(
    ara.stocks.food.value,
    12,
    "scenario filled to the cap, no further",
  );
  assert.equal(
    world.entities.wolf.stocks.food.value,
    7,
    "the rest stays on the carcass for others - nothing wasted",
  );
});
