import { Texture } from "pixi.js";
import type { SpriteSpec } from "./types";

// The sprite baker: turns a sprite spec into a Pixi texture via an offscreen
// canvas. Most sprites are inline art (palette + character grid, the DSL
// register_kind_visual / register_terrain take); a sprite may instead name one
// tile of a tileset PNG this page serves (`sheet` + `tile`), which loads
// asynchronously - see sheetsVersion for how the map redraws once it lands.
//
// Textures are cached by the spec's JSON, so an edited sprite is simply a new
// key (the old texture ages out with its world) and identical specs share one
// texture. A missing or malformed sprite resolves to a loud magenta checker -
// by design there is no icon/color fallback on the map.

// The canonical authoring grid. Every map sprite is drawn as though 16 source
// pixels span one tile, so one source pixel is always CELL/SPRITE_GRID
// world-pixels no matter what dimensions the art declares. This is what keeps
// the pixel grid uniform across terrain, tokens, creatures, items, and
// characters: a sprite authored at a coarser or finer grid occupies a larger or
// smaller footprint, never a different pixel size.
export const SPRITE_GRID = 16;

export interface ResolvedSprite {
  texture: Texture;
  anchor: { x: number; y: number };
  missing: boolean;
}

const DEFAULT_ANCHOR = { x: 0.5, y: 1 };

let cache = new Map<string, Texture>();
let warned = new Set<string>();
let missingTexture: Texture | null = null;

// Tileset images by path. A sheet still loading resolves to an empty texture
// (and is not cached); when it lands, sheetsVersion bumps so the map's
// signatures change and the layers that used it redraw on the next poll.
let sheets = new Map<string, HTMLImageElement | "loading" | "failed">();
let sheetLoads = 0;

export function sheetsVersion(): number {
  return sheetLoads;
}

function sheetImage(path: string): HTMLImageElement | "loading" | "failed" {
  let known = sheets.get(path);
  if (known) return known;
  sheets.set(path, "loading");
  let image = new Image();
  image.onload = () => {
    sheets.set(path, image);
    sheetLoads += 1;
  };
  image.onerror = () => {
    sheets.set(path, "failed");
    sheetLoads += 1;
    warnOnce(path, `Tileset ${path} failed to load.`);
  };
  image.src = `/${path}`;
  return "loading";
}

