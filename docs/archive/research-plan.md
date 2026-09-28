# Research plan — the speculative-physics paper

Status: **plan, 2026-07-30**. The experiment protocol for a research paper about Agent
Island's core claim. It fixes the research questions, the metric battery, the run
matrix, and the per-run protocol, so every run banked from here on is usable
evidence rather than anecdote.

## Thesis

Multi-agent LLM world papers treat shared hallucination as a failure mode -
Emergence World documented agents collectively believing false things about their
world. Agent Island inverts it: **what a character imagines this world supports, a
director ratifies into executable physics**. The paper's claim is that this loop -
attempt, soft refusal, synthesis, redemption - reliably bootstraps a coherent,
playable, majority agent-originated physics from a near-empty world, at cheap-model
prices, and that its failure modes are legible and mechanically addressable.

One-sentence version: *the world is a hallucination, made mechanically real - and we
can measure how much of it the inhabitants authored.*

## Why this is publishable now

- **The vacancy is documented by the competition.** Emergence World's agents
  legislated eagerly (332 votes, 32 constitutional articles in their Claude world)
  but produced two custom tools in fifty agent-runs, neither adopted - their votes
  write law, never physics. Their own data is the demand signal for the channel
  only this system has: speculation that reaches the engine.
- **The loop is already healthy.** Median attempt-to-mint latency fell from ~255-479
  ticks (cb263000) to 7-52 with median ~23 (cc3d1956), ~15 (Referee run 3), ~40
  (087dc6c0). Synonym thrash, no-op mints, and missing redemption are fixed and
  regression-tested (test/invention-pulse.test.ts, test/dormant-verbs.test.ts).
- **The run history already sketches the ablations.** Fourteen archived runs
  (3 Referee-era + 11 here) contain natural-history versions of every planned
  contrast: no Oracle (run 1), threshold Oracle (run 2), cheap-director collapse
  (b0dfe2e6), pressure-driven attempt explosions (b0dfe2e6 again), competence
  suppressing invention (c63dbd07), the comfort ratchet ending it (087dc6c0). The
  paper turns each anecdote into a controlled cell.
- **The measurement gap is the known weakness.** EW published with a named
  11-indicator battery; our evidence lives in narrative retros, and three of the
  four metrics named in docs/speculative-physics.md are computed nowhere (see
  Phase 0). Closing that gap is the only engineering this plan requires.

## Prior evidence (the run ledger)

Architecture note: runs before 2026-07-24 used the retired 4-director cast
(Oracle + Auditor + Seeder + Tuner); the working tree consolidates those into
Oracle + Steward. **The current 2-seat architecture has never had a full run** -
the baseline phase is new data, and pre-consolidation retros are a different
condition when compared.

