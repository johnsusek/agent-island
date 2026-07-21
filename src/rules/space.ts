// The space subsystem: the one part of the world that is *not* data rules.
//
// Grids, pathfinding, and fog of war are inherently algorithmic - there is no
// honest way to express "breadth-first shortest path over passable tiles" as a
// serializable condition. So the kernel stays mechanic-agnostic about *stocks*,
// and movement lives here as a sibling system. The seam between them is narrow:
//   - movement still enters through the same action-intent surface (commitMove)
//     and occupies the agent via the kernel's ActiveAction, so an
//     agent can't act while walking;
//   - each engine tick advances space before running the rule VM phases.
//
// Nothing here is survival-specific. The grid is generated from a WorldGen the
// scenario supplies; with no WorldGen you get a bare, fully-passable grid. The
// subsystem emits movement events; rules decide what those events mean.

import type {
  ActionParam,
  Args,
  Entity,
  KernelEvent,
  KernelWorld,
  MapEdge,
  Occupancy,
} from "./kernel.js";
import { hasTag } from "./kernel.js";

// Substrate spatial tuning. These are generic ranges, not game balance.
//
// Scale canon (docs/rimworld-scale.md): a tile is ~1 m - one person - and a
// pawn occupies exactly one tile, RimWorld-style. Under that reading sight (12)
// is open-ground visibility (~12 m, LLM-budget-capped, not the horizon), a
// spoken word carries ~5-6 m (a conversation, not a shout across a valley), and
// a whisper is leaning over to the adjacent tile. A tick is still an abstract
// effort-beat, never surfaced as clock time: the 100-tick year is narrative
// pacing - never convert ticks to days/minutes in rules or character-facing text.
//
// Sight reaches beyond speech, speech beyond a whisper: you can see someone
// too far away to talk to, and talk to someone too far away to whisper to.
export const SIGHT = 12; // Chebyshev radius perceived each tick.
export const EARSHOT = 6; // Chebyshev radius ordinary speech carries: ~5-6 m of conversation.
export const WHISPER_RANGE = 1; // whispering means leaning in: the adjacent tile.
export const TOUCH_RANGE = 1; // arm's reach: give/hand-off and other adjacent contact.
// The single default edge length for a world whose WorldGen names no dimensions
// (the bare, no-scenario grid). config/config.json supplies the real size; this
// only backstops a gen with no width/height, kept here so config, fallback, and
// admin resets cannot silently disagree.
export const DEFAULT_MAP_SIZE = 64;
const EXPLORE_TILES = 3; // how far explore strikes out.
const SCAN_RANGE = 16; // how far scan reveals along a heading; must outreach SIGHT to stay useful.
const SCAN_DURATION = 6; // ticks a scan occupies the agent.

export interface Position {
  x: number;
  y: number;
}

// Terrain is an open string: a scenario coins whatever kinds it wants ("forest",
// "water", ...). The substrate only cares which kinds are impassable.
export type Terrain = string;

// The grid fill used only when a WorldGen names no defaultTerrain - i.e. the
// bare, no-scenario world. A live game's ground comes from the active scenario's
// defaultTerrain (validated to exist in its terrainSpecs), never this fallback.
export const BARE_FILL: Terrain = "plains";

// A token is a named, tagged location. Tags are what the kernel's `colocated`
// gate matches on (so "stand on a wood token" is a tag check); the name is for
// projection and travel. `kind` mirrors the backing entity's kind - the one
// identity name sprites and labels key off; matching treats it as a tag too.
export interface TokenRef {
  name: string;
  kind?: string;
  tags: string[];
  // Mirrors the backing entity's occupancy, so pathing can tell a wall from a
  // signpost without a lookup back into the world. Always set on a token
  // actually projected onto the grid by syncTokens; absent on the synthetic
  // refs that only ever name a route's goal (an agent being followed, a patch
  // of terrain), which never sit in a tile slot.
  occupancy?: Occupancy;
}
export interface Tile {
  terrain: Terrain;
  token: TokenRef | null;
}
export interface Heading {
  dx: number;
  dy: number;
}
export type DirectionName =
  | "north"
  | "south"
  | "east"
  | "west"
  | "northeast"
  | "northwest"
  | "southeast"
  | "southwest";

// --- WorldGen: the data that shapes a grid ------------------------------

export interface BlobGen {
  terrain: Terrain;
  count?: number; // explicit blob count...
  density?: number; // ...or blobs per 100 tiles, so coverage scales with map area
  maxRadius: number;
}

// --- Terrain layers ------------------------------------------------------
//
// The layered map recipe: an ordered stack of paint passes over the fill, each
// one a generator + a terrain + an optional mask. Layers paint in order, later
// over earlier; a `where.on` mask restricts a layer to tiles whose current
// terrain is in the list (the maze that only stands on the island's grass).
// Each layer draws from its own seed stream derived from (seed, index), so
// tuning one layer never reshuffles what the others drew. Declared on a
// WorldGen as `terrainLayers`, which replaces the legacy blobs recipe when
// present; defaultTerrain still supplies the base fill the stack paints over.

export interface IslandGen {
  size?: number; // landmass radius as a fraction of the map's half-extent (default 0.6)
  roughness?: number; // how far noise wobbles the coastline (default 0.35)
  scale?: number; // coastline noise feature size in tiles (default 5)
}

export interface NoiseGen {
  scale?: number; // noise feature size in tiles (default 6)
  above?: number; // paint where the 0..1 noise field exceeds this (default 0.5)
  octaves?: number; // fBm octaves, more = finer detail (default 2, max 6)
}

// The maze carves 1-wide corridors on the classic odd lattice and paints this
// layer's terrain as the walls everywhere else. No params yet; the empty object
// keeps the authored shape stable when corridor/wall widths arrive.
export type MazeGen = Record<string, never>;

// A layer-stack blob pass: the legacy square patches, minus the terrain (that
// is the layer's) and minus the only-over-fill rule (that is the layer's mask).
export interface PatchGen {
  count?: number; // explicit patch count...
  density?: number; // ...or patches per 100 tiles, scaling with map area
  maxRadius: number;
}

// Exactly one generator key per layer. A bare preset string is shorthand for
// the object form with all-default params ("island" == { island: {} }).
export interface LayerGenSpec {
  fill?: Record<string, never>;
  island?: IslandGen;
  maze?: MazeGen;
  noise?: NoiseGen;
  blobs?: PatchGen;
}
export type LayerPreset = "fill" | "island" | "maze" | "noise";
export type LayerGen = LayerPreset | LayerGenSpec;

export interface TerrainLayer {
  terrain: Terrain;
  gen: LayerGen;
  where?: { on: Terrain[] }; // only paint over tiles currently of these terrains
}

// The post-paint connectivity guarantee: `true` carves corridors of the fill
// terrain, `{carve}` names the corridor terrain (required when the fill itself
// is impassable - an island map's fill is the sea).
export type WorldGenConnect = boolean | { carve: Terrain };

// Shape-check an authored terrainLayers value. Scenario JSON never passes
// through tsc, so a malformed layer (two gen keys, a typoed preset, a blobs
// pass with no count) must fail at load time with the layer index attached,
// not as a silently blank map. Strict on unknown keys to catch typos.
export function assertValidTerrainLayers(
  value: unknown,
): asserts value is TerrainLayer[] {
  if (!Array.isArray(value))
    throw new Error("terrainLayers must be an array of layers.");
  value.forEach((layer, index) => {
    let at = `terrainLayers[${index}]`;
    if (!layer || typeof layer !== "object" || Array.isArray(layer))
      throw new Error(`${at} must be an object.`);
    for (let key of Object.keys(layer))
      if (!["terrain", "gen", "where"].includes(key))
        throw new Error(`${at} has unknown key "${key}".`);
    let { terrain, gen, where } = layer as {
      terrain?: unknown;
      gen?: unknown;
      where?: unknown;
    };
    if (typeof terrain !== "string" || !terrain)
      throw new Error(`${at}.terrain must be a terrain name.`);
    assertValidLayerGen(at, gen);
    if (where !== undefined) {
      if (!where || typeof where !== "object" || Array.isArray(where))
        throw new Error(`${at}.where must be an object like {"on": [...]}.`);
      for (let key of Object.keys(where))
        if (key !== "on")
          throw new Error(`${at}.where has unknown key "${key}".`);
      let on = (where as { on?: unknown }).on;
      if (
        !Array.isArray(on) ||
        on.length === 0 ||
        on.some((t) => typeof t !== "string" || !t)
      )
        throw new Error(
          `${at}.where.on must be a non-empty array of terrain names.`,
        );
    }
  });
}

const LAYER_PRESET_NAMES = new Set(["fill", "island", "maze", "noise"]);

function assertValidLayerGen(at: string, gen: unknown): void {
  if (typeof gen === "string") {
    if (!LAYER_PRESET_NAMES.has(gen))
      throw new Error(
        `${at}.gen preset "${gen}" is unknown - use fill, island, maze, or noise (blobs needs params, so it has no preset form).`,
      );
    return;
  }
  if (!gen || typeof gen !== "object" || Array.isArray(gen))
    throw new Error(`${at}.gen must be a preset name or a one-key object.`);
  let keys = Object.keys(gen);
  let known = ["fill", "island", "maze", "noise", "blobs"];
  if (keys.length !== 1 || !known.includes(keys[0]))
    throw new Error(`${at}.gen must have exactly one of: ${known.join(", ")}.`);
  let kind = keys[0];
  let params = (gen as Record<string, unknown>)[kind];
  if (!params || typeof params !== "object" || Array.isArray(params))
    throw new Error(
      `${at}.gen.${kind} must be an object (use {} for defaults).`,
    );
  let numeric = (name: string, value: unknown, min: number) => {
    if (value === undefined) return;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min)
      throw new Error(
        `${at}.gen.${kind}.${name} must be a number of at least ${min}.`,
      );
  };
  let entries = params as Record<string, unknown>;
  let allow = (names: string[]) => {
    for (let key of Object.keys(entries))
      if (!names.includes(key))
        throw new Error(`${at}.gen.${kind} has unknown param "${key}".`);
  };
  if (kind === "fill" || kind === "maze") allow([]);
  if (kind === "island") {
    allow(["size", "roughness", "scale"]);
    numeric("size", entries.size, 0.05);
    numeric("roughness", entries.roughness, 0);
    numeric("scale", entries.scale, 1);
  }
  if (kind === "noise") {
    allow(["scale", "above", "octaves"]);
    numeric("scale", entries.scale, 1);
    numeric("above", entries.above, -1);
    let octaves = entries.octaves;
    if (
      octaves !== undefined &&
      (typeof octaves !== "number" ||
        !Number.isInteger(octaves) ||
        octaves < 1 ||
        octaves > 6)
    )
      throw new Error(
        `${at}.gen.noise.octaves must be an integer from 1 to 6.`,
      );
  }
  if (kind === "blobs") {
    allow(["count", "density", "maxRadius"]);
    numeric("count", entries.count, 0);
    numeric("density", entries.density, 0);
    if (
      typeof entries.maxRadius !== "number" ||
      !Number.isInteger(entries.maxRadius) ||
      entries.maxRadius < 1
    )
      throw new Error(
        `${at}.gen.blobs.maxRadius must be an integer of at least 1.`,
      );
    if (entries.count === undefined && entries.density === undefined)
      throw new Error(`${at}.gen.blobs needs a count or a density.`);
  }
}

