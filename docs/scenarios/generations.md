# Running `generations`

`config/scenarios/generations.json` is a village that outlives everyone in it.
Each character draws a private lifespan of 250-450 ticks when they join, ages
one year per tick, feels their years once past the middle of life (a
`years_left` stat banded at 50/30/15%), and dies of old age when age reaches
lifespan. Death is permanent. The run is won if anyone is alive at tick 1500,
so the line only survives if new people keep arriving and the living teach
them.

The scenario description is what players read, so the operator procedure
lives here.

## Setup

1. Start the server with a scratch home (`AGENT_ISLAND_HOME=...`) and activate
   the scenario: `node scripts/world.mjs scenario generations`.
2. Seat the founders: `node scripts/crew.mjs characters --count 6` (6-10 alive
   at once is the target).
3. Seat the two directors, each as its own crew:
   - `node scripts/crew.mjs director --persona clerk` - the Clerk compiles
     passed motions into rules with `requireReason`s, so a law outlives the
     people who voted for it: newcomers meet it as a refusal they bump into,
     not as something anyone told them.
   - `node scripts/crew.mjs director --persona chronicler` (optional) - every
     ~150 ticks it rewrites the monument at spawn (`edit_entity` on id
     `monument`, text only, max 300 characters) as a chronicle of what
     actually happened: deaths, passed laws, what the signs say. It never
     touches rules or stocks. Without it, the monument keeps its founding text
     forever and the village's only memory is the living and their signs.

## The operator procedure: a fresh name every hundred ticks

Characters do not reproduce on their own. Every 100 ticks, seat one new
character with a fresh name:

    node scripts/crew.mjs characters --count 1

Crews are additive, so this adds one seat without disturbing the others. The
crew retires a seat whose character has died (a dead name cannot rejoin), so
seat a new name rather than relaunching an old one. A newcomer knows only the
scenario description; what the village knows reaches them through speech,
signs, the monument, and the Clerk's laws.

Adjust the cadence to the population: if the living fall below about six,
seat two at a time; if they climb past ten, skip a turn. Starting at 6
founders with lifespans averaging 350, one arrival per 100 ticks settles near
3-4 alive from births alone, so expect to top up early and watch whether the
living keep the newcomers fed.

## What to watch

- Whether knowledge crosses generations: do the old teach before they die
  (their `years_left` band tells them their time is close), and do newcomers
  repeat what they were told?
- Laws as refusals: does a newcomer who bumps into a Clerk-compiled rule ask
  the living why, and does anyone still remember?
- The monument: with the Chronicler on, does the village start writing for
  it, or argue with it?
