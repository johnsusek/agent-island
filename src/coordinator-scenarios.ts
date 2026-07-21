import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { scenario } from "./rules/config.js";
import type { Scenario, TerrainSpec } from "./rules/scenario.js";
import {
  pickSpawn,
  worldgenWithTerrainPolicy,
  type Terrain,
  type WorldGen,
} from "./rules/space.js";
import {
  createScenarioStore,
  normalizeScenarioName,
  type ScenarioFile,
  type ScenarioStore,
} from "./scenarios.js";

export interface ScenarioBootOptions {
  scenariosDir?: string | null;
  scenariosSaveDir?: string | null;
  activeScenariosPath?: string | null;
  scenarios?: string[];
}

export interface ScenarioBoot {
  scenarioStore: ScenarioStore | null;
  activeScenariosPath: string | null;
  activeScenarios: Set<string>;
  bootScenario(): Scenario;
  validateScenario(scenario: ScenarioFile): void;
  writeActiveScenarios(): void;
}

// The map recipe a scenario runs under: the shared canvas (width/height/seed) from
// the world file, with the scenario's terrain placement (defaultTerrain plus
// either blobs or the terrainLayers stack, and the connect guarantee) laid over
// it. A scenario that declares none of them rides the base unchanged. When the
// scenario brings terrainLayers, any blobs from the base are dropped - the
// painter gives layers precedence, and the composed gen should say so plainly.
function composeWorldgen(
  base: WorldGen | undefined,
  scenario: ScenarioFile | null,
): WorldGen | undefined {
  let overlay = scenario?.overlay;
  let defaultTerrain = overlay?.defaultTerrain;
  let blobs = overlay?.blobs;
  let terrainLayers = overlay?.terrainLayers;
  let connect = overlay?.connect;
  if (
    defaultTerrain === undefined &&
    blobs === undefined &&
    terrainLayers === undefined &&
    connect === undefined
  )
    return base;
  let merged: WorldGen = {
    ...(base ?? { width: 21, height: 21 }),
    ...(defaultTerrain !== undefined ? { defaultTerrain } : {}),
    ...(blobs !== undefined ? { blobs } : {}),
    ...(terrainLayers !== undefined ? { terrainLayers } : {}),
    ...(connect !== undefined ? { connect } : {}),
  };
  if (terrainLayers !== undefined && blobs === undefined) delete merged.blobs;
  return merged;
}

// Fail loudly if the map recipe paints a terrain no active spec defines. Only
// meaningful once a scenario has declared terrain (an empty spec set means the bare
// no-scenario world, whose fill is a hardcoded fallback). Catches the authoring slip
// of a blob or defaultTerrain naming a terrain that isn't in terrainSpecs, at
// boot/reset rather than as a blank grid the characters walk onto.
function assertPlacementDefined(
  worldgen: WorldGen | undefined,
  specs: Record<string, TerrainSpec>,
  scenarioName?: string,
): void {
  let known = new Set(Object.keys(specs));
  if (!known.size || !worldgen) return;
  let painted = new Set<Terrain>();
  if (worldgen.defaultTerrain) painted.add(worldgen.defaultTerrain);
  for (let blob of worldgen.blobs ?? []) painted.add(blob.terrain);
  for (let layer of worldgen.terrainLayers ?? []) {
    painted.add(layer.terrain);
    // A mask naming an unknown terrain would just never match - the same
    // authoring slip, caught the same way.
    for (let on of layer.where?.on ?? []) painted.add(on);
  }
  if (worldgen.connect && worldgen.connect !== true)
    painted.add(worldgen.connect.carve);
  for (let terrain of painted)
    if (!known.has(terrain))
      throw new Error(
        `scenario "${scenarioName ?? "?"}" paints terrain "${terrain}" but no terrainSpecs entry defines it`,
      );
}

