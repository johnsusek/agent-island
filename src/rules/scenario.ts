// A Scenario is everything the substrate does not know on its own.
//
// The substrate (the kernel + the space subsystem + the generic host) gives you
// the irreducible core: an agent stands somewhere on a grid, moves, and talks to
// whoever shares its tile. A Scenario overlays meaning on that core - the stocks
// an agent carries, the global stocks the world tracks, the rules that make them
// drift and interact, the actions beyond movement, how the land is generated,
// and how its own events read. Hand the host `scenario` (assembled in
// config.ts) and the same core becomes the colony game.

import type { Args, Rule, Stock } from "./kernel.js";
import { assertValidMoveCost, type Position, type WorldGen } from "./space.js";
import { assertValidSpriteSpec, type SpriteSpec } from "./sprite.js";

// What a stock IS to a character, independent of its name: a pressure that
// can hurt or kill (`vital`, band-alarmed prose, never a figure), a personal
// dimension worth a mention only when it's notable (`stat`, adjectival prose,
// silent otherwise), or a fungible quantity that gets carried and handed over
// (`pack`, the "Carrying:" figures, the only role give/stockpile ever touch).
// An unclassified stock is `pack`: the plain reading of a bare number nobody
// has said anything else about.
export type StockRole = "vital" | "stat" | "pack";

// How a stock starts. An unset min/max takes the kernel stock() defaults (0,100).
// `icon` is the game-icons.net slug that represents this resource everywhere
// it's shown — the header pills, the character cards, the map. It rides on the
// resource by name: the first spec to declare an icon for a given stock name
// registers it in the kindVisuals registry for the whole world. Authored stocks
// should always carry one; when a GM introduces a brand-new resource at runtime
// it must supply one too. `color` is an optional CSS hex tint for the icon;
// without one, renderers fall back to a stable name-derived tint.
export interface StockSpec {
  value: number;
  min?: number;
  max?: number;
  icon?: string;
  color?: string;
  // Marks this resource as one characters can haul into a stockpile. Only
  // meaningful on a `pack`-role resource (rejected on vital/stat at
  // set_stock_default) - it is a narrower, deposit/withdraw-specific opt-in
  // *within* pack, not a second givability axis: giving itself is gated on
  // role alone (see engine.ts packStockNames), stockpilable only decides
  // which pack resources the generic deposit/withdraw actions list.
  stockpilable?: boolean;
  // What this stock IS - see StockRole. Omitted, the stock is pack.
  role?: StockRole;
  // How the stock reads to a character and on the dashboard. `label` names it
  // in prose ("your warmth"); `bands` are what the world tells a vital/stat at
  // each depth of trouble, with any band left unwritten getting a default
  // built from the label. Direction is not a choice here: every gauge in this
  // world reads up as good, so harm always sits toward the floor - a stock
  // whose harm rises (a cold, an exposure) is named for its relief instead
  // (warmth, not cold), which is what makes that true without a field to get
  // backwards. This is the ONLY home for a stock's presentation - a stock spec
  // is both the declaration and the authoring, so a GM's set_stock_default
  // carries it at runtime with no second registry to keep in step (see
  // engine.ts stockDisplay).
  label?: string;
  bands?: Partial<Record<"pressing" | "serious" | "critical", string>>;
}

// The reader-facing view of one stock: what it is and how to say it. Built
// fresh on every read (see engine.ts stockDisplay) from the registry that
// declares the stock - stockDefaults for a per-character stock, worldStocks
// for a global one - which is where `scope` comes from. Prose, alarms, the
// dry-run lints, and the dashboard all read this one shape; nothing authors
// it directly.
export interface StockDisplay {
  role: StockRole;
  scope: "agent" | "world";
  label?: string;
  bands?: Partial<Record<"pressing" | "serious" | "critical", string>>;
}

// The kind, tags, and stocks an entity is stamped out with. An agent
// template's tags must include "agent" - that tag is how the substrate knows
// an entity is a living participant on the grid. `kind` is the entity's
// identity (what visuals and labels key off); tags are a pure behavior set.
export interface EntityTemplate {
  kind?: string;
  tags: string[];
  stocks: Record<string, StockSpec>;
}

// The context a scenario's describeEvent receives: the acting entity's display
// name, its stocks, the world singleton's stocks, and the committing action's
// args - enough to render "Ara gathers 6 wood" without the host knowing wood.
export interface DescribeContext {
  name: string;
  stocks: Record<string, Stock>;
  world: Record<string, Stock>;
  args: Args;
}

// Render a {{ ... }} template against a DescribeContext. The mini-language is
// kept deliberately tiny so a scenario's prose stays pure, serializable data:
//
//   {{ ctx.name }}                                  a dotted path under { ctx }
//   {{ ctx.stocks.energy.value }}                   nested stock lookup
//   {{ ctx.args.resource | lookup: wood=6, food=5 }}   path piped through a filter
//
// A path that resolves to null/undefined renders as "" (so a stray reference
// just disappears rather than throwing); an unknown filter passes its value
// through untouched. The result is returned verbatim - an empty string means
// "no prose", letting the caller fall back to the rule's emit text.
export function renderTemplate(template: string, ctx: DescribeContext): string {
  let scope: Record<string, unknown> = { ctx };
  return template.replace(/\{\{(.+?)\}\}/g, (_, expr: string) => {
    let [path, ...filters] = expr.split("|").map((s) => s.trim());
    let value = resolvePath(scope, path);
    for (let filter of filters) value = applyFilter(value, filter);
    return value === null || value === undefined ? "" : String(value);
  });
}

