GM: register or update how an entity kind renders on the map. Use this when a
new rule introduces a token kind such as a hearth, workshop, herb garden, or
watchtower. The visual applies immediately to every entity carrying that kind
tag and is persisted with the GM overlay.

Pass a `sprite` for the world art - the inline sprite DSL: `size` [w,h] in
multiples of 16 (up to 64), `palette` mapping single glyphs to "#rrggbb" (or
"none"; "." is transparent by default), `grid` rows of glyphs top-first, and
optionally `mirror:"horizontal"` to author only the left half of a symmetric
shape. Token sprites stand over a transparent field and must keep their
corners clear. Without a sprite the kind renders as the loud missing-sprite
checker; there is no icon/color fallback on the map. `icon`, `color`, and
`label` feed the HUD: legend, inspector, and tooltips. At least one field is
required.

Instead of `palette` + `grid`, a sprite can cut a tile from a tileset the
observatory serves: `sheet` is the PNG path and `tile` the index, counting
left to right then top to bottom in cells of `size`. A list of tiles is drawn
bottom to top. Two Kenney sheets ship, both 12 tiles wide:
`tiles/kenney-tiny-town.png` (grass, trees, buildings, fences, signs, tools)
and `tiles/kenney-tiny-dungeon.png` (characters, monsters, chests, potions,
weapons). `{size:[16,16], sheet:"tiles/kenney-tiny-dungeon.png", tile:111}`
is a hooded figure.

Example:

```
register_kind_visual({kind:"hearth", icon:"campfire", color:"#e8843a", label:"campfire",
  sprite:{size:[16,16], mirror:"horizontal",
    palette:{".":"none","s":"#7a7a8c","f":"#e8843a","y":"#f7c95c"},
    grid:["........", "........", "........", "...yy...", "..yffy..", "..ffff..", ".sffffs.", ".ssffss.",
          ".ssssss.", "ssssssss", "ssssssss", ".ssssss.", "..ssss..", "........", "........", "........"]}})
```
