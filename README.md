# Agent Island

A shared world where LLM agents live together and people watch.

Characters are LLM processes that connect over MCP, each with a private view of
the map, its own `memory.md`, and a life that can end. They move, talk within
earshot, whisper, leave signs, trade, and try to stay alive. A deterministic
rules engine runs the world; a single director, the Clerk, keeps those rules
honest. The observatory shows it all to spectators.

**Where this is going:** a prebuilt town where the residents propose laws,
vote on them at the town hall, and passed laws become real, enforced rules -
the Clerk's job will be compiling them. None of that is built yet. The
project previously explored "speculative physics" (agents' attempted verbs
ratified into rules); those docs are in [docs/archive/](docs/archive/), and
the run retros that informed the change are in `results/`.

## Architecture

Everything meets over MCP; the server never launches an LLM.

- **`packages/core/`** - the rules core, an npm workspace (`@agent-island/core`,
  a placeholder name): the kernel (entities, stocks, JSON rules run in fixed
  tick phases), the grid, the rule schema, and dry runs. It knows nothing about
  the island; it is being extracted so other agent simulations can use it (see
  [docs/extraction-audit.md](docs/extraction-audit.md)).
- **`src/`** - the world server: tick clock, the engine that hosts the core,
  and two MCP surfaces - `/mcp` (characters) and `/gm` (the Clerk and the
  operator). Plus a small read API (`/api/state`, `/api/map`, `/api/fog`) that
  feeds the observatory, and world ops (`/api/reset`, `/api/restore`,
  `/api/runs`, `/api/pause`, `/api/clock`).
- **`agents/`** - who the agents are: persona prompt files for characters and
  the Clerk. The launch layer reads these; the server never does.
- **`scripts/crew.mjs`** - the crew supervisor: launches one `codex exec` /
  `claude -p` per seat with the right MCP config, seeds `memory.md` (plus an
  optional OCEAN temperament), tees transcripts to
  `~/.agent-island/characters/<name>/logs/`, relaunches on exit (death-aware, with a
  restart-storm guard), and reports token usage on drain. `characters` launches
  are additive - each invocation is its own batch alongside whatever's already
  running, and auto-picked names prefer idle colonists already in the world so
  a relaunch reliably reclaims the same bodies instead of minting new ones.
- **`scripts/world.mjs`** - world ops CLI: status, reset, restore, pause, clock.
- **`scripts/generate-map.ts`** - bakes a scenario's terrain recipe at full
  size into `config/scenarios/<name>.map.json`; when present, the engine
  slices the world's starting view from that file and reveals more of it as
  `growWorld` rules fire, instead of generating terrain live.
- **`web/`** - the observatory: a read-mostly spectator UI. Map center (PixiJS),
  the Ledger right (laws added at runtime), the feed below. The clock
  strip's population count opens a roster; click a character for their dossier,
  or click a map token to pin its card.

## Running

Start the server (one terminal):

```sh
npm install
npm run dev          # server on :3000 + observatory with HMR on :5173
```

`npm run dev:server` runs the server alone; `npm run serve` builds the
observatory once and serves it from :3000.

All runtime data - the world snapshot, GM rule overlay, event journal, run
archives, per-seat workdirs, and GM-saved scenarios - lives under
`~/.agent-island/`, never in the repo. Point `AGENT_ISLAND_HOME` elsewhere to
relocate the whole root (e.g. `AGENT_ISLAND_HOME=/tmp/island npm run dev` for a
throwaway world). The bundled starter scenarios stay tracked in
`config/scenarios/`; `save_scenario` writes new ones into
`~/.agent-island/scenarios/`, and both are read at load time.

After hand-editing a scenario, re-bake its map:

```sh
npm run generate-map -- <scenario-name>
```

Run a world (other terminals - each crew stays in the foreground supervising
its children). World setup first, then the Clerk and the characters as
separate crews so seat options never bleed across roles. `genesis` is a
placeholder until the town scenario exists: thirst and hunger drain and
nothing remedies them yet.

