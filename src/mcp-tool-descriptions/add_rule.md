GM: append one rule to the live rule set; it takes effect next tick.

A rule is a plain object with:

- a unique string `id`
- a short plain-language `description` summarizing what the rule does and why (for dashboards and other GMs — the kernel ignores it)
- a `phase` (`derived|event|flow|threshold|watch|transition`) or `kind` (`action|modifier`)

**Examples**

A flow that drains a world stock:

```
{id:"cold-snap", description:"A cold snap bleeds the world's warmth each tick", phase:"flow", target:"warmth", rate:-2}
```

An event rule that reacts to movement:

```
{id:"movement-costs-energy", description:"Walking costs energy", phase:"event", on:"moved", do:[{adjust:{target:"energy",by:-2}}]}
```

A per-agent flow — add `each:{tag:"agent"}`.

A watch fires its emit once when `when` newly becomes true (re-arming when it clears). Adding `interrupt` makes the alarm stop the subject's hands — their in-flight action and running order end "interrupted" with this text as the reason:

```
{id:"starving", description:"The hunger alarm", phase:"watch", each:{tag:"agent"}, when:{cmp:"gte", left:{stock:"hunger"}, right:100}, emit:{type:"starving", interrupt:"you are starving - eat now"}}
```

**Inter-agent rules**

A `colocated` condition/selector can filter and search:

```
{tag:"agent", where:{cmp:"gt", left:{stock:"infection"}, right:0}, range:1}
```

This matches another agent within 1 tile whose infection>0 (contagion); use the same shape under an effect's `of` to hit that matched other (combat). `range` defaults to 0 (same tile); `other` defaults to true (excludes the acting agent itself).

When several candidates qualify, add `pick` to choose:

- `"nearest"`
- `{lowest:"health"}` — the weakest
- `{highest:"strength"}` — the strongest
- `{random:["salt"]}` — a seeded, replay-stable draw

Omitted, the first in a fixed order wins.

To hit ALL matches instead of one, use the `forEach` effect:

```
{forEach:{colocated:{tag:"agent",range:1}, do:[{adjust:{target:"morale",by:3}}]}}
```

This runs its inner effects once per match with that match as "self".

Aggregates (`count`/`sum`/`avg`/`min_of`/`max_of`) accept `near` (chebyshev radius around the bound entity) and `other:true`, so:

```
{count:{tag:"agent",near:3,other:true}}
```

reads "how many OTHER agents stand within 3 tiles of me".

**Dynamic tags**

Every tag position except a rule's `each` selector accepts, besides a literal string, `{arg:"param"}` (an action argument) or `{nameOf:<entity selector>}` (an entity's id, resolved when the rule runs). `{nameOf:"self"}` is the ownership idiom:

```
{spawn:{kind:"stash",tags:[{nameOf:"self"}],at:"self"}}
```

mints a stash carrying its builder's name as a tag (`kind` is the spawn's identity — it feeds the sprite, label, and auto-id; tags are an unordered behavior set), and

```
{sum:{tag:{nameOf:"self"},stock:"gold"}}
```

in a per-agent derived rule totals that agent's own stashes. A tag ref always resolves against the acting/evaluating entity, not the entity an effect's `of` targets — so `{tag:{of:{arg:"target"},add:{nameOf:"self"}}}` brands the target with the actor's name. `each` stays a literal tag: the selector is what produces the bound entity, so there is nothing to resolve `{nameOf}` against yet.

**Kind vs tags**

An entity's `kind` is its one identity name ("wolf", "hearth") — sprite, label, and auto-id key off it. `tags` is an unordered behavior set ("solid" blocks routes, "token" projects onto the map). The tag effect cannot touch kind; change identity with the `kind` effect (immediate phases only):

```
{kind:{of:"self",set:"carcass"}}
```

`"token"` is not decoration: a spawn that lands with a position and without it is invisible on the map, absent from what agents can see and route to, and reachable by nothing but a colocation match on its own tile. Anything your rule mints that is supposed to _exist in the world_ — a dropped item, a built structure, a carcass — gets `tags:["token"]` or it is a ghost.

