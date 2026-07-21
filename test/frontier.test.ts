// Frontier: the "what we know we lack" quadrants. An agent can ask where
// their knowledge ends - coverage of walkable ground, the nearest tile they
// have never seen, which directions are most unknown, where their map has
// gone stalest - and their open contradictions ride along, so a refuted claim
// is visible until it scrolls off.

import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceSpace,
  frontier,
  knownTiles,
  spawn,
} from "../src/rules/space.js";
import {
  addAgent,
  makeSurvivalSpace,
  makeSurvivalWorld,
  spawnAgent,
} from "./helpers.js";

test("frontier reports coverage, nearest unseen ground, and unknown directions", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();
  addAgent(world, "ara");
  spawnAgent(space, "ara");
  let here = world.entities.ara.pos!;

  let view = frontier(space, "ara", here, 0);
  assert.ok(view.coverage > 0, "the spawn reveal counts as coverage");
  assert.ok(view.coverage < 0.5, "most of the map starts unknown");
  assert.ok(view.nearestUnseen, "there is unseen ground to head for");
  assert.ok(
    view.nearestUnseen!.distance >= 1,
    "the nearest unseen tile is a real walk away",
  );
  assert.ok(view.unexplored.length > 0, "unknown directions are named");
  assert.ok(
    view.unexplored.every((u) => u.unknownShare > 0 && u.tiles > 0),
    "each unexplored sector carries its share and size",
  );

  // Growing the fog shrinks the frontier: full-map reveal drives coverage to
  // 1 and leaves nothing unseen.
  spawn(space, "ara", 0, {
    radius: Math.max(space.grid.width, space.grid.height),
  });
  let after = frontier(space, "ara", here, 0);
  assert.equal(after.coverage, 1);
  assert.equal(after.nearestUnseen, undefined);
  assert.deepEqual(after.unexplored, []);
});

test("staleness names the sector whose freshest sighting is oldest", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();
  addAgent(world, "ara");
  spawnAgent(space, "ara"); // fog around spawn at tick 0

  let here = world.entities.ara.pos!;

  // At the moment of the reveal, nothing is stale.
  let fresh = frontier(space, "ara", here, 0);
  assert.equal(fresh.stalest, undefined, "a fresh map reports no staleness");

  // Move well clear of the spawn disc and re-perceive there much later: the new
  // ground is fresh, but the spawn-time reveal - now far behind the agent and
  // never seen again - has rotted into a stale sector.
  let far = { x: here.x + 30, y: here.y };
  world.entities.ara.pos = far;
  world.tick = 500;
  advanceSpace(space, world, []);

  let view = frontier(space, "ara", far, 500);
  assert.ok(view.stalest, "a stalest sector is reported");
  assert.ok(
    view.stalest!.ticksAgo > 100,
    `the tick-0 spawn disc dominates some sector's mean age (got ${view.stalest!.ticksAgo})`,
  );
});

test("frontier knows nothing it wasn't shown: knownTiles stays per-agent", () => {
  let world = makeSurvivalWorld();
  let space = makeSurvivalSpace();
  addAgent(world, "ara");
  addAgent(world, "bo");
  spawnAgent(space, "ara");
  spawn(space, "bo", 0, { radius: 0 });

  assert.ok(
    knownTiles(space, "ara").length > knownTiles(space, "bo").length,
    "ara's reveal doesn't leak into bo's frontier arithmetic",
  );
  let bo = frontier(space, "bo", world.entities.bo.pos!, 0);
  let ara = frontier(space, "ara", world.entities.ara.pos!, 0);
  assert.ok(bo.coverage < ara.coverage);
});