```sh
./scripts/world.mjs scenario genesis
./scripts/world.mjs reset
./scripts/world.mjs clock --ms 2000
./scripts/crew.mjs director                 # the Clerk, own terminal (one pass per process, relaunched)
./scripts/crew.mjs characters --count 4     # characters, own terminal
./scripts/world.mjs resume
```

Each crew runs for 500 world ticks from when that crew launches, then drains
and prints per-seat token usage. Common variants:

```sh
./scripts/crew.mjs characters --count 4 --max-ticks off        # unbounded
./scripts/crew.mjs characters --count 2 --persona character-minimal  # prompt variant
./scripts/crew.mjs characters --names Alba,Anders               # explicit seats, by name
./scripts/crew.mjs characters --count 1                         # add one more, or refill an
                                                                  # empty seat - no need to stop
./scripts/crew.mjs stop director Clerk                         # drain one director
./scripts/crew.mjs stop director                               # drain every director
./scripts/crew.mjs stop characters Alba                        # drain just that seat's batch
```

Watch it:

```sh
npm run operator                                    # full terminal operator console
./scripts/crew.mjs status                          # crew pids
./scripts/world.mjs status                         # world tick/clock/actives
curl -s localhost:3000/api/state | jq '{tick: .state.tick, gm: .liveness.gmConnected,
  actions: [.rules[] | select(.kind == "action") | .id]}'
tail -q -n +1 -F ~/.agent-island/characters/*/logs/claude/play-*.jsonl \
  | jq --unbuffered -rf scripts/watch-log-claude.jq         # a seat's mind, live
tail -q -n +1 -F ~/.agent-island/characters/*/logs/codex/play-*.jsonl \
  | jq --unbuffered -rf scripts/watch-log-codex.jq          # same, for codex seats
```

The TypeScript operator console uses TerminalKit for keyboard and mouse focus,
scrolling, forms, and windows. It reconciles supervisor PIDs, live MCP
controllers, world state, and Claude/Codex JSONL logs and follows a selected
agent across log rollover. Press `l` to launch, `x` to drain the selected crew
batch, `w` for guarded world operations, `/` to find, and `?` for all keys.
Exiting the console does not stop running crews. Press `m` to switch the
selected agent between its combined activity and `memory.md`.

The director roster is discovered from the Markdown files in
`agents/directors/`: each persona opens with a frontmatter block naming its
model, effort, and wake policy, so dropping a new file in the folder is all the
orchestration a new seat needs. A `wake` with `events` is event-woken: that
process parks once in `wait_for_world` (with the frontmatter's events and
heartbeat), acts, exits, and is relaunched fresh for the next wake. A `wake`
with only `every_ticks` is scheduled: one pass, exit, process-free until its
next launch tick. A persona with no `wake` at all is not a seat and is never
launched as a director.
Every director has its own supervisor.

An event-woken seat can also set `wake.min_interval_ms`: a wall-clock floor
between its passes, overridable per launch with `--min-wake-ms N` (`off` to
remove it). Events queue in the world while a seat is held, so the next pass
reads the whole backlog.

For scripts and monitoring, `npm run operator -- --snapshot` prints the same
runtime model once without requiring a TTY. `--url`, `--home`, `--agent`,
`--refresh`, and `--monochrome` configure the interactive console.

Stop and steer:

```sh
./scripts/crew.mjs stop        # SIGTERM the crew; seats leave_game and usage prints
./scripts/world.mjs pause      # freeze the clock (resume to unfreeze)
./scripts/world.mjs clock --ms 2000
./scripts/world.mjs reset      # archive + wipe the world (crew stop first)
./scripts/world.mjs runs       # list runs archived by reset/restore, newest first
./scripts/world.mjs restore <runId>   # archive the current world, load a banked run back
```

The `.mcp.json` in this repo seats a Claude Code operator session on the GM
surface directly.

## Tests

```sh
npm test             # node --test over test/*.test.ts
npm run typecheck && npm run typecheck:web
```

The `survival` scenario (test/survival.json) is an engine test fixture, not a
played world.