| run | scenario | ticks | chars | directors | attempts/verbs | minted | takeaway |
|---|---|---|---|---|---|---|---|
| 73a15086 (R1) | genesis | 34,481 | 2 | none | 248/103 | 0 | invention persists 34k ticks against an inert world; late shift from acting to interrogating (retro file lost; numbers live in the doc) |
| 5d121c3a (R2) | genesis | 3,475 | 3 | Oracle, threshold-era | 29/- | 18 | threshold = latency: build_tower after 829t + 3 petitions, used 0 times; maker verbs spawned nothing |
| 32d46bd9 (R3) | genesis | 2,001 | 2 | Oracle, haiku | 136/- | - | fixes worked: median mint ~15t, 40 redemptions, 19 built entities; synonym thrash 21 verbs in 35t |
| 6cc892ba | genesis | ~150 | 1 | Oracle | 3/2 | 0 | aborted: seat options leaked across roles |
| 2de76408 | genesis | ~43 | 4 | Oracle | 5/3 | 0 | shakedown of order parsing |
| 9fca9a42 | genesis | 4,000 | 3 | Oracle | 78/59 | 10 | **expectations collapse**: all mints in first 966t; only 16% of clusters carried an expectation after prompt drift - a prompt defect, fixed in character-minimal |
| cc3d1956 | genesis | 371 | 2 | Oracle (haiku) | 17/14 | 13 | mint loop healthy (median 23t), every structure corrupt via spawn.id bug (fixed) |
| 3a89cfab | genesis | 432 | 2 | Oracle (luna) | - | - | inverted exposure gauge read backwards; killed the tone field, all vitals now read up-as-good |
| cb263000 | genesis | 4,003 | 6 | 4-seat | 140/91 | 48 actions | **70.8% of runtime actions strictly agent-originated**; median latency 255t; invention flatlined t2633 while directors read chat/travel as health; ore-tool consensus-vs-state divergence |
| d56e5b87 | genesis | 2,000 | 2 | 4-seat | 21/19 | 13 | clean run, all mints priced with reasons |
| c63dbd07 | genesis | 2,000 | 5 | 4-seat | 14 | 9 | **more colonists produced less invention**; capable seats satisfied needs with existing verbs; pre-registered the competence 2-arm; fast Tuner cadence = 7x tokens, zero effect |
| b0dfe2e6 | drowned-quarry | 1,762 | 4 | 4-seat, all haiku | **609/227** | 10, all dead | **pressure drives attempts (38x c63dbd07) but cheap directors cannot convert**: every mint shaped as a dead event rule; dormant analysis was blind to the mis-shape |
| 846c5a72 | genesis | 285 | 3 | 4-seat (luna) | 10/8 | 7 | clean loop, latencies 4-53t; Oracle paid for build_fire with stone instead of inventing wood (ontology bullet added) |
| 087dc6c0 | winter-glasshouse | 666 | 3 | Oracle (luna) | 18/16 | 9 | median latency ~40t, clean folding and rejections - and **the comfort ratchet won**: 3 free faucets covered every vital, invention died t551; one unsatisfiable mint (cistern reachability); two unbacked investment verbs |

Standing cross-run lessons the paper should carry: the Oracle prices what sounds
dangerous and gifts what sounds kind; activity is not invention (directors
confabulated health from travel/chat twice); social consensus can outrun
inspectable state (ore-tool incident).

## Research questions

- **RQ1 (existence).** From a near-empty world, does the loop produce a coherent,
  playable physics? What fraction is agent-originated at t2000?
- **RQ2 (mechanism).** Which components are load-bearing: the Oracle, the
  no-threshold doctrine, the pricing doctrine, the Steward's lanes?
- **RQ3 (latency).** Does mint latency causally drive adoption and continued
  invention?
- **RQ4 (pressure).** Attempts rise with survival pressure - but does *realized*
  physics? Is sustained invention non-monotonic in pressure?
- **RQ5 (who plays and where).** How do character tier, director tier, population
  size, and scenario noun-density move the loop - and does minted content track
  the fiction while loop health stays put?

## Hypotheses (pre-registered)

Primary:

- **H1.** Baseline runs end with >= 60% of runtime action rules strictly
  agent-originated (alias matching a pre-mint attempt; cb263000 measured 70.8%
  under the old cast). Genesis ships zero baseline action rules, so the
  denominator is clean.
- **H2.** The event-woken Oracle holds median mint latency <= 50 ticks.
- **H3.** Redemption uptake falls with latency; verbs minted > 300 ticks after
  first attempt get near-zero use by their original speculators (run 2's
  build_tower; cb263000's late batch: craft_basket, craft_brick, tan_hide,
  tame_animal - never used).
- **H4.** A two-attempter consensus threshold multiplies median latency >= 3x and
  reduces minted count and uptake - the no-vote doctrine defended quantitatively.
- **H5.** Removing the pricing doctrine raises the free-faucet count and brings
  the invention flatline earlier: paradise ends speculation (087dc6c0 flatlined
  at t551 once three free faucets covered every vital).
- **H6.** Removing the Steward brings the flatline earlier and accumulates more
  dormant verbs and unpriced chains (nobody prices the system or seeds matter).
- **H7.** Pressure splits the loop: attempt volume rises monotonically with vital
  decay rate (b0dfe2e6: 609 attempts under lethal pressure, 38x a comfortable
  run), but *realized-and-adopted* physics follows an inverted U - too soft
  flatlines into paradise, too harsh kills speculators or outruns ratification.

Secondary:

- **H8.** No-Oracle populations sustain invention longer than baseline (run 1:
  34k ticks of non-repeating attempts) - granting speculations ends speculation
  faster than refusing them, with a characteristic late shift from acting to
  interrogating.
