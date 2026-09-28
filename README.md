# Agent Island

A spatial world whose physics its inhabitants speculate into being.

LLM characters play a game that mostly doesn't exist: they attempt verbs they
expect a world like this to support (`drink_water`, `build_shelter`), the world
softly refuses ("nothing happens... yet"), and a resident director - the Oracle -
ratifies plausible attempts into real, executable rules. Physics precipitates
out of practice. See [docs/speculative-physics.md](docs/speculative-physics.md).

## Architecture

Everything meets over MCP; the server never launches an LLM.

- **`src/`** - the world server: tick clock, grid world, the rules DSL engine,
  and two MCP surfaces - `/mcp` (characters) and `/gm` (the Oracle and the
  operator). Plus a small read API (`/api/state`, `/api/map`, `/api/fog`) that
  feeds the observatory, and world ops (`/api/reset`, `/api/restore`,
  `/api/runs`, `/api/pause`, `/api/clock`).
- **`agents/`** - who the agents are: persona prompt files for characters and
  directors. The launch layer reads these; the server never does.
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
  the Ledger right (laws minted, open speculations), the feed below. The clock
  strip's population count opens a roster; click a character for their dossier,
  or click a map token to pin its card.
- **`.claude/skills/genesis-run`** - the experiment protocol, end to end.

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

Run a full genesis experiment (other terminals - each crew stays in the
foreground supervising its children). World setup first, then the Oracle and
the characters as separate crews so seat options never bleed across roles:

```sh
./scripts/world.mjs scenario genesis
./scripts/world.mjs reset
./scripts/world.mjs clock --ms 2000
./scripts/crew.mjs director                 # Oracle first, own terminal (one wake per process, relaunched)
./scripts/crew.mjs director --persona steward   # the top-down seat; cadence, model, and
                                                  # effort come from the persona's frontmatter;
                                                  # --cadence-ticks N overrides per launch
./scripts/crew.mjs characters --count 4     # characters, own terminal
./scripts/world.mjs resume
```

Each crew runs for 500 world ticks from when that crew launches, then drains
and prints per-seat token usage. Common variants:

```sh
./scripts/crew.mjs characters --count 4 --max-ticks off        # unbounded
./scripts/crew.mjs characters --count 2                        # no Oracle: measure refusal
./scripts/crew.mjs characters --count 2 --persona character-minimal  # prompt variant
./scripts/crew.mjs characters --names Alba,Anders               # explicit seats, by name
./scripts/crew.mjs characters --count 1                         # add one more, or refill an
                                                                  # empty seat - no need to stop
./scripts/crew.mjs stop director Steward                       # drain one director
./scripts/crew.mjs stop director                               # drain every director
./scripts/crew.mjs stop characters Alba                        # drain just that seat's batch
```

Watch it:

```sh
npm run operator                                    # full terminal operator console
./scripts/crew.mjs status                          # crew pids
./scripts/world.mjs status                         # world tick/clock/actives
curl -s localhost:3000/api/state | jq '{tick: .state.tick, oracle: .liveness.gmConnected,
  laws: [.rules[] | select(.kind == "action") | .id], speculations: [.speculative[].verb]}'
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

An event-woken seat can also set `wake.min_interval_ms` (the Oracle uses
30000): a wall-clock floor between its passes, overridable per launch with
`--min-wake-ms N` (`off` to remove it). Without one, a busy attempt feed spends
a whole process per attempt, and the seat's re-orientation cost - join,
`list_rules`, `list_speculative_attempts` - is paid every time; a 397-tick
two-character run woke the Oracle ten times and made it the most expensive seat
on the island despite being the cheapest model. The floor is measured from the
previous pass's start, so it is a rate limit and not an added delay: a pass
that already ran longer than the interval relaunches on the ordinary gap.
Nothing is missed while a seat is held - attempts queue in the world, so the
next pass reads the whole backlog and ratifies the cluster at once.

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
surface directly; the `genesis-run` skill codifies the whole loop, retro
included.

## Tests

```sh
npm test             # node --test over test/*.test.ts
npm run typecheck && npm run typecheck:web
```

The `survival` scenario (test/survival.json) is an engine test fixture, not a
played world; played
worlds run `genesis` - a near-empty map with two clocks (hunger, thirst) and no
remedies. Every remedy is for the characters to speculate into being.
