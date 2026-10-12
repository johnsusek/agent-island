// Shared test scaffolding: build a raw survival KernelWorld and Space straight
// from scenario, so the kernel-level tests can poke stocks and drive
// step()/commit() without the host. This mirrors exactly what createWorld() does
// internally — the host has no special knowledge the scenario doesn't carry.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  hasTag,
  stock,
  type Entity,
  type KernelWorld,
  type Rule,
  type Stock,
} from "@agent-island/core/kernel";
import {
  createWorld,
  normalizeId,
  type RuleOverlay,
  type WorldEngine,
} from "@agent-island/engine/engine";
import {
  expandWorldGen,
  makeSpace,
  pickSpawn,
  spawn,
  worldgenWithTerrainPolicy,
  type TokenScatter,
  type Space,
} from "@agent-island/core/space";
import { scenario } from "../src/config.js";
import { mergeOverlays } from "@agent-island/engine/overlays";
import { resolveIncludes, rulesetsDirFor } from "../src/scenarios.js";
import type { Scenario, StockSpec } from "@agent-island/engine/scenario";

// The full default game ships as the survival scenario layered onto a minimal
// ruleset (name + worldgen only): the needs loop, terrain, base prose, the
// season clock, and every feature system (cold, hearth, farming, building,
// predators, stockpile, morale). The tests exercise that combined physics.
// The scenarios directory also carries standalone genre scenarios (boomtown,
// descent, and friends) that REPLACE the survival game rather than layer
// onto it - sweeping the whole directory would merge them into a
// franken-world no deployment runs, so the scaffold pins the default active
// set instead.
// Resolve any `include`d rulesets exactly as the live loader does. The survival
// fixture is self-contained today (its include list is empty), so this is a
// straight read, but staying on the loader path keeps the scaffold honest if a
// fixture ever pulls a ruleset in again.
// Load a `test/<name>.json` fixture and resolve its includes exactly as the
// live loader does - the general form `readScenario` used to hardcode to
// "survival" alone. Every standalone per-test fixture (combat.json,
// stockpile.json, ...) rides this same path.
export function loadFixtureOverlay(name: string): RuleOverlay {
  let parsed = JSON.parse(
    readFileSync(path.resolve(`test/${name}.json`), "utf8"),
  );
  return resolveIncludes(
    parsed,
    rulesetsDirFor(path.resolve("config/scenarios")),
  );
}
function readScenario(name: string): { overlay: RuleOverlay } {
  return { overlay: loadFixtureOverlay(name) };
}
let scenarioNames = ["survival"];

// Colony options that boot the survival fixture from this directory.
export let survivalBoot = {
  scenarios: ["survival"],
  scenariosDir: path.resolve("test"),
};

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

// A fresh engine over ANY `test/<name>.json` fixture: merge its terrain fields
// onto the base scenario exactly as bootScenario does (so pickSpawn rolls
// against the real passability), then apply its overlay. Generalizes what
// makeSurvivalEngine used to do only for "survival" - every standalone
// per-test fixture that needs a full host (not just a bare kernel world)
// rides this instead of duplicating the terrain-merge dance.
export function makeFixtureEngine(name: string): WorldEngine {
  let overlay = loadFixtureOverlay(name);
  let terrainSpecs = {
    ...(scenario.terrainSpecs ?? {}),
    ...(overlay.terrainSpecs ?? {}),
  };
  let worldgen = scenario.worldgen
    ? {
        ...scenario.worldgen,
        ...(overlay.defaultTerrain !== undefined
          ? { defaultTerrain: overlay.defaultTerrain }
          : {}),
        ...(overlay.blobs !== undefined ? { blobs: overlay.blobs } : {}),
        ...(overlay.terrainLayers !== undefined
          ? { terrainLayers: overlay.terrainLayers }
          : {}),
        ...(overlay.connect !== undefined ? { connect: overlay.connect } : {}),
      }
    : undefined;
  let fixtureScenario: Scenario = {
    ...scenario,
    terrainSpecs,
    worldgen,
    spawn: pickSpawn(worldgenWithTerrainPolicy(worldgen, terrainSpecs)),
  };
  let engine = createWorld(fixtureScenario);
  engine.applyOverlay(overlay);
  return engine;
}

