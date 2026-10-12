// Regression: on a snapshot restore, a joining character must be placed at the
// RESTORED map's spawn, not at the pre-restore scenario.spawn.
//
// addAgent seats a newcomer at freeSpawnNear(grid, spawnPos): the `spawnPos`
// closure, NOT space.grid.spawn. The two diverge after a reset rerolls the map
// under a fresh random seed - the persisted grid carries the rerolled spawn,
// but a freshly constructed engine's spawnPos still holds scenario.spawn, picked
// against the config's fixed seed. On the rerolled map that stale tile can be
// water, so characters were landing on an all-water tile and stranding there.
// restore() now re-syncs spawnPos (and activeSeed) from the restored snapshot.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createWorld } from "@agent-island/engine/engine";
import { makeSurvivalEngine, survivalScenario } from "./helpers.js";

type Pt = { x: number; y: number };
let cheb = (a: Pt, b: Pt) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

test("a restored world seats joining characters on the restored spawn, not the stale scenario spawn", () => {
  let source = makeSurvivalEngine();
  let snap = source.snapshot();
  let map = source.getMap();
  let restoredSpawn = map.spawn;

  // Construct the target engine with a scenario.spawn deliberately pinned to the
  // far corner, so its spawnPos closure is unmistakably different from the
  // snapshot's spawn - exactly the divergence a reseeded reset produces.
  let corners: Pt[] = [
    { x: 0, y: 0 },
    { x: map.width - 1, y: 0 },
    { x: 0, y: map.height - 1 },
    { x: map.width - 1, y: map.height - 1 },
  ];
  let farSpawn = corners.reduce((a, b) =>
    cheb(b, restoredSpawn) > cheb(a, restoredSpawn) ? b : a,
  );

  let target = createWorld({ ...survivalScenario, spawn: farSpawn });
  assert.equal(target.restore(snap), true);

  target.addAgent("Probe");
  let probe = target.getEntities()["probe"];
  assert.ok(probe?.pos, "probe should have a position");

  // freeSpawnNear returns the origin when it is passable and unoccupied, so a
  // correctly re-synced spawnPos lands the character exactly on the restored
  // spawn. Before the fix it landed at (or beside) the stale far-corner spawn.
  assert.deepEqual(probe.pos, restoredSpawn);
});
