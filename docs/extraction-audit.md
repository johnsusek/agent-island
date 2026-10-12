# Extracting the rules engine and MCP server

Audit of how the rules engine and MCP server are coupled to Agent Island, and
the plan for pulling them out into packages anyone can use to run a rule-based
simulation for agents over MCP. Audited 2026-10-12 at `c92b326`; step 1 is
done (see the status at the end).

## The dependency graph

```
kernel.ts ──► (no internal imports)
space.ts  ──► kernel only
rule-schema, dryrun ──► kernel (+ one display type)
engine.ts (a 3,600-line createWorld closure) ──► everything above + scenario, vitals, sprite, orders
coordinator.ts (2k lines) ──► engine, journal, scenarios, fs/paths
mcp-handler.ts (1.2k lines) ──► coordinator, sense-prose, briefings (fs)
```

Every dependency points down and there are no cycles, so the cut lines
already exist.

## What is already generic

- **The rules DSL.** Flow, threshold, watch, event, transition, derived,
  action, and modifier rules, plus a full expression and condition language.
  All of it is plain JSON, validated by zod in `rule-schema.ts`. The kernel's
  own header says it "knows nothing about fire, hunger, characters".
- **Spatial hooks.** The kernel reaches the map only through `TerrainLookup`,
  `PassableLookup`, `TerrainWriter` and `Revealer`, each installed for one
  synchronous call.
- **Actions.** Characters don't get a fixed set of verbs. `sense` returns
  `availableActions` derived from the rules, and `set_order` takes any of them
  plus generic stop conditions (stock thresholds, elapsed ticks, action
  unavailable, a visible event). That design carries over to a library as-is.
- **GM tools.** `add_rule`, `tweak_rule`, `remove_rule` and `list_rules` are
  generic, and adds and patches already come back with a dry-run report.

## Blockers, most important first

1. **Global state in the kernel.** _Fixed in step 1._ `knownStocks` and
   `stockpilableStocks` were module-level variables. The engine set them when
   stock defaults changed, not on each call, so two worlds in one process
   silently shared whichever vocabulary was installed last. Four test files
   already reset them defensively, and two stockpile tests relied on the
   leak to read the real scenario's stockpilable set.
2. **`engine.ts` is the real extraction.** One closure returns about 70
   methods. Most are the generic host a library needs (agents, liveness,
   actions, orders, events, rule CRUD, snapshots). Mixed in are island
   features: fog, minimap, terrain and kind-visual registries, sprites,
   `inscribe`, and vitals banding.
3. **The grid is not optional in the engine.** Speech uses
   `EARSHOT`/`WHISPER_RANGE`, spawning and joining place entities on the map,
   and visibility is based on sight. The kernel runs without positions, but
   the engine does not. **Decision:** v0.1 targets grid-based simulations, and
   non-spatial games (auctions, Werewolf) run as a single-room map where
   everyone shares a tile. No generic "location" abstraction. _Since the
   playtest, a 1x1 world is inferred to be a room: the movement verbs and the
   sight grid are left out automatically._
4. **The MCP layer depends on island-specific text and the filesystem.**
   Briefings are read from `.md` files, observations are rendered by
   `sense-prose.ts`, and tool descriptions live in
   `src/mcp-tool-descriptions/`. These become hooks with neutral defaults.
   Five tools are island-only and should be registered by Agent Island:
   `inscribe`, `register_terrain`, `register_kind_visual`, `set_terrain`,
   `save_scenario`.
5. **Persistence is wired to `~/.agent-island`.** The coordinator, journal,
   scenarios and `paths.ts` write there directly; the host needs a storage
   interface. `src/config.ts` (was `rules/config.ts`) reads files and env vars at import time
   (`export const scenario = loadRuleset()`), so it stays app-only and must
   never be exported from a package.
6. **Smaller items.**
   - There's no standalone `dry_run_rule` tool; dry runs only ride on
     add and patch. Worth adding and showing off.
   - The `"agent"` tag meaning "alive" and the `"world"` singleton entity are
     fine as documented conventions.

## Corrections from the first pass

- `overlays.ts` belongs with the engine, not core: `RuleOverlay` carries
  terrain specs, visuals, fixtures and setup directives.
- `orders.ts` is a host concept (standing orders over actions), so it also
  goes with the engine.
- Only one type had to move down into core: `StockRole`/`StockDisplay`, which
  the dry-run lints read. `scenario.ts` re-exports them.
