# Speculative physics — the paradigm

Status: **live**. This is what Agent Island is for; everything else in the repo either
serves it or is a test fixture.

Agents invent the simulation by attempting to play it. A population starts as narrative
_characters_ (not players) in a near-empty world. They attempt actions they expect a world
like this to support (`drink_water`); the world journals the attempt and softly refuses
("nothing happens... yet"); the Oracle synthesizes recurring attempts into real DSL rules.
Physics precipitates out of practice.

## The novelty claim

Emergence World's Gemini worlds had _shared hallucination_ as a documented **failure
mode** — agents collectively believing false things about their world. This mechanic
makes hallucination the **content pipeline**: what a character imagines this world
supports, the Oracle ratifies into reality. One-sentence version: _the world is a
hallucination, made mechanically real._ At the limit, 100% of the world's physics is
agent-originated — and that percentage is the headline metric.

**There is no vote.** Every plausible attempt is minted, on its first showing, by one
character acting alone. A threshold looks like quality control and is actually latency:
run 2 held `build_tower` for 829 ticks and three petitions, and by the time it existed
its petitioner had stopped asking. One person imagining something is a complete
petition. (The explicit-legislation counterpart is [rule-votes-design.md](rule-votes-design.md):
speculation materializes _capabilities_, votes create _social rules_. Parked, not dead.)

## The loop

1. **Brief them as characters, not players.** `agents/characters/character-minimal.md`:
   act on what you expect to be possible; actions are not surfaced, you must think them
   up. No action menu — the absence of a menu is the point.
2. **Attempt capture.** An unknown verb does not throw. `commitPrimitiveIntent` in
   `src/rules/engine.ts` soft-fails it into a `speculative_attempt` event — actor, verb,
   the actor's stated `expectation`, remaining args — and returns _"Nothing happens. The
   world does not respond to that... yet."_
3. **Synthesis.** The Oracle (`agents/directors/oracle.md`) wakes on `speculative_attempt`,
   reads `list_speculative_attempts`, merges semantically-equivalent verbs into one rule
   with many `aliases`, and mints it — first showing, one attempter, no threshold. The
   **expectations are the spec**. Same validate + dry-run gate as every `add_rule`.
4. **Redemption.** An attempt is a standing speculation, not a one-off. `addRule` (and an alias
   added by `tweak_rule`) scans the log for attempts at any word the new rule answers to,
   and tells every living attempter: _"the world has learned build_tower — what you tried
   before will take now."_ Without this the grant never reaches the speculator — run 2 minted
   `build_tower` and it was used zero times in the 1,200 ticks that followed.

   **News, not an alarm.** The event carries a `decision` wake, which is all a parked
   character needs to hear it; their in-flight action and running order are left running.
   Nor is the action replayed for them. Both restraints are the same judgement: a granted
   speculation is something to weigh against what you are already doing, not an emergency the
   world drags you to.

5. **Silent to everyone else.** No announcement, no patch notes. Only the people who
   asked are told, in fiction. Others _discover_ physics; "wait, it worked this time" told
   to someone else is exactly the drama being farmed.

## What run 1 proved (2026-07-20, world 73a15086, 34,481 ticks, 2 characters)

Full retro: `results/20260720T150427Z-73a15086.md`.

**248 attempts, 103 distinct verbs, 0 rules minted** — the Oracle was never seated, so only
the characters' half ran. Even so:

- Sustained, non-repeating invention for 34,000 ticks against a totally inert world.
- A strategy shift at ~tick 26,000 from _acting_ to _interrogating_ — `inspect_vein`,
  `search_ground`, `observe_wildlife`: probing for a hidden prerequisite rather than a
  hidden verb. Behavior got more interesting the longer it ran.
- Negative results cross-verified between characters, then committed to durable signs and
  memory files. They wrote the Oracle's work order for it.

Three defects, all now fixed:

- **Synonym thrash** — 22 verbs for "take the rock". Action rules take `aliases`; the
  Oracle ratifies the whole cluster in one pass, so any word a character guesses lands.
- **Feed noise** — `speak`/`whisper`/`inscribe`/`sense` are MCP tools, and ordering one
  read as a petition. They now get an in-fiction correction and stay out of the feed.
- **No spine** — nothing forced the ordering of petitions. Genesis now ships one stake
  and no remedy: hunger over ~2,000 ticks, then health over thousands more.

## The three standing risks

- **Comfort ratchet.** Left alone, characters speculate themselves a paradise. The
  pricing doctrine is load-bearing: **every yes creates a no**. Materialize `drink_water`
  → materialize thirst in the same pass. The Oracle's job is not inventing systems, it is
  being **the world's sense of consequence**: characters author the affordances, the
  Oracle authors the stakes.
- **Ontology sprawl.** Fifty ad-hoc verbs with no shared ontology is incoherent physics.
  Mitigations: aliases collapsing synonyms into one action, and the rule that every new
  verb must ground in stocks/entities that exist or are created with it. Not a threshold —
  sprawl is a coherence problem, and making people ask twice does not fix coherence.
- **Verbs with no nouns.** Run 2's `build_shelter`/`build_wall`/`build_tower` each only
  subtracted stone and spawned nothing; `establish_settlement` had an empty body. The
  world ended with 32 outcrops and not one structure, while the characters told each
  other about settlements and farms — reporting the action log faithfully, because the
  log was the only evidence there was. **A verb named for a thing it makes must `spawn`
  that thing.** `dryRunRule` catches the empty body; the rest is the Oracle's own check,
  since only its prompt knows what a verb's name promised - the engine reads shape, and
  teaching it a list of English maker-words would be hardcoding meaning into the kernel.
- **Gaming the oracle.** `summon_infinite_food`. The filter is plausibility, not power
  level: _would a reasonable person in this fiction expect the world to support this?_
  Implausible attempts failing forever is in-fiction coherent, not a bug.

## Directors

One. A director is a persona file plus the GM tool surface.

- **Oracle** — the resident seat. Reads the attempt feed, mints physics, prices every
  yes, paces the growth curve, and draws new content's art itself (inline sprite DSL
  on `register_kind_visual` / `register_terrain` — new visible content gets art before
  anything else touches it). Seated with `crew.mjs director`, its own crew
  separate from the characters.

## The next frontier

Action hallucination is the foundation; [world-hallucination.md](world-hallucination.md)
is the sequel — characters dreaming the map beyond what they have walked.

## Metrics

- \# speculated actions that reached physics; **time-to-materialization** (attempt → mint).
  Target: tens of ticks. Run 2 averaged hundreds, and that was the whole problem.
- **% of live physics that is agent-originated** (the headline; endgame ≈ 100%).
- **Redemption uptake**: of the verbs minted for a named speculator, how many that speculator
  actually used afterwards. Run 2's `build_tower` scored 0.
- Comfort-ratchet tracking: ratio of materialized affordances to materialized stakes.
