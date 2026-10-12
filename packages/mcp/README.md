# @agent-island/mcp

Run a rule-based world that LLM agents play over MCP.

You describe the world as data: entities that hold numeric stocks, and JSON
rules that change those stocks every tick. A deterministic engine runs the
rules. Agents connect over MCP and act through the actions the rules define.
A game master, which can be an agent too, can inspect the world and add,
change or dry-run rules while it runs.

> **Status:** not published yet. The `@agent-island/*` names are
> placeholders. Run everything from this repository for now.

Three packages, each usable alone:

| Package                             | What it does                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@agent-island/core`](../core)     | The rules kernel: entities, stocks, JSON rules run in fixed tick phases, the grid, the rule schema, and dry runs. No I/O.                              |
| [`@agent-island/engine`](../engine) | A world host on the kernel: agents on a grid, actions and standing orders, speech, event visibility, runtime rule edits, scenarios, snapshots. No I/O. |
| `@agent-island/mcp` (this one)      | Sessions, turns or a wall clock, victory, an event journal, optional file persistence, and the two MCP endpoints. Plus `serve`.                        |

## Quick start

From the repository root, run the bundled example: a fishing village
sharing one bay.

```bash
npm install
```

```bash
npx tsx packages/mcp/src/cli.ts serve --world packages/mcp/examples/commons/world.json --scenarios packages/mcp/examples/commons/scenarios
```

That serves:

- `http://127.0.0.1:3000/mcp` for characters
- `http://127.0.0.1:3000/gm` for game masters
- `http://127.0.0.1:3000/api/state` for the whole world as JSON

The world is in memory. Add `--data ./commons-data` to keep it across
restarts.

## Add players

Each player is one agent connected to `/mcp`. With Claude Code, start one
per villager (four or five makes the best game):

```bash
claude -p "You are Ara, a villager in a small fishing village. Join the game as Ara and play until the season ends." --mcp-config '{"mcpServers":{"commons":{"type":"http","url":"http://127.0.0.1:3000/mcp"}}}' --strict-mcp-config --allowedTools mcp__commons
```

The server sends each player a briefing (MCP instructions, and again in the
`join_game` result), so the prompt only needs a name and a personality.

To add the server to an interactive Claude Code session instead:

```bash
claude mcp add --transport http commons http://127.0.0.1:3000/mcp
```

Any MCP client that speaks Streamable HTTP works the same way.

## Add a game master

A game master connects to `/gm`. Its tools read the world
(`inspect_world`, `list_rules`, `wait_for_world`) and change it (`add_rule`,
`tweak_rule`, `remove_rule`, `set_stock`, `spawn_entity`, `announce`, and
more). `dry_run_rule` simulates a candidate rule against the live world
without adding it, and reports the errors it would throw.

In the commons, a GM could turn a quota the villagers agree on into a real
rule by tightening the `fish` action with `tweak_rule`:

```json
{
  "id": "fish",
  "fields": {
    "requires": {
      "all": [
        {
          "cmp": "gte",
          "left": { "stock": "school", "of": "world" },
          "right": 15
        },
        { "cmp": "lt", "left": { "stock": "fish" }, "right": 6 }
      ]
    },
    "requireReason": "the council has closed the bay until it holds 15 fish"
  }
}
```

A character who tries to fish below the quota is refused with that reason.

## The commons example

[`examples/commons`](examples/commons) is a 5x5 shore everyone shares, so
everyone hears everyone.

- **The bay** starts with 30 fish and holds at most 40. Fish regrow fastest
  at half capacity and not at all from an empty bay. Below one fish, the bay
  is empty for good.
- **`fish`** takes 2 ticks and lands up to 2 fish, if your basket (6) has
  room.
- **`eat`** turns one fish into 15 satiation. Hunger costs 1 satiation per
  tick. Starving costs 4 health per tick.
- **The season** ends in victory at tick 300 if anyone is alive.

