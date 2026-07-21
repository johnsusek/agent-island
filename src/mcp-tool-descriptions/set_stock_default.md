GM: register a per-agent stock DEFAULT and seed it onto every agent at once — both those alive now AND every future joiner (and anyone reincarnated fresh).

This is the safe way to introduce a new per-agent need BEFORE adding a rule that reads it: a rule referencing a stock some agent lacks throws and freezes the whole tick for everyone. Use this instead of calling set_stock per agent.

The default fills gaps only — it never overwrites a stock an agent already carries.

A brand-new resource needs an `icon` (a game-icons.net slug — browse https://game-icons.net and copy the slug from an icon's URL) so the dashboard can show it; it drives the map, header pills, and agent stat icons. `color` is an optional hex tint.

**Example**

```
set_stock_default({stock:"warmth", value:100, min:0, max:100, icon:"warmth", color:"#e8843a"})
```

then add a rule that drains warmth.
