import assert from "node:assert/strict";
import test from "node:test";

import {
  commit,
  step,
  stock,
  type ActionRule,
} from "@agent-island/core/kernel";
import { addAgent, makeSurvivalWorld } from "./helpers.js";

// The base game forages straight from a source — there is no stockpile. But the
// kernel still supports the transfer mechanic a GM would layer on to add
// stockpiling: stand on a token and haul its reserve into a shared world pile,
// capped to what the token has left. These tests pin that transfer contract by
// defining the gather rule inline, exactly as the director would inject it.

const GATHER_YIELD = 6;

const gatherRule: ActionRule = {
  id: "gather",
  kind: "action",
  duration: 8,
  params: [],
  requires: {
    all: [
      { colocated: { tag: "wood" } },
      {
        cmp: "gte",
        left: { stock: "wood", of: { colocated: "wood" } },
        right: 1,
      },
      { cmp: "gte", left: { stock: "energy" }, right: 25 },
    ],
  },
  do: [
    {
      transfer: {
        from: { stock: "wood", of: { colocated: "wood" } },
        to: { stock: "wood", of: "world" },
        amount: {
          min: [GATHER_YIELD, { stock: "wood", of: { colocated: "wood" } }],
        },
      },
    },
    { adjust: { target: "energy", by: -25 } },
  ],
  emit: { type: "gathered" },
};

const RULES = [gatherRule];

// A world with a shared wood stockpile and a wood token under the agent's feet.
function woodWorld(tokenReserve = 24) {
  let world = makeSurvivalWorld();
  world.entities.world.stocks.wood = stock(8, 0, 9999); // the shared stockpile
  let ara = addAgent(world, "ara");
  let token = {
    id: "grove-1",
    tags: ["wood"],
    occupancy: "tile" as const,
    stocks: { wood: stock(tokenReserve, 0, 48) },
    pos: { ...ara.pos! },
  };
  world.entities["grove-1"] = token;
  return { world, ara, token };
}

// Drive one full gather (commit + the 8 ticks it occupies), topping the agent's
// energy back up so a sequence of gathers isn't capped by stamina.
function gatherOnce(world: ReturnType<typeof woodWorld>["world"], id: string) {
  world.entities[id].stocks.energy.value = 100;
  let res = commit(world, RULES, id, "gather");
  for (let t = 1; t <= 8; t += 1) step(world, RULES);
  return res;
}

test("a wood token depletes as it's gathered and is conserved into the stockpile", () => {
  let { world, token } = woodWorld();

  let tokenStart = token.stocks.wood.value; // the token's reserve
  let pileStart = world.entities.world.stocks.wood.value; // 8

  gatherOnce(world, "ara");
  assert.equal(
    token.stocks.wood.value,
    tokenStart - GATHER_YIELD,
    `token lost ${GATHER_YIELD}`,
  );
  assert.equal(
    world.entities.world.stocks.wood.value,
    pileStart + GATHER_YIELD,
    `stockpile gained ${GATHER_YIELD}`,
  );
});

test("gathering empties a token exactly to zero, then the gate refuses it", () => {
  let { world, token } = woodWorld(GATHER_YIELD * 2);

  let reserve = token.stocks.wood.value;
  let pileStart = world.entities.world.stocks.wood.value;

  for (let i = 0; i < reserve / GATHER_YIELD; i += 1) {
    assert.equal(gatherOnce(world, "ara").ok, true, `gather #${i + 1} commits`);
  }
  assert.equal(token.stocks.wood.value, 0, "token is dry");
  assert.equal(
    world.entities.world.stocks.wood.value,
    pileStart + reserve,
    "all of it banked",
  );

  // A dry token fails the requires gate — no more gathering here.
  world.entities.ara.stocks.energy.value = 100;
  let denied = commit(world, RULES, "ara", "gather");
  assert.equal(denied.ok, false, "can't gather an exhausted token");
});

test("the final partial pull is capped to what the token has left", () => {
  let remainder = GATHER_YIELD - 2;
  let { world, token } = woodWorld(remainder);

  let pileStart = world.entities.world.stocks.wood.value;

  gatherOnce(world, "ara");
  assert.equal(token.stocks.wood.value, 0, "drained the remainder");
  assert.equal(
    world.entities.world.stocks.wood.value,
    pileStart + remainder,
    `stockpile gained only ${remainder}, not ${GATHER_YIELD}`,
  );
});

test("the gathered event reports the real amount moved, not the nominal rate", () => {
  // Leave the token with less than one full pull, so min(rate, left) bites.
  let remainder = GATHER_YIELD - 2;
  let { world, ara } = woodWorld(remainder);
  ara.stocks.energy.value = 100;

  commit(world, RULES, "ara", "gather");
  let gathered;
  for (let t = 1; t <= 8; t += 1)
    for (let e of step(world, RULES)) if (e.type === "gathered") gathered = e;

  assert.ok(gathered, "a gathered event was emitted");
  assert.equal(
    gathered!.args?.amount,
    remainder,
    `event reports ${remainder} actually banked, not the nominal ${GATHER_YIELD}`,
  );
});
