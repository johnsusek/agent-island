// Shared test scaffolding: build a raw survival KernelWorld and Space straight
// from scenario, so the kernel-level tests can poke stocks and drive
// step()/commit() without the host. This mirrors exactly what createWorld() does
// internally — the host has no special knowledge the scenario doesn't carry.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  hasTag,
  stock,
  type Entity,
  type KernelWorld,
  type Rule,
  type Stock,
} from "../src/rules/kernel.js";
import {
  createWorld,
  normalizeId,
  type RuleOverlay,
  type WorldEngine,
} from "../src/rules/engine.js";
import {
  expandWorldGen,
  makeSpace,
  pickSpawn,
  spawn,
  worldgenWithTerrainPolicy,
  type TokenScatter,
  type Space,
} from "../src/rules/space.js";
import { scenario } from "../src/rules/config.js";
import { mergeOverlays } from "../src/rules/overlays.js";
import { resolveIncludes, rulesetsDirFor } from "../src/scenarios.js";
import type { Scenario, StockSpec } from "../src/rules/scenario.js";

// The full default game ships as the survival scenario layered onto a minimal
// ruleset (name + worldgen only): the needs loop, terrain, base prose, the
// season clock, and every feature system (cold, hearth, farming, building,
// predators, stockpile, morale). The tests exercise that combined physics.
// The scenarios directory also carries standalone genre scenarios (boomtown,
// descent, and friends) that REPLACE the survival game rather than layer
// onto it - sweeping the whole directory would merge them into a
// franken-world no deployment runs, so the scaffold pins the default active
// set instead.
// Resolve the scenario's `include`d rulesets exactly as the live loader does, so
// the merged overlay carries the rules the scenario pulls in (survival includes
// the shared `metabolism` ruleset) and not just the ones left inline in the file.
function readScenario(name: string): { overlay: RuleOverlay } {
  let parsed = JSON.parse(
    readFileSync(path.resolve(`config/scenarios/${name}.json`), "utf8"),
  );
  return {
    overlay: resolveIncludes(
      parsed,
      rulesetsDirFor(path.resolve("config/scenarios")),
    ),
  };
}
let scenarioNames = ["survival"];

// Every scenario merged into one overlay exactly as the coordinator merges the
// active set. The default game is a single scenario, so this is normally just
// survival.json verbatim.
export let survivalOverlay = mergeOverlays(
  [],
  scenarioNames.map((name) => readScenario(name).overlay),
);

export let survivalRules: Rule[] = survivalOverlay.dynamicRules;

// The merged terrain kinds, as the coordinator's boot merge sees them - the
// base ruleset carries no terrainSpecs anymore, they ride the survival scenario.
export let survivalTerrainSpecs = {
  ...(scenario.terrainSpecs ?? {}),
  ...(survivalOverlay.terrainSpecs ?? {}),
};

// Terrain placement (defaultTerrain + the terrainLayers stack + connect) rides
// the survival scenario now, not the bare world file. Fold it back onto the
// canvas exactly as bootScenario does, so the generated map has water again and
// onTerrain scatter lands.
export let survivalWorldgen = scenario.worldgen
  ? {
      ...scenario.worldgen,
      ...(survivalOverlay.defaultTerrain !== undefined
        ? { defaultTerrain: survivalOverlay.defaultTerrain }
        : {}),
      ...(survivalOverlay.blobs !== undefined
        ? { blobs: survivalOverlay.blobs }
        : {}),
      ...(survivalOverlay.terrainLayers !== undefined
        ? { terrainLayers: survivalOverlay.terrainLayers }
        : {}),
      ...(survivalOverlay.connect !== undefined
        ? { connect: survivalOverlay.connect }
        : {}),
    }
  : undefined;

// The scenario as the coordinator boots it: scenario terrain merged in and the
// spawn rerolled against the merged passability. Engine-level tests that layer
// survivalOverlay should build on this, not the bare scenario, or their
// spawn is rolled as if water were walkable.
export let survivalScenario: Scenario = {
  ...scenario,
  terrainSpecs: survivalTerrainSpecs,
  worldgen: survivalWorldgen,
  spawn: pickSpawn(
    worldgenWithTerrainPolicy(survivalWorldgen, survivalTerrainSpecs),
  ),
};

// A fresh engine running the full layered game - the scenario as the
// coordinator boots it plus the survival scenario, which is what production
// always runs.
// Host-level tests build on this unless they specifically probe bare worlds.
export function makeSurvivalEngine() {
  let engine = createWorld(survivalScenario);
  engine.applyOverlay(survivalOverlay);
  return engine;
}

let setupTokenScatter = (survivalOverlay.setup ?? [])
  .map((directive) => directive.scatter)
  .filter(
    (scatter): scatter is TokenScatter =>
      Boolean(scatter) && hasTag(scatter, "token"),
  );

// Production rolls a random spawn, but the kernel-level tests want a fixed, roomy
// start they can place entities around by offset. Pin spawn to the map's centre —
// the spawnClearRadius guarantees it's passable — so these tests stay
// deterministic regardless of the world's seeded spawn.
export const TEST_SPAWN = {
  x: (scenario.worldgen?.width ?? 21) >> 1,
  y: (scenario.worldgen?.height ?? 21) >> 1,
};