- **H9.** Loop conversion depends on director tier, not character tier: haiku
  characters attempt fine, but the all-haiku director cast minted 10 laws shaped
  as dead event rules (b0dfe2e6) while luna/sonnet Oracles run clean. Characters
  are cheap; judgment is not. (Retest with the Phase-0 mint-shape guard landed -
  the guard may rescue the cheap Oracle, which is itself a result.)
- **H10.** Character competence anti-correlates with speculation: weaker
  characters attempt more because unmet needs are the engine of reaching
  (c63dbd07's pre-registered 2-arm: 2 luna-low vs 2 mini-medium, same budget,
  nothing else moving).
- **H11.** Per-capita invention falls with population (c63dbd07: adding capable
  seats suppressed speculation), while collective-coordination speculation
  (trade, pooling, storage, roles) only appears at n >= 4 and goes mechanically
  unanswered by a verb-only Oracle (cb263000).
- **H12.** The pricing asymmetry is measurable: share of `requires: null` mints
  among kind-sounding verbs (drink/eat/gather class) exceeds that among
  dangerous-sounding verbs (swim/fight/mine class), across all runs.
- **H13.** Noun density extends invention: genesis-wilds (14 scatter kinds, live
  fauna, 7 terrains - survival clock byte-identical to genesis) pushes
  time-to-flatline and distinct-verb count above genesis (1 scatter kind). This
  is the Steward's seeding premise, tested at scenario scale.
- **H14.** Scenario moves minted *content*, not loop *health*: low cross-scenario
  verb overlap (Jaccard over minted verb sets), while latency, fold rate, and
  rejection legibility stay in-band - same protocol, different physics.

## The metric battery

