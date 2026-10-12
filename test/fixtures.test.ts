// GM-spawned fixtures are authoring, not colony state: a colony reset rebuilds
// the world from the scenario but the director's fixtures ride the portable
// overlay back, the same way rule edits and stock defaults do.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { WorldEngine } from "@agent-island/engine/engine";
import { makeSurvivalEngine } from "./helpers.js";

function survival(): WorldEngine {
  return makeSurvivalEngine();
}

const CRATE = {
  id: "supply-crate",
  tags: ["item"],
  stocks: { wood: { value: 40, min: 0, max: 40 } },
  pos: { x: 5, y: 5 },
};

test("a spawned fixture is captured in the portable overlay", () => {
  let engine = survival();
  engine.spawnEntity({ ...CRATE });
  let overlay = engine.getOverlay();
  // The scenario's own fixture (the camp ledger) rides the overlay too; the GM
  // crate is captured alongside it.
  let crate = overlay.fixtures?.find((f) => f.id === "supply-crate");
  assert.ok(crate, "the spawned crate is in the overlay");
  // The one-shot reveal flag is not persistent identity, so it never rides along.
  assert.equal("reveal" in crate!, false);
});

test("a fixture rides the overlay back across a colony reset", () => {
  let engine = survival();
  engine.spawnEntity({ ...CRATE });
  let overlay = engine.getOverlay();

  engine.reset();
  assert.equal(
    engine.getEntities()["supply-crate"],
    undefined,
    "reset rebuilds the world without the fixture",
  );

  engine.applyOverlay(overlay);
  let crate = engine.getEntities()["supply-crate"];
  assert.ok(crate, "re-applied overlay restores the fixture");
  assert.deepEqual(crate.pos, { x: 5, y: 5 });
  assert.equal(crate.stocks.wood.value, 40);
});

test("reset refills a fixture drained during the run to its spawn spec", () => {
  let engine = survival();
  engine.spawnEntity({ ...CRATE });
  let overlay = engine.getOverlay();
  // The colony harvests the crate dry.
  engine.setStock("supply-crate", "wood", 0);
  assert.equal(engine.getEntities()["supply-crate"].stocks.wood.value, 0);

  engine.reset();
  engine.applyOverlay(overlay);
  assert.equal(
    engine.getEntities()["supply-crate"].stocks.wood.value,
    40,
    "the replayed fixture starts from its spawn-spec value, not the drained one",
  );
});

test("restore does not double-spawn a fixture already in the snapshot", () => {
  let a = survival();
  a.spawnEntity({ ...CRATE });
  let snap = a.snapshot();

  let b = survival();
  assert.equal(b.restore(snap), true);
  let crate = b.getEntities()["supply-crate"];
  assert.ok(crate, "restored world carries the fixture");
  // The overlay still reports the crate exactly once (replay was a no-op, not
  // a re-add), so a later reset re-applies it once - not twice.
  assert.equal(
    b.getOverlay().fixtures?.filter((f) => f.id === "supply-crate").length,
    1,
  );
});