// A fresh engine running the full layered game - the scenario as the
// coordinator boots it plus the survival scenario, which is what production
// always runs.
// Host-level tests build on this unless they specifically probe bare worlds.
export function makeSurvivalEngine() {
  return makeFixtureEngine("survival");
}

let setupTokenScatter = (survivalOverlay.setup ?? [])
  .map((directive) => directive.scatter)
  .filter((scatter): scatter is TokenScatter => Boolean(scatter));

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

export function instantiate(
  specs: Record<string, StockSpec>,
): Record<string, Stock> {
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
      occupancy: s.occupancy ?? "tile",
      stocks: instantiate(s.stocks ?? {}),
      pos: { x: s.x, y: s.y },
    };
  return { tick: 0, entities };
}

// A bare kernel world seeded from ANY overlay's worldStocks, with no scattered
// map tokens - the generic form of makeSurvivalWorld for fixtures that never
// touch space/travel (combat, stockpile: pure commit()/step() at the kernel
// level, entities placed by hand).
export function makeBareWorld(overlay: RuleOverlay): KernelWorld {
  return {
    tick: 0,
    entities: {
      world: {
        id: "world",
        tags: ["world"],
        stocks: instantiate(overlay.worldStocks ?? {}),
      },
    },
  };
}

// addAgent, generalized to any overlay's stockDefaults rather than
// survivalOverlay specifically.
export function addAgentTo(
  world: KernelWorld,
  id: string,
  overlay: RuleOverlay,
): Entity {
  let template = scenario.agentTemplate ?? { tags: ["agent"], stocks: {} };
  let agent: Entity = {
    id,
    tags: [...template.tags],
    stocks: instantiate({
      ...template.stocks,
      ...(overlay.stockDefaults ?? {}),
    }),
    pos: { ...TEST_SPAWN },
    action: null,
  };
  world.entities[id] = agent;
  return agent;
}

// The first token carrying a given tag (e.g. "wood") — kernel tests stand an agent
// on a resource token without caring which procedurally-named one it is.
export function findToken(world: KernelWorld, tag: string): Entity {
  let token = Object.values(world.entities).find(
    (e) => e.occupancy !== undefined && hasTag(e, tag),
  );
  if (!token) throw new Error(`no token tagged "${tag}"`);
  return token;
}

export function addAgent(world: KernelWorld, id: string): Entity {
  return addAgentTo(world, id, survivalOverlay);
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

// Reveal the spawn surroundings plus the nearest food source. Production no longer
// hands a fresh character a known food token (it must explore), but the kernel-level
// tests aren't about discovery — they stand an agent next to known food to drive
// eat/travel mechanics, so the scaffold reveals it for them.
export function spawnAgent(space: Space, id: string) {
  spawn(space, id, 0, { nearest: [{ tag: "food", count: 1 }] });
}

// Declare the world `progress` stock a bare test Scenario's flow rule writes
// to. Every adjust target must already exist (see kernel.ts requireStock), and
// a bare Scenario has no worldStocks field of its own - that's an overlay
// concept - so the fixtures that drive a clock off `progress` declare it here
// first. Without it those flow rules throw a rule_error every tick, progress
// never advances, and a fast-forwarding test spins to its timeout.
//
// Poked straight into a snapshot rather than set through engine.setStock,
// which would also record a "stock_set" GM action - pulse.test.ts asserts
// ticksSinceLastGmAction against a precise sequence of its own recordGm calls,
// so the scaffolding has to stay out of the GM log. The max is generous on
// purpose: a watch rule may wait for a value well past the default 100
// (omenScenario(1000) and friends).
export function declareProgress<Engine extends ReturnType<typeof createWorld>>(
  engine: Engine,
): Engine {
  let snap = engine.snapshot();
  snap.world.entities.world.stocks.progress = {
    value: 0,
    min: 0,
    max: 1_000_000,
  };
  engine.restore(snap);
  return engine;
}