Computed identically for every run, from the archive alone
(`~/.agent-island/runs/<runId>/`: state.json, rules.json, journal.jsonl,
meta.json, every seat's memory file). The paper's "Speculative Physics
Indicators" panel, the analogue of EW's Agent World Indicators:

1. **Attempt flow** - `speculative_attempt` / `noun_attempt` counts, distinct
   verbs/nouns, per-250-tick-window rate (the invention-pulse trajectory).
2. **Time-to-flatline** - last window containing a novel attempt; flatline = 3
   consecutive empty windows.
3. **Mint latency** - per-verb delta from earliest attempt in the answered
   cluster to `rule_added` in the GM audit stream; median, IQR, share <= 50t.
   (The live engine ring caps at 200 samples to reflect current pacing; the
   archive script computes the full distribution.)
4. **Ratification ledger** - minted / rejected (`speculation_rejected`, with
   one-sentence-reason compliance) / unanswered at end; aliases folded per mint.
5. **Agent-origination** - strict-provenance share of runtime action rules, of
   all runtime rules, of all live physics (three denominators, cb263000 method).
6. **Redemption uptake** - for each `speculation_realized`, whether that named
   actor later has an `action_started` on the granted rule, and after how long;
   plus colony-wide uses per minted verb. **Count executions, not just starts**
   (a rule that starts and always fizzles must not read as adopted).
7. **Dormancy** - minted-never-used past the 100-tick grace; hard-missing
   referents vs absent-but-producible chains; missing-noun leverage. Extended to
   any GM-minted rule regardless of shape (see Phase 0).
8. **Pricing** - free-faucet count (vital-touching actions with `requires: null`),
   affordance:stake ratio, faucet share of action uses, and the H12 asymmetry
   split.
9. **Behavior mix** - explore/travel share of action starts (67% in cb263000;
   "most of the run was logistics" in 087dc6c0), top-3 verb concentration.
10. **Danger** - deaths, vitals-alarm counts, ticks in pressing/serious/critical
    bands.
11. **Expressiveness** - effect families exercised by runtime rules (cb263000:
    4 of 18), parameterized actions, ambient rules minted.
12. **Integrity incidents** - `rule_error`s, unsatisfiable mints, unbacked
    investment verbs, no-op mints, mis-shaped mints, consensus-vs-state
    divergences (counted by hand from transcripts + state).
13. **Cost** - per-seat uncached input / output tokens from the crew drain
    report, tokens per tick, tokens per mint. Tokens, never dollars.
14. **Provenance** - commit SHA, persona files, scenario, seats (engine, model,
    effort), clock ms, caps, flags, OCEAN draw per seat (recoverable from the
    archived memory files), interventions.

## Phase 0 - instrumentation and freeze (before any paper run)

1. **`scripts/analyze-run.mjs`** - reads a banked run, emits the battery as JSON
   plus a Markdown panel. Three of the four doc-named metrics exist nowhere
   today and land here: **% agent-originated** (dashboard has the ingredients,
   never forms the ratio), **redemption uptake** (nothing joins
   `speculation_realized` to the recipient's later starts), **comfort-ratchet
   ratio** (retros compute free/priced by hand). Validate the script by
   reproducing the hand-counted numbers of cb263000 and 087dc6c0 (28 archives
   are on disk to test against).
2. **Integrity guards, landed pre-freeze** (each de-confounds every later run,
   and each is the top item of a retro's change list):
   - **Mint-shape guard** - dry-run error or hard warning when a non-action rule
     carries action-only fields (b0dfe2e6's root cause: 10 laws minted as dead
     event rules, silently accepted).
   - **Reachability check at mint** - warn when no agent could ever satisfy a new
     rule's `requires` on the current map (087dc6c0's unsatisfiable cistern mint).
   - **Dormancy sees every mint** - dormant-verb analysis currently iterates
     action rules only, so a mis-shaped mint never registers as dormant; extend
     to any GM-minted rule that has never fired.
   - Optional hygiene while there: the operator console's open-attempts count
     filters on a field that does not exist (`redeemed`), so it always equals
     total and disagrees with the engine pulse - filed by two retros.
3. **Runs manifest** - `results/manifest.csv`, one row per run: run id, phase +
   cell, commit SHA, scenario, seats, clock, caps, flags, OCEAN draws, token
   totals per seat (captured at drain - tokens are NOT in the archive), valid /
   tainted, intervention notes.
4. **Freeze.** Tag `paper-v1` (engine + personas + scenarios + briefings).
   Ablation personas are separate tracked files with minimal diffs against the
   frozen originals: `oracle-unpriced.md`, `oracle-threshold.md`. Commit the
   three new scenarios and the Steward persona (currently untracked) as part of
   the tag.
5. **Doc drift, cheap to fix before anything is public**: README still points at
   the retired `.claude/skills/genesis-run` path (protocol now lives in this
   plan; the old skill text survives at `.agents/skills/genesis-run/SKILL.md`);
   speculative-physics.md links a rule-votes doc that lives in Referee, and
   cites run 1's retro file which is not in results/.

## The run matrix

Baseline configuration - every cell varies exactly one thing against this:

- Scenario **genesis** (pregenerated map), clock **2000 ms/tick**, cap **2,000
  ticks** (`--max-ticks 2000` explicitly - the default is 500). EW's early
  lock-in finding and our own flatline data agree a few thousand ticks is an
  evaluation, not a compromise.
- **4 characters**, `character-minimal`, codex / low (the cleanest recent runs;
  splitting characters and directors across the two subscription plans also
  spreads the burn), `--pass-ticks` left at its measured default.
- **Oracle + Steward** per persona frontmatter (haiku, event-woken, 30s floor;
  sonnet, every 250 ticks). OCEAN stays on; draws recorded post-run.
- No operator interventions.

| Phase | Cell | Runs | Change vs baseline | Tests |
|---|---|---|---|---|
| 1 Baseline | B | 3 | none | H1, H2, RQ1, replicate variance |
| 2 Ablations | A1 no-Oracle | 2 | no director seats | H8 |
| | A2 no-Steward | 2 | Oracle only | H6 |
| | A3 unpriced | 2 | Oracle persona minus pricing doctrine | H5 |
| | A4 threshold-2 | 2 | Oracle persona requires 2 distinct attempters | H4 |
| | A5 slow Oracle | 2 | `--min-wake-ms` ~600000 (10 min ~ 300 ticks) | H3 |
| 3 Pressure | P-soft | 2 | halve `satiation-falls` / `hydration-falls` rates (scenario variant) | H7 |
| | P-harsh | 2 | double them | H7 |
| 4 Who & where | S-wilds | 2 | genesis-wilds (noun-density arm, stakes identical) | H13 |
| | S-grotto, S-glass | 1+1 | vermilion-grotto, winter-glasshouse | H14 |
| | M-directors | 2 | directors on haiku with guards landed (vs baseline tiers) | H9 |
| | M-chars | 2 | the c63dbd07 2-arm: 2 luna-low vs 2 mini-medium | H10 |
| | N-2, N-6 | 1+1 | population 2 and 6 | H11 |

**27 runs** (3 + 10 + 4 + 10). Phases run in order; cells interleave in time so
provider drift cannot masquerade as treatment. If budget tightens, the paper
stands on Phases 1-3 plus S-wilds; the rest of Phase 4 upgrades case study to
robustness. P-mid is the baseline cell reused, and the P variants are one-line
rate edits on a genesis copy - the survival clock is otherwise byte-identical
across all shipped scenarios, which the paper should state as a design property
(scenarios are a pure noun/terrain treatment).

**Pilot first**: one un-banked baseline run before B1. The Oracle + Steward cast
has never run together; the pilot debugs the protocol, calibrates tokens and
wall-clock per run, and shakes down analyze-run. Its data is not evidence.

## Per-run protocol

1. Fresh world per run: dedicated `AGENT_ISLAND_HOME` (and `AGENT_ISLAND_PORT`
   if parallel). Fresh home also guarantees fresh names and fresh OCEAN draws -
   reclaimed names keep their temperament and memory, which would make runs
   non-independent.
2. `world.mjs scenario <name>`, `reset`, `clock --ms 2000`.
3. Directors first, then characters, then `resume`:
   `crew.mjs director` / `crew.mjs director --persona steward` /
   `crew.mjs characters --count 4 --max-ticks 2000`. (Run 1 lost ten hours to an
   unseated director; the checklist exists because of it.)
4. Write the manifest row at launch; config is provenance.
5. **Hands off.** No GM-surface edits, no persona nudges, no reseeding. The
   087dc6c0 cistern fix was the right operator move and it also contaminated the
   run as evidence. If the run breaks (server crash, stuck clock, restart storm),
   stop, mark tainted, diagnose, rerun. Watching the observatory / operator
   console is always fine.
6. At cap the crews pause the world and drain: capture the token report into the
   manifest, `world.mjs reset` to bank the archive, run analyze-run, write the
   short retro in results/ (numbers from the script, prose for what numbers
   miss), commit manifest + retro.
7. Runs start on John's go, never auto-chained.

## Analysis and figures

- **F1** System diagram: attempt -> soft refusal -> feed -> synthesis -> mint ->
  redemption, Steward's lanes above, Illuminator aside.
- **F2** Invention pulse over time, baseline vs ablations (the flatline plot) -
  carries H5, H6, H8.
- **F3** Mint-latency distributions: the historical arc (255 -> 23-40 -> 15
  median) plus controlled A4/A5 - carries H2, H3, H4.
- **F4** Cumulative live rules colored by provenance (agent / director /
  scenario) - carries H1; the headline figure.
- **F5** Redemption uptake vs mint latency, per verb, pooled - carries H3.
- **F6** Attempts and adopted-mints vs pressure level (the split H7 predicts:
  one curve monotone, one inverted-U).
- **T1** The battery for every valid run. **T2** Failure taxonomy with per-run
  incidence and the fix that closed each (synonym thrash, no-op mints,
  verbs-without-nouns, mis-shaped mints, unsatisfiable mints, unbacked
  investments, free faucets, consensus-vs-state divergence).
- **Boxed episodes**, verbatim from transcripts: run 1's interrogation shift;
  the cistern saga; the ore-tool divergence; a redemption drama beat
  ("gather_wood just became available!").

Statistics: n of 2-3 per cell means no significance theater. Report every run,
medians across replicates, direction-consistency as the evidentiary bar (EW
published n=1 per condition and said so). Within-run distributions (latency,
uptake) carry bootstrap intervals.

## Cost and schedule

Token burn is the budget (subscription plans; tokens, never dollars). Reference
points: 087dc6c0 (666t, 3 chars + Oracle, codex): characters 5.1M uncached-in /
0.9M out, Oracle 16.3M / 1.9M; cc3d1956's haiku Oracle: 81M in / 0.4M out over
371t. Working estimate for a 2,000-tick baseline run: **~80-120M uncached input,
~10-15M output across both plans**; the pilot replaces this with a measured
number and gates any matrix trimming.

Wall-clock varies with crew tier, not just the 2000 ms clock: codex/luna crews
reached 2,000 ticks in ~1 h; the all-haiku crew ran ~2 ticks/min (a 4,000-tick
haiku run is ~33 h). Plan tick caps against the slowest seat's tier; expect the
M-cells to be the slow ones. Parallel runs (separate homes + ports) buy
wall-clock, not plan quota.

Sequence (elastic, John-paced): **week 1** Phase 0 + pilot; **weeks 2-3**
Phases 1-2; **week 4** Phase 3 + S-wilds; **weeks 5-6** rest of Phase 4 as
budget allows, figures, drafting.

## Paper outline

1. **Introduction** - shared hallucination as documented failure mode; the
   inversion; contributions (mechanic, director hierarchy, SPI battery,
   ablation results, failure taxonomy).
2. **Related work** - agent societies (Generative Agents, Project Sid, Emergence
   World); offline rule generation (AutoBG, GAVEL, GenSim); LLM-authored world
   models (Code World Models, OPINE-World); drama management (HAMLET,
   interactive-drama line). Positioning: EW varies who plays under frozen
   physics; we freeze who plays and let physics be the output. Re-run the
   literature search before submission - this list dates to the 07-18 memo.
3. **System** - world, rules DSL, MCP surfaces; attempt capture and soft
   refusal; Oracle synthesis (aliases, first-showing minting, pricing doctrine);
   redemption; Steward lanes; Illuminator; Worldsmith-authored scenarios. The
   no-vote doctrine gets its own subsection - it is the design claim H4 defends.
4. **Method** - SPI battery, frozen protocol, matrix.
5. **Results** - characterization; ablations; pressure; who-and-where; the
   failure taxonomy with incidence and fixes.
6. **Qualitative episodes** - the boxes.
7. **Discussion** - what is load-bearing; latency as the binding constraint; the
   comfort ratchet as the standing tension; "characters are cheap, judgment is
   not"; limits.
8. **Future work** - world hallucination (dreams -> places; designed, unbuilt);
   rule votes (speculation materializes capabilities, votes create social
   rules); mixed-model populations under fog - the EW replication only an open
   architecture can run.

Venue: arXiv preprint first (cs.MA / cs.AI), then COLM (LLM-agent framing) or
AIIDE / FDG / IEEE CoG (game-authorship framing) or an open-endedness workshop.
Decide after baseline numbers exist; check deadlines then.

## Threats to validity

- **Nondeterminism, no seeds** - replicates, full battery per run, claims rest
  on direction-consistency. OCEAN draws are unseeded `Math.random()` (recorded
  post-run from archived memory files; `--no-ocean` is the fallback if replicate
  variance swamps effects).
- **Provider drift** - pin model IDs in the manifest; interleave cells in time.
- **Persona sensitivity** - personas are long and load-bearing; the freeze plus
  minimal-diff ablation files is the control, and prompt content is declared
  part of the system under test.
- **Tick/wall-clock coupling** - slower models act less per tick; tiers held
  constant within every contrast, decision counts reported.
- **Starts vs executions** - live use-counts tally accepted starts; the archive
  script counts executions, and the paper reports the latter.
- **Operator effect** - the no-intervention rule; tainted runs excluded and
  disclosed.
- **Single lab, single stack** - EW's published battery gives one external
  comparison point; releasing run archives + analyze-run makes replication
  possible.

## Out of scope

World hallucination (design only), rule votes (parked; cited as sequel), human
players, public deployment, and any engine capability beyond the Phase-0 guards
- demand-driven only, and demand now comes from the matrix.

## Decisions to confirm before Phase 0

1. Baseline character count and tier (recommended: 4 x codex low).
2. The three Phase-0 guards land pre-freeze (recommended: yes - each is a
   retro's top change item and de-confounds every later run).
3. A4 and A5 both run (recommended: yes - A4 changes which speculations mint,
   A5 changes only when; together they separate selection from timing).
4. Phase 4 scope (recommended: S-wilds + M-cells firm; S-grotto/S-glass and
   N-cells as budget allows).
5. OCEAN on (recommended) vs `--no-ocean` for primary runs.
6. Venue class - affects length and framing, not the runs.
