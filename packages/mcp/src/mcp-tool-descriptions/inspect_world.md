GM: read the unredacted world.

With NO arguments you get a compact overview:

- world stocks
- a one-line roster per agent (location, status, bare vitals)
- a compact list of every non-agent entity (tokens, spawned predators, drops, with position and reserves)
- rule headlines (id + description, no bodies)
- the recent event log

It stays small by excluding the heavy sections (full map, observations, history); the roster and entity list themselves are uncapped, so they grow with population.

Then drill into only what you care about instead of loading everything:

- `agent` — one agent's full state + observation
- `entity` — one entity's full stocks/tags
- `rule` — one rule's full body
- `area` — the map tiles and occupants around a point or place (the whole map is ~93 KB — prefer this)

`include` upgrades an overview section to full data or pulls a heavy one (map, observations, history, controllers); `include:["all"]` is the full snapshot. The response's `drilldown` field lists these.

Free; does not advance time.
