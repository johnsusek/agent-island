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

- 4 characters, prompt `agents/characters/character-minimal.md`, claude / haiku / low.
- Oracle seated (claude / haiku / medium).
- Scenario `genesis`, real-time clock 2000ms/tick, tick cap 2000.

## Launch

1. **Restart the server first** if any code changed - the crew hits a live
   server and never reloads code. Start it with `npm run dev:server` (or
   `npm run dev` for the observatory with HMR). Never `tsx watch`.
2. Set up the world with world.mjs: `node scripts/world.mjs scenario genesis`,
   then `node scripts/world.mjs reset`, then `node scripts/world.mjs clock
--ms 2000`.
3. Launch the two crews SEPARATELY, each as a BACKGROUND task, Oracle first so
   the first petitions land on a listening director:
   - `node scripts/crew.mjs director` (seat options here affect only the
     Oracle). Skip this only to deliberately measure refusal.
   - `node scripts/crew.mjs characters --count N` (seat options here affect
     only the characters; `--persona X` tests a prompt variant).
     Each crew supervises until the tick cap (`--max-ticks off` = unbounded) and
     drains with a per-seat token report.
4. Resume the clock: `node scripts/world.mjs resume`.
5. Confirm the seats: `node scripts/crew.mjs status` shows both crew pids, and
   `curl -s localhost:3000/api/state | jq .liveness` should show activeCount N
   plus `gmConnected: true`. No Oracle = stop and fix before burning hours.

## Monitor

Check **every 30-60 seconds**, from /api/state - the observatory at
http://localhost:3000 shows the same live (Ledger = laws + open speculations).
Report movement as it happens rather than going quiet between checks. Runs go
wrong fast and quietly; an hour of unwatched ticks is an hour of tokens spent
re-demonstrating a bug you could have caught at t50.

A snapshot loop beats a sleep - one line per interval, so silence means the
poller died rather than the world being calm:

    while true; do curl -s localhost:3000/api/state | jq -r '"t\(.state.tick) actions=\([.rules[]|select(.kind=="action")]|length) spec=\(.speculative|length) chars=\(.liveness.activeCount) gm=\(.liveness.gmConnected)"'; sleep 45; done

Note `.state.tick` - there is no top-level `tick`, and reading `.tick` returns
`null` rather than erroring.

What to watch:

- **Mint rate** - are `kind:"action"` rules growing? `.speculative` clusters
  with no ratification for thousands of ticks means the Oracle is stuck or
  asleep.
- **Attempt character** - are new verbs still appearing, or synonym thrash on
  one concept? Thrash on a ratified concept means aliases were missed.
- **Pricing** - a minted action with no `requires` is a free grant; free
  outrunning priced is the comfort ratchet. Note it.
- **Unbounded yield** - a `requires` is not scarcity. An action that depletes
  nothing (near-terrain check, +N food, infinite repeats) is a faucet that
  passes the free/priced test. Check what each mint *spends*, not just what it
  demands.
- **Spawned artifacts** - open the `do` of any rule that spawns. A `spawn.id`
  containing `{{` is not interpolated: it becomes a literal entity id, which
  makes the structure a global singleton, leaks raw braces into character-facing
  prose, and gets adopted by characters as a place name. Check the entity list
  for ids that are obviously templates.
- **No-op mints** - a `kind:"action"` rule with `do: []` grants a verb that
  cannot act. Dry-run warns but does not block, so these ship. Worse than a
  refusal: refusal is legible, a silent no-op teaches the character to distrust
  grants. Grep new mints for empty `do`.
- **Unbacked threats** - a `critical` emit that promises consequences ("your
  health will fail") with no rule implementing them is theatre. Match each
  threat to the rule that enforces it.
- **Deaths** - any death is over-tuned risk. Say so in the retro.

Interrupt John for: a restart storm, an Oracle that has ratified nothing after
~5,000 ticks, or a death.

Stopping early is fine and often right. Once a bug has blocked a branch, further
ticks re-demonstrate it rather than surfacing anything new - diagnose, then stop
and write it up.

## Stop and retro

`node scripts/crew.mjs stop` drains both crews early (the tick cap otherwise
does it; `stop director` or `stop characters` drains one). Then write `results/<UTC stamp>-<worldId8>.md` from
`~/.agent-island/journal/journal.jsonl`: attempt count, distinct verbs, laws
minted (and from which clusters), the free/priced ratio, mint latency,
redemption uptake, behavior shifts over time, and what to change next. Quote the
characters - their speech and signs are the evidence. Never auto-start the next
run; end by asking "ready?".

Journal records are one JSON object per command with the interesting bits nested
under `.events[]`, so tally through that array:

    jq -r '.events[]?|select(.type=="speculative_attempt")|"\(.verb)\t\(.agentId)\tt\(.tick)"' ~/.agent-island/journal/journal.jsonl

Mint latency is the gap between an attempt and the matching "feels the world
give" line in the server log - the journal alone will not give you it.

Separate what the loop did from what the loop produced. A run can close every
petition inside two ticks with perfect pricing and still ship nothing that works;
grading the loop alone would score that run as a success.