// The Scenario the coordinator runs a given scenario under: the world file's canvas
// with the scenario's terrain definitions (terrainSpecs) and placement (defaultTerrain
// + blobs) merged in, identity stamped from the scenario, and spawn rerolled against
// the merged passability. The live boot, the reset path, and the offline scenario
// validator all shape a world the same way through this. Throws if the scenario
// paints terrain it never defined.
export function scenarioBootScenario(
  base: Scenario,
  scenario: ScenarioFile | null,
): Scenario {
  let terrainSpecs = {
    ...(base.terrainSpecs ?? {}),
    ...(scenario?.overlay.terrainSpecs ?? {}),
  };
  let worldgen = composeWorldgen(base.worldgen, scenario);
  assertPlacementDefined(worldgen, terrainSpecs, scenario?.name);
  return {
    ...base,
    name: scenario?.name ?? base.name,
    terrainSpecs,
    worldgen,
    spawn: pickSpawn(worldgenWithTerrainPolicy(worldgen, terrainSpecs)),
  };
}

export function createScenarioBoot(options: ScenarioBootOptions): ScenarioBoot {
  let scenariosDir =
    options.scenariosDir === undefined
      ? resolve("config/scenarios")
      : options.scenariosDir;
  let scenarioStore = scenariosDir
    ? createScenarioStore(scenariosDir, options.scenariosSaveDir ?? scenariosDir)
    : null;
  let activeScenariosPath = options.activeScenariosPath ?? null;
  let activeScenarios = new Set(
    (options.scenarios ?? []).map(normalizeScenarioName),
  );

  if (scenarioStore && activeScenariosPath) {
    try {
      let saved = JSON.parse(readFileSync(activeScenariosPath, "utf8"));
      activeScenarios = new Set(
        (saved.active ?? []).map(normalizeScenarioName),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // Scenarios are mutually exclusive: at most one scenario defines the game at a
  // time. A state file written before that rule (or a hand-edited one) may
  // list several; keep the alphabetically-first so the pick is deterministic.
  if (activeScenarios.size > 1) {
    let [keep] = [...activeScenarios].sort();
    console.warn(
      `! multiple active scenarios found; keeping "${keep}" (scenarios are mutually exclusive)`,
    );
    activeScenarios = new Set([keep]);
  }

  // The active scenario, loaded, or null. Scenarios are mutually exclusive, so at most
  // one is active; a missing file is treated as no scenario rather than an error so
  // a stale active-set entry can't wedge boot.
  function activeScenario(): ScenarioFile | null {
    if (!scenarioStore) return null;
    let [name] = activeScenarios;
    if (!name) return null;
    try {
      return scenarioStore.load(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return null;
    }
  }

  // Check a scenario's terrain placement against its own terrain definitions before
  // it is activated - activating resets the world, so a scenario that paints terrain
  // it never defined must fail here, while the colony still stands, not partway
  // through the reset it triggers. scenarioBootScenario throws on the mismatch.
  function validateScenario(authoredScenario: ScenarioFile): void {
    scenarioBootScenario(scenario, authoredScenario);
  }

  // Identity follows the game, which is the active scenario: snapshots, the saved GM
  // overlay, and the journal all key off the scenario name through here, so a
  // survival save can't rehydrate under a dungeon scenario. Bare scenario when none.
  function bootScenario(): Scenario {
    if (!scenarioStore) return scenario;
    return scenarioBootScenario(scenario, activeScenario());
  }

  function writeActiveScenarios() {
    if (!activeScenariosPath) return;
    let payload = JSON.stringify(
      { active: [...activeScenarios].sort() },
      null,
      2,
    );
    let tmp = `${activeScenariosPath}.tmp`;
    mkdirSync(dirname(activeScenariosPath), { recursive: true });
    writeFileSync(tmp, payload);
    renameSync(tmp, activeScenariosPath);
  }

  return {
    scenarioStore,
    activeScenariosPath,
    activeScenarios,
    bootScenario,
    validateScenario,
    writeActiveScenarios,
  };
}
