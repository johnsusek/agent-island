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

## Quickstart

```sh
npm install
npm run dev          # server on :3000 + observatory with HMR on :5173
```

Then, in a Claude Code session (or by hand):

```sh
node scripts/crew.mjs run --count 4 --scenario genesis --director
```

resets the world, seats the Oracle, launches four characters, and supervises
until tick 10,000. `node scripts/crew.mjs stop` drains early. The `.mcp.json`
in this repo connects an operator session to the GM surface directly.

## Tests

```sh
npm test             # node --test over test/*.test.ts
npm run typecheck && npm run typecheck:web
```

The `survival` scenario is an engine test fixture, not a played world; played
worlds run `genesis` - a near-empty map with two clocks (hunger, thirst) and no
remedies. Every remedy is for the characters to wish for.
