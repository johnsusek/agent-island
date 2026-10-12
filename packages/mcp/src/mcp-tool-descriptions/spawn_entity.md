GM: conjure a kernel entity with an id, tags rules can bind to, optional stocks, and an optional grid position so a `colocated` rule/condition can match it.

`occupancy` decides whether it takes ground. `"tile"` carves it onto the grid as a real location agents can see and route/travel to, and reserves that tile so nothing can be built over it. `"blocking"` does the same and also makes routes go around it — a wall, a hearth. Omit it and the entity is only colocation-matchable and invisible on the map. A positioned token agents haven't walked near yet stays hidden by fog until then; set `reveal:true` to make it known to the whole world immediately (pairs well with announce).

The result reports `onMap` (false if the tile already held another token) and `revealedTo`.

`pos` must be a tile agents can walk onto: a position on impassable ground (water, lava) is refused, because such a token is reachable only from an adjacent bank and can never be stood or built on. Check the terrain with inspect_world's `area` before placing. `allowImpassable:true` overrides it for something that genuinely belongs in the water.

Pass `icon` (a game-icons.net slug) and `color` (a CSS hex) to give this entity's _kind_ a real map icon instead of the generic fallback pin. They key off the entity's most specific tag — set them once on the first entity of a kind and every later one with that tag draws the same way. If `icon` is set, `color` is required.

**Examples**

A hidden predator:

```
spawn_entity({id:"wolf-1", tags:["predator"], stocks:{health:{value:20}}, pos:{x:8,y:8}})
```

An announced food source with its own icon:

```
spawn_entity({id:"berry-grove", tags:["food-bush"], occupancy:"tile", reveal:true, stocks:{food:{value:40,max:40}}, pos:{x:12,y:9}, icon:"berries-bowl", color:"#8a3ffc"})
```
