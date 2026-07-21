GM: set a stock on any entity — the world singleton (entity "world"), an agent (its name), or a token.

The entity must already exist (it errors otherwise — use spawn_entity to create one); the stock itself is created if absent, so you can introduce a brand-new resource mid-game. The value is clamped to its bounds.

Introducing a resource the world has never seen requires an `icon` (a game-icons.net slug — browse https://game-icons.net and copy the slug from an icon's URL, e.g. 'campfire') so the dashboard can show it; an already-known resource needs none. `color` is an optional hex tint for the icon.

To seed a NEW per-agent stock across the whole world (and future joiners), use set_stock_default instead.

**Examples**

```
set_stock({entity:"world", stock:"fire", value:0, icon:"campfire", color:"#e8843a"})
set_stock({entity:"world", stock:"warmth", value:100, min:0, max:100, icon:"thermometer-hot"})
```
