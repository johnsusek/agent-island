GM: mint (or redefine) a terrain KIND as data — its look, and whether it can be walked and how slowly.

Terrain holds no stock of its own, but a rule can still read it: `requires:{nearTerrain:{type:"water",range:1}}` is how "you may only drink at the lake" is written, and it needs no entity at all. Gate on the ground for an unlimited ambient source (water, forest, an ore seam) — a token is for a countable thing that gets carried, depleted, or destroyed, and `setTerrain` is how ground itself is spent (felled forest becomes plains). Never simulate a lake or a wood with a field of tokens: check what terrain already exists before minting either.

`sprite` (optional) is the ground art drawn on the viewport, as the inline sprite DSL (palette + character grid, kind:"terrain", filling the full cell edge to edge — same shape as register_kind_visual's sprite, glyph palette + grid rows). Author it yourself in the same call. Without a sprite the tile renders as the loud missing-sprite checker — there is no color fallback on the map. `color` is the map fill on HTML surfaces (tooltips, legend); `icon` (optional) is a game-icons.net slug (browse https://game-icons.net, copy the slug from an icon's URL, e.g. 'volcano'). `moveCost` (optional) is the ticks to step onto a tile of it (default 1; higher = slower ground). `passable:false` makes it a barrier.

Register the terrain BEFORE painting it with set_terrain.

**Example** — an orange, impassable lava barrier:

```
register_terrain({name:"lava", passable:false, color:"#ff6a00", icon:"lava",
  sprite:{size:[16,16], kind:"terrain",
    palette:{"k":"#1d1117","o":"#ff6a00","r":"#c8331f"},
    grid:["kkkkokkkkkkkrkkk", ...16 rows of 16 glyphs...]}})
```
