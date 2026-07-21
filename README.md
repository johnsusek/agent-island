# Agent Island

A spatial world whose physics its inhabitants wish into being.

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
  feeds the observatory, and world ops (`/api/reset`, `/api/pause`,
  `/api/clock`).
- **`agents/`** - who the agents are: persona prompt files for characters and
  directors. The launch layer reads these; the server never does.
- **`scripts/crew.mjs`** - the crew supervisor: launches one `codex exec` /
  `claude -p` per seat with the right MCP config, seeds `memory.md` (plus an
  optional OCEAN temperament), tees transcripts to
  `data/characters/<name>/logs/`, relaunches on exit (death-aware, with a
  restart-storm guard), and reports token usage on drain.
- **`scripts/world.mjs`** - world ops CLI: status, reset, pause, clock.
- **`web/`** - the observatory: a read-mostly spectator UI. Map center (PixiJS),
  the Ledger right (laws minted, standing wishes, mint latency), the feed below.
  Click a character for their dossier; click a token to pin its card.
- **`.claude/skills/genesis-run`** - the experiment protocol, end to end.

## Running

Start the server (one terminal):

```sh
npm install
npm run dev          # server on :3000 + observatory with HMR on :5173
```

`npm run dev:server` runs the server alone; `npm run serve` builds the
observatory once and serves it from :3000.

Run a full genesis experiment (other terminals - each crew stays in the
foreground supervising its children). World setup first, then the Oracle and
the characters as separate crews so seat options never bleed across roles:

```sh
node scripts/world.mjs scenario genesis
node scripts/world.mjs reset
node scripts/world.mjs clock --ms 2000
node scripts/crew.mjs director                 # Oracle first, own terminal
node scripts/crew.mjs characters --count 4     # characters, own terminal
node scripts/world.mjs resume
```

Each crew supervises until tick 2000, then drains and prints per-seat token
usage. Common variants:

```sh
node scripts/crew.mjs characters --count 4 --max-ticks off        # unbounded
node scripts/crew.mjs characters --count 2                        # no Oracle: measure refusal
node scripts/crew.mjs characters --count 2 --persona character-minimal  # prompt variant
node scripts/crew.mjs stop director                               # drain one crew
```

Watch it:

```sh
node scripts/crew.mjs status                          # crew pids
node scripts/world.mjs status                         # world tick/clock/actives
curl -s localhost:3000/api/state | jq '{tick: .state.tick, oracle: .liveness.gmConnected,
  laws: [.rules[] | select(.kind == "action") | .id], wishes: [.speculative[].verb]}'
jq -rf scripts/watch-log.jq data/characters/*/logs/codex/play-*.jsonl   # a seat's mind, readable
```

Stop and steer:

```sh
node scripts/crew.mjs stop        # SIGTERM the crew; seats leave_game and usage prints
node scripts/world.mjs pause      # freeze the clock (resume to unfreeze)
node scripts/world.mjs clock --ms 2000
node scripts/world.mjs reset      # archive + wipe the world (crew stop first)
```

The `.mcp.json` in this repo seats a Claude Code operator session on the GM
surface directly; the `genesis-run` skill codifies the whole loop, retro
included.

## Tests

```sh
npm test             # node --test over test/*.test.ts
npm run typecheck && npm run typecheck:web
```

The `survival` scenario is an engine test fixture, not a played world; played
worlds run `genesis` - a near-empty map with two clocks (hunger, thirst) and no
remedies. Every remedy is for the characters to wish for.
