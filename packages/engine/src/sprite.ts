// The sprite DSL: a palette plus a character grid, or one tile cut from a
// sheet image the viewport serves (a tileset such as Kenney's Tiny Town). A sprite is stored INLINE
// in the Visual that owns it - a terrain spec's visual or a kindVisuals entry
// - so art is authored data that travels with its scenario, not a file in an
// asset pack. The web viewport bakes the grid into a texture; there is no PNG
// anywhere in the pipeline.
//
// This validator is the shared gate: scenario boot and register_terrain /
// register_kind_visual all call it, so a broken grid fails loudly at the door
// instead of rendering wrong.

export interface SpriteSpec {
  // Exact pixel size [width, height]; both multiples of 16, at most 64 (a bad
  // sprite is a wrong tile, not a wrong screen).
  size: [number, number];
  // "token" (default) stands over a transparent field and must keep its
  // corners clear; "terrain" fills the cell edge to edge.
  kind?: "token" | "terrain";
  // Glyph -> "#rrggbb", or "none"/"transparent" for clear. "." is transparent
  // unless redefined. Required unless the sprite is a sheet tile.
  palette?: Record<string, string>;
  // Rows of glyphs, top first, one character per pixel. With a mirror set,
  // this is the authored half; the expanded grid must match `size` exactly.
  grid?: string[];
  // The sheet form, instead of palette + grid: a PNG path the viewport serves
  // (relative, e.g. "tiles/kenney-tiny-town.png") and which tile of it to cut,
  // counting left to right then top to bottom in cells of `size`, no spacing.
  // A list of tiles is drawn bottom to top: [grass, tree] puts a tree with a
  // transparent background on grass.
  sheet?: string;
  tile?: number | number[];
  mirror?: "horizontal" | "vertical" | "none";
  // Standing-token anchor as fractions; renderers default to bottom-center.
  anchor?: { x: number; y: number };
}

const CELL = 16;
const MAX_DIMENSION = 64;
const MAX_OPAQUE_COLORS = 10;

// Expand the authored grid through its mirror, the same construction the
// renderer uses: author one half, the other half is pixel-identical by
// construction. Returns the grid untouched for mirror "none".
export function expandSpriteGrid(spec: {
  grid: string[];
  mirror?: string;
}): string[] {
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
  // "vertical": bottom half mirrors the top (dropping the middle row when odd).
  let bottom = grid
    .slice(0, grid.length % 2 === 0 ? grid.length : grid.length - 1)
    .reverse();
  return [...grid, ...bottom];
}

// Is this palette entry transparent? Mirrors the renderer's color parsing.
function isTransparent(value: string): boolean {
  let v = value.trim().toLowerCase();
  return v === "none" || v === "transparent" || v === "";
}

function isHexColor(value: string): boolean {
  return /^#?[0-9a-f]{6}$/i.test(value.trim());
}

