// The Illuminator's renderer: the one sanctioned way to turn a sprite DSL into a
// PNG. A drawing session authors ONE JSON file (palette + character grid) and
// runs this; the script does every mechanical thing that used to be hand-written
// Python - palette-membership enforcement, exact in-code mirroring, the
// rectangular / 16-multiple / size asserts, the PNG encode, the x12 upscale, and
// the reopen checks (corners transparent, <=10 opaque colors). If anything is
// wrong it prints a specific error and exits non-zero, so a broken grid is caught
// here instead of shipping.
//
// Pure Node (zlib only) - no image dependency. It reads the staged palette
// (a .hex list, one rrggbb per line) to check every pixel is a real palette
// color, and hand-rolls a tiny PNG encoder for the output.
//
// Usage:  node render-sprite.mjs <sprite.json> [--palette palette.hex]
//         node render-sprite.mjs --dump-palette palette.hex   (list the palette's colors as hex)
//
// sprite.json shape:
//   {
//     "size": [16, 16],            // required, exact commissioned pixel size; both 16-multiples
//     "kind": "token",             // "token" (default) or "terrain"; token checks transparent corners
//     "palette": {                 // char -> color. "#rrggbb", or "none"/"." for transparent
//       "k": "#1a1a1a", "g": "#33aa77", ".": "none"
//     },
//     "grid": ["................", ...],   // rows of equal-width strings, one char per pixel
//     "mirror": "horizontal"       // optional: author the LEFT half, renderer mirrors it exactly.
//                                  //   "horizontal" | "vertical" | "none" (default)
//   }

import { promises as fsp } from "node:fs";
import { deflateSync } from "node:zlib";
import { resolve } from "node:path";

const TRANSPARENT = [0, 0, 0, 0];

async function main() {
  const args = process.argv.slice(2);
  let jsonPath;
  let palettePath;
  let dumpPalette;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--palette") palettePath = args[++i];
    else if (args[i] === "--dump-palette") dumpPalette = args[++i];
    else if (!jsonPath) jsonPath = args[i];
  }

  // --dump-palette: list the palette's colors as normalized #rrggbb so the
  // author can choose from them before writing the grid.
  if (dumpPalette) {
    const colors = await loadPaletteColors(dumpPalette);
    if (!colors) fail(`could not parse palette ${dumpPalette}`);
    const hex = [...colors].map((c) => "#" + c.split(",").map((n) => (+n).toString(16).padStart(2, "0")).join(""));
    process.stdout.write(hex.join("\n") + "\n");
    process.stdout.write(`# ${hex.length} colors in ${dumpPalette}\n`);
    return;
  }

  if (!jsonPath) fail("usage: node render-sprite.mjs <sprite.json> [--palette palette.hex]");

  const spec = await readJson(jsonPath);

  // --- size ---
  const size = spec.size;
  if (!Array.isArray(size) || size.length !== 2 || !size.every((n) => Number.isInteger(n) && n > 0))
    fail(`"size" must be [width, height] of positive integers; got ${JSON.stringify(size)}`);
  const [width, height] = size;
  if (width % 16 !== 0 || height % 16 !== 0)
    fail(`size ${width}x${height} is not a multiple of 16 on both axes`);

  const kind = spec.kind === "terrain" ? "terrain" : "token";

  // --- palette dict -> RGBA, with the transparent glyphs ---
  const palette = spec.palette;
  if (!palette || typeof palette !== "object")
    fail(`"palette" must be an object mapping single characters to colors`);
  const charToRGBA = new Map();
  for (const [ch, val] of Object.entries(palette)) {
    if (ch.length !== 1) fail(`palette key ${JSON.stringify(ch)} must be a single character`);
    charToRGBA.set(ch, colorToRGBA(ch, val));
  }
  // `.` is transparent by default unless the author redefined it.
  if (!charToRGBA.has(".")) charToRGBA.set(".", TRANSPARENT);

  // --- grid, then mirror in code ---
  let grid = spec.grid;
  if (!Array.isArray(grid) || grid.length === 0 || !grid.every((r) => typeof r === "string"))
    fail(`"grid" must be a non-empty array of strings`);
  grid = applyMirror(grid, spec.mirror);

  const w = grid[0].length;
  for (let y = 0; y < grid.length; y++)
    if (grid[y].length !== w)
      fail(`grid is not rectangular: row 0 is ${w} wide but row ${y} is ${grid[y].length} wide`);
  if (w !== width || grid.length !== height)
    fail(
      `grid is ${w}x${grid.length} after mirroring but "size" says ${width}x${height} - they must match exactly`,
    );

  // --- rasterize, validating every glyph is defined ---
  const pixels = Buffer.alloc(width * height * 4);
  const usedOpaque = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ch = grid[y][x];
      const rgba = charToRGBA.get(ch);
      if (!rgba) fail(`row ${y} uses glyph ${JSON.stringify(ch)} which is not in "palette"`);
      const o = (y * width + x) * 4;
      pixels[o] = rgba[0];
      pixels[o + 1] = rgba[1];
      pixels[o + 2] = rgba[2];
      pixels[o + 3] = rgba[3];
      if (rgba[3] !== 0) usedOpaque.add(rgba.slice(0, 3).join(","));
    }
  }

  // --- palette-membership: every opaque color must be in the staged palette ---
  if (palettePath) {
    const allowed = await loadPaletteColors(palettePath);
    if (allowed) {
      const stray = [...usedOpaque].filter((c) => !allowed.has(c));
      if (stray.length)
        fail(
          `these colors are not in the palette file (${palettePath}): ${stray
            .map((c) => "rgb(" + c + ")")
            .join(", ")}. Use ONLY palette colors.`,
        );
    } else {
      warn(`could not parse palette ${palettePath}; skipping color-membership check`);
    }
  }

  // --- the reopen checks, done up front on the buffer we are about to write ---
  if (usedOpaque.size > 10)
    fail(`${usedOpaque.size} opaque colors used; the ceiling is 10 (fewer is better)`);
  if (kind === "token") {
    const corners = [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ];
    for (const [x, y] of corners) {
      const a = pixels[(y * width + x) * 4 + 3];
      if (a !== 0)
        fail(`token corner (${x},${y}) is not transparent - a standing token sits over a clear field`);
    }
  }

  // --- write sprite.png and the x12 inspection copy ---
  const outDir = resolve(jsonPath, "..");
  await fsp.writeFile(resolve(outDir, "sprite.png"), encodePng(pixels, width, height));
  const scale = 12;
  await fsp.writeFile(
    resolve(outDir, "sprite_x12.png"),
    encodePng(upscale(pixels, width, height, scale), width * scale, height * scale),
  );

  // --- report + echo the (mirrored) grid so the author reads what actually rendered ---
  process.stdout.write(grid.join("\n") + "\n\n");
  process.stdout.write(
    `OK  ${width}x${height} ${kind}  |  ${usedOpaque.size} opaque color${
      usedOpaque.size === 1 ? "" : "s"
    }  |  wrote sprite.png + sprite_x12.png\n`,
  );
}