// The survival tokens are scattered procedurally, so resolve them once (exactly as
// createWorld does) and drive both the kernel world and the space off this — the
// concrete token list with names, positions, and reserves.
let survivalWorldGenInput = survivalWorldgen
  ? worldgenWithTerrainPolicy(
      {
        ...survivalWorldgen,
        tokenScatter: [
          ...(survivalWorldgen.tokenScatter ?? []),
          ...setupTokenScatter,
        ],
      },
      survivalTerrainSpecs,
    )
  : undefined;
let survivalWorldGen = survivalWorldGenInput
  ? expandWorldGen(survivalWorldGenInput, TEST_SPAWN)
  : undefined;

function instantiate(specs: Record<string, StockSpec>): Record<string, Stock> {
  let out: Record<string, Stock> = {};
  for (let [name, s] of Object.entries(specs))
    out[name] = stock(s.value, s.min, s.max);
  return out;
}

export function makeSurvivalWorld(): KernelWorld {
  // World stocks are scenario authoring now (overlay.worldStocks, seeded by
  // applyOverlay) - the scenario declares none, so seed straight from the scenarios.
  let entities: Record<string, Entity> = {
    world: {
      id: "world",
      tags: ["world"],
      stocks: instantiate(survivalOverlay.worldStocks ?? {}),
    },
  };
  for (let s of survivalWorldGen?.tokens ?? [])
    entities[s.name] = {
      id: s.name,
      kind: s.kind,
      tags: s.tags,
      stocks: instantiate(s.stocks ?? {}),
      pos: { x: s.x, y: s.y },
    };
  return { tick: 0, entities };
}

// The first token carrying a given tag (e.g. "wood") — kernel tests stand an agent
// on a resource token without caring which procedurally-named one it is.
export function findToken(world: KernelWorld, tag: string): Entity {
  let token = Object.values(world.entities).find(
    (e) => hasTag(e, "token") && hasTag(e, tag),
  );
  if (!token) throw new Error(`no token tagged "${tag}"`);
  return token;
}

export function addAgent(world: KernelWorld, id: string): Entity {
  // The scenario no longer authors an agent template - a character is the bare
  // "agent" tag plus the scenario's per-agent stock defaults (health/hunger/
  // thirst/energy/warmth/morale/wood), the same layering addAgent does in the
  // engine via withStockDefaults.
  let template = scenario.agentTemplate ?? { tags: ["agent"], stocks: {} };
  let agent: Entity = {
    id,
    tags: [...template.tags],
    stocks: instantiate({
      ...template.stocks,
      ...(survivalOverlay.stockDefaults ?? {}),
    }),
    pos: { ...TEST_SPAWN },
    action: null,
  };
  world.entities[id] = agent;
  return agent;
}

// The compass direction (one of the eight the explore action accepts) from
// one tile toward another, or null if they coincide.
export function dirToward(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string | null {
  let ns = to.y < from.y ? "north" : to.y > from.y ? "south" : "";
  let ew = to.x < from.x ? "west" : to.x > from.x ? "east" : "";
  return ns + ew || null;
}

// Teleport an existing agent by snapshot/restore, bypassing movement rules -
// for tests that need a fixed spatial arrangement rather than travel time.
export function placeAt(engine: WorldEngine, id: string, x: number, y: number) {
  let snap = engine.snapshot();
  snap.world.entities[normalizeId(id)].pos = { x, y };
  engine.restore(snap);
}

// Advance a host-level engine until the agent's current action finishes
// (bounded, so a stuck run fails loudly instead of hanging).
export function runToIdle(engine: WorldEngine, id: string, safety = 80) {
  let steps = 0;
  while (engine.getObservation(id).you.action && steps < safety) {
    engine.tick();
    steps += 1;
  }
  return engine.getObservation(id);
}

export function makeSurvivalSpace(): Space {
  return makeSpace(TEST_SPAWN, survivalWorldGen);
}

// Narrow a commitIntent/commitPrimitiveIntent result to the speculative-attempt
// branch (see docs/speculative-physics.md). The `speculative` field only
// exists on that branch, so this doubles as an assertion that the call really
// took the soft-fail path instead of a recognized action.
export function assertSpeculative(result: unknown): asserts result is {
  accepted: false;
  speculative: true;
  approaching: boolean;
  verb: string;
  message: string;
} {
  assert.ok(
    typeof result === "object" &&
      result !== null &&
      (result as { speculative?: unknown }).speculative === true,
    "expected a speculative-attempt outcome",
  );
}

// Reveal the spawn surroundings plus the nearest food source. Production no longer
// hands a fresh character a known food token (it must explore), but the kernel-level
// tests aren't about discovery — they stand an agent next to known food to drive
// eat/travel mechanics, so the scaffold reveals it for them.
export function spawnAgent(space: Space, id: string) {
  spawn(space, id, 0, { nearest: [{ tag: "food", count: 1 }] });
}