export function assertValidConnect(
  value: unknown,
): asserts value is WorldGenConnect {
  if (typeof value === "boolean") return;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    let keys = Object.keys(value);
    let carve = (value as { carve?: unknown }).carve;
    if (keys.length === 1 && typeof carve === "string" && carve) return;
  }
  throw new Error('connect must be true, false, or {"carve": "<terrain>"}.');
}

// A number a scatter spec may give as a fixed value or a [lo, hi] range the
// generator rolls within (seeded). Lets procedurally-placed tokens vary their
// reserves without the scenario pinning every one by hand.
export type ScatterNum = number | [number, number];

export interface ScatterStock {
  value: ScatterNum; // starting reserve (rolled if a range)
  min?: number; // floor, default 0
  max?: ScatterNum; // capacity (rolled if a range), default = value
  icon?: string; // the resource's game-icons slug, registered by the engine
  color?: string; // optional CSS hex tint for the icon
}

// A spec for scattering a *kind* of token across the map (e.g. "wood groves on
// forest"), the procedural counterpart to the hand-placed `tokens` list. The
// generator turns one of these into many concrete TokenGen entries, so the same
// scenario fills a 21x21 or an 81x81 map without listing coordinates.
export interface TokenScatter {
  namePrefix: string; // generated tokens are <prefix>-1, <prefix>-2, ...
  kind?: string; // what each token IS ("tree", "boulder") - feeds sprite/label
  tags: string[]; // e.g. ["wood"] - the gather gate matches these
  // A scattered token is on the map by definition, so this only chooses whether
  // it also blocks routes; "tile" when omitted.
  occupancy?: Occupancy;
  count?: number; // explicit count...
  density?: number; // ...or tokens per 100 tiles of area (resources: local availability constant)...
  edgeDensity?: number; // ...or tokens per 100 tiles of average edge (threats/POIs: encounter rate along a journey)
  onTerrain?: Terrain[]; // only place on these terrains (e.g. ["forest"])
  terrain?: Terrain; // override the tile's terrain where a token lands
  minSpacing?: number; // keep generated tokens at least this far apart (Chebyshev)
  spawnKeepout?: number; // never place within this radius of spawn
  stocks?: Record<string, ScatterStock>; // per-token reserves, rolled per token
}

export interface TokenGen {
  name: string;
  kind?: string;
  tags: string[];
  occupancy?: Occupancy; // "tile" when omitted, as for TokenScatter
  x: number;
  y: number;
  terrain?: Terrain; // override the tile's terrain where the token sits
  // Per-token starting reserves (e.g. a forest's wood). The substrate ignores
  // these - createWorld() instantiates them as stocks on the token entity so the
  // token can be drained and run dry. Untyped here to keep space.ts spatial-only.
  stocks?: Record<
    string,
    {
      value: number;
      min?: number;
      max?: number;
      icon?: string;
      color?: string;
    }
  >;
}
export interface WorldGen {
  width: number;
  height: number;
  seed?: number;
  defaultTerrain?: Terrain; // the fill the grid starts as (default "plains")
  blobs?: BlobGen[]; // scattered terrain patches, painted in order
  terrainLayers?: TerrainLayer[]; // the layered paint recipe; replaces blobs when present
  connect?: WorldGenConnect; // carve corridors so every passable tile is reachable
  tokens?: TokenGen[]; // fixed named locations
  tokenScatter?: TokenScatter[]; // procedurally placed tokens, resolved by expandWorldGen
  // Compiled terrain policy. Authored scenarios should prefer TerrainSpec-style
  // data, then call worldgenWithTerrainPolicy before making a grid.
  impassable?: Terrain[]; // terrains an agent cannot enter
  terrainCost?: Record<Terrain, number>;
}

export interface TerrainPolicySpec {
  passable?: boolean;
  moveCost?: number;
}

export function assertValidMoveCost(
  terrain: string,
  moveCost: unknown,
): asserts moveCost is number {
  if (
    typeof moveCost !== "number" ||
    !Number.isFinite(moveCost) ||
    !Number.isInteger(moveCost) ||
    moveCost < 1
  )
    throw new Error(
      `Terrain "${terrain}" moveCost must be a finite integer of at least 1.`,
    );
}

export function worldgenWithTerrainPolicy(
  gen: WorldGen | undefined,
  terrainSpecs: Record<Terrain, TerrainPolicySpec> | undefined,
): WorldGen | undefined {
  for (let [terrain, moveCost] of Object.entries(gen?.terrainCost ?? {}))
    assertValidMoveCost(terrain, moveCost);
  if (!terrainSpecs) return gen;
  let impassable = new Set<Terrain>(gen?.impassable ?? []);
  let terrainCost: Record<Terrain, number> = { ...(gen?.terrainCost ?? {}) };

  for (let [terrain, spec] of Object.entries(terrainSpecs)) {
    if (spec.passable === false) impassable.add(terrain);
    else if (spec.passable === true) impassable.delete(terrain);
    if (spec.moveCost !== undefined) {
      assertValidMoveCost(terrain, spec.moveCost);
      terrainCost[terrain] = spec.moveCost;
    }
  }

  if (!gen)
    return {
      width: DEFAULT_MAP_SIZE,
      height: DEFAULT_MAP_SIZE,
      impassable: [...impassable],
      terrainCost,
    };
  return { ...gen, impassable: [...impassable], terrainCost };
}

const DIRECTIONS: Record<DirectionName, Heading> = {
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 },
  east: { dx: 1, dy: 0 },
  west: { dx: -1, dy: 0 },
  northeast: { dx: 1, dy: -1 },
  northwest: { dx: -1, dy: -1 },
  southeast: { dx: 1, dy: 1 },
  southwest: { dx: -1, dy: 1 },
};

// --- Grid generation ----------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GridToken extends TokenRef {
  x: number;
  y: number;
}

export interface Grid {
  width: number;
  height: number;
  // Absolute coordinate of tiles[0][0]. West/north growth moves this origin
  // outward instead of renumbering anything already in the world.
  origin?: Position;
  spawn: Position;
  fill: Terrain; // the default terrain; tiles still set to it are "empty"/unremarkable
  tiles: Tile[][];
  tokens: GridToken[];
  impassable: Set<Terrain>;
  terrainCost: Map<Terrain, number>; // ticks to enter a tile of each terrain (default 1)
}

function inBoundsOf(
  grid: Grid | { width: number; height: number; origin?: Position },
  x: number,
  y: number,
): boolean {
  let origin = grid.origin ?? { x: 0, y: 0 };
  return (
    x >= origin.x &&
    y >= origin.y &&
    x < origin.x + grid.width &&
    y < origin.y + grid.height
  );
}

function tileIndexes(grid: Grid, x: number, y: number): Position {
  let origin = grid.origin ?? { x: 0, y: 0 };
  return { x: x - origin.x, y: y - origin.y };
}

function key(x: number, y: number): string {
  return `${x},${y}`;
}

// Resolve a "count or density" spec against the map: an explicit count wins,
// then edgeDensity (items per 100 tiles of average edge, so threats/POIs scale
// with journey length not area), then density (items per 100 tiles of area, so
// resource availability stays locally constant as the map grows). `edge` is only
// consulted for edgeDensity, so area-only callers (blobs) may omit it.
function resolveCount(
  spec: { count?: number; density?: number; edgeDensity?: number },
  area: number,
  edge?: number,
): number {
  if (spec.count !== undefined) return spec.count;
  if (spec.edgeDensity !== undefined && edge !== undefined)
    return Math.max(0, Math.round((edge / 100) * spec.edgeDensity));
  if (spec.density !== undefined)
    return Math.max(0, Math.round((area / 100) * spec.density));
  return 0;
}

function blankTiles(width: number, height: number, fill: Terrain): Tile[][] {
  let tiles: Tile[][] = [];
  for (let y = 0; y < height; y += 1) {
    let row: Tile[] = [];
    for (let x = 0; x < width; x += 1) row.push({ terrain: fill, token: null });
    tiles.push(row);
  }
  return tiles;
}

// Extend one edge in place with blank default terrain. The grid's signed origin
// moves for north/west growth, so existing tiles, entities, fog, and routes keep
// their absolute coordinates. Omitting direction retains the original east-plus-
// south growth. New tiles belong to no agent's fog and arrive unrevealed.
export function growGrid(
  grid: Grid,
  by: number,
  direction?: MapEdge,
): { width: number; height: number; grew: boolean } {
  let steps = Math.max(0, Math.floor(by));
  if (steps === 0)
    return { width: grid.width, height: grid.height, grew: false };
  let directions: MapEdge[] = direction ? [direction] : ["east", "south"];
  let origin = grid.origin ?? { x: 0, y: 0 };

  for (let edge of directions) {
    if (edge === "west") {
      let columns = blankTiles(steps, grid.height, grid.fill);
      for (let rowIndex = 0; rowIndex < grid.height; rowIndex += 1)
        grid.tiles[rowIndex] = columns[rowIndex].concat(grid.tiles[rowIndex]);
      grid.width += steps;
      origin.x -= steps;
      continue;
    }
    if (edge === "east") {
      for (let row of grid.tiles)
        for (let step = 0; step < steps; step += 1)
          row.push({ terrain: grid.fill, token: null });
      grid.width += steps;
      continue;
    }
    if (edge === "north") {
      grid.tiles = blankTiles(grid.width, steps, grid.fill).concat(grid.tiles);
      grid.height += steps;
      origin.y -= steps;
      continue;
    }
    for (let row of blankTiles(grid.width, steps, grid.fill))
      grid.tiles.push(row);
    grid.height += steps;
  }
  grid.origin = origin;
  return { width: grid.width, height: grid.height, grew: true };
}

// Paint terrain blobs into a fresh tile grid. Only overwrites still-fill tiles so
// earlier blobs aren't clobbered, and pulls counts from the shared `rand` stream
// so the same seed reproduces the same map. Factored out so expandWorldGen can
// repaint the identical terrain when it needs to know what's under each tile.
function paintBlobs(
  tiles: Tile[][],
  blobs: BlobGen[],
  width: number,
  height: number,
  fill: Terrain,
  rand: () => number,
) {
  for (let blob of blobs) {
    let count = resolveCount(blob, width * height);
    for (let i = 0; i < count; i += 1) {
      let cx = Math.floor(rand() * width);
      let cy = Math.floor(rand() * height);
      let radius = 1 + Math.floor(rand() * blob.maxRadius);
      for (let y = cy - radius; y <= cy + radius; y += 1)
        for (let x = cx - radius; x <= cx + radius; x += 1) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          if (tiles[y][x].terrain === fill) tiles[y][x].terrain = blob.terrain;
        }
    }
  }
}

// --- Terrain layer painting ----------------------------------------------

