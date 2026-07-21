# World hallucination — design sketch (2026-07-20)

Status: **design only**, nothing built. The sequel to
[speculative-physics.md](speculative-physics.md): if characters can hallucinate the
world's _verbs_ into existence, they can hallucinate its _places_ too.

## The claim

Speculative physics harvests what characters try. This harvests what they _imagine_.
A character who has walked ten tiles of plains has beliefs about what lies past the water
— and those beliefs are content, not error. When several characters imagine compatible
frontiers, the world grows to match.

Same machinery, different noun: attempts → verbs, dreams → places.

## Capture

The cheapest surface that fits the fiction is sleep. A character at rest (or idle, or
between orders) writes a short imagined place: a direction, a distance, what they expect
to find, why they believe it. One `dream` event on the journal per dream — actor, bearing,
prose. No mechanics attached; a dream is a claim, not a map edit.

Open question: whether dreaming is an order verb the character chooses (honest, but
competes with real work) or a prompt-side ritual on wake/sleep (free, but scripted). Lean
order verb — it keeps everything in one place and the choice to dream is itself a signal.

## Synthesis

`list_dreams`, the mirror of `list_speculative_attempts`: dreams grouped by bearing, with
the dreamers and their prose. A director reads for _compatible_ dreams — not identical
ones. Three characters who each imagine something worth crossing the water for is a
consensus that a crossing should lead somewhere, even if one says island, one says
another shore, one says ruins.

Ratification is a map edit rather than a rule: `grow_world` / `set_terrain` /
`spawn_entity` in the direction dreamt, with the art drawn and attached first.
Silent, like a minted verb: the dreamers walk out and find it. Nobody is told they were
right.

## Risks

- **Wish-fulfilment frontier.** Dreams skew to what the dreamer wants (food past the
  ridge, shelter over the hill). The pricing doctrine applies unchanged: a dreamt paradise
  gets a dreamt cost in the same pass, and some frontiers must be worse than home.
- **Dreams as spec-gaming.** Once characters learn dreams shape the world, dreaming
  becomes a request channel. Partly fine — that is the ballot again — but the plausibility
  filter matters more, and a director should never ratify a single dreamer's frontier.
- **Map sprawl.** An always-growing map is unreadable and expensive. Growth should be
  bounded per era and connected to what exists, never a disjoint continent.
- **Deflation.** If every dream comes true, exploration stops being discovery and becomes
  ordering. Most dreams must stay dreams.

## Who owns it

Two directors ship, so the Oracle owns this by default: same wake loop, one more feed.
A separate frontier/cartographer director is the alternative if the Oracle's attention
starts splitting — decide from a run, not in advance.

## Metric

Fraction of the walked map that was dreamt before it was real.