// Walk a dotted path ("ctx.stocks.energy.value") through nested objects, giving
// undefined the moment a segment is missing or not an object.
function resolvePath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === "object")
      return (acc as Record<string, unknown>)[key];
    return undefined;
  }, root);
}

// Apply one pipe filter. Currently only "lookup: a=1, b=2" - map the value
// through a small inline table, passing it through unchanged if absent.
function applyFilter(value: unknown, filter: string): unknown {
  let colon = filter.indexOf(":");
  let name = (colon === -1 ? filter : filter.slice(0, colon)).trim();
  let rest = colon === -1 ? "" : filter.slice(colon + 1);
  if (name === "lookup") {
    for (let pair of rest.split(",")) {
      let [k, v] = pair.split("=").map((s) => s.trim());
      if (k === String(value)) return v;
    }
    return value;
  }
  return value;
}

// How a kind of thing appears. `sprite` is the world art, stored inline as the
// sprite DSL (palette + character grid) and baked to a texture by the web map -
// there are no external asset packs. color, icon, and label are semantic hints
// for the surrounding UI (HUD pills, legend, tooltips), never map fallbacks: a
// terrain or kind with no sprite renders as the loud missing-sprite checker.
export interface Visual {
  sprite?: SpriteSpec;
  color?: string;
  icon?: string;
  label?: string;
}

// Everything a terrain *kind* means beyond its name: how it draws and whether it
// can be walked and how slowly. Keyed by terrain name in a registry
// (Scenario.terrainSpecs), the terrain analog of a StockSpec. The engine expands
// one of these into concrete behavior - grid passability, move cost, a map tint -
// so a scenario (or a GM) declares terrain as data instead of code. Terrain is
// only ground: anything harvestable lives on top as a token, not on the tile.
export interface TerrainSpec {
  passable?: boolean; // default true; false adds the kind to the impassable set
  moveCost?: number; // ticks to enter a tile of this terrain (default 1)
  visual?: Visual; // sprite and surrounding UI hints
}

export function assertValidTerrainSpec(
  name: string,
  value: unknown,
): asserts value is TerrainSpec {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Terrain "${name}" must be an object.`);
  let moveCost = (value as { moveCost?: unknown }).moveCost;
  if (moveCost !== undefined) assertValidMoveCost(name, moveCost);
  let visual = (value as { visual?: unknown }).visual;
  if (visual !== undefined) assertValidVisual(`terrain "${name}"`, visual);
}

// Gate a Visual wherever one enters the world - a terrain spec's visual, a
// kindVisuals entry (authored or GM-registered) - so a malformed inline sprite
// fails at the door, not in the renderer.
export function assertValidVisual(
  label: string,
  value: unknown,
): asserts value is Visual {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Visual for ${label} must be an object.`);
  let sprite = (value as { sprite?: unknown }).sprite;
  if (sprite !== undefined) assertValidSpriteSpec(label, sprite);
}

export interface Scenario {
  name: string;
  rules: Rule[];
  // What a joining agent is stamped with. Defaults to a bare { tags: ["agent"] }.
  agentTemplate?: EntityTemplate;
  // How the land is generated. Omit for a bare, fully-passable grid.
  worldgen?: WorldGen;
  // Where agents enter the grid. Not authored on disk: the loader rolls a random
  // passable tile from the worldgen seed and stamps it here (see config.ts).
  spawn: Position;
  // Optional prose templates for the scenario's own events, keyed by event type.
  // Each value is a {{ ... }} template rendered against the DescribeContext (see
  // renderTemplate) - pure, serializable data rather than code. A type with no
  // entry (or whose template renders empty) falls back to the rule's own emit
  // text, then to a generic "<name> <type>".
  describeEvent?: Record<string, string>;
  // How each entity kind-tag draws on the map (icon + tint + legend label),
  // keyed by the kind-tag a token or entity carries ("wolf", "hearth"). Only
  // needed for tags that have no spec to ride: a stock's look belongs on its
  // StockSpec (icon/color), a terrain's on its TerrainSpec (visual) - both feed
  // the same live registries. An explicit entry here wins over a spec's.
  kindVisuals?: Record<string, Visual>;
  // How each terrain kind behaves and what per-tile resource (if any) it grows,
  // keyed by terrain name. The engine expands these at load into grid passability,
  // carrier entities, and depletion rules (see TerrainSpec).
  terrainSpecs?: Record<string, TerrainSpec>;
}

// --- On-disk shapes ------------------------------------------------------
//
// The world file (config/config.json) is deliberately small: just the shared
// canvas (width/height/seed) with the WorldGen fields flat at the root - no
// nested "worldgen" object, no rules, no authoring sections, no name. The game
// itself, including its terrain and where that terrain is painted, ships as a
// scenario (config/scenarios/): terrainSpecs define the terrain; defaultTerrain
// plus either blobs or a terrainLayers stack place it (with an optional connect
// guarantee). loadRuleset assembles a bare Scenario from this file; the
// coordinator layers the active scenario's placement and identity on at boot.
export type WorldFile = WorldGen;