// A 32-bit avalanche (the murmur3 finalizer): the workhorse behind per-layer
// seed derivation and the noise lattice, so nearby inputs land far apart.
function mix32(value: number): number {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

// Each layer's own seed, derived from (world seed, layer index): tuning or
// removing one layer never reshuffles what the layers around it drew.
function layerSeed(seed: number, index: number): number {
  return mix32(((seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0);
}

// Value noise: a hashed lattice bilinearly interpolated with smoothstep, in
// [0, 1). Pure in (seed, x, y), which is what lets a grown frontier or a
// repaint sample the identical field.
function latticeHash(seed: number, ix: number, iy: number): number {
  return (
    mix32(mix32(seed ^ Math.imul(ix, 0x27d4eb2f)) ^ Math.imul(iy, 0x165667b1)) /
    4294967296
  );
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(seed: number, x: number, y: number): number {
  let ix = Math.floor(x);
  let iy = Math.floor(y);
  let sx = smoothstep(x - ix);
  let sy = smoothstep(y - iy);
  let top =
    latticeHash(seed, ix, iy) +
    (latticeHash(seed, ix + 1, iy) - latticeHash(seed, ix, iy)) * sx;
  let bottom =
    latticeHash(seed, ix, iy + 1) +
    (latticeHash(seed, ix + 1, iy + 1) - latticeHash(seed, ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

function fbm(seed: number, x: number, y: number, octaves: number): number {
  let total = 0;
  let norm = 0;
  let amplitude = 1;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    total +=
      valueNoise(mix32(seed + octave), x * frequency, y * frequency) *
      amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / norm;
}

const LAYER_GEN_KEYS = ["fill", "island", "maze", "noise", "blobs"] as const;
type LayerGenKind = (typeof LAYER_GEN_KEYS)[number];

// Resolve a layer's gen to (kind, params): a preset string is the object form
// with default params. Assumes the shape already passed assertValidTerrainLayers.
function normalizeLayerGen(gen: LayerGen): {
  kind: LayerGenKind;
  params: Record<string, unknown>;
} {
  if (typeof gen === "string") return { kind: gen, params: {} };
  let kind = LAYER_GEN_KEYS.find((key) => gen[key] !== undefined)!;
  return { kind, params: (gen[kind] ?? {}) as Record<string, unknown> };
}

// Classic recursive-backtracker maze on the odd lattice: passage cells sit at
// odd (x, y), walls between and around them. Cells whose passage tile fails
// the layer mask are left out of the maze graph entirely, so a masked maze
// grows only inside its region; disconnected regions each get their own maze
// (the connect pass can join them). Returns wall[y][x] over the whole grid -
// true wherever this layer should paint its wall terrain.
function mazeWalls(
  width: number,
  height: number,
  rand: () => number,
  inMaze: (x: number, y: number) => boolean,
): boolean[][] {
  let wall: boolean[][] = [];
  for (let y = 0; y < height; y += 1) wall.push(new Array(width).fill(true));
  let cellsX = (width - 1) >> 1;
  let cellsY = (height - 1) >> 1;
  if (cellsX < 1 || cellsY < 1) return wall;
  let visited: boolean[][] = [];
  for (let cy = 0; cy < cellsY; cy += 1)
    visited.push(new Array(cellsX).fill(false));
  let cellOpen = (cx: number, cy: number) =>
    cx >= 0 &&
    cy >= 0 &&
    cx < cellsX &&
    cy < cellsY &&
    inMaze(2 * cx + 1, 2 * cy + 1);
  const CARDINALS = [
    { dx: 0, dy: -1 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: -1, dy: 0 },
  ];

  for (let sy = 0; sy < cellsY; sy += 1)
    for (let sx = 0; sx < cellsX; sx += 1) {
      if (visited[sy][sx] || !cellOpen(sx, sy)) continue;
      visited[sy][sx] = true;
      wall[2 * sy + 1][2 * sx + 1] = false;
      let stack = [{ x: sx, y: sy }];
      while (stack.length > 0) {
        let top = stack[stack.length - 1];
        let options = CARDINALS.filter(
          (dir) =>
            cellOpen(top.x + dir.dx, top.y + dir.dy) &&
            !visited[top.y + dir.dy][top.x + dir.dx],
        );
        if (options.length === 0) {
          stack.pop();
          continue;
        }
        let dir = options[Math.floor(rand() * options.length)];
        let nx = top.x + dir.dx;
        let ny = top.y + dir.dy;
        visited[ny][nx] = true;
        wall[2 * top.y + 1 + dir.dy][2 * top.x + 1 + dir.dx] = false;
        wall[2 * ny + 1][2 * nx + 1] = false;
        stack.push({ x: nx, y: ny });
      }
    }
  return wall;
}

// Paint one layer of the stack onto the tiles. The mask gates every write: a
// tile only takes the layer's terrain if its *current* terrain is in where.on
// (or there is no mask), which is what lets a maze stand only on the island.
//
// `offset` is the world coordinate of tiles[0][0]: the position-pure fields
// (noise, island's wobble) sample at world coordinates so a grown frontier
// continues the same field. It defaults to origin so the initial full paint is
// byte-identical. `only` restricts writes to tiles a predicate accepts (local
// indexes) - the frontier repaint passes the new-tile mask so the existing map
// is left untouched. The globally-scoped kinds (island's shape, blobs, maze)
// are tied to the whole grid and cannot extend a frontier without re-rolling
// the existing map, so they no-op whenever `only` is set.
function paintLayer(
  tiles: Tile[][],
  layer: TerrainLayer,
  index: number,
  width: number,
  height: number,
  seed: number,
  offset: Position = { x: 0, y: 0 },
  only?: (x: number, y: number) => boolean,
) {
  let { kind, params } = normalizeLayerGen(layer.gen);
  if (only && (kind === "island" || kind === "blobs" || kind === "maze"))
    return;
  let lseed = layerSeed(seed, index);
  let mask = layer.where?.on ? new Set(layer.where.on) : null;
  let may = (x: number, y: number) =>
    mask === null || mask.has(tiles[y][x].terrain);
  let put = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (only && !only(x, y)) return;
    if (may(x, y)) tiles[y][x].terrain = layer.terrain;
  };

  if (kind === "fill") {
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) put(x, y);
  } else if (kind === "noise") {
    let scale = (params.scale as number) ?? 6;
    let above = (params.above as number) ?? 0.5;
    let octaves = (params.octaves as number) ?? 2;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1)
        if (
          fbm(lseed, (offset.x + x) / scale, (offset.y + y) / scale, octaves) >=
          above
        )
          put(x, y);
  } else if (kind === "island") {
    let size = (params.size as number) ?? 0.6;
    let roughness = (params.roughness as number) ?? 0.35;
    let scale = (params.scale as number) ?? 5;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        let nx = (x - (width - 1) / 2) / (width / 2);
        let ny = (y - (height - 1) / 2) / (height / 2);
        let distance = Math.sqrt(nx * nx + ny * ny);
        let wobble =
          fbm(lseed, (offset.x + x) / scale, (offset.y + y) / scale, 2) - 0.5;
        if (distance <= size + roughness * wobble) put(x, y);
      }
  } else if (kind === "blobs") {
    let rand = mulberry32(lseed);
    let count = resolveCount(
      params as { count?: number; density?: number },
      width * height,
    );
    let maxRadius = params.maxRadius as number;
    for (let i = 0; i < count; i += 1) {
      let cx = Math.floor(rand() * width);
      let cy = Math.floor(rand() * height);
      let radius = 1 + Math.floor(rand() * maxRadius);
      for (let y = cy - radius; y <= cy + radius; y += 1)
        for (let x = cx - radius; x <= cx + radius; x += 1) put(x, y);
    }
  } else if (kind === "maze") {
    let wall = mazeWalls(width, height, mulberry32(lseed), may);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) if (wall[y][x]) put(x, y);
  }
}

// Repaint just the tiles a `growGrid` call added, resampling the terrain-layer
// stack at their WORLD coordinates so a grown edge continues the same field
// instead of arriving as flat fill. `original` is the world rectangle the map
// covered before growth; any tile outside it is fresh frontier. Only the
// position-pure layers (noise, fill) carry across a frontier - paintLayer skips
// the grid-scoped kinds (island, blobs, maze), which would need the whole map
// re-rolled. Existing tiles keep their terrain because the new-tile mask gates
// every write. A no-op when the recipe has no layers (the legacy blobs path and
// the bare fallback both grow as flat fill, unchanged).
export function extendTerrain(
  grid: Grid,
  recipe: { terrainLayers?: TerrainLayer[]; seed: number },
  original: { x: number; y: number; width: number; height: number },
) {
  if (!recipe.terrainLayers?.length) return;
  let origin = grid.origin ?? { x: 0, y: 0 };
  let isNew = (localX: number, localY: number) => {
    let wx = origin.x + localX;
    let wy = origin.y + localY;
    return (
      wx < original.x ||
      wy < original.y ||
      wx >= original.x + original.width ||
      wy >= original.y + original.height
    );
  };
  for (let [index, layer] of recipe.terrainLayers.entries())
    paintLayer(
      grid.tiles,
      layer,
      index,
      grid.width,
      grid.height,
      recipe.seed,
      origin,
      isNew,
    );
}

// The connectivity guarantee behind WorldGen.connect: flood the passable tiles,
// then carve minimal corridors from every stranded pocket to the largest
// region, so a maze, a noise field, or an unlucky blob roll can never wall off
// the spawn or a victory token. Entering a passable tile costs 0 and an
// impassable one costs 1, so each corridor converts the fewest tiles possible.
// Deterministic: no randomness, ties break in row-major scan order.
function connectTiles(
  tiles: Tile[][],
  gen: WorldGen,
  width: number,
  height: number,
  fill: Terrain,
) {
  let impassable = new Set<Terrain>(gen.impassable ?? []);
  if (impassable.size === 0) return;
  let carve =
    gen.connect === true ? fill : (gen.connect as { carve: Terrain }).carve;
  if (impassable.has(carve))
    throw new Error(
      gen.connect === true
        ? `"connect": true carves with the fill terrain "${carve}", which is impassable - use {"carve": "<passable terrain>"} instead.`
        : `connect.carve terrain "${carve}" is impassable - corridors must be walkable.`,
    );

  let open = (x: number, y: number) => !impassable.has(tiles[y][x].terrain);
  let at = (x: number, y: number) => y * width + x;

  // Label the connected components of passable tiles (8-direction, matching
  // movement).
  let component = new Int32Array(width * height).fill(-1);
  let sizes: number[] = [];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (!open(x, y) || component[at(x, y)] !== -1) continue;
      let label = sizes.length;
      let queue = [{ x, y }];
      component[at(x, y)] = label;
      let size = 0;
      while (queue.length > 0) {
        let current = queue.pop()!;
        size += 1;
        for (let dir of Object.values(DIRECTIONS)) {
          let nx = current.x + dir.dx;
          let ny = current.y + dir.dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (!open(nx, ny) || component[at(nx, ny)] !== -1) continue;
          component[at(nx, ny)] = label;
          queue.push({ x: nx, y: ny });
        }
      }
      sizes.push(size);
    }
  if (sizes.length <= 1) return;

  let base = sizes.indexOf(Math.max(...sizes));

  // Multi-source Dijkstra out of the base region over ALL tiles, impassable
  // ones at cost 1 - the cheapest route from anywhere back into the base is
  // the corridor that disturbs the map least.
  let dist = new Float64Array(width * height).fill(Infinity);
  let cameFrom = new Int32Array(width * height).fill(-1);
  let heap = new MinHeap();
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      if (component[at(x, y)] === base) {
        dist[at(x, y)] = 0;
        heap.push(at(x, y), 0);
      }
  while (heap.size() > 0) {
    let current = heap.pop();
    if (current.prio > dist[current.node]) continue; // stale entry
    let cx = current.node % width;
    let cy = (current.node - cx) / width;
    for (let dir of Object.values(DIRECTIONS)) {
      let nx = cx + dir.dx;
      let ny = cy + dir.dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      let next = current.prio + (open(nx, ny) ? 0 : 1);
      if (next >= dist[at(nx, ny)]) continue;
      dist[at(nx, ny)] = next;
      cameFrom[at(nx, ny)] = current.node;
      heap.push(at(nx, ny), next);
    }
  }

  // Walk each stranded region's cheapest entry back to the base, converting
  // the impassable tiles along the way into the carve terrain.
  for (let label = 0; label < sizes.length; label += 1) {
    if (label === base) continue;
    let best = -1;
    for (let index = 0; index < component.length; index += 1)
      if (
        component[index] === label &&
        (best === -1 || dist[index] < dist[best])
      )
        best = index;
    for (let index = best; index !== -1; index = cameFrom[index]) {
      let x = index % width;
      let y = Math.floor(index / width);
      if (!open(x, y)) tiles[y][x].terrain = carve;
    }
  }
}

// Paint a fresh tile grid the way this WorldGen says: the terrainLayers stack
// when one is declared, else the legacy blobs recipe, then the optional
// connect pass. The single painter behind makeGrid, expandWorldGen, and
// pickSpawn, so the real map, the scatter's terrain reads, and the spawn pick
// can never drift apart. `sharedRand` is expandWorldGen's blob stream (its
// scatter continues on the same stream after the blobs are painted); the
// layers path ignores it - each layer derives its own stream from (seed, index).
export function paintedTiles(
  gen: WorldGen | undefined,
  width: number,
  height: number,
  fill: Terrain,
  sharedRand?: () => number,
): Tile[][] {
  let tiles = blankTiles(width, height, fill);
  if (gen?.terrainLayers?.length) {
    let seed = gen.seed ?? 1;
    for (let [index, layer] of gen.terrainLayers.entries())
      paintLayer(tiles, layer, index, width, height, seed);
  } else if (
    gen?.blobs?.length &&
    (sharedRand !== undefined || gen.seed !== undefined)
  ) {
    paintBlobs(
      tiles,
      gen.blobs,
      width,
      height,
      fill,
      sharedRand ?? mulberry32(gen.seed!),
    );
  }
  if (gen?.connect) connectTiles(tiles, gen, width, height, fill);
  return tiles;
}

// Build a grid from a WorldGen. With no WorldGen, a bare passable grid
// (DEFAULT_MAP_SIZE square) of the fill terrain - exactly the empty world an agent joins when the
// scenario has no rules. The RNG/blob/token order is fixed so a given seed
// reproduces the same map every run. Any tokenScatter is assumed already resolved
// into `tokens` by expandWorldGen - makeGrid only places concrete tokens. The map
// is never edited to fit the spawn - pickSpawn chooses a tile with a clear
// neighborhood instead.
function makeGrid(spawn: Position, gen?: WorldGen): Grid {
  let width = gen?.width ?? DEFAULT_MAP_SIZE;
  let height = gen?.height ?? DEFAULT_MAP_SIZE;
  let fill = gen?.defaultTerrain ?? BARE_FILL;
  let impassable = new Set<Terrain>(gen?.impassable ?? []);

  let tiles = paintedTiles(gen, width, height, fill);

  let tokens: GridToken[] = [];
  for (let s of gen?.tokens ?? []) {
    let tile = tiles[s.y][s.x];
    tile.token = {
      name: s.name,
      kind: s.kind,
      tags: s.tags,
      occupancy: s.occupancy ?? "tile",
    };
    if (s.terrain !== undefined) tile.terrain = s.terrain;
    tokens.push({
      name: s.name,
      kind: s.kind,
      tags: s.tags,
      occupancy: s.occupancy ?? "tile",
      x: s.x,
      y: s.y,
    });
  }

  let terrainCosts = Object.entries(gen?.terrainCost ?? {});
  for (let [terrain, moveCost] of terrainCosts)
    assertValidMoveCost(terrain, moveCost);
  let terrainCost = new Map<Terrain, number>(terrainCosts);
  return {
    width,
    height,
    origin: { x: 0, y: 0 },
    spawn: { ...spawn },
    fill,
    tiles,
    tokens,
    impassable,
    terrainCost,
  };
}

// Roll a ScatterNum: a fixed value passes through, a [lo, hi] range draws an
// integer within it (inclusive) from the seeded stream.
function rollNum(rand: () => number, v: ScatterNum): number {
  return Array.isArray(v) ? v[0] + Math.floor(rand() * (v[1] - v[0] + 1)) : v;
}

function rollStocks(
  specs: Record<string, ScatterStock> | undefined,
  rand: () => number,
): TokenGen["stocks"] {
  let out: NonNullable<TokenGen["stocks"]> = {};
  for (let [name, s] of Object.entries(specs ?? {})) {
    let value = rollNum(rand, s.value);
    let max = s.max !== undefined ? rollNum(rand, s.max) : value;
    out[name] = {
      value,
      min: s.min ?? 0,
      max: Math.max(value, max),
      ...(s.icon !== undefined ? { icon: s.icon } : {}),
      ...(s.color !== undefined ? { color: s.color } : {}),
    };
  }
  return out;
}

export function scatterOnGrid(
  grid: Grid,
  spawn: Position,
  specs: TokenScatter[],
  seedOrRandom: number | (() => number),
  occupiedPositions: Position[] = [],
): TokenGen[] {
  let occupied = new Set([
    ...grid.tokens.map((token) => key(token.x, token.y)),
    ...occupiedPositions.map((position) => key(position.x, position.y)),
  ]);
  let area = grid.width * grid.height;
  let edge = (grid.width + grid.height) / 2;
  let rand =
    typeof seedOrRandom === "number" ? mulberry32(seedOrRandom) : seedOrRandom;
  let scattered: TokenGen[] = [];

  for (let spec of specs) {
    let want = resolveCount(spec, area, edge);
    let keepout = spec.spawnKeepout ?? 0;
    let spacing = spec.minSpacing ?? 0;
    let onTerrain = spec.onTerrain ? new Set(spec.onTerrain) : null;
    let placed: Position[] = [];

    let candidates: Position[] = [];
    let origin = grid.origin ?? { x: 0, y: 0 };
    for (let rowIndex = 0; rowIndex < grid.height; rowIndex += 1)
      for (let columnIndex = 0; columnIndex < grid.width; columnIndex += 1) {
        let x = origin.x + columnIndex;
        let y = origin.y + rowIndex;
        let terrain = grid.tiles[rowIndex][columnIndex].terrain;
        if (grid.impassable.has(terrain)) continue;
        if (onTerrain && !onTerrain.has(terrain)) continue;
        if (occupied.has(key(x, y))) continue;
        if (chebyshev(x, y, spawn.x, spawn.y) <= keepout) continue;
        candidates.push({ x, y });
      }

    for (
      let candidateIndex = candidates.length - 1;
      candidateIndex > 0;
      candidateIndex -= 1
    ) {
      let randomIndex = Math.floor(rand() * (candidateIndex + 1));
      [candidates[candidateIndex], candidates[randomIndex]] = [
        candidates[randomIndex],
        candidates[candidateIndex],
      ];
    }

    let made = 0;
    for (let candidate of candidates) {
      if (made >= want) break;
      if (
        spacing > 0 &&
        placed.some(
          (position) =>
            chebyshev(position.x, position.y, candidate.x, candidate.y) <
            spacing,
        )
      )
        continue;
      scattered.push({
        name: `${spec.namePrefix}-${made + 1}`,
        kind: spec.kind,
        tags: [...spec.tags],
        occupancy: spec.occupancy,
        x: candidate.x,
        y: candidate.y,
        terrain: spec.terrain,
        stocks: rollStocks(spec.stocks, rand),
      });
      placed.push(candidate);
      occupied.add(key(candidate.x, candidate.y));
      made += 1;
    }
  }

  return scattered;
}

// Resolve a WorldGen's procedural tokenScatter into concrete `tokens`, returning a
// new WorldGen with those entries folded in and `tokenScatter` consumed. This is
// the single place scatter happens, so the host and the test scaffold both feed
// the *same* expanded gen to makeGrid (the map) and to their token-entity loop
// (the drainable stocks) - keeping the two in lockstep. Deterministic: it repaints
// the same terrain makeGrid will (shared seed) to know what's under each tile,
// then scatters on top using the continuing stream.
export function expandWorldGen(gen: WorldGen, spawn: Position): WorldGen {
  if (!gen.tokenScatter?.length) return gen;

  let width = gen.width ?? DEFAULT_MAP_SIZE;
  let height = gen.height ?? DEFAULT_MAP_SIZE;
  let fill = gen.defaultTerrain ?? BARE_FILL;
  let impassable = new Set<Terrain>(gen.impassable ?? []);
  let rand = mulberry32(gen.seed ?? 1);

  // Repaint terrain exactly as makeGrid will, so onTerrain placement reads the
  // real ground. makeGrid uses its own fresh stream, so the extra rolls we make
  // for scatter below don't perturb the terrain it produces.
  let tiles = paintedTiles(gen, width, height, fill, rand);

  let authored = gen.tokens ?? [];
  let grid = {
    width,
    height,
    origin: { x: 0, y: 0 },
    spawn,
    fill,
    tiles,
    tokens: authored.map((token) => ({
      name: token.name,
      kind: token.kind,
      tags: token.tags,
      occupancy: token.occupancy ?? ("tile" as const),
      x: token.x,
      y: token.y,
    })),
    impassable,
    terrainCost: new Map<Terrain, number>(),
  };
  let scattered = scatterOnGrid(grid, spawn, gen.tokenScatter, rand);

  return {
    ...gen,
    tokens: [...authored, ...scattered],
    tokenScatter: undefined,
  };
}

// Roll a spawn tile: a random passable square, chosen from the worldgen seed so a
// given world reproduces the same start every run. Painted terrain decides
// passability, so spawn never lands in water; with no worldgen the whole bare
// grid is fair game. Candidates whose whole radius-2 neighborhood is passable
// are preferred - the camp gets a real clearing without ever editing the map to
// make one (the old spawnClearRadius repainted water to plains; this just picks
// a tile that already fits). Falls back to any-passable if the map is so choked
// that no clearing exists. The stream is derived from (but independent of) the
// seed makeGrid/expandWorldGen use, so picking a spawn never perturbs the map.
export function pickSpawn(gen?: WorldGen): Position {
  let width = gen?.width ?? DEFAULT_MAP_SIZE;
  let height = gen?.height ?? DEFAULT_MAP_SIZE;
  let fill = gen?.defaultTerrain ?? BARE_FILL;
  let impassable = new Set<Terrain>(gen?.impassable ?? []);
  let rand = mulberry32(((gen?.seed ?? 1) ^ 0x9e3779b9) >>> 0);

  // Paint the terrain EXACTLY as makeGrid will - same painter, same streams -
  // so passability is judged against the real map, not a phantom layout. (The
  // old code painted with the choice stream, picking against a map that never
  // existed; the spawnClearRadius surgery then repainted the real map to match.
  // That surgery is gone, so fidelity here is what keeps spawn out of water.)
  // Only the pick among candidates uses the derived `rand` stream.
  let tiles = paintedTiles(gen, width, height, fill);

  let open = (x: number, y: number) => !impassable.has(tiles[y][x].terrain);
  let clearAround = (cx: number, cy: number, radius: number) => {
    for (let y = cy - radius; y <= cy + radius; y += 1)
      for (let x = cx - radius; x <= cx + radius; x += 1)
        if (x < 0 || y < 0 || x >= width || y >= height || !open(x, y))
          return false;
    return true;
  };

  let candidates: Position[] = [];
  let roomy: Position[] = [];
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (!open(x, y)) continue;
      candidates.push({ x, y });
      if (clearAround(x, y, 2)) roomy.push({ x, y });
    }

  let pool = roomy.length ? roomy : candidates;
  if (pool.length === 0)
    return { x: Math.floor(width / 2), y: Math.floor(height / 2) };
  return pool[Math.floor(rand() * pool.length)];
}