A tile shows exactly one token, and `"exclusive"` is how a token reserves its ground: an action that would raise a new token where an exclusive one already stands is refused up front, before time or materials are spent. Without it the same build silently falls off the grid — the builder pays, the log says it worked, and the tile still shows whatever was already there. `"solid"` is the separate question of whether the thing blocks routes.

Every matcher takes both forms: `tag:"wolf"` is loose (matches the name in either slot — kind or tags), `kind:"wolf"` is strict (the entity IS a wolf; a tag carrying the name doesn't count). Available at `each:{kind}`, conditions (`{kind:"wolf",of:...}` — one of tag/kind per cond, combine with `all`), `colocated:{kind,range,pick}`, aggregates (`{count:{kind:"wolf"}}`), and action target params. In colocated/aggregate/each, giving both tag and kind demands both; giving neither is rejected.

**Spatial effects** (immediate phases only, like all structural effects)

`moveToward` steps an entity toward a target selector, closing 1 tile of chebyshev distance per step:

```
{moveToward:{target:{colocated:{tag:"agent",range:6,pick:"nearest"}}}}
```

This is the chase idiom (gate the rule with a matching `when` so a tick with no target in range skips instead of erroring; optional `steps` walks further per tick).

A `spawn`'s `at` takes literal coordinates as well as an entity selector:

```
{spawn:{kind:"crate",at:{x:30,y:12}}}
```

Both coordinates are expressions, so:

```
{at:{x:{round:{rand:[0,63,"dx"]}},y:{round:{rand:[0,63,"dy"]}}}}
```

scatters an airdrop (off-map coordinates throw as a `rule_error` rather than spawning).

`{posX:sel}` / `{posY:sel}` read an entity's own tile coordinate (the selector resolves like anywhere else — `"self"`, an id, `{arg}`, `{colocated}`), so a spawn can land _relative_ to something already on the map. This is spatial diffusion — a full grass patch seeding a neighbour tile:

```
{at:{x:{add:[{posX:"self"},{round:{rand:[-1,1,"sx"]}}]},y:{add:[{posY:"self"},{round:{rand:[-1,1,"sy"]}}]},skipOffMap:true}}
```

`skipOffMap:true` makes an off-map roll a quiet no-op instead of a `rule_error`, so a patch on the frontier spreading outward simply doesn't cross the edge that tick. A coordinate spawn does NOT check passability — add `snapToPassable:true` and a landing in the lake slides to the nearest walkable tile instead of leaving a token nobody can stand on. A spawn `at:"self"` needs neither: the actor is standing there, so the tile is walkable by definition.

**Gating on the ground**

`nearTerrain` gates a rule on the tile the actor stands on (or `range` tiles around it, chebyshev) instead of on an entity:

```
{id:"drink_water", kind:"action", duration:3, aliases:["drink","scoop_water"],
 requires:{nearTerrain:{type:"water",range:1}},
 requireReason:"you have to be standing at the water's edge",
 do:[{adjust:{target:"thirst",by:-40}}]}
```

Reach for this before spawning tokens whenever the world already has ground that means the thing. An unlimited ambient source — a lake, a forest, an ore seam — is terrain the verb reads; a token is for a countable thing that gets carried, depleted, or destroyed. Painting a lake as a hundred "water" tokens is the wrong shape: the map fills with clutter, and characters treat a puddle as an object to hoard rather than a place to go.

Terrain gates are also the cheapest to reach: an action refused only because the actor is standing in the wrong place returns the terrain kind as a travel destination, so "chop at forest" tells a character to walk to the forest without anyone naming a tile. `range:1` is the idiom for impassable ground (water) — the actor stands beside it; `range:0` for ground they stand on (forest, plains).

`setTerrain` (an immediate-phase structural effect) rewrites the tile under an entity, so ground can be spent or transformed:

```
{setTerrain:{of:"self", to:"plains"}}
```

This is how a forest tile clears when it is felled out, or scorched earth follows a fire. Terrain that never changes is free forever — if a verb harvests the ground, either price it elsewhere or let it consume the tile.

**Pacing knobs** on a flow/threshold/watch/transition/event rule:

- `priority` (number, default 0) — higher runs first within a phase or channel fold; ties keep declared order, so an unset priority reproduces today's plain array-order behavior
- `chance` (0-1) — a seeded reproducible draw gating whether the rule fires this tick for this (rule, self) pair; omit for "always"
- `cooldown` (non-negative ticks) — the rule skips until this many ticks have passed since it last fired for this (rule, self) pair, tracked in `world.cooldowns` so it survives snapshot/restore

A threshold rule only may also set `conflict` (`"override"|"highest"|"lowest"`, default `"override"`) to resolve competing buffered `set` effects landing on the same (entity, stock) this tick — `"override"` is last-writer-wins, `"highest"`/`"lowest"` keep the most extreme proposed value without hand-rolling a priority order to fake it (only meaningful for `set`; an `adjust` is additive and needs no conflict policy).

**Example** — a raid that can strike at most once every 20 ticks and only 5% of the time it's eligible:

```
{id:"raid", description:"A rare raid strikes an eligible agent", phase:"threshold", each:{tag:"agent"}, chance:0.05, cooldown:20, when:{cmp:"gte", left:{stock:"health"}, right:1}, do:[{adjust:{target:"health",by:-15}}]}
```

**Action aliases**

An `action` rule may list `aliases` - other names the same action answers to:

```
{id:"mine_stone", kind:"action", duration:5, aliases:["mine","quarry","chip_stone","extract_stone"], requires:..., do:[...]}
```

Every alias resolves to this action, and the actor's result reports the canonical
name. Ratify a synonym cluster in one rule this way instead of one rule per word;
add stragglers later with tweak_rule. A name already used by another action (as id
or alias) is rejected.

**Spawn and consume are one rule set**

A `spawn` puts an entity in the world; nothing consumes it unless another rule says so. The pair that makes an item economy real is a `requires` naming the item and a `destroy` spending it:

```
{id:"gather_food", kind:"action", duration:4, do:[{spawn:{kind:"berry",tags:["token"],at:"self"}}]}
{id:"eat_food", kind:"action", duration:2, requires:{colocated:{kind:"berry",range:1}},
 requireReason:"must be beside berries to eat",
 do:[{destroy:{of:{colocated:{kind:"berry",range:1}}}},{adjust:{target:"hunger",by:-25}}]}
```

Write the second rule with no `requires` and no `destroy` and the two are unrelated systems that merely look like a loop: the berries accumulate untouched forever and `eat_food` pays out hunger relief on demand, needing nothing. The dry-run cannot catch this — an unconditional rule is valid, just free.

Read list_rules first to copy the shape of a working rule.

**Validation**

Structural validation (unique id, recognized phase/kind, structural-effect placement) rejects outright; everything else is checked by an automatic dry-run — the result carries a `dryRun` report from simulating the new rule set ~50 ticks on a disposable copy of the world.

- `warnings` are the rule_errors your rule threw (a bad expression, a stock some agent lacks)
- `notes` are softer findings (the rule matched no entity, or had no observable effect — normal for a rule awaiting a season or threshold)

Warnings do NOT block: the rule is live regardless, so a warning about a stock you are about to seed with set_stock_default is expected — fix or proceed deliberately. One is worth treating as a hard stop, because nothing downstream will catch it: an empty `do`, which lets a character pay, be told they succeeded, and describe a structure that is not in the world.

The dry-run reads shape, never intent — it cannot tell you a verb promised a noun it never spawns, or that a built thing forgot to reserve its tile. Those are yours to check.

**Redemption.** If the new rule's name or any alias matches a verb someone attempted speculatively, the result carries `redeemed: [agentId, ...]` — those agents were told in fiction that the world learned the verb, and woken to weigh it. It is news, not an alarm: their running order carries on and their action is not replayed for them.

At real runtime a failure never pauses the clock: it is isolated to the offending (rule, agent) pair and surfaces as a `rule_error` in the dashboard event log while the rest of the world keeps ticking.