Every character's prose shows the shared count: `The world holds: fish in
the bay 30/40.`

The bay can feed four or five villagers who fish only when hungry. If
everyone keeps a full basket, the bay collapses within about 50 to 100 ticks
and the village starves before the season ends. The tests in
[`test/commons-example.test.ts`](test/commons-example.test.ts) play both
strategies for a full season. Nothing in the rules forbids hoarding; the
players have to talk each other out of it.

## Writing a world

A world is two kinds of file.

**The world file** is the canvas:

```json
{ "name": "commons", "width": 5, "height": 5, "seed": 7 }
```

**A scenario** is everything else, as an overlay:

```json
{
  "name": "commons",
  "description": "What the game is, for people choosing a scenario.",
  "recommendedPlayers": { "min": 4, "max": 5 },
  "include": [],
  "overlay": {
    "defaultTerrain": "shore",
    "terrainSpecs": { "shore": { "moveCost": 1 } },
    "worldStocks": {
      "school": {
        "value": 30,
        "min": 0,
        "max": 40,
        "icon": "big-wave",
        "role": "pack",
        "label": "fish in the bay"
      }
    },
    "stockDefaults": {
      "fish": {
        "value": 0,
        "min": 0,
        "max": 6,
        "icon": "fish-bucket",
        "role": "pack",
        "label": "fish"
      }
    },
    "dynamicRules": []
  }
}
```

- `stockDefaults` are the stocks every character starts with.
- `worldStocks` live on the single `world` entity.
- A stock's `role` decides how characters read it:
  - `vital`: a pressure that can kill, described in words by band
    (`bands.pressing`, `serious`, `critical`).
  - `stat`: mentioned only when low.
  - `pack`: a count, shown as a figure. A world stock with role `pack` is
    shown to every character.
- `icon` is a [game-icons.net](https://game-icons.net) slug.

`serve` runs the scenarios folder's only scenario, or the one named with
`--scenario`.

### Rules

A rule is a JSON object with an `id`, a `description`, and either a
`phase` or a `kind`. Each tick runs the phases in a fixed order, so the
result never depends on the order rules were added.

| Rule               | Runs                                                | Use it for                                          |
| ------------------ | --------------------------------------------------- | --------------------------------------------------- |
| `derived`          | first, every tick                                   | recomputing a stock from an expression (a calendar) |
| `event`            | when an event of type `on` fires                    | reacting to what just happened                      |
| `kind: "action"`   | when a character commits it, after `duration` ticks | the verbs characters can use                        |
| `flow`             | every tick, as a rate                               | drains and growth                                   |
| `threshold`        | every tick while `when` holds                       | ongoing effects of a state                          |
| `watch`            | once, when `when` newly becomes true                | alarms, announcements, victory                      |
| `transition`       | once, when `when` newly holds, after thresholds     | one-way changes such as death                       |
| `kind: "modifier"` | wherever a flow or adjust names its `channel`       | "in winter, gather at half rate"                    |

`each: { "tag": "agent" }` runs a rule once per character, and
`each: { "tag": "world" }` once on the world.

Effects include `adjust`, `set`, `transfer`, `spawn`, `destroy`, `tag`,
`take`, `release`, `move`, `moveToward`, `moveTo`, `setTerrain`, `reveal`
and `forEach`. Expressions include arithmetic, `min` and `max`, `if`,
`count` and `sum` over entities, `{"stock": name, "of": entity}`, and
`{"tick": true}`.

A watch emitting `{"type": "victory", "global": true}` ends the game after a
grace period. The full grammar is the `Rule` type in
[`packages/core/src/kernel.ts`](../core/src/kernel.ts), and the GM's
`add_rule` description walks through examples.

## Using it as a library

`serve` is a thin wrapper. To embed the world in your own server:

```ts
import express from "express";
import { readFileSync } from "node:fs";
import {
  createColony,
  createMcpHandler,
  scenarioFromWorldFile,
} from "@agent-island/mcp";

let colony = createColony({
  baseScenario: scenarioFromWorldFile(
    JSON.parse(readFileSync("world.json", "utf8")),
    "world.json",
  ),
  scenariosDir: "scenarios",
  scenarios: ["commons"],
});
let mcp = createMcpHandler(colony, { serverName: "commons" });

let app = express();
app.use(express.json());
app.post("/mcp", mcp.character.post);
app.get("/mcp", mcp.character.get);
app.delete("/mcp", mcp.character.delete);
app.post("/gm", mcp.gm.post);
app.get("/gm", mcp.gm.get);
app.delete("/gm", mcp.gm.delete);
colony.start();
app.listen(3000);
```

Useful `createColony` options:

| Option                                            | Default             | Effect                                                                                                                            |
| ------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `baseScenario`                                    | required            | The canvas every scenario is shaped onto                                                                                          |
| `scenariosDir`, `scenarios`                       | none                | Where scenarios live, and which to run                                                                                            |
| `briefings`                                       | the bundled prompts | `{ character, gm }` instructions for each endpoint                                                                                |
| `realTimeMs`                                      | `0` (lockstep)      | Advance one tick every N ms instead of when every character has acted                                                             |
| `statePath`, `rulesPath`, `journalDir`, `runsDir` | none (in memory)    | File persistence                                                                                                                  |
| `engineOptions`                                   | both on             | `requireStockIcons` and `warnUnillustratedSpawns`; turn them off if your UI draws no icons or sprites, and brief your GM to match |

The engine runs without MCP or a server:

```ts
import { createWorld } from "@agent-island/engine";

let world = createWorld(scenario);
world.applyOverlay(overlay);
world.addAgent("Ara");
world.commitIntent("ara", { type: "fish" });
world.tick();
```

## Tests

```bash
npm test --workspaces --if-present
```
