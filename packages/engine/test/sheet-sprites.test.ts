// Sheet sprites: a sprite may name a tile of a served tileset PNG instead of
// carrying palette + grid art. The validator checks the path and the tile
// list; the art itself is the viewport's to cut.

import test from "node:test";
import assert from "node:assert/strict";

import { assertValidSpriteSpec } from "../src/sprite.js";

const SHEET = "tiles/kenney-tiny-town.png";

test("a sheet tile, or a stack of them, is a valid sprite", () => {
  assertValidSpriteSpec("grass", {
    size: [16, 16],
    kind: "terrain",
    sheet: SHEET,
    tile: 0,
  });
  assertValidSpriteSpec("forest", {
    size: [16, 16],
    kind: "terrain",
    sheet: SHEET,
    tile: [0, 19],
  });
  assertValidSpriteSpec("hero", {
    size: [16, 16],
    sheet: SHEET,
    tile: 85,
    anchor: { x: 0.5, y: 1 },
  });
});

test("sheet sprites refuse bad paths, bad tiles, and mixed forms", () => {
  let bad: [unknown, RegExp][] = [
    [
      { size: [16, 16], sheet: "../secret.png", tile: 0 },
      /relative \.png path/,
    ],
    [{ size: [16, 16], sheet: "/tiles/a.png", tile: 0 }, /relative \.png path/],
    [{ size: [16, 16], sheet: "tiles/a.gif", tile: 0 }, /relative \.png path/],
    [{ size: [16, 16], sheet: SHEET }, /tile index/],
    [{ size: [16, 16], sheet: SHEET, tile: -1 }, /tile index/],
    [{ size: [16, 16], sheet: SHEET, tile: [] }, /tile index/],
    [{ size: [16, 16], sheet: SHEET, tile: [1, 2, 3, 4, 5] }, /tile index/],
    [{ size: [16, 16], sheet: SHEET, tile: 0, grid: ["."] }, /takes no "grid"/],
    [{ size: [16, 16], tile: 3 }, /relative \.png path/],
  ];
  for (let [spec, message] of bad)
    assert.throws(() => assertValidSpriteSpec("thing", spec), message);
});