function applyMirror(grid, mode) {
  if (!mode || mode === "none") return grid;
  if (mode === "horizontal")
    // author the left half (including a center column if width is odd); the right
    // half is its exact mirror, so the two halves are pixel-identical by construction.
    return grid.map((row) => row + [...row].reverse().slice(row.length % 2 === 0 ? 0 : 1).join(""));
  if (mode === "vertical") {
    const bottom = grid.slice(0, grid.length % 2 === 0 ? grid.length : grid.length - 1).reverse();
    return [...grid, ...bottom];
  }
  fail(`"mirror" must be "horizontal", "vertical", or "none"; got ${JSON.stringify(mode)}`);
}

function colorToRGBA(ch, val) {
  if (typeof val !== "string") fail(`palette["${ch}"] must be a color string`);
  const v = val.trim().toLowerCase();
  if (v === "none" || v === "transparent" || v === "") return TRANSPARENT;
  const hex = v.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/.test(hex)) fail(`palette["${ch}"] = ${JSON.stringify(val)} is not a #rrggbb hex or "none"`);
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 255];
}

function upscale(px, w, h, s) {
  const out = Buffer.alloc(w * s * h * s * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let dy = 0; dy < s; dy++)
        for (let dx = 0; dx < s; dx++) {
          const p = ((y * s + dy) * w * s + (x * s + dx)) * 4;
          out[p] = px[o];
          out[p + 1] = px[o + 1];
          out[p + 2] = px[o + 2];
          out[p + 3] = px[o + 3];
        }
    }
  return out;
}

// --- minimal PNG encoder (8-bit RGBA, no filtering) ---
function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter type 0 (none)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// --- palette reader: a lospec-style .hex list, one rrggbb per line (a leading
// "#" is tolerated); blank lines and lines starting with ";" are ignored ---
async function loadPaletteColors(path) {
  let text;
  try {
    text = await fsp.readFile(path, "utf8");
  } catch {
    return null;
  }
  const colors = new Set();
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith(";")) continue;
    const hex = entry.replace(/^#/, "").toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return null;
    colors.add(
      `${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)}`,
    );
  }
  return colors.size > 0 ? colors : null;
}

async function readJson(path) {
  let raw;
  try {
    raw = await fsp.readFile(path, "utf8");
  } catch {
    fail(`could not read ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`${path} is not valid JSON: ${e.message}`);
  }
}

function fail(msg) {
  process.stderr.write(`render-sprite: ${msg}\n`);
  process.exit(1);
}
function warn(msg) {
  process.stderr.write(`render-sprite: warning: ${msg}\n`);
}

main().catch((e) => fail(e?.stack || String(e)));