// A tile is passable when it is on-map, its terrain is not impassable, and no
// blocking token stands on it. Blocking tokens (a hearth, a wall, the ledger)
// are the one occupancy mechanic beyond terrain: pathing routes around them and
// travel approaches them from an adjacent bank, exactly as it already does for a
// token sunk in impassable ground. Standing is exclusive to open ground, so a
// mist puff or a pile - anything short of "blocking" - never blocks a route.
export function passable(grid: Grid, x: number, y: number): boolean {
  if (!inBoundsOf(grid, x, y)) return false;
  let indexes = tileIndexes(grid, x, y);
  let tile = grid.tiles[indexes.y][indexes.x];
  if (grid.impassable.has(tile.terrain)) return false;
  return !tile.token || tile.token.occupancy !== "blocking";
}

// Ticks to step onto (x, y): the tile's terrain cost, defaulting to 1. Off-map or
// impassable is Infinity - a tile you can never enter. This is the single place
// terrain turns into travel time; everything else (pathfinding, ETA, the per-tile
// dwell while walking) reads it.
export function enterCost(grid: Grid, x: number, y: number): number {
  if (!passable(grid, x, y)) return Infinity;
  return grid.terrainCost.get(tileAt(grid, x, y).terrain) ?? 1;
}

// A reserved per-agent stock that slows travel. Its value (non-negative, floored)
// is added to every tile's enter cost, so a mover carrying `sluggish` of 2 dwells
// two extra ticks on each step. Scenarios drive it however they like - e.g. a
// starving character growing more sluggish as their health falls. Absent or <= 0
// means full speed, so a world that never sets it pays nothing.
export const SLOW_STOCK = "sluggish";
export function moveSlow(entity: Entity): number {
  let v = entity.stocks[SLOW_STOCK]?.value ?? 0;
  return v > 0 ? Math.floor(v) : 0;
}

