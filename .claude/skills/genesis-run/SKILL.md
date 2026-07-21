---
name: genesis-run
description: Run a speculative-physics experiment end to end - restart the server, seat the Oracle, launch N characters into genesis, monitor the attempt feed and mint rate, then write a retro to results/.
argument-hint: "[character count] [notes: prompt variant, model, ticks, 'no reset', 'monitor only']"
---

# Genesis run protocol

You drive the run; John reads the retro. The experiment is the loop: characters
attempt verbs that don't exist, the Oracle mints them on first showing. A run
where only one half moved is a failed run, not a result.

## Defaults (notes in $ARGUMENTS override)

- 4 characters, prompt `agents/characters/character-minimal.md`, gpt-5.4-mini / low.
- Oracle seated (codex / gpt-5.6-luna / medium).
- Scenario `genesis`, real-time clock 2000ms/tick, tick cap 10000.

## Launch

1. **Restart the server first** if any code changed - the crew hits a live
   server and never reloads code. Start it with `npm run dev:server` (or
   `npm run dev` for the observatory with HMR). Never `tsx watch`.
2. Run `node scripts/crew.mjs run --count N --scenario genesis --director` as a
   BACKGROUND task - it resets the world, seats the Oracle, launches the
   characters, sets the 2000ms clock, resumes, then supervises until the tick
   cap and drains with a per-seat token report. The director is opt-in: drop
   `--director` only to deliberately measure refusal. `--persona X` tests a
   prompt variant; `--max-ticks off` runs unbounded.
3. Confirm the seats: `node scripts/crew.mjs status` shows the crew pid, and
   `curl -s localhost:3000/api/state | jq .liveness` should show activeCount N
   plus `gmConnected: true`. No Oracle = stop and fix before burning hours.

## Monitor

Check at widening intervals (~15m, 30m, then hourly), from /api/state - the
observatory at http://localhost:3000 shows the same live (Ledger = laws +
standing wishes):

- **Mint rate** - are `kind:"action"` rules growing? `.speculative` clusters
  with no ratification for thousands of ticks means the Oracle is stuck or
  asleep.
- **Attempt character** - are new verbs still appearing, or synonym thrash on
  one concept? Thrash on a ratified concept means aliases were missed.
- **Pricing** - a minted action with no `requires` is a free wish; free
  outrunning priced is the comfort ratchet. Note it.
- **Deaths** - any death is over-tuned risk. Say so in the retro.

Interrupt John for: a restart storm, an Oracle that has ratified nothing after
~5,000 ticks, or a death.

## Stop and retro

`node scripts/crew.mjs stop` drains the crew early (the tick cap otherwise does
it). Then write `results/<UTC stamp>-<worldId8>.md` from
`data/journal/journal.jsonl`: attempt count, distinct verbs, laws minted (and
from which clusters), the free/priced ratio, mint latency, redemption uptake,
behavior shifts over time, and what to change next. Quote the characters -
their speech and signs are the evidence. Never auto-start the next run; end by
asking "ready?".
