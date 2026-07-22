GM: register a per-agent stock DEFAULT and seed it onto every agent at once — both those alive now AND every future joiner (and anyone reincarnated fresh).

This is the safe way to introduce a new per-agent need BEFORE adding a rule that reads it: a rule referencing a stock some agent lacks throws and freezes the whole tick for everyone. Use this instead of calling set_stock per agent.

The default fills gaps only — it never overwrites a stock an agent already carries.

A brand-new resource needs an `icon` (a game-icons.net slug — browse https://game-icons.net and copy the slug from an icon's URL) so the dashboard can show it; it drives the map, header pills, and agent stat icons. `color` is an optional hex tint.

**Example**

```
set_stock_default({stock:"warmth", value:100, min:0, max:100, icon:"warmth", color:"#e8843a"})
```

then add a rule that drains warmth.

This is the normal way to declare a resource BEFORE a rule writes to it: an `adjust`/`set` effect only ever touches a stock an entity already carries, and never auto-creates one — a stray `target` that names an entity instead of a stock ("self") is now a rule_error, not a phantom stock. Declare first (here, or on a spawn's own `stocks`), then write.

**Role — what this stock IS to a character**

Pass `role` to classify it, so prose and givability are right from the moment you mint it:

- `"vital"` — a pressure that can hurt or kill (health, satiation, hydration, warmth...). Band-alarmed prose only ("You are starving."), never a bare figure, never givable. Pair it with `bands` (what the world says at `pressing`/`serious`/`critical` — any band you don't write gets a serviceable default built from `label`). Direction is not a field here and never has been a choice: every vital in this world reads up as good, so harm always sits toward the floor, full stop — there is no setting that could make it otherwise. If the thing you're minting would naturally rise toward harm (a cold, an exposure), that is a sign you're naming the problem instead of the relief: name the stock for the relief instead (`warmth`, not `cold`) and write the rule that drains it. That is what makes "low is always the emergency" true without a field to get backwards — the run this doctrine comes from shipped a vital called `exposure`, wired to rise toward harm, and its own alarm read backwards as a result: screaming when the character was safest, silent the one tick real damage started.
- `"stat"` — a personal dimension worth a mention only when it's notable (courage, skill, reputation). Adjectival prose only when banded ("Your courage is low."), silent otherwise, never givable. Same `bands` shape as vital, just milder, and the same up-is-good direction.
- `"pack"` (the default — omit `role` entirely for an ordinary carried resource) — a fungible quantity that shows as a figure ("Carrying: wood 12.") and is the only role `give` ever touches. Add `stockpilable:true` on top if it should also be haulable into a stockpile via deposit/withdraw (rejected on vital/stat — stockpilable is a pack-only subflag, not a second givability axis).

**Example — a harm-coupled pressure, fully specified in one mint**

```
set_stock_default({stock:"warmth", value:100, min:0, max:100, icon:"warmth", color:"#e8843a",
  role:"vital", bands:{pressing:"You feel the cold.", serious:"You are shivering badly.", critical:"You are freezing to death."}})
```

then add a rule that drains warmth — the alarm reaches the character with no second authoring step, because role/label/bands live right here on the stock and ride the overlay, so a GM's edits persist and survive snapshot/restore. Note the rule *drains* warmth rather than raising a "cold" — that's the naming-for-the-relief pattern, not a stylistic choice.
