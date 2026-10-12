#!/usr/bin/env node
// Bakes a scenario's terrain recipe at full size and writes it to
// config/scenarios/<name>.map.json, a plain sibling of the scenario file. The
// live engine loads that file (coordinator-scenarios.ts's loadPregeneratedMap)
// and, when present, slices its starting view from it and reveals more of it
// as growWorld rules fire, instead of generating terrain live - see
// copyPregeneratedFrontier in packages/core/src/space.ts.
//
// Reuses paintedTiles, the exact painter makeGrid/pickSpawn/expandWorldGen
// already call, just run once at the scenario's `worldWidth`/`worldHeight`
// instead of the live grid's (usually much smaller) width/height - so the
// pregenerated map is byte-identical to what live generation would have
// produced at that size, including layer kinds (blobs, island, maze) that
// can't extend a live frontier.
//
// Usage:
//   node --import tsx scripts/generate-map.ts <scenario> [options]
//   npm run generate-map -- <scenario> [options]
//
// Options:
//   --scenarios-dir DIR   Where scenario JSON lives (default config/scenarios)
//   --ruleset FILE        World file for the base seed (env AGENT_ISLAND_RULESET,
//                         default config/config.json)

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createScenarioStore } from "../src/scenarios.js";
import {
  paintedTiles,
  worldgenWithTerrainPolicy,
  type PregeneratedMap,
  type Terrain,
  type WorldGen,
} from "@agent-island/core/space";

function parseArgs(argv: string[]) {
  let positional: string[] = [];
  let opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    if (arg.startsWith("--")) opts[arg.slice(2)] = argv[++i];
    else positional.push(arg);
  }
  return { positional, opts };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

// One printable character per terrain, preferring the terrain's own initial
// so a hand-read map file stays legible (genesis: p/w/f), falling back
// through the rest of the alphabet/digits when that's taken or non-ASCII.
const LEGEND_POOL =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function buildLegend(terrains: Terrain[]): {
  legend: Record<string, Terrain>;
  charOf: Map<Terrain, string>;
} {
  let legend: Record<string, Terrain> = {};
  let charOf = new Map<Terrain, string>();
  let used = new Set<string>();
  for (let terrain of terrains) {
    if (charOf.has(terrain)) continue;
    let preferred = terrain[0]?.toLowerCase();
    let char =
      preferred && /[a-z0-9]/.test(preferred) && !used.has(preferred)
        ? preferred
        : [...LEGEND_POOL].find((candidate) => !used.has(candidate));
    if (!char)
      throw new Error(`too many distinct terrains to encode (${used.size})`);
    used.add(char);
    legend[char] = terrain;
    charOf.set(terrain, char);
  }
  return { legend, charOf };
}

async function main() {
  let { positional, opts } = parseArgs(process.argv.slice(2));
  let name = positional[0];
  if (!name)
    fail(
      "usage: generate-map <scenario> [--scenarios-dir DIR] [--ruleset FILE]",
    );

  let scenariosDir = opts["scenarios-dir"]
    ? path.resolve(opts["scenarios-dir"])
    : path.resolve("config/scenarios");
  let rulesetPath = opts.ruleset
    ? path.resolve(opts.ruleset)
    : path.resolve(process.env.AGENT_ISLAND_RULESET ?? "config/config.json");

  let store = createScenarioStore(scenariosDir);
  let scenarioFile = store.load(name);
  let overlay = scenarioFile.overlay;
  let worldWidth = overlay.worldWidth;
  let worldHeight = overlay.worldHeight;
  if (!worldWidth || !worldHeight)
    fail(
      `scenario "${name}" has no worldWidth/worldHeight - nothing to pregenerate.`,
    );
  if (!overlay.terrainLayers?.length && !overlay.blobs?.length)
    fail(`scenario "${name}" has no terrainLayers or blobs to paint.`);

  let seed = 1;
  try {
    let world = JSON.parse(readFileSync(rulesetPath, "utf8")) as {
      seed?: number;
    };
    if (typeof world.seed === "number") seed = world.seed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let terrainSpecs = overlay.terrainSpecs ?? {};
  let fill = overlay.defaultTerrain ?? "plains";
  let gen: WorldGen = worldgenWithTerrainPolicy(
    {
      width: worldWidth,
      height: worldHeight,
      seed,
      defaultTerrain: overlay.defaultTerrain,
      blobs: overlay.blobs,
      terrainLayers: overlay.terrainLayers,
      connect: overlay.connect,
    },
    terrainSpecs,
  )!;

  console.log(
    `painting "${name}" at ${worldWidth}x${worldHeight} (seed ${seed})...`,
  );
  let tiles = paintedTiles(gen, worldWidth, worldHeight, fill);

  let seen = new Set<Terrain>();
  for (let row of tiles) for (let tile of row) seen.add(tile.terrain);
  let { legend, charOf } = buildLegend([...seen]);

  let rows = tiles.map((row) =>
    row.map((tile) => charOf.get(tile.terrain)!).join(""),
  );

  let map: PregeneratedMap = {
    width: worldWidth,
    height: worldHeight,
    origin: {
      x: -Math.floor(worldWidth / 2),
      y: -Math.floor(worldHeight / 2),
    },
    seed,
    legend,
    rows,
  };

  let destination = path.join(scenariosDir, `${name}.map.json`);
  let tmp = `${destination}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, destination);
  console.log(
    `wrote ${destination} (${Object.keys(legend).length} terrains: ${[...seen].join(", ")})`,
  );
}

main();