// Total ticks to walk a path: the sum of each step's enter cost (the start tile,
// already stood on, isn't paid for).
function pathCost(grid: Grid, path: Position[]): number {
  let total = 0;
  for (let step of path) total += enterCost(grid, step.x, step.y);
  return total;
}

function tokenAt(grid: Grid, pos: Position): TokenRef | null {
  if (!inBoundsOf(grid, pos.x, pos.y)) return null;
  return tileAt(grid, pos.x, pos.y).token;
}

function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

// Per-search scratch, sized to the grid and reused across every search. A
// cross-map route on a big grid touches thousands of tiles; allocating (or
// zeroing) that bookkeeping for every call is the constant cost that used to
// dominate, so instead each array cell carries the stamp of the search that
// last wrote it - a fresh search bumps the stamp and every cell is instantly
// "unvisited" again without a clear. Module-level is safe: searches never nest.
let scratch = {
  size: 0,
  stamp: 0,
  seen: new Int32Array(0), // stamp when the node was last opened
  done: new Int32Array(0), // stamp when the node was settled (popped)
  dist: new Float64Array(0), // g-cost this search
  cameFrom: new Int32Array(0),
};

function scratchFor(grid: Grid) {
  let size = grid.width * grid.height;
  if (scratch.size < size) {
    scratch.size = size;
    scratch.seen = new Int32Array(size);
    scratch.done = new Int32Array(size);
    scratch.dist = new Float64Array(size);
    scratch.cameFrom = new Int32Array(size);
    scratch.stamp = 0;
  }
  if (scratch.stamp === 0x7fffffff) {
    scratch.seen.fill(0);
    scratch.done.fill(0);
    scratch.stamp = 0;
  }
  scratch.stamp += 1;
  return scratch;
}

// Beyond this many goals, scanning the goal set per node for the heuristic
// costs more than the guidance is worth; fall back to plain Dijkstra (still
// exact, still early-exiting at the first goal settled).
const MULTI_GOAL_HEURISTIC_CAP = 16;

// Least-time path from `start` to the cheapest-to-reach of `goals`, over
// passable tiles (eight-direction), weighted by each tile's enter cost - so a
// route bends around slow ground (hills, forest) when a longer-but-faster way
// exists. A* with a Chebyshev heuristic: a diagonal step costs the same as a
// cardinal one and every entered tile costs at least 1, so the straight-line
// tile distance to the nearest goal never overestimates - the search stays
// exact but expands toward the goal instead of flooding the map ring by ring
// the way plain Dijkstra did. The heuristic is also consistent (one step can
// shrink it by at most 1), so a node is settled the first time it pops.
// Returns the steps after `start` to whichever goal is cheapest, [] when
// already standing on one, or null when none is reachable. Impassable goals
// are simply ignored. Ties break deterministically (fixed neighbor order,
// deterministic heap).
function findPathToAny(
  grid: Grid,
  start: Position,
  goals: Position[],
): Position[] | null {
  let reachable = goals.filter((goal) => passable(grid, goal.x, goal.y));
  if (reachable.length === 0) return null;
  if (reachable.some((goal) => goal.x === start.x && goal.y === start.y))
    return [];

  let width = grid.width;
  let origin = grid.origin ?? { x: 0, y: 0 };
  let at = (x: number, y: number) => (y - origin.y) * width + (x - origin.x);
  let h: (x: number, y: number) => number =
    reachable.length > MULTI_GOAL_HEURISTIC_CAP
      ? () => 0
      : (x, y) => {
          let best = Infinity;
          for (let goal of reachable) {
            let d = chebyshev(x, y, goal.x, goal.y);
            if (d < best) best = d;
          }
          return best;
        };

  let goalSet = new Set(reachable.map((goal) => at(goal.x, goal.y)));
  let { stamp, seen, done, dist, cameFrom } = scratchFor(grid);
  let heap = new MinHeap();
  let startNode = at(start.x, start.y);
  seen[startNode] = stamp;
  dist[startNode] = 0;
  cameFrom[startNode] = -1;
  heap.push(startNode, h(start.x, start.y));

  while (heap.size() > 0) {
    let node = heap.pop().node;
    if (done[node] === stamp) continue; // stale duplicate heap entry
    done[node] = stamp;
    if (goalSet.has(node)) {
      let path: Position[] = [];
      for (let n = node; n !== startNode; n = cameFrom[n]) {
        let columnIndex = n % width;
        path.push({
          x: origin.x + columnIndex,
          y: origin.y + (n - columnIndex) / width,
        });
      }
      return path.reverse();
    }
    let columnIndex = node % width;
    let x = origin.x + columnIndex;
    let y = origin.y + (node - columnIndex) / width;
    for (let dir of Object.values(DIRECTIONS)) {
      let nx = x + dir.dx;
      let ny = y + dir.dy;
      let step = enterCost(grid, nx, ny);
      if (!Number.isFinite(step)) continue;
      let nd = dist[node] + step;
      let n = at(nx, ny);
      if (seen[n] === stamp && nd >= dist[n]) continue;
      seen[n] = stamp;
      dist[n] = nd;
      cameFrom[n] = node;
      heap.push(n, nd + h(nx, ny));
    }
  }
  return null;
}

function findPath(
  grid: Grid,
  start: Position,
  goal: Position,
): Position[] | null {
  return findPathToAny(grid, start, [goal]);
}

// Route to a token you cannot stand on. Many tokens sit on impassable ground -
// a waterhole on a pond, a well sunk in rock - yet are meant to be used from
// beside them (draw_water only asks you to be adjacent). findPath refuses an
// impassable goal outright, so travelling straight to the token's tile always
// failed with "no route". Instead, when the goal tile can't be entered, aim for
// the cheapest-to-reach passable tile touching it - one multi-goal search over
// all eight banks, not one search per bank. Returns [] when already standing on
// (or beside) the goal, a path when one exists, or null when nothing reaches it.
function pathToApproach(
  grid: Grid,
  from: Position,
  goal: Position,
): Position[] | null {
  if (passable(grid, goal.x, goal.y)) return findPath(grid, from, goal);
  if (chebyshev(from.x, from.y, goal.x, goal.y) <= 1) return [];
  let banks: Position[] = [];
  for (let dir of Object.values(DIRECTIONS))
    banks.push({ x: goal.x + dir.dx, y: goal.y + dir.dy });
  return findPathToAny(grid, from, banks);
}