- **Visuals stay as they are (step 2).** The plan was to make sprites and
  visuals opaque to the engine. The visual registry turned out to run through
  about 40 places (overlay persistence, stock icons, the dry-run sprite
  warning), so making it opaque would be a redesign inside a file move.
  `sprite.ts` and `Visual` moved with the engine as presentation metadata the
  engine stores for any spectator UI, which a library user can use too. The
  island policy in it is narrow and becomes engine options in step 3: new
  resources must carry a game-icons.net slug (`ensureIconFor`), and dry runs
  warn about spawned kinds with no sprite.
- **Most engine tests stay at the root for now.** About 23 of them build
  worlds through `test/helpers.ts`, which replays the app's boot (reading
  `config/config.test.json` via `src/config.ts`, resolving scenario includes,
  merging terrain). Moving them needs a package-local fixture harness, which
  is its own task. They still exercise the engine only through its package
  exports.
- **The host was more generic than blocker 4 said (step 3).** The briefings
  only named Agent Island in their titles, and the five "island-only" tools
  all drive features that now live in the engine (inscriptions, terrain,
  kind visuals, scenario files), so they stay in the package. Nothing had to
  be split out of the coordinator.
- **Persistence needs no new interface (step 3).** Every coordinator path
  option (`statePath`, `rulesPath`, `journalDir`, `runsDir`,
  `scenariosDir`, ...) is nullable, and null means in-memory. That is the
  storage hook for v0.1: `~/.agent-island` lives only in `src/server.ts`.
  The real coupling was elsewhere: `coordinator-scenarios.ts` and
  `coordinator-admin.ts` imported `src/config.ts`, so the coordinator read
  the ruleset file and an env var at import time. The colony now takes
  `baseScenario` and `graphics` as options, and an omitted `scenariosDir`
  means no scenario store instead of this repo's `config/scenarios`.
- **Engine options default on (step 3).** `requireStockIcons` and
  `warnUnillustratedSpawns` default to today's behavior because the bundled
  GM briefing and tool descriptions describe it. A host that turns them off
  should also brief its GM differently, which is what the briefing hook in
  step 4 is for.

## Packages

| Package               | Files                                                                                                                                         | Tests                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `core`                | kernel, space, rule-schema, dryrun, stock-display                                                                                             | 10 pure-core test files (75 tests)                               |
| `engine`              | engine, engine-actions, engine-orders, overlays, orders, vitals, scenario, sprite                                                             | 5 helper-free test files (25 tests); the helper-based ones later |
| `mcp`                 | coordinator and its helpers, journal, scenario store, mcp-handler, order schema, sense-prose, world-file parser, briefings, tool descriptions | none yet; coordinator tests stay at the root                     |
| stays in Agent Island | `src/server.ts`, `src/config.ts`, `src/paths.ts`, operator, web, crew, generate-map                                                           | the rest                                                         |

The `@agent-island/*` names are placeholders until the public name is chosen.

## Steps

Each step leaves typecheck, the web build, and the full test suite green.

1. **Workspaces and core.** Set up npm workspaces, remove the kernel globals,
   move the display type down, and move the core files and their tests.
   _Done._
2. **Engine.** Move the engine files into `packages/engine`. _Done_ (visuals
   kept as-is; see the corrections above).
3. **MCP host.** Move the host into `packages/mcp`, inject the config the
   coordinator used to import, add `dry_run_rule`, and turn the icon
   requirement and the missing-sprite warning into engine options. _Done._
4. **Ship it.** _Done except publishing and the test harness._
   - A briefing hook and an MCP server name, so a host can replace the
     prompts. _Done._
   - A `serve` entry point that boots a colony from a world file and a
     scenarios folder. _Done._
   - A single-room example with tests, and READMEs with a ready-to-paste
     MCP config. _Done_ (the commons; see below).
   - A build step that emits JS and types. _Done._
   - Publishing. _Waiting on the public name._ Then: rename the packages and
     the `agent-island-mcp` bin, drop `private: true`, set the default
     `serverName`, and `npm publish` core, engine, mcp in that order.
   - The package-local test harness, so the helper-based engine and
     coordinator tests can move into their packages. _Not started_; they
     still run at the root against the packages' exports.

## Status

**Step 1, 2026-10-12, branch `extract-core`:**

- Kernel entry points (`commit`, `checkAction`, `actionApplicable`,
  `actionUnavailableReason`, `runRulesForTick`, `step`) take an optional
  `StockVocabulary` and install it for that call only. An omitted vocabulary
  inherits the caller's, so nested entry points keep it. Each engine owns one
  vocabulary object and passes it everywhere, including dry runs.
