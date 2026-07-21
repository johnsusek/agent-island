// The coordination ledger: the one sanctioned exception to per-agent
// perception. Standing at (or beside) a ledger-tagged entity - the survival
// scenario plants one at the spawn camp - reads every character's name and
// declared work. Coordination state only: no positions, no world knowledge.
// Away from the board, you know only what you see and hear.

import assert from "node:assert/strict";
import test from "node:test";

import { createColony } from "../src/coordinator.js";
import { describeSense } from "../src/sense-prose.js";
import { makeSurvivalEngine } from "./helpers.js";

function withColony(fn: (colony: any) => void | Promise<void>) {
  let colony = createColony({
    statePath: null,
    rulesPath: null,
    waitTimeoutMs: 2000,
    scenarios: ["survival"],
  });
  colony.start();
  colony.connect("a");
  return Promise.resolve(fn(colony)).finally(() => colony.stop());
}

test("the survival scenario plants its ledger at the spawn camp", () =>
  withColony((colony) => {
    colony.join("a", "Ara");
    let entities = colony.getAdminPayload().state;
    void entities;
    let situation = colony.sense("a", "situation");
    assert.equal(
      situation.colony.atLedger,
      true,
      "a fresh character spawns within reach of the board",
    );
    assert.equal(situation.colony.ledger, "camp-ledger");
  }));

test("the ledger lists declared work without positions", () =>
  withColony((colony) => {
    colony.join("a", "Ara");
    colony.connect("b");
    colony.join("b", "Bo");
    colony.setOrder("b", {
      kind: "repeat",
      action: { type: "forage" },
      maxRepeats: 3,
      label: "foraging for the larder",
    });

    let board = colony.sense("a", "situation").colony;
    assert.equal(board.atLedger, true);
    let bo = board.roster.find((c: any) => c.name === "Bo");
    assert.ok(bo, "every living character is on the board");
    assert.match(String(bo.doing), /forage|foraging/);
    for (let entry of board.roster) {
      assert.equal(entry.direction, undefined, "no bearings on the board");
      assert.equal(entry.distance, undefined, "no distances on the board");
      assert.equal(entry.at, undefined, "no positions on the board");
    }

    let prose = describeSense(colony.sense("a", "situation"));
    assert.match(prose, /camp-ledger/);
    assert.match(prose, /Bo:/);
  }));

test("away from the board there is no roster", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  assert.equal(engine.getObservation("ara").colony.atLedger, true);

  // Move Ara well out of ledger reach via the snapshot seam (walking is
  // terrain-dependent; a teleport keeps the distance deterministic).
  let map = engine.getMap();
  let x = map.spawn.x + 5 < map.width ? map.spawn.x + 5 : map.spawn.x - 5;
  let snap = engine.snapshot();
  snap.world.entities.ara.pos = { x, y: map.spawn.y };
  engine.restore(snap);

  let colony = engine.getObservation("ara").colony;
  assert.equal(
    colony.atLedger,
    false,
    "five tiles out, the board is unreadable",
  );
  assert.equal(colony.roster, undefined);
});