export function resolveSprite(
  spec: SpriteSpec | null | undefined,
): ResolvedSprite {
  if (!spec)
    return { texture: missing(), anchor: DEFAULT_ANCHOR, missing: true };
  if (spec.sheet !== undefined && sheetImage(spec.sheet) === "loading")
    return {
      texture: Texture.EMPTY,
      anchor: spec.anchor ?? DEFAULT_ANCHOR,
      missing: false,
    };
  let key = JSON.stringify(spec);
  let texture = cache.get(key);
  if (!texture) {
    try {
      texture = bake(spec);
    } catch (error) {
      warnOnce(
        key,
        `Sprite failed to bake: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { texture: missing(), anchor: DEFAULT_ANCHOR, missing: true };
    }
    cache.set(key, texture);
  }
  return {
    texture,
    anchor: spec.anchor ?? DEFAULT_ANCHOR,
    missing: false,
  };
}

// The loud placeholder for "this thing has no sprite": a magenta/black
// checker, unmistakably an authoring gap rather than art.
export function missing(): Texture {
  if (missingTexture) return missingTexture;
  let canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  let context = canvas.getContext("2d")!;
  for (let y = 0; y < 2; y += 1)
    for (let x = 0; x < 2; x += 1) {
      context.fillStyle = (x + y) % 2 === 0 ? "#ff00ff" : "#1a001a";
      context.fillRect(x * 8, y * 8, 8, 8);
    }
  missingTexture = Texture.from(canvas);
  missingTexture.source.scaleMode = "nearest";
  return missingTexture;
}

function bake(spec: SpriteSpec): Texture {
  let texture = Texture.from(bakeCanvas(spec));
  texture.source.scaleMode = "nearest";
  return texture;
}

// Paint a sprite spec onto a fresh 1:1 canvas (one canvas pixel per grid cell).
// The texture baker and the data-URL previewer share this; it throws on any
// malformed spec (bad size, wrong row count/width, unknown glyph) so callers can
// fall back to the missing marker.
function bakeCanvas(spec: SpriteSpec): HTMLCanvasElement {
  let [width, height] = spec.size;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error(`bad size ${JSON.stringify(spec.size)}`);
  if (spec.sheet !== undefined) return cutTile(spec, width, height);
  let grid = expandGrid(spec as { grid: string[] });
  if (grid.length !== height)
    throw new Error(`grid is ${grid.length} rows for height ${height}`);

  let canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  let context = canvas.getContext("2d")!;
  let image = context.createImageData(width, height);
  for (let y = 0; y < height; y += 1) {
    let row = grid[y];
    if (row.length !== width)
      throw new Error(`row ${y} is ${row.length} wide for width ${width}`);
    for (let x = 0; x < width; x += 1) {
      let rgba = colorFor(spec.palette ?? {}, row[x]);
      let offset = (y * width + x) * 4;
      image.data[offset] = rgba[0];
      image.data[offset + 1] = rgba[1];
      image.data[offset + 2] = rgba[2];
      image.data[offset + 3] = rgba[3];
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

// Copy a tile (or a stack of tiles) of a loaded tileset onto a fresh canvas,
// counting tiles left to right then top to bottom in cells of the sprite's size.
function cutTile(
  spec: SpriteSpec,
  width: number,
  height: number,
): HTMLCanvasElement {
  let image = sheetImage(spec.sheet!);
  if (image === "loading" || image === "failed")
    throw new Error(`tileset ${spec.sheet} is not available`);
  let columns = Math.floor(image.naturalWidth / width);
  let rows = Math.floor(image.naturalHeight / height);
  let tiles = Array.isArray(spec.tile) ? spec.tile : [spec.tile ?? 0];
  let canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  let context = canvas.getContext("2d")!;
  // Drawn bottom to top, so [grass, tree] stands a tree on grass.
  for (let tile of tiles) {
    if (!columns || tile >= columns * rows)
      throw new Error(`tile ${tile} is outside ${spec.sheet}`);
    context.drawImage(
      image,
      (tile % columns) * width,
      Math.floor(tile / columns) * height,
      width,
      height,
      0,
      0,
      width,
      height,
    );
  }
  return canvas;
}

// A sprite spec as a PNG data URL, for previewing off the Pixi map (e.g. the
// Scenario panel's asset list, drawn into a plain <img>). Returns null for a
// missing or malformed spec so the caller can show the "no sprite" marker
// instead. Cached by the spec's JSON, like the texture cache.
let dataUrlCache = new Map<string, string | null>();

export function spriteDataUrl(
  spec: SpriteSpec | null | undefined,
): string | null {
  if (!spec) return null;
  if (spec.sheet !== undefined && sheetImage(spec.sheet) === "loading")
    return null;
  let key = JSON.stringify(spec);
  if (dataUrlCache.has(key)) return dataUrlCache.get(key)!;
  let url: string | null;
  try {
    url = bakeCanvas(spec).toDataURL();
  } catch (error) {
    warnOnce(
      key,
      `Sprite failed to bake: ${error instanceof Error ? error.message : String(error)}`,
    );
    url = null;
  }
  dataUrlCache.set(key, url);
  return url;
}

// Mirror expansion, matching the server's expandSpriteGrid: author one half,
// the other half is pixel-identical by construction.
function expandGrid(spec: { grid: string[]; mirror?: string }): string[] {
  let grid = spec.grid;
  let mode = spec.mirror ?? "none";
  if (mode === "none") return grid;
  if (mode === "horizontal")
    return grid.map(
      (row) =>
        row +
        [...row]
          .reverse()
          .slice(row.length % 2 === 0 ? 0 : 1)
          .join(""),
    );
  let bottom = grid
    .slice(0, grid.length % 2 === 0 ? grid.length : grid.length - 1)
    .reverse();
  return [...grid, ...bottom];
}

const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

function colorFor(
  palette: Record<string, string>,
  glyph: string,
): [number, number, number, number] {
  let value = palette[glyph];
  if (value === undefined) {
    if (glyph === ".") return TRANSPARENT;
    throw new Error(`glyph ${JSON.stringify(glyph)} is not in the palette`);
  }
  let v = value.trim().toLowerCase();
  if (v === "none" || v === "transparent" || v === "") return TRANSPARENT;
  let hex = v.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/.test(hex))
    throw new Error(
      `palette["${glyph}"] = ${JSON.stringify(value)} is not a #rrggbb hex`,
    );
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
    255,
  ];
}

function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[sprites] ${message}`);
}