// A tiny binary min-heap of (node index, priority) pairs held in flat number
// arrays - no per-entry object allocation on the search hot path.
class MinHeap {
  private nodes: number[] = [];
  private prios: number[] = [];
  size() {
    return this.nodes.length;
  }
  push(node: number, prio: number) {
    let { nodes, prios } = this;
    nodes.push(node);
    prios.push(prio);
    let i = nodes.length - 1;
    while (i > 0) {
      let parent = (i - 1) >> 1;
      if (prios[parent] <= prios[i]) break;
      [prios[parent], prios[i]] = [prios[i], prios[parent]];
      [nodes[parent], nodes[i]] = [nodes[i], nodes[parent]];
      i = parent;
    }
  }
  pop(): { node: number; prio: number } {
    let { nodes, prios } = this;
    let top = { node: nodes[0], prio: prios[0] };
    let lastNode = nodes.pop()!;
    let lastPrio = prios.pop()!;
    if (nodes.length > 0) {
      nodes[0] = lastNode;
      prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        let left = 2 * i + 1;
        let right = 2 * i + 2;
        let smallest = i;
        if (left < nodes.length && prios[left] < prios[smallest])
          smallest = left;
        if (right < nodes.length && prios[right] < prios[smallest])
          smallest = right;
        if (smallest === i) break;
        [prios[smallest], prios[i]] = [prios[i], prios[smallest]];
        [nodes[smallest], nodes[i]] = [nodes[i], nodes[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

// `terrain`, when given, stops the strike-out the moment it steps onto a tile
// of that kind - so "explore northeast for forest" lands you on the first
// timber it crosses instead of always walking the full stretch and, as often
// happened, overshooting straight past a patch into the open ground beyond it.
function explorePath(
  grid: Grid,
  start: Position,
  heading: Heading,
  terrain?: string,
): Position[] {
  let path: Position[] = [];
  let x = start.x;
  let y = start.y;
  for (let i = 0; i < EXPLORE_TILES; i += 1) {
    x += heading.dx;
    y += heading.dy;
    if (!passable(grid, x, y)) break;
    path.push({ x, y });
    if (terrain && tileAt(grid, x, y).terrain === terrain) break;
  }
  return path;
}

// --- Space state: the grid, per-agent fog, and in-flight movement -------

export interface Space {
  grid: Grid;
  fog: Map<string, Map<string, number>>; // agentId -> "x,y" -> tick last seen
  fogRevision: number;
  // active path follows. `progress` counts ticks already spent stepping toward
  // path[index]; the agent moves onto it once progress reaches that tile's enter
  // cost, so a costly tile takes several ticks to cross.
  moves: Map<string, { path: Position[]; index: number; progress: number }>;
}

export function makeSpace(spawn: Position, worldgen?: WorldGen): Space {
  return {
    grid: makeGrid(spawn, worldgen),
    fog: new Map(),
    fogRevision: 0,
    moves: new Map(),
  };
}

function known(space: Space, id: string): Map<string, number> {
  let m = space.fog.get(id);
  if (!m) {
    m = new Map();
    space.fog.set(id, m);
  }
  return m;
}

// Per-agent knowledge: a tile is "known" to an agent only if *that agent* has
// seen it (walked within sight, scanned it, or had it revealed to them). World
// knowledge - the map, resources, threats - spreads only by sensing it yourself
// or being told. Every gameplay read (travel gates, known-token lists, target
// visibility) is scoped to one agent's fog; the union across all fog maps exists
// solely for the spectator dashboard (unionKnownTiles).
export function knows(space: Space, id: string, x: number, y: number): boolean {
  return space.fog.get(id)?.has(key(x, y)) ?? false;
}

export function knownTiles(
  space: Space,
  id: string,
): { x: number; y: number }[] {
  let out: { x: number; y: number }[] = [];
  for (let tileKey of space.fog.get(id)?.keys() ?? []) {
    let [x, y] = tileKey.split(",").map(Number);
    out.push({ x, y });
  }
  return out;
}

// Every tile any character has seen - the spectator dashboard's reveal layer.
export function unionKnownTiles(space: Space): { x: number; y: number }[] {
  let out = new Map<string, { x: number; y: number }>();
  for (let m of space.fog.values()) {
    for (let tileKey of m.keys()) {
      if (out.has(tileKey)) continue;
      let [x, y] = tileKey.split(",").map(Number);
      out.set(tileKey, { x, y });
    }
  }
  return [...out.values()];
}

function reveal(space: Space, id: string, x: number, y: number, tick: number) {
  if (!inBoundsOf(space.grid, x, y)) return;
  // Bump the reveal counter whenever a tile is new to *this* character, not just
  // new to the whole colony. The dashboard masks the map to one selected
  // character's fog, so their personal reveals must invalidate the cached map
  // even when a teammate had already seen the tile.
  if (!knows(space, id, x, y)) space.fogRevision += 1;
  known(space, id).set(key(x, y), tick);
}

// Light up a single tile in one agent's fog. The GM lever for making a freshly
// placed token known immediately, instead of waiting for the character to wander
// within sight of it - pairs with announce() to point the colony at a new source.
export function revealAt(
  space: Space,
  id: string,
  pos: Position,
  tick: number,
) {
  reveal(space, id, pos.x, pos.y, tick);
}

export function revealAround(
  space: Space,
  id: string,
  c: Position,
  radius: number,
  tick: number,
) {
  for (let y = c.y - radius; y <= c.y + radius; y += 1)
    for (let x = c.x - radius; x <= c.x + radius; x += 1)
      reveal(space, id, x, y, tick);
}

function revealLine(
  space: Space,
  id: string,
  from: Position,
  heading: Heading,
  tick: number,
) {
  for (let i = 1; i <= SCAN_RANGE; i += 1) {
    let tx = from.x + heading.dx * i;
    let ty = from.y + heading.dy * i;
    if (!inBoundsOf(space.grid, tx, ty)) break;
    revealAround(space, id, { x: tx, y: ty }, 1, tick);
  }
}

// Reveal a fresh agent's surroundings (ordinary SIGHT unless a test narrows or
// widens it), plus any named tokens the scenario lights up at spawn so it has
// somewhere to head.
export function spawn(
  space: Space,
  id: string,
  tick: number,
  opts: {
    radius?: number;
    tokens?: string[];
    nearest?: { tag: string; count: number }[];
  } = {},
) {
  let spawnPos = space.grid.spawn;
  revealAround(space, id, spawnPos, opts.radius ?? SIGHT, tick);
  for (let name of opts.tokens ?? []) {
    let s = space.grid.tokens.find((g) => g.name === name);
    if (s) reveal(space, id, s.x, s.y, tick);
  }
  // Light up the closest token of each requested tag, so a fully procedural map
  // still hands a fresh character somewhere to head without naming coordinates.
  for (let req of opts.nearest ?? []) {
    let closest = space.grid.tokens
      .filter((s) => hasTag(s, req.tag))
      .sort(
        (a, b) =>
          chebyshev(spawnPos.x, spawnPos.y, a.x, a.y) -
          chebyshev(spawnPos.x, spawnPos.y, b.x, b.y),
      )
      .slice(0, Math.max(0, req.count));
    for (let s of closest) reveal(space, id, s.x, s.y, tick);
  }
}

// Reconcile the grid's token layer with the world's positioned entities that
// take ground - the bridge that lets a structure a rule spawns (a built
// campfire, a dropped crate) or a GM conjures appear on the map and in
// knownTokens, and one a rule destroys disappear. The kernel itself stays
// space-unaware: it only mints the entity; the host calls this after each tick
// to project the change onto the grid. Projection is opt-in by `occupancy`, so
// an agent and, importantly, a corpse (which merely drops the "agent" tag on
// death) never silently become map tokens; a build rule that wants its
// structure on the map sets the spawn's occupancy. A tile holds at most one
// token - and because taking ground now also reserves it, a second occupant is
// refused at commit rather than quietly landing off the grid.
export function syncTokens(space: Space, world: KernelWorld): boolean {
  let grid = space.grid;
  let want = new Map<string, Entity>();
  let changed = false;
  for (let entity of Object.values(world.entities))
    if (entity.pos && entity.occupancy) want.set(entity.id, entity);

  // Keep grid tokens whose entity still exists on the same tile; clear the tile
  // slot of any whose entity was destroyed or moved away.
  let kept: GridToken[] = [];
  for (let gridToken of grid.tokens) {
    let entity = want.get(gridToken.name);
    if (
      entity &&
      entity.pos!.x === gridToken.x &&
      entity.pos!.y === gridToken.y
    ) {
      if (
        gridToken.tags.join("\0") !== entity.tags.join("\0") ||
        gridToken.kind !== entity.kind ||
        gridToken.occupancy !== entity.occupancy
      ) {
        gridToken.kind = entity.kind;
        gridToken.tags = [...entity.tags];
        gridToken.occupancy = entity.occupancy!;
        let tile = tileAt(grid, gridToken.x, gridToken.y);
        if (tile.token?.name === gridToken.name) {
          tile.token.kind = entity.kind;
          tile.token.tags = [...entity.tags];
          tile.token.occupancy = entity.occupancy!;
        }
        changed = true;
      }
      kept.push(gridToken);
    } else if (inBoundsOf(grid, gridToken.x, gridToken.y)) {
      let tile = tileAt(grid, gridToken.x, gridToken.y);
      if (tile.token && tile.token.name === gridToken.name) {
        tile.token = null;
        changed = true;
      }
    } else changed = true; // stale token off the (shrunk) grid; just drop it
  }
  grid.tokens = kept;

  // Register any entity not yet on the grid, where its tile's token slot is free.
  // A fixture whose saved position now falls outside a shrunk/regenerated grid
  // is skipped rather than crashing - it simply stays off the map.
  let present = new Set(grid.tokens.map((token) => token.name));
  for (let entity of want.values()) {
    if (present.has(entity.id)) continue;
    if (!inBoundsOf(grid, entity.pos!.x, entity.pos!.y)) continue;
    let tile = tileAt(grid, entity.pos!.x, entity.pos!.y);
    if (tile.token) continue; // tile already shows a token; leave this one off the grid
    let ref: TokenRef = {
      name: entity.id,
      kind: entity.kind,
      tags: [...entity.tags],
      occupancy: entity.occupancy!,
    };
    tile.token = ref;
    grid.tokens.push({ ...ref, x: entity.pos!.x, y: entity.pos!.y });
    changed = true;
  }
  return changed;
}

// --- Geography: the projection an agent reads (no raw coordinates) ------

// Every remembered place is something this agent's own eyes saw, age-stamped
// via lastSeenTicksAgo. What other characters SAY about places lives in words
// alone - a hearer who cares writes it into their own memory file; the server
// keeps no second-hand map.
export interface KnownToken {
  name: string;
  kind?: string;
  tags: string[];
  distance: number;
  direction: string;
  lastSeenTicksAgo: number;
}

// The tokens this agent knows of, summarized as direction + distance from
// where they now stand - what travel() resolves names against. Per-agent: a
// token a teammate found is unknown to you until you see it yourself. What
// teammates tell you travels as words only - remembering (and believing) a
// claim is the hearer's own job, in their own memory file.
export function knownTokens(
  space: Space,
  id: string,
  from: Position,
  tick: number,
): KnownToken[] {
  let out: KnownToken[] = [];
  for (let s of space.grid.tokens) {
    if (!knows(space, id, s.x, s.y)) continue;
    let seenTick = lastSeen(space, id, s.x, s.y);
    out.push({
      name: s.name,
      kind: s.kind,
      tags: s.tags,
      distance: chebyshev(from.x, from.y, s.x, s.y),
      direction: compass(s.x - from.x, s.y - from.y),
      lastSeenTicksAgo: tick - (seenTick ?? tick),
    });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

// --- Frontier: knowing what you don't know ------------------------------

// The right-hand column of the perception quadrants: where does this agent's
// knowledge end? Coverage of walkable ground, the nearest tile they have never
// seen (reachable by walking, so it is an actionable goal, not a locked pocket),
// which compass sectors are most unknown, and where their knowledge has gone
// stalest. Makes exploration a visible affordance instead of an unpromptable
// behavior - without this, an agent literally cannot ask the world where its
// map ends.
export interface FrontierView {
  coverage: number; // share of walkable tiles personally seen, 0..1
  nearestUnseen?: { distance: number; direction: string }; // walking steps
  unexplored: { direction: string; unknownShare: number; tiles: number }[];
  stalest?: { direction: string; ticksAgo: number };
}

export function frontier(
  space: Space,
  id: string,
  from: Position,
  tick: number,
): FrontierView {
  let grid = space.grid;
  let seen = space.fog.get(id) ?? new Map<string, number>();

  let walkable = 0;
  let known = 0;
  // Per compass sector (relative to where the agent stands): how much walkable
  // ground lies that way, how much of it is unknown, and the summed age of the
  // known part. Staleness uses the MEAN age of known tiles - the agent's
  // just-refreshed ring touches every sector, so a max-freshness statistic
  // would read "all fresh" forever; the mean lets a distant rotten wedge show.
  let sectors = new Map<
    string,
    { walkable: number; unknown: number; knownCount: number; ageSum: number }
  >();
  let origin = grid.origin ?? { x: 0, y: 0 };
  for (let rowIndex = 0; rowIndex < grid.height; rowIndex += 1)
    for (let columnIndex = 0; columnIndex < grid.width; columnIndex += 1) {
      let x = origin.x + columnIndex;
      let y = origin.y + rowIndex;
      if (grid.impassable.has(grid.tiles[rowIndex][columnIndex].terrain))
        continue;
      walkable += 1;
      let direction = compass(x - from.x, y - from.y);
      let sector = sectors.get(direction);
      if (!sector) {
        sector = { walkable: 0, unknown: 0, knownCount: 0, ageSum: 0 };
        sectors.set(direction, sector);
      }
      sector.walkable += 1;
      let at = seen.get(key(x, y));
      if (at === undefined) {
        sector.unknown += 1;
      } else {
        known += 1;
        sector.knownCount += 1;
        sector.ageSum += tick - at;
      }
    }

  // Nearest never-seen walkable tile, by walking (8-direction BFS over
  // passable ground) - a frontier you can actually head for.
  let nearestUnseen: FrontierView["nearestUnseen"];
  {
    let visited = new Set<string>([key(from.x, from.y)]);
    let queue: (Position & { d: number })[] = [{ ...from, d: 0 }];
    for (let i = 0; i < queue.length; i += 1) {
      let cur = queue[i];
      if (cur.d > 0 && !seen.has(key(cur.x, cur.y))) {
        nearestUnseen = {
          distance: cur.d,
          direction: compass(cur.x - from.x, cur.y - from.y),
        };
        break;
      }
      for (let dir of Object.values(DIRECTIONS)) {
        let nx = cur.x + dir.dx;
        let ny = cur.y + dir.dy;
        let nk = key(nx, ny);
        if (visited.has(nk) || !passable(grid, nx, ny)) continue;
        visited.add(nk);
        queue.push({ x: nx, y: ny, d: cur.d + 1 });
      }
    }
  }

  // The most-unknown directions, largest share first. "here" is the agent's
  // own tile; skip it. Only sectors with meaningfully unknown ground make the
  // list, so a fully-mapped direction reads as silence, not a zero.
  let unexplored = [...sectors]
    .filter(([direction, s]) => direction !== "here" && s.unknown > 0)
    .map(([direction, s]) => ({
      direction,
      unknownShare: s.unknown / s.walkable,
      tiles: s.unknown,
    }))
    .sort((a, b) => b.unknownShare - a.unknownShare || b.tiles - a.tiles);

  // The known sector whose knowledge is oldest on average - where the agent's
  // map has rotted the most. Silence when nothing is stale (all fresh).
  let stalest: FrontierView["stalest"];
  for (let [direction, s] of sectors) {
    if (direction === "here" || s.knownCount === 0) continue;
    let ticksAgo = Math.round(s.ageSum / s.knownCount);
    if (ticksAgo === 0) continue;
    if (!stalest || ticksAgo > stalest.ticksAgo)
      stalest = { direction, ticksAgo };
  }

  return {
    coverage: walkable === 0 ? 1 : known / walkable,
    nearestUnseen,
    unexplored,
    stalest,
  };
}

export function tokenNameAt(grid: Grid, pos: Position): string | null {
  return tokenAt(grid, pos)?.name ?? null;
}

// Nearest tiles of a raw terrain kind this agent knows, the terrain analog of
// knownTokens for the resources this substrate never gave a name - a forest patch
// grows wood but isn't a GridToken, so it can't show up there. Sorted closest
// first so callers can try the next candidate when the closest is unreachable.
export function nearestKnownTerrain(
  space: Space,
  id: string,
  from: Position,
  terrain: string,
): (Position & { distance: number })[] {
  let want = terrain.trim().toLowerCase();
  let out: (Position & { distance: number })[] = [];
  for (let t of knownTiles(space, id)) {
    if (tileAt(space.grid, t.x, t.y).terrain !== want) continue;
    out.push({ ...t, distance: chebyshev(from.x, from.y, t.x, t.y) });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

export function tileAt(grid: Grid, x: number, y: number): Tile {
  let indexes = tileIndexes(grid, x, y);
  return grid.tiles[indexes.y][indexes.x];
}

// Rewrite a tile's terrain at runtime - the spatial half of the kernel's
// `setTerrain` effect. Returns whether the tile actually changed, so the caller
// can bump its map revision only when something moved. Off-map or a no-op
// (already that terrain) returns false.
//
// Passability and entry cost are derived from terrain. If either changes, any
// traveler whose remaining route uses the tile is re-planned around it, or halted
// cleanly if the destination is no longer reachable. A same-cost, same-passability
// repaint leaves active routes untouched.
export function setTerrainAt(
  space: Space,
  world: KernelWorld,
  x: number,
  y: number,
  terrain: Terrain,
): boolean {
  let grid = space.grid;
  if (!inBoundsOf(grid, x, y)) return false;
  let tile = tileAt(grid, x, y);
  if (tile.terrain === terrain) return false;
  let previousCost = enterCost(grid, x, y);
  tile.terrain = terrain;
  if (enterCost(grid, x, y) !== previousCost)
    replanRoutes(space, world, (step) => step.x === x && step.y === y);
  return true;
}

// Re-route every traveler whose remaining path uses a terrain kind whose policy
// changed. Cost changes matter as much as passability: the old route and ETA may
// no longer be optimal even when every tile remains walkable.
export function replanRoutesForTerrain(
  space: Space,
  world: KernelWorld,
  terrain: Terrain,
) {
  replanRoutes(
    space,
    world,
    (step) => tileAt(space.grid, step.x, step.y).terrain === terrain,
  );
}

// Re-route every traveler whose remaining path now runs through a tile a solid
// token has blocked (a wall raised, a hearth built underfoot). The occupancy
// analog of replanRoutesForTerrain; freeing a tile needs no replan, since the
// old route around the vanished obstacle stays valid.
export function replanRoutesForSolids(space: Space, world: KernelWorld) {
  replanRoutes(space, world, (step) => !passable(space.grid, step.x, step.y));
}

function replanRoutes(
  space: Space,
  world: KernelWorld,
  matches: (step: Position) => boolean,
) {
  for (let [entityId, move] of space.moves) {
    let crosses = false;
    for (let index = move.index; index < move.path.length; index += 1)
      if (matches(move.path[index])) {
        crosses = true;
        break;
      }
    if (!crosses) continue;
    let mover = world.entities[entityId];
    let goal = move.path[move.path.length - 1];
    let reroute = mover?.pos ? findPath(space.grid, mover.pos, goal) : null;
    if (reroute && reroute.length > 0) {
      move.path = reroute;
      move.index = 0;
      move.progress = 0;
      if (mover.action)
        mover.action.endTick = world.tick + pathCost(space.grid, reroute);
    } else {
      space.moves.delete(entityId);
      if (mover) mover.action = null;
    }
  }
}

export { chebyshev };

// Eight-point compass with "here" at the origin.
export function compass(dx: number, dy: number): string {
  let ns = dy < 0 ? "north" : dy > 0 ? "south" : "";
  let ew = dx < 0 ? "west" : dx > 0 ? "east" : "";
  return ns + ew || "here";
}

// The most recent tick *this agent* saw a tile, or undefined if they never have.
// A teammate standing on a token right now does not freshen your own memory of
// it - only your eyes (or their words, once told) update what you know.
function lastSeen(
  space: Space,
  id: string,
  x: number,
  y: number,
): number | undefined {
  return space.fog.get(id)?.get(key(x, y));
}

type TravelRoute =
  | {
      ok: true;
      token: GridToken;
      path: Position[];
      eta: number;
      direction: string;
    }
  | {
      ok: false;
      error: string;
      commitError: string;
      token?: GridToken;
    };

// A living agent you can walk up to, keyed by their id: the destination behind
// "travel to Solstice". Agents aren't tokens, so travelRoute resolves them
// separately, and only when the caller has a world to look them up in. Excludes
// the actor (you can't walk to yourself) and the position-less.
function agentTarget(
  world: KernelWorld | undefined,
  want: string,
  selfId: string,
): Entity | undefined {
  if (!world) return undefined;
  let e = world.entities[want];
  if (!e || e.id === selfId || !e.pos || !hasTag(e, "agent")) return undefined;
  return e;
}

function travelRoute(
  space: Space,
  id: string,
  from: Position,
  locationName: string,
  world?: KernelWorld,
): TravelRoute {
  let want = locationName.trim().toLowerCase();
  let token = space.grid.tokens.find((gridToken) => gridToken.name === want);
  if (!token) {
    let terrainRoute = travelToNearestTerrain(space, id, from, want);
    if (terrainRoute) return terrainRoute;
    // A named character is a place too: you can't stand on them, so route to a
    // tile at arm's reach. Their body moves, so the goal is presented under
    // their id and advanceSpace re-aims at where they now stand each tick.
    let agent = agentTarget(world, want, id);
    if (agent)
      return routeToPoint(
        space,
        from,
        { x: agent.pos!.x, y: agent.pos!.y },
        {
          name: agent.id,
          kind: agent.kind,
          tags: [...agent.tags],
          x: agent.pos!.x,
          y: agent.pos!.y,
        },
      );
    return {
      ok: false,
      error: `No known location named "${locationName}".`,
      commitError: `no known location named "${locationName}"`,
    };
  }
  if (!knows(space, id, token.x, token.y)) {
    // Not seen with their own eyes: not a destination. A place someone told
    // you about is theirs to describe and yours to find - explore toward
    // where they said it was.
    return {
      ok: false,
      token,
      error: `You haven't discovered ${token.name} yet.`,
      commitError: `you haven't discovered ${token.name} yet`,
    };
  }
  if (from.x === token.x && from.y === token.y)
    return { ok: true, token, path: [], eta: 0, direction: "here" };
  let path = pathToApproach(space.grid, from, token);
  if (!path)
    return {
      ok: false,
      token,
      error: "no route found",
      commitError: `no route to ${token.name}`,
    };
  return {
    ok: true,
    token,
    path,
    eta: pathCost(space.grid, path),
    direction: compass(token.x - from.x, token.y - from.y),
  };
}

// Route to an arbitrary tile, presenting it as the given token - the tail of
// terrain destinations (walk to known ground of a kind).
function routeToPoint(
  space: Space,
  from: Position,
  goal: Position,
  token: GridToken,
): TravelRoute {
  if (from.x === goal.x && from.y === goal.y)
    return { ok: true, token, path: [], eta: 0, direction: "here" };
  let path = pathToApproach(space.grid, from, goal);
  if (!path)
    return {
      ok: false,
      token,
      error: "no route found",
      commitError: `no route to ${token.name}`,
    };
  return {
    ok: true,
    token,
    path,
    eta: pathCost(space.grid, path),
    direction: compass(goal.x - from.x, goal.y - from.y),
  };
}

// `travel({location: "forest"})` when no token is named that: treat the name as
// a terrain kind and route to the nearest tile of it this agent knows, skipping
// any candidate that turns out unreachable (path around it, not stuck on a
// disconnected pocket). Synthesizes a GridToken-shaped result so callers don't
// need a separate code path for terrain destinations.
function travelToNearestTerrain(
  space: Space,
  id: string,
  from: Position,
  terrain: string,
): TravelRoute | null {
  let candidates = nearestKnownTerrain(space, id, from, terrain);
  if (candidates.length === 0) return null;
  // A bare terrain name means open ground of that kind, not a named token that
  // merely sits on such a tile: `travel forest` should not deposit a character
  // onto the goblin den squatting the nearest forest tile (to go there they'd
  // name the token). Prefer unoccupied tiles, falling back to token-occupied ones
  // only when every known tile of this kind is taken - so routing still
  // succeeds on a map whose only forest is under tokens.
  let open = candidates.filter((tile) => !tokenAt(space.grid, tile));
  let taken = candidates.filter((tile) => tokenAt(space.grid, tile));
  for (let pool of [open, taken]) {
    if (pool.length === 0) continue;
    let standing = pool.find((tile) => tile.x === from.x && tile.y === from.y);
    if (standing) {
      let token: GridToken = {
        name: terrain,
        tags: [terrain],
        x: standing.x,
        y: standing.y,
      };
      return { ok: true, token, path: [], eta: 0, direction: "here" };
    }
    // One search over the whole pool: the cheapest-to-reach tile of this kind
    // wins, instead of one full search per candidate until something connects.
    let path = findPathToAny(space.grid, from, pool);
    if (!path || path.length === 0) continue;
    let goal = path[path.length - 1];
    let token: GridToken = {
      name: terrain,
      tags: [terrain],
      x: goal.x,
      y: goal.y,
    };
    return {
      ok: true,
      token,
      path,
      eta: pathCost(space.grid, path),
      direction: compass(goal.x - from.x, goal.y - from.y),
    };
  }
  return {
    ok: false,
    error: `No route to any known ${terrain}.`,
    commitError: `no route to any known ${terrain}`,
  };
}

// --- Movement intents ---------------------------------------------------

const DIRECTION_NAMES = Object.keys(DIRECTIONS) as DirectionName[];
export type MovementActionName = "travel" | "explore" | "scan";

export type MovementPlan =
  | {
      ok: true;
      endsInTicks: number;
      actionArgs: Args;
      path?: Position[];
    }
  | { ok: false; error: string };

// Movement actions aren't ActionRules (they run in the space subsystem, not the
// kernel), so they carry their own descriptors for the action registry and
// availableActions.
export const movementActions: {
  name: MovementActionName;
  description: string;
  params: ActionParam[];
}[] = [
  {
    name: "travel",
    description:
      'Walk to a token you\'ve discovered, one tile per tick, revealing ground as you go. Also accepts a terrain kind (e.g. "forest"), routing to the nearest tile of that kind you have seen yourself, or the name of another character, routing to a tile at their side and re-aiming as they move.',
    params: [
      {
        name: "location",
        type: "string",
        required: true,
        description: 'a discovered token, or a terrain kind like "forest"',
      },
    ],
  },
  {
    name: "explore",
    description:
      "Strike out into the unknown in a compass direction, revealing new tiles.",
    params: [
      {
        name: "direction",
        type: "enum",
        values: DIRECTION_NAMES,
        required: true,
      },
      {
        name: "terrain",
        type: "string",
        required: false,
        description:
          'stop as soon as you reach a tile of this terrain kind (e.g. "forest"), instead of always walking the full stretch',
      },
    ],
  },
  {
    name: "scan",
    description: "Survey the land along a compass direction without moving.",
    params: [
      {
        name: "direction",
        type: "enum",
        values: DIRECTION_NAMES,
        required: true,
      },
    ],
  },
];

function actorOf(world: KernelWorld, id: string): Entity {
  let e = world.entities[id];
  if (!e) throw new Error(`no entity "${id}"`);
  return e;
}

export type MovementArgs = {
  location?: string;
  direction?: string;
  terrain?: string;
};

function planMoveFrom(
  space: Space,
  id: string,
  here: Position,
  type: MovementActionName,
  args: MovementArgs,
  world?: KernelWorld,
): MovementPlan {
  if (type === "travel") {
    let route = travelRoute(space, id, here, args.location ?? "", world);
    if (!route.ok) return { ok: false, error: route.commitError };
    if (route.path.length === 0)
      return { ok: false, error: `already at ${route.token.name}` };
    return {
      ok: true,
      endsInTicks: route.eta,
      actionArgs: { goal: route.token.name },
      path: route.path,
    };
  }

  if (type === "explore") {
    let heading = DIRECTIONS[args.direction as DirectionName];
    if (!heading) return { ok: false, error: "unknown direction" };
    let path = explorePath(space.grid, here, heading, args.terrain);
    if (path.length === 0)
      return { ok: false, error: `can't head ${args.direction} from here` };
    return {
      ok: true,
      endsInTicks: pathCost(space.grid, path),
      actionArgs: args.terrain
        ? { direction: args.direction!, terrain: args.terrain }
        : { direction: args.direction! },
      path,
    };
  }

  let heading = DIRECTIONS[args.direction as DirectionName];
  if (!heading) return { ok: false, error: "unknown direction" };
  return {
    ok: true,
    endsInTicks: SCAN_DURATION,
    actionArgs: { direction: args.direction! },
  };
}

export function planMove(
  space: Space,
  world: KernelWorld,
  id: string,
  type: MovementActionName,
  args: MovementArgs,
): MovementPlan {
  let actor = actorOf(world, id);
  if (!actor.pos) return { ok: false, error: `${id} has no position` };
  return planMoveFrom(space, id, actor.pos, type, args, world);
}

export function movementApplicable(
  space: Space,
  world: KernelWorld,
  id: string,
  type: MovementActionName,
  args: MovementArgs,
): boolean {
  return planMove(space, world, id, type, args).ok;
}

export function commitMove(
  space: Space,
  world: KernelWorld,
  id: string,
  type: MovementActionName,
  args: MovementArgs,
): { ok: boolean; error?: string; endsInTicks?: number } {
  let actor = actorOf(world, id);
  let plan: MovementPlan = actor.pos
    ? planMoveFrom(space, id, actor.pos, type, args, world)
    : { ok: false, error: `${id} has no position` };
  if (!plan.ok) return { ok: false, error: plan.error };

  actor.action = {
    type,
    args: plan.actionArgs,
    startTick: world.tick,
    endTick: world.tick + plan.endsInTicks,
  };
  if (plan.path)
    space.moves.set(id, { path: plan.path, index: 0, progress: 0 });
  return { ok: true, endsInTicks: plan.endsInTicks };
}

// The spawn tile, or the nearest passable tile to it not already taken by a
// standing agent - so characters joining at the same clearing fan out onto their
// own tiles instead of stacking. BFS outward over passable ground in the fixed
// neighbour order (deterministic); returns the origin when it is already free or
// when a tiny, packed map leaves nowhere else to stand.
export function freeSpawnNear(
  grid: Grid,
  origin: Position,
  taken: Position[],
): Position {
  let blocked = new Set(taken.map((p) => key(p.x, p.y)));
  let free = (p: Position) =>
    passable(grid, p.x, p.y) && !blocked.has(key(p.x, p.y));
  if (free(origin)) return origin;
  let seen = new Set<string>([key(origin.x, origin.y)]);
  let queue: Position[] = [origin];
  for (let i = 0; i < queue.length; i += 1) {
    let cur = queue[i];
    for (let dir of Object.values(DIRECTIONS)) {
      let next = { x: cur.x + dir.dx, y: cur.y + dir.dy };
      let k = key(next.x, next.y);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!passable(grid, next.x, next.y)) continue;
      if (!blocked.has(k)) return next;
      queue.push(next);
    }
  }
  return origin;
}

// The first passable tile beside `center` that no standing agent has claimed,
// scanned in the fixed DIRECTIONS order so a sidestep is deterministic. Null
// when every neighbour is blocked or occupied - the mover then waits a tick.
function freeStandingNeighbor(
  grid: Grid,
  center: Position,
  standing: Set<string>,
): Position | null {
  for (let dir of Object.values(DIRECTIONS)) {
    let nx = center.x + dir.dx;
    let ny = center.y + dir.dy;
    if (passable(grid, nx, ny) && !standing.has(key(nx, ny)))
      return { x: nx, y: ny };
  }
  return null;
}

// Advance trips a tile, resolve finished scans, then perceive - so movement
// lands before that tick's actions and needs.
export function advanceSpace(
  space: Space,
  world: KernelWorld,
  events: KernelEvent[],
): KernelEvent[] {
  let agents = Object.values(world.entities).filter((e) => hasTag(e, "agent"));

  // 1. Path-followers step one tile, revealing ground as they go.
  let movers = agents
    .filter(
      (c) =>
        c.action && (c.action.type === "travel" || c.action.type === "explore"),
    )
    .sort(
      (a, b) =>
        a.action!.startTick - b.action!.startTick || a.id.localeCompare(b.id),
    );
  // Standing is exclusive: an arriving mover may not stop on a tile another
  // agent already stands on. Agents in transit are NOT standing - they pass
  // through freely and move on next tick - so seed the claim from the non-movers
  // and add each mover's tile only as it settles. Movers resolve in the fixed
  // order above, so an earlier arrival is visible to a later one: the resolution
  // is deterministic and replay-safe.
  let movingIds = new Set(movers.map((m) => m.id));
  let standing = new Set<string>();
  for (let agent of agents)
    if (agent.pos && !movingIds.has(agent.id))
      standing.add(key(agent.pos.x, agent.pos.y));
  for (let mover of movers) {
    if (!mover.pos) continue;
    let mv = space.moves.get(mover.id)!;

    // Follow a moving goal. A travel path is a snapshot of where the token was
    // when the order was set; a creeping flame drifts off it and the character
    // walks to bare ground. So each tick, if the goal token still exists and is
    // close enough to see (within SIGHT - no omniscient tracking of fire you
    // can't lay eyes on), re-plan toward where it is now. A token that has died
    // or slipped out of sight leaves the old path intact: you head to where you
    // last knew it, and learn the truth on arrival.
    let goal = mover.action!.type === "travel" ? mover.action!.args.goal : null;
    if (typeof goal === "string") {
      // The goal is a token name or - when travelling to a person - an agent id.
      // Either way it may have moved; re-aim at where it now stands.
      let token: Position | undefined = space.grid.tokens.find(
        (t) => t.name === goal,
      );
      if (!token) {
        let agent = agentTarget(world, goal, mover.id);
        if (agent) token = agent.pos;
      }
      if (
        token &&
        chebyshev(mover.pos.x, mover.pos.y, token.x, token.y) <= SIGHT
      ) {
        let repath = pathToApproach(space.grid, mover.pos, token);
        let cur = mv.path[mv.path.length - 1];
        let dest = repath?.[repath.length - 1];
        let shifted =
          repath !== null &&
          (!dest || !cur || dest.x !== cur.x || dest.y !== cur.y);
        if (shifted && repath!.length === 0) {
          // The token moved onto or beside us: the trip is over where we stand.
          mover.action = null;
          space.moves.delete(mover.id);
          let here = tokenAt(space.grid, mover.pos);
          events.push({
            tick: world.tick,
            type: "arrived",
            entity: mover.id,
            text: here
              ? `arrives at ${here.name}`
              : `reaches ${mover.pos.x},${mover.pos.y}`,
          });
          continue;
        }
        if (shifted) {
          mv.path = repath!;
          mv.index = 0;
          mv.progress = 0;
          mover.action!.endTick = world.tick + pathCost(space.grid, repath!);
        }
      }
    }

    let step = mv.path[mv.index];
    // Spend one tick stepping toward the next tile; only actually move onto it
    // once enough ticks have accrued for its terrain (slow ground dwells longer),
    // plus any slow the mover itself carries (a starving character trudges).
    let stepCost = enterCost(space.grid, step.x, step.y) + moveSlow(mover);
    mv.progress += 1;
    if (mv.progress < stepCost) continue;

    // This commit ends the trip when it consumes the last path tile; only then
    // does the mover become standing and owe the tile to itself.
    let arriving = mv.index + 1 >= mv.path.length;
    let dest = step;
    if (arriving && standing.has(key(step.x, step.y))) {
      // The destination is already taken - sidestep to a free neighbour of it,
      // or hold at the threshold and retry next tick if fully hemmed in.
      let aside = freeStandingNeighbor(space.grid, step, standing);
      if (!aside) {
        mv.progress = stepCost - 1;
        continue;
      }
      dest = aside;
    }

    mv.index += 1;
    mv.progress = 0;
    let from = mover.pos;
    mover.pos = { x: dest.x, y: dest.y };
    if (arriving) standing.add(key(dest.x, dest.y));
    events.push({
      tick: world.tick,
      type: "moved",
      entity: mover.id,
      args: {
        fromX: from.x,
        fromY: from.y,
        toX: dest.x,
        toY: dest.y,
        terrain: tileAt(space.grid, dest.x, dest.y).terrain,
      },
    });
    if (mv.index >= mv.path.length) {
      mover.action = null;
      space.moves.delete(mover.id);
      let token = tokenAt(space.grid, mover.pos);
      events.push({
        tick: world.tick,
        type: "arrived",
        entity: mover.id,
        text: token
          ? `arrives at ${token.name}`
          : `reaches ${mover.pos.x},${mover.pos.y}`,
      });
    }
  }

  // 2. Finished scans reveal a line out along their heading.
  for (let c of agents) {
    if (!c.action || c.action.type !== "scan" || c.action.endTick > world.tick)
      continue;
    let dir = DIRECTIONS[c.action.args.direction as DirectionName];
    revealLine(space, c.id, c.pos!, dir, world.tick);
    c.action = null;
    events.push({ tick: world.tick, type: "scanned", entity: c.id });
  }

  // 3. Perceive: reveal the immediate surroundings of where each now stands.
  for (let c of agents) revealAround(space, c.id, c.pos!, SIGHT, world.tick);

  return events;
}