- A regression test (`test/strict-stocks.test.ts`, "a vocabulary binds only
  the call it is passed to") runs a closed and an open world side by side.
- `packages/core` is an npm workspace. Its `exports` point straight at the
  TypeScript sources, which works under tsx, tsc and Vite. Publishing will
  need a build step (step 4).
- The app imports core through `@agent-island/core/<module>` subpaths; the
  package also has a barrel `index.ts`.
- Results: 75 core tests plus 434 app tests pass (509 total). Both
  typechecks, the web typecheck and the web build pass, and the server boots
  and serves the genesis rules.

**Step 2, 2026-10-12, branch `extract-engine`:**

- `packages/engine` (`@agent-island/engine`, depends on core) holds engine,
  engine-actions, engine-orders, orders, overlays, scenario, sprite and
  vitals, with subpath exports and a barrel `index.ts`. The engine has no
  filesystem or environment access.
- `src/rules/` is gone: its last file, the app's ruleset loader, moved to
  `src/config.ts`.
- Five helper-free engine tests moved into the package.
- Results: 75 core, 25 engine and 409 app tests pass (509 total). All
  typechecks, the web typecheck and the web build pass; the server boots,
  serves the genesis rules, and answers an MCP `initialize`.

**Step 3, 2026-10-12, branch `extract-mcp`:**

- `createColony` takes `baseScenario` (required), `graphics` and
  `engineOptions`; `src/server.ts` passes the first two from `src/config.ts`.
  World-file parsing moved to `world-file.ts`
  (`scenarioFromWorldFile`, `graphicsFromWorldFile`), so a host can build a
  base scenario without the filesystem. Tests get a `createColony` wrapper in
  `test/helpers.ts` with the old defaults.
- `packages/mcp` (`@agent-island/mcp`, depends on core and engine, the MCP
  SDK, express and zod) holds the coordinator and its helpers, the journal,
  the scenario store, the MCP handler and order schema, sense prose, the
  world-file parser, and the briefings and tool descriptions. `src/` keeps
  only `server.ts`, `config.ts`, `paths.ts` and the operator. The briefing
  titles no longer name Agent Island.
- `dry_run_rule` (GM): validates a candidate rule like `add_rule`, then
  simulates the live rules with it added, or swapped in for a live rule with
  the same id, and returns the report without changing anything. The engine
  side is `dryRunCandidateRule`.
- `EngineOptions` on `createWorld`: `requireStockIcons` and
  `warnUnillustratedSpawns`, both default on.
- Results: 75 core, 25 engine and 414 app tests pass (514 total; 5 new). All
  typechecks and the web build pass. On a live server, `/mcp` lists 11 tools
  and `/gm` lists 17, all with descriptions loaded, and a GM can call
  `dry_run_rule` over MCP while the live rule set stays unchanged.

**Step 4, 2026-10-12, branch `ship-packages`:**

- `createColony` takes `briefings: { character, gm }` and exposes them;
  `createMcpHandler` takes a `serverName`. Agent Island pins
  `agent-island`.
- `serve` (`packages/mcp/src/serve.ts`, CLI in `cli.ts`): a world file, a
  scenarios folder (its only scenario runs by default), `--data` for
  persistence, `--tick-ms` for a wall clock, plus briefing and name flags.
  Serves `/mcp`, `/gm` and `/api/state`.
- The commons example (`packages/mcp/examples/commons`): 4 or 5 villagers
  share a bay that regrows logistically and never recovers once empty.
  Tests play it for a full season: hoarding a full basket collapses the bay
  and starves everyone; fishing only when hungry survives and wins. Tuning
  it surfaced two engine issues, both fixed:
  - **Character prose never showed world stocks.** A world stock with role
    `pack` now appears as "The world holds: fish in the bay 30/40."
  - **A watch on `{tick: true}` never fired**, because `beginTick` took the
    "before" snapshot after incrementing the tick. The snapshot is now taken
    first.
- Builds: each export resolves to `dist` for consumers and to `src` under
  the `source` condition, which the repo enables in tsc, tsx and node.
  Verified by packing all three packages, installing the tarballs in an
  empty project, running `npx agent-island-mcp serve` on the bundled
  example, joining over MCP, and typechecking a strict TypeScript consumer.
  That caught `@types/express` being a devDependency although the public
  types use it.
- Results: 76 core, 25 engine, 6 mcp and 415 app tests pass (522 total).
  All typechecks and the web build pass, and `npm run dev` serves the
  observatory.