export function assertValidSpriteSpec(
  label: string,
  value: unknown,
): asserts value is SpriteSpec {
  let fail = (message: string): never => {
    throw new Error(`Sprite for ${label}: ${message}`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("must be an object (size, palette, grid).");
  let spec = value as Partial<SpriteSpec> & Record<string, unknown>;

  for (let key of Object.keys(spec))
    if (
      ![
        "size",
        "kind",
        "palette",
        "grid",
        "mirror",
        "anchor",
        "sheet",
        "tile",
      ].includes(key)
    )
      fail(`has unknown key "${key}".`);
  let fromSheet = spec.sheet !== undefined || spec.tile !== undefined;

  let size = spec.size;
  if (
    !Array.isArray(size) ||
    size.length !== 2 ||
    !size.every((n) => Number.isInteger(n) && n > 0)
  )
    fail(`"size" must be [width, height] of positive integers.`);
  let [width, height] = size as [number, number];
  for (let [axis, dimension] of [
    ["width", width],
    ["height", height],
  ] as const)
    if (dimension % CELL !== 0 || dimension < CELL || dimension > MAX_DIMENSION)
      fail(
        `${axis} is ${dimension}px; sprites are ${CELL}-${MAX_DIMENSION}px in multiples of ${CELL}.`,
      );

  if (
    spec.kind !== undefined &&
    spec.kind !== "token" &&
    spec.kind !== "terrain"
  )
    fail(`"kind" must be "token" or "terrain".`);
  let kind = spec.kind ?? "token";

  if (
    spec.mirror !== undefined &&
    !["horizontal", "vertical", "none"].includes(spec.mirror)
  )
    fail(`"mirror" must be "horizontal", "vertical", or "none".`);

  if (fromSheet) {
    if (
      typeof spec.sheet !== "string" ||
      !/^[a-z0-9][a-z0-9_./-]*\.png$/i.test(spec.sheet) ||
      spec.sheet.includes("..")
    )
      fail(
        `"sheet" must be a relative .png path the viewport serves, like "tiles/kenney-tiny-town.png".`,
      );
    let tiles = Array.isArray(spec.tile) ? spec.tile : [spec.tile];
    if (
      tiles.length < 1 ||
      tiles.length > 4 ||
      !tiles.every((t) => Number.isInteger(t) && (t as number) >= 0)
    )
      fail(
        `"tile" must be a tile index (0 or more), or a list of 1 to 4 drawn bottom to top.`,
      );
    for (let key of ["palette", "grid", "mirror"] as const)
      if (spec[key] !== undefined)
        fail(
          `a sheet tile takes no "${key}"; use either sheet + tile or palette + grid.`,
        );
    assertValidAnchor(spec.anchor, fail);
    return;
  }

  let palette = spec.palette;
  if (!palette || typeof palette !== "object" || Array.isArray(palette))
    fail(`"palette" must map single-character glyphs to colors.`);
  let glyphs = new Map<string, boolean>(); // glyph -> transparent?
  for (let [glyph, color] of Object.entries(
    palette as Record<string, unknown>,
  )) {
    if (glyph.length !== 1)
      fail(`palette key ${JSON.stringify(glyph)} must be a single character.`);
    if (typeof color !== "string")
      fail(`palette["${glyph}"] must be a color string.`);
    let value = String(color);
    if (!isTransparent(value) && !isHexColor(value))
      fail(
        `palette["${glyph}"] = ${JSON.stringify(value)} is not a #rrggbb hex or "none".`,
      );
    glyphs.set(glyph, isTransparent(value));
  }
  if (!glyphs.has(".")) glyphs.set(".", true);

  if (
    !Array.isArray(spec.grid) ||
    spec.grid.length === 0 ||
    !spec.grid.every((row) => typeof row === "string")
  )
    fail(`"grid" must be a non-empty array of strings.`);

  let grid = expandSpriteGrid(spec as { grid: string[]; mirror?: string });
  let gridWidth = grid[0].length;
  for (let y = 0; y < grid.length; y += 1)
    if (grid[y].length !== gridWidth)
      fail(
        `grid is not rectangular: row 0 is ${gridWidth} wide but row ${y} is ${grid[y].length}.`,
      );
  if (gridWidth !== width || grid.length !== height)
    fail(
      `grid is ${gridWidth}x${grid.length} after mirroring but "size" says ${width}x${height}.`,
    );

  let opaque = new Set<string>();
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      let glyph = grid[y][x];
      let transparent = glyphs.get(glyph);
      if (transparent === undefined)
        fail(
          `row ${y} uses glyph ${JSON.stringify(glyph)} which is not in "palette".`,
        );
      if (!transparent)
        opaque.add((palette as Record<string, string>)[glyph].toLowerCase());
    }
  if (opaque.size > MAX_OPAQUE_COLORS)
    fail(
      `${opaque.size} opaque colors used; the ceiling is ${MAX_OPAQUE_COLORS}.`,
    );

  if (kind === "token")
    for (let [x, y] of [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ])
      if (!glyphs.get(grid[y][x]))
        fail(
          `token corner (${x},${y}) is not transparent - a standing token sits over a clear field.`,
        );

  assertValidAnchor(spec.anchor, fail);
}

function assertValidAnchor(anchor: unknown, fail: (message: string) => never) {
  if (anchor !== undefined) {
    if (
      !anchor ||
      typeof anchor !== "object" ||
      !Number.isFinite((anchor as { x: number }).x) ||
      !Number.isFinite((anchor as { y: number }).y)
    )
      fail(`"anchor" must be {x, y} numbers.`);
    let { x, y } = anchor as { x: number; y: number };
    if (x < 0 || x > 1 || y < 0 || y > 1)
      fail(`"anchor" x and y must be between 0 and 1.`);
  }
}
