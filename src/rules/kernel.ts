// The rule kernel: a tiny, fully serializable simulation engine.
//
// Nothing here knows about fire, hunger, characters, or any specific mechanic.
// It knows only entities that hold named numeric *stocks*, and *rules* - pure
// data - that read and adjust those stocks each tick. The whole survival game
// is expressed as a `Rule[]` (see the scenarios under config/scenarios/); the GM, later, will just be an
// authorized client that adds more rule objects to that array.
//
// A tick runs in fixed phases so the result never depends on rule insertion
// order. Continuous mechanics (flows, thresholds) write *deltas* into a buffer
// and we apply them together at the phase end, so no rule reads a stock another
// rule wrote in the same phase. Discrete events (a finished action) apply
// immediately, in a deterministic order, the way the old engine resolved them.

export interface Stock {
  value: number;
  min: number;
  max: number;
}

// A committed-but-unfinished action occupying an entity. It only takes effect
// on the tick it completes (endTick); committing a new one abandons this.
export interface ActiveAction {
  type: string;
  args: Args;
  startTick: number;
  endTick: number;
}

// How an entity sits on its tile - the one structural axis the substrate
// itself dispatches on, as opposed to `tags`, which only rules ever match.
// It is a ladder, not a set of flags: blocking implies holding the tile, and
// holding the tile implies being on the grid at all. Absent means the entity
// does not compete for ground - it is invisible to the map and to pathing, and
// is only reachable through colocation.
//
//   undefined  off-grid; colocation-matchable only (an item pile, a corpse)
//   "tile"     on the grid, holds its tile, walkable (a sign, a shelter)
//   "blocking" on the grid, holds its tile, routes go around (a wall)
//
// Holding the tile is what makes a second build there a refusal rather than a
// silent no-op, which is why there is no "on the grid but buildable-over"
// rung: a tile shows one token, so that state could only ever mean "the loser
// pays and nothing appears".
export type Occupancy = "tile" | "blocking";

// Tag names that the substrate used to dispatch on, before occupancy replaced
// them. Rejected wherever an author can still write a tag, so a rulepack that
// reaches for the old convention gets a sentence instead of silence.
export const RETIRED_OCCUPANCY_TAGS = new Set(["token", "solid", "exclusive"]);

export interface Entity {
  id: string;
  // The entity's identity: the one species/thing name ("tree", "hearth",
  // "wolf") that visuals, labels, and auto-ids key off. Distinct from `tags`,
  // which is a pure unordered set of behavior/selector strings ("predator",
  // "water-source"). For matching, kind counts as a tag (see hasTag);
  // for everything else it is the single answer to "what is this thing".
  // Optional: a kindless entity renders as the missing-sprite checker and
  // labels fall back to its id.
  kind?: string;
  tags: string[];
  occupancy?: Occupancy;
  stocks: Record<string, Stock>;
  pos?: { x: number; y: number };
  action?: ActiveAction | null;
  // Writing carried by the entity - a sign's face, a tablet's etching. Free
  // text authored by a mind (an agent's inscribe, a GM spawn), never by an
  // expression, and deliberately opaque to the rule DSL: no matcher or Expr
  // can read it, so words stay communication rather than incantation. Capped
  // at MAX_INSCRIPTION wherever it is written.
  text?: string;
  // The id of the entity holding this one, if any - a discrete item's
  // containment relation (an axe in a character's hand), as opposed to a
  // stock's fungible count. A held entity is off-grid by construction: it
  // carries no `pos` and no `occupancy` (see the `take`/`release` effects),
  // so it is invisible to the map/sight/colocation the same way any other
  // positionless entity is, and reachable only through `held`/`holds`.
  heldBy?: string;
}

// The longest inscription an entity can carry. Long enough for a warning, a
// posted law, or a short lore fragment; short enough that a sign read in
// passing can't flood a reader's context.
export const MAX_INSCRIPTION = 300;

// Validate a free-text inscription at its write seams (spawn effect, the
// host's inscribe verb, GM fixtures): trimmed, non-empty, bounded.
export function validInscription(text: unknown): string {
  let trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed || trimmed.length > MAX_INSCRIPTION)
    throw new Error(`Inscription must be 1 to ${MAX_INSCRIPTION} characters.`);
  return trimmed;
}

export interface KernelWorld {
  tick: number;
  // Seed for the kernel's stateless noise expressions (see noise()). Optional so
  // pre-RNG snapshots restore cleanly - a missing seed reads as 0 and the world
  // still replays, just on a different noise stream than a seeded one.
  seed?: number;
  entities: Record<string, Entity>;
  // Last tick a (rule, self) pair fired, keyed "<ruleId>:<selfId>" - backs a
  // rule's `cooldown`. Optional so a pre-cooldown snapshot restores cleanly
  // (a missing map just means no rule has a live cooldown yet); lazily
  // created on first use rather than always seeded, so a world with no
  // cooldown rules carries no dead weight.
  cooldowns?: Record<string, number>;
  // A pending world reroll requested by the `regenerate` effect this tick: the
  // seed to rebuild worldgen from. The kernel only records it (the world can't
  // be rebuilt mid-iteration); the host reads and clears it after the tick, so
  // every other effect in the same `do` runs against the old world first. Never
  // survives a tick, so it never rides a snapshot.
  pendingRegen?: number;
  // Pending map growth requested by `growWorld` this tick, accumulated per edge.
  // The host reads and clears it after the tick, so it never rides a snapshot.
  pendingGrow?: Partial<Record<MapEdge, number>>;
}

export type MapEdge = "north" | "east" | "south" | "west";

export interface KernelEvent {
  tick: number;
  type: string;
  entity?: string;
  text?: string;
  // Opt in to colony-wide reach. Absent/false, the host scopes the event to who
  // could perceive it (the actor and whoever stood within SIGHT); a scenario
  // sets it for a world-level happening no one stands at (a season, a victory).
  global?: boolean;
  args?: Args; // flat event/action data, so hosts and rules can render or react
  // Carried over from a watch rule's emit: the host should stop the subject's
  // current action and order, citing this text (see WatchRule.emit.interrupt).
  interrupt?: string;
}

// "self" is the entity a per-entity rule is currently bound to; "world" is the
// singleton entity that holds global stocks (fire, the stockpile, the clock).
// Any other string is a literal entity id. `{arg}` resolves an action argument
// to an entity id, and `{colocated}` resolves the entity self shares a tile with
// that carries a tag.
export type EntitySel =
  | "self"
  | "world"
  | string
  | { arg: string }
  // The bare-tag form `{colocated:"food"}` is shorthand for `{colocated:{tag}}`;
  // the object form adds a range (chebyshev radius) and a `where` predicate so a
  // rule can bind to "another agent within 1 tile whose infection > 0" and then
  // read or adjust *that* entity's stocks via `of`.
  | { colocated: TagRef | ColocatedSel }
  // The entity self is holding that matches `tag`/`kind`/`where` - the
  // containment counterpart to `colocated`, for an item with no position of
  // its own (see Entity.heldBy). The bare-tag form `{held:"axe"}` is shorthand
  // for `{held:{tag:"axe"}}`; a candidate is tested with itself as "self",
  // exactly like colocated's `where`. Throws when nothing held matches -
  // reading through an empty hand is a real error, the same as an empty
  // `colocated` match.
  | { held: TagRef | HeldSel };

// A match against entities self is holding (heldBy === self.id). `tag` is
// loose (kind or tags); `kind` is strict; give both and a candidate must
// satisfy both. With more than one match, the first in entity-iteration order
// wins - deterministic, so a snapshot still replays the same pick. No `range`
// or `pick` (unlike ColocatedSel): a hand isn't a neighbourhood to search or
// rank by distance, and multiple held items of the same kind are rare enough
// that "the first one" is a fine default until a real use forces more.
export interface HeldSel {
  tag?: TagRef;
  kind?: TagRef;
  where?: Cond;
}

// A spatial match against other entities. `tag` matches the name in either
// slot (kind or tags); `kind` matches identity strictly; give both and a
// candidate must satisfy both, give neither and the selector throws. `where`
// filters candidates (each candidate is "self" while it is tested, exactly
// like an Aggregate's `where`); `range` is the chebyshev radius to search
// (default 0 - the actor's own tile); `other` excludes the actor itself from
// the candidates (default true, so a per-agent rule matches a *different*
// agent, not itself). With no `pick`, the first match in entity-iteration
// order wins, which is deterministic and so snapshot-replayable.
export interface ColocatedSel {
  tag?: TagRef;
  kind?: TagRef;
  where?: Cond;
  range?: number;
  other?: boolean;
  pick?: ColocatedPick;
}

// How a colocated selector chooses when several candidates qualify. Omitted,
// the first match in entity-iteration order wins (cheap, and the historical
// behavior). Every pick breaks ties by that same iteration order, so a
// snapshot still replays to the identical match. `random` is a seeded draw
// (see noise()), reproducible per (seed, tick, actor) - its keys are salt,
// exactly as in `rand`, so two random picks in one rule can decorrelate.
export type ColocatedPick =
  | "nearest" // smallest chebyshev distance to the actor
  | { lowest: NameRef } // the candidate with the least of a stock - "the weakest"
  | { highest: NameRef } // the candidate with the most of a stock - "the strongest"
  | { random: NoiseKey[] }; // a reproducible uniform choice among the candidates

// Action arguments, e.g. { resource: "wood" }. Effects and conditions can read
// these to parameterize a single action over many targets.
export type Args = Record<string, string | number>;

// A stock or tag name that is either a literal or pulled from an action arg -
// this is what lets one `gather` rule serve both wood and food.
export type NameRef = string | { arg: string };

// A tag name that is a literal, an action arg, or - the form NameRef lacks -
// the id of an entity resolved at runtime. `{nameOf: "self"}` is the ownership
// primitive: a spawn tagged with its creator's id makes "my stashes" an
// ordinary tag query (a colocated match, an aggregate domain), and one rule
// parameterized over a team arg replaces a mirror-image pair. Accepted at
// every tag position that evaluates with a bound self; a rule's `each`
// selector is the deliberate exception (it enumerates the selves, so there is
// no self to resolve against yet).
export type TagRef = NameRef | { nameOf: EntitySel };

// A literal salt for a noise/rand draw. Not a value the kernel reads at runtime
// but a compile-time address: distinct keys give independent random streams that
// share the same (seed, tick, entity) coordinates, so a single world rule can
// roll for several unrelated events on the same tick without them correlating.
export type NoiseKey = string | number;

// --- Expressions: a deliberately tiny arithmetic AST --------------------
//
// Kept minimal on purpose. The moment this grows a parser or an `eval`, the
// "serializable rules a GM can author" property is lost. Add to it only when a
// real mechanic forces it.
export type Expr =
  | number
  | { stock: NameRef; of?: EntitySel } // read a stock's current value (name may be an arg)
  // Room left in a stock before it hits its ceiling: max - value. The gate
  // behind a leak-free withdraw ("take only what fits in the scenario") and a
  // "top up to full" adjust. Reads max, which `stock` can't.
  | { headroom: NameRef; of?: EntitySel; maxIfMissing?: number }
  | { tick: true } // the world clock - the basis of the calendar
  | { arg: string } // read a numeric action arg
  // The x/y of an entity's tile, so a rule can compute a coordinate *relative*
  // to where something already stands - the missing piece behind spatial
  // diffusion (a `spawn.at` of `{posX:"self"}+/-1` seeds a copy on a neighbour
  // tile) and any distance/gradient math. The selector resolves like everywhere
  // else (`"self"`, an id, `{arg}`, `{colocated}`); an entity with no position
  // throws, the same as reading a stock it never held.
  | { posX: EntitySel }
  | { posY: EntitySel }
  | { lookup: { on: string; table: Record<string, number> } } // arg -> number
  | { add: Expr[] }
  | { sub: Expr[] } // left fold: a - b - c ...; the inverse of add
  | { mul: Expr[] }
  | { min: Expr[] } // smallest of - clamps a gather yield to what the token has left
  | { max: Expr[] }
  | { floor: Expr }
  | { ceil: Expr }
  | { round: Expr }
  | { abs: Expr }
  | { sqrt: Expr }
  | { sign: Expr } // -1, 0, or 1 - branch on the direction of a difference
  | { div: [Expr, Expr] }
  | { mod: [Expr, Expr] }
  | { pow: [Expr, Expr] } // base ^ exponent
  | { clamp: [Expr, Expr, Expr] } // (value, lo, hi)
  // The kernel's only randomness, and it is not actually nondeterministic: a
  // reproducible draw in [0,1) addressed by (world seed, tick, self, ...keys)
  // rather than drawn from a sequential PRNG (see noise()). The salt `keys`
  // decorrelate independent streams within one tick/entity - one for "raid",
  // another for "weather". `rand` is the ergonomic range form: a uniform draw in
  // [lo, hi), with any entries after the bounds used as salt keys.
  | { noise: NoiseKey[] }
  | { rand: [Expr, Expr, ...NoiseKey[]] }
  // The only branching expression: condition ? then : else. Lets a single
  // value bend on state ("base + (cold ? 5 : 0)") without a second rule.
  | { if: [Cond, Expr, Expr] }
  // Reductions over every entity carrying `tag` (optionally filtered by `where`,
  // which is evaluated with that entity as "self"). The basis of population-
  // scaled difficulty, quorum gates, and collapse detection. `count` ignores
  // `stock`; the others require it.
  | { count: Aggregate }
  | { sum: Aggregate }
  | { avg: Aggregate }
  | { max_of: Aggregate }
  | { min_of: Aggregate };

// A reduction's domain: the entities matching `tag` (loose: kind or tags)
// and/or `kind` (strict identity) that also satisfy `where`, optionally
// bounded to the evaluating self's neighbourhood via `near` - that is what
// makes "how many agents stand within 3 tiles of me" expressible
// ({ count: { tag: "agent", near: 3, other: true } }). At least one of
// tag/kind is required; given both, an entity must satisfy both.
export interface Aggregate {
  tag?: TagRef;
  kind?: TagRef;
  stock?: NameRef; // the stock to reduce (required by all but `count`)
  where?: Cond; // a per-entity filter; "self" is each candidate in turn
  // Only entities within this chebyshev radius of the evaluating self. Needs a
  // positioned self: a world-bound rule has no vantage point, so `near` there
  // is an authoring error and throws (surfacing as a rule_error / dry-run
  // warning rather than silently reducing over nothing).
  near?: number;
  // Exclude the evaluating self from the domain (default false: an agent
  // counting "agent"s historically counts itself).
  other?: boolean;
}

export type Cmp = "gte" | "gt" | "lte" | "lt" | "eq";

export type Cond =
  | { cmp: Cmp; left: Expr; right: Expr }
  // The tag resolves against the *evaluating* self (not `of`), so
  // `{tag: {nameOf: "self"}, of: {colocated: "stash"}}` asks "does that stash
  // carry MY name" - the ownership check. Loose: matches the name in either
  // slot (kind or tags).
  | { tag: TagRef; of?: EntitySel }
  // The strict counterpart: the entity IS this kind (a tag carrying the name
  // doesn't count). Resolves against the evaluating self, exactly like tag.
  | { kind: TagRef; of?: EntitySel }
  // self shares a tile (or, with `range`, a neighbourhood) with some other
  // entity carrying `tag` - the spatial gate behind "must stand on a food
  // source" and, with `where`, "an adjacent agent who is infected".
  | { colocated: ColocatedSel }
  // The entity named by `of` (default self) is holding something matching
  // `tag`/`kind`/`where` - the containment gate behind "you must be holding
  // an axe to chop" or "requires a lit torch". `of` resolves against the
  // *evaluating* self, exactly like `tag`'s `of`.
  | { holds: TagRef | HeldSel; of?: EntitySel }
  // self stands on (range 0) or within `range` tiles (chebyshev) of a map tile
  // whose terrain is one of `type` - the gate behind "drink beside water". The
  // host must install a terrain lookup for the kernel call (see TerrainLookup);
  // unlike `colocated`, this reads the grid, not an entity.
  | { nearTerrain: { type: string | string[]; range?: number } }
  // True when self stands on the named boundary. This remains valid when
  // north/west growth moves the map origin into negative coordinates.
  | { atMapEdge: { edge: MapEdge } }
  // True once self is within `within` tiles of the named boundary - the gate
  // behind growth rules. `within` should be >= the host's sight radius, or
  // agents reach a stretch where nothing new is revealed before the map
  // actually grows and have no signal pulling them further that way.
  | { canSeeMapEdge: { edge: MapEdge; within: number } }
  // the named stock (literal or arg) is one the ruleset marks stockpilable - the
  // gate behind "you may only haul haulable resources into a stockpile". Reads a
  // ruleset-level registry the host installs (see setStockpilable), not entity
  // state, so it holds for any self.
  | { stockpilable: NameRef }
  | { stockpileAccepts: NameRef; of?: EntitySel }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond };

// A rule binds to the world singleton (no `each`) or to every matching entity,
// in which case "self" resolves to each match in turn. `tag` is the loose form
// (matches the name in either slot - kind or tags, see hasTag); `kind` is the
// strict form (the entity IS that kind, a tag carrying the name doesn't
// count). Given both, an entity must satisfy both. Deliberately plain strings,
// not TagRefs: the selector is what *produces* the bound self, so there is
// nothing yet to resolve a `{nameOf}`/`{arg}` against. At least one of the two
// is required (enforced by validateRule; an empty selector binds nothing).
export interface Selector {
  tag?: string;
  kind?: string;
}

// Pure metadata carried by every rule: the GM's one-line summary of what the
// rule does and why, in plain language. The kernel never reads it - it rides
// along verbatim through add/patch/overlay/snapshot so dashboards and other GMs
// can read the author's intent instead of reverse-engineering it from the body.

// Per-rule pacing, layered orthogonally onto phase/kind and onto `when`: an
// explicit run order within the rule's own phase, a stochastic gate, and a
// minimum-tick spacing between firings. All optional; a rule declaring none of
// them behaves exactly as before - this is a purely additive rule-algebra
// upgrade, not a change to any existing rule's runtime behavior.
interface RulePacing {
  // Run order within this rule's own phase - NOT across phases; the fixed
  // pipeline order (derived -> event -> action -> event -> flow -> threshold
  // -> watch -> transition) is unaffected. Higher runs first; ties keep the
  // rules' declared array order (a stable sort), so a rule set where nothing
  // declares priority reproduces today's plain array-order behavior exactly.
  // Matters only where a phase's rules can observe each other's effects
  // within the same tick: derived's sequential recompute, an event/transition
  // chain reacting to an earlier rule's write, or a channel's modifier fold
  // order (scale vs. add composition is order-sensitive). Buffered numeric
  // writes within one phase (flow/threshold) still resolve by `conflict`
  // policy, not by priority alone.
  priority?: number;
  // A per-(rule, self) stochastic gate, checked only after `when` passes: a
  // seeded, reproducible draw (the same addressed-noise mechanism as `rand`/
  // `noise`, keyed by this rule's id) rather than Math.random, so a replayed
  // snapshot rolls the identical outcome on the identical tick. Omitted means
  // "always" (chance 1), the historical behavior.
  chance?: number;
  // The minimum number of ticks between this rule firing again for the same
  // (rule, self) pair - "firing" meaning `when` (and `chance`) passed and the
  // rule's body ran. Tracked in world.cooldowns, so it survives snapshot/
  // restore like any other world state. Omitted means no minimum spacing.
  cooldown?: number;
}

export interface FlowRule extends RulePacing {
  id: string;
  description?: string;
  phase: "flow";
  each?: Selector;
  target: NameRef; // stock on self to adjust
  rate: Expr; // signed amount per tick
  channel?: string; // modifiers on this channel scale/offset the rate
  when?: Cond;
}

// How a buffered `set` effect resolves against another rule's `set` on the
// same (entity, stock) within the same threshold pass. "override" (default)
// reproduces today's behavior exactly: whichever rule's set runs last (by
// priority, then declared order) wins outright. "highest"/"lowest" instead
// keep the most extreme value seen this phase regardless of run order - for
// "several hazards each cap health at a different ceiling; take the worst
// one" without hand-rolling a priority ordering to fake it. Only meaningful
// for `set` (an `adjust` conflict is unambiguously additive and needs no
// policy) and only threshold carries free-form `set` effects in a buffered
// phase - flow's implicit effect is always a single `adjust`.
export type SetConflict = "override" | "highest" | "lowest";

export interface ThresholdRule extends RulePacing {
  id: string;
  description?: string;
  phase: "threshold";
  each?: Selector;
  when?: Cond;
  do: Effect[];
  conflict?: SetConflict;
}

// Emits an event the tick its condition becomes *newly* true (false before this
// tick's deltas, true after) - that is how edge alerts like "fire_out" or
// "starving" fire once on the crossing rather than every tick after.
// `interrupt` marks the alarm loud enough to stop the subject's hands: the host
// abandons their in-flight action and interrupts their running order, with this
// text as the reason. The fresh-crossing latch keeps it one-shot - it cannot
// trip again against the recovery it forces, and re-arms once the condition
// clears.
export interface WatchRule extends RulePacing {
  id: string;
  description?: string;
  phase: "watch";
  each?: Selector;
  when: Cond;
  emit: { type: string; text?: string; global?: boolean; interrupt?: string };
}

export interface EntityTargetMatch {
  tag?: string; // loose: matches kind or tags
  tags?: string[]; // loose, all required
  kind?: string; // strict: the target IS this kind
  range?: number;
  visible?: boolean;
  includeSelf?: boolean;
  // Restrict the candidates to items the actor is holding (heldBy === actor).
  // Held items have no position, so a `heldBySelf` match skips the range and
  // visibility checks entirely - a hand isn't a place on the map. This is the
  // `drop` action's target: "which of the things in my hand". Distinct from
  // the DSL's `held` selector (that resolves one item inside a rule);
  // this scopes an action's self-describing entity-param choices.
  heldBySelf?: boolean;
}

interface ActionParamBase {
  name: string;
  required?: boolean;
  description?: string;
}

// A parameter an action accepts - the self-describing schema a client reads
// from availableActions, since there is no per-action MCP tool to carry it.
export type ActionParam =
  | (ActionParamBase & { type: "string" })
  | (ActionParamBase & {
      type: "enum";
      values?: readonly string[];
      // Instead of a fixed `values` list, draw the choices from a ruleset
      // registry at read time, so the whitelist has one source rather than
      // being restated on every action. "stockpilable" offers the narrower,
      // deposit/withdraw-specific opt-in subset of pack resources; "pack"
      // offers every givable resource (the role give's own `item` param
      // draws from) - see scenario.ts StockRole.
      from?: "stockpilable" | "pack";
    })
  | (ActionParamBase & { type: "entity"; match?: EntityTargetMatch });

// An action is a rule too: its trigger is "this entity committed intent of this
// type" (see commit()), it occupies the actor for `duration` ticks, and its
// completion effects use the same executor with a different trigger. The
// `description`/`params` are pure presentation metadata (the kernel ignores
// them) so hosts can advertise this action to clients.
export interface ActionRule {
  id: string; // the action name clients use in order action objects
  kind: "action";
  duration: number; // ticks the actor is occupied
  requires?: Cond; // commit-time gate (self = actor); rejects if false
  requireReason?: string;
  fizzleWhen?: Cond; // completion-time abort (the stockpile emptied meanwhile)
  fizzleReason?: string;
  do: Effect[]; // applied immediately on completion, in order
  emit?: { type: string; global?: boolean };
  description?: string;
  params?: ActionParam[];
  // Other names this same action answers to. Characters invent the word before
  // the world has one, and a world that only accepts `mine` while people try
  // `quarry`, `chip`, and `extract_stone` teaches them to hunt vocabulary
  // instead of play. A director ratifying a verb attaches the synonyms it saw.
  aliases?: string[];
}

export interface ActionCheck {
  applicable: boolean;
  unavailableReason?: string;
}

// Not a phase: a conditional scale/offset registered against a named channel.
// Flows and adjusts that declare that channel fold the active modifiers in.
// "In winter, gather food at half rate" is one of these and nothing else.
export interface Modifier {
  id: string;
  description?: string;
  kind: "modifier";
  channel: string;
  op: "scale" | "add";
  value: Expr;
  when?: Cond; // evaluated against the world ("self" = world)
  // Fold order among modifiers sharing a channel - scale vs. add composition
  // is order-sensitive, so this is the one RulePacing field that applies to a
  // `kind`, not a `phase`, rule. See RulePacing.priority for the tie-breaking
  // rule (a stable sort; omitted on every modifier reproduces today's plain
  // array-order fold exactly).
  priority?: number;
}

// A serializable template for an entity a rule conjures at runtime: a crate that
// drops where a character stood, a campfire a build action raises, a corpse a
// death leaves behind. Stocks are plain numbers (not Expr) to keep a spawn pure
// data; an unset max defaults to UNBOUNDED so an item pile isn't silently capped
// at 100. With no `id` the kernel mints a fresh "<prefix>-<n>" so a recipe can
// fire repeatedly without the author tracking ids.
export interface SpawnSpec {
  id?: NameRef; // explicit id (literal or from an arg); omit to auto-generate
  idPrefix?: string; // base for an auto id (default: kind, else "entity")
  // What the spawn IS - the single name its sprite, label, and auto-id key
  // off ("crate", "campfire", "corpse"). Resolves at spawn time like a tag,
  // so `{nameOf: "self"}` works here too. A spawn without one renders as the
  // missing-sprite checker.
  kind?: TagRef;
  // Behavior/selector strings, an unordered set every one of which is matchable
  // by rules and none of which the substrate itself reads. Each tag resolves at
  // spawn time, so `[{nameOf: "self"}]` mints a stash carrying its builder's
  // id. Order never matters; identity belongs in `kind`, and how the thing sits
  // on its tile belongs in `occupancy`.
  tags?: TagRef[];
  // Whether the spawn takes ground, and how. A structure meant to appear on the
  // map wants "tile"; one that also blocks routes wants "blocking". Omit for
  // something that merely lies where it fell. Unlike `kind` and `tags` this is
  // a static enum rather than a TagRef - it is engine structure, not authored
  // vocabulary, so it must be knowable before the action commits.
  occupancy?: Occupancy;
  // `icon`/`color` are ignored by the kernel (which only instantiates
  // value/min/max) but carried so the host can register a built structure's
  // stock icon and map look at load.
  stocks?: Record<
    string,
    {
      value: number;
      min?: number;
      max?: number;
      icon?: string;
      color?: string;
    }
  >;
  // Where the spawn lands: copy an entity's tile (default: the acting "self"),
  // or a literal coordinate pair - `{x: 30, y: 12}` places it on an absolute
  // tile, and since both are Exprs, `{x: {rand: [0, 63, "drop-x"]}, ...}`
  // scatters it. A coordinate spawn is bounds-checked against the installed
  // terrain lookup and throws off-map (surfacing as a rule_error rather than
  // silently minting an entity no tile owns) - UNLESS `skipOffMap` is set, in
  // which case an off-map target is a quiet no-op instead. That is what makes
  // edge-of-map diffusion clean: a spread that rolls `{posX:"self"}+1` past the
  // frontier simply doesn't seed a child there, rather than spamming rule_errors
  // every time a patch on the boundary tries to spread outward.
  // `snapToPassable` relocates a coordinate spawn that lands on blocked terrain
  // to the nearest passable tile (growing Chebyshev rings, row-major within a
  // ring, so the pick is deterministic) - what lets a "scatter anywhere" rule
  // keep working on wall-heavy layered maps instead of minting a stairway
  // inside the rock. Needs the host's passability oracle; without one the
  // coordinates are taken at face value, like the other guards.
  at?:
    | EntitySel
    | {
        x: Expr;
        y: Expr;
        skipOffMap?: boolean;
        snapToPassable?: boolean;
      };
  // A literal inscription the spawn carries (see Entity.text) - how a rule or
  // GM seeds a pre-written sign. Plain string, not a TagRef/Expr: the DSL can
  // place writing but never compose or read it.
  text?: string;
  // Spawn this entity directly into another entity's hand (see Entity.heldBy)
  // rather than onto the grid - the "craft an axe" idiom, as opposed to
  // "build a shelter" which wants `occupancy`. Mutually exclusive with `at`:
  // a held spawn is off-grid by construction, so `at`/`occupancy` are ignored
  // when this is set. Resolves against the acting self like any EntitySel
  // (`heldBy:"self"` is the common case - the actor crafts it into their own
  // hand).
  heldBy?: EntitySel;
}

export type Effect =
  | {
      adjust: {
        target: NameRef;
        of?: EntitySel;
        by: Expr;
        channel?: string;
        as?: string;
      };
    }
  | { set: { target: NameRef; of?: EntitySel; to: Expr } }
  | {
      transfer: {
        from: { stock: NameRef; of?: EntitySel; as?: string };
        to: {
          stock: NameRef;
          of?: EntitySel;
          as?: string;
          maxIfMissing?: number;
        };
        amount: Expr;
      };
    }
  // Flip an entity's tags - how an agent leaves the "agent" selector on
  // death, so every rule that binds to agents simply stops touching it. The
  // add/remove refs resolve against the *acting* self, so
  // `{tag: {of: {arg: "target"}, add: {nameOf: "self"}}}` brands the target
  // with the actor's name.
  | { tag: { of?: EntitySel; add?: TagRef; remove?: TagRef } }
  // Rewrite an entity's kind - the explicit identity change behind "a felled
  // raider becomes a carcass". This is the only way to change what an entity
  // IS at runtime; tag add/remove deliberately can't touch kind, so a sprite
  // never changes by tag-order accident. Immediate phases only, like tag.
  | { kind: { of?: EntitySel; set: TagRef } }
  | { clearAction: { of?: EntitySel } }
  // Entity lifecycle - the structural effects behind crafting, hauling drops,
  // building, and butchering. Like tag/clearAction they restructure the world
  // rather than nudge a number, so they run only in immediate (action/event/
  // transition) phases, never buffered into the continuous delta pass.
  | { spawn: SpawnSpec }
  | { destroy: { of?: EntitySel } }
  // Move an item into a hand - the pick-up idiom, and what a `spawn.heldBy`
  // desugars past for an ALREADY-existing entity (a corpse's dropped axe
  // picked back up). Clears `item`'s `pos`/`occupancy` (so it stops rendering
  // on the map: see space.ts syncTokens, which only ever projects a
  // pos+occupancy entity) and sets `heldBy` to the resolved holder (default
  // self). Structural: immediate phases only.
  | { take: { item: EntitySel; by?: EntitySel } }
  // The inverse of `take` - drop a held item at a tile, giving it back
  // `pos`/`occupancy:"tile"` so it re-enters the grid. `at` defaults to the
  // resolved holder's own tile (default self). An `at` that is itself
  // positionless leaves the item positionless too rather than inventing a
  // coordinate for it (see releaseHeld). Structural: immediate phases only.
  | { release: { item: EntitySel; by?: EntitySel; at?: EntitySel } }
  // Step an entity across the grid by a signed (dx, dy) - the structural effect
  // behind a roaming predator or a drifting hazard. Movement is otherwise owned
  // by the space subsystem (agents following committed travel/explore paths);
  // this and `moveToward` are the kernel's only ways to relocate an entity, so
  // a rule can patrol a creature that never commits an action. The destination
  // is bounds-checked against the installed terrain lookup (an off-map step is
  // dropped, never written, so syncSites can't index a tile that doesn't
  // exist); terrain passability is intentionally ignored, so a predator may
  // cross water a character can't. Like the other structural effects it runs
  // only in an immediate (action/event/transition) phase.
  | { move: { of?: EntitySel; dx: Expr; dy: Expr } }
  // Step an entity toward another entity's tile - the homing counterpart to
  // `move`, the effect behind a predator that chases the nearest character
  // rather than wandering. Each step snaps dx and dy to the sign of the
  // remaining offset, so one step closes distance on both axes at once
  // (chebyshev distance falls by 1); `steps` (default 1) repeats that up to N
  // times, stopping early on arrival at the target's tile. The target resolves
  // like any entity selector - `{colocated: {tag: "agent", range: 6, pick:
  // "nearest"}}` is the chase idiom; gate the rule with a matching `when`
  // condition so a tick with no target in range skips instead of erroring.
  // Unlike `move`, a chase RESPECTS passability when the host installs its oracle
  // (see PassableLookup): a diagonal step blocked by a wall greedily slides along
  // whichever axis is open, so a creature hugs walls toward its prey instead of
  // phasing through them or cutting a corner; a straight approach walled dead
  // ahead simply stops (greedy, not A* - it can stick in a concave pocket). An
  // off-map step is dropped like `move`; with no oracle installed it falls back
  // to the on-map-only guard. Immediate phases only.
  | { moveToward: { of?: EntitySel; target: EntitySel; steps?: Expr } }
  // Teleport an entity to an absolute tile - the third member of the movement
  // family (`move` relative, `moveToward` a step closer, `moveTo` all the way).
  // `to` mirrors `spawn.at`: either an entity selector, landing the mover on that
  // entity's tile ("teleport to the matching portal / the stairs-up" without
  // hardcoding coordinates worldgen rolled), or a literal `{x, y}` coordinate
  // pair (both Exprs, so `{x: {rand: [...]}}` scatters). Unlike `move`/`moveToward`
  // an off-map target THROWS like `spawn` rather than silently no-op'ing - a
  // teleport that quietly doesn't happen is the worst kind of rule bug to debug.
  // Immediate (action/event/transition) phases only.
  | { moveTo: { of?: EntitySel; to: EntitySel | { x: Expr; y: Expr } } }
  // Reroll the whole map from a seed - the "next floor" primitive, the effect
  // behind descending stairs / entering a portal / boarding a ship. `seed` is a
  // full Expr (`{seed: {stock: "floor"}}` is the canonical roguelike form), so
  // arithmetic seeds come free. Unlike an operator reset (which wipes the GM
  // overlay and returns to the scenario baseline), a regenerate KEEPS the live
  // rule set and carries agents forward: living characters retain their tags and
  // stocks and land on the new spawn, the world entity keeps its stocks (so the
  // very counter that drove the reroll survives it), and everything else is
  // rebuilt by worldgen. The reroll is DEFERRED to end of tick - the kernel only
  // records the request here (see `pendingRegen`), so a rule can't rebuild the
  // world out from under the iteration it's in the middle of. Immediate phases
  // only; a `when` cooldown guards against a world-thrashing loop.
  | { regenerate: { seed: Expr } }
  // Extend one map edge by `by` blank default-terrain tiles. With no direction,
  // the original behavior grows east and south together. Signed grid origins
  // let north/west growth preserve every existing absolute coordinate.
  | { growWorld: { by: Expr; direction?: MapEdge } }
  // Rewrite the terrain of a tile - the structural effect behind terrain that
  // changes at runtime (a forest chopped bare becoming plains, a GM painting
  // lava). It writes the terrain under an entity's own tile (`of`, default the
  // acting "self"); pairing it with a `nearTerrain: { range: 0 }` gate lets a
  // rule key on the tile it will rewrite. The host must install a terrain writer
  // for the kernel call (see TerrainWriter), which owns the side effects a live
  // terrain change implies - passability, cached routes, the map revision. Like
  // the other structural effects it runs only in an immediate (action/event/
  // transition) phase.
  | { setTerrain: { of?: EntitySel; to: NameRef } }
  // Light up map knowledge in an agent's fog - the effect behind scenario-authored
  // perception verbs (a survey action revealing radius N, a watchtower, a
  // bought map). `to` is whose fog gains the tiles (default the acting self);
  // `around` centers the reveal on another entity's tile (default: wherever
  // `to` stands); `radius` is Chebyshev, default 1. The host installs a
  // Revealer that owns what "reveal" means (per-agent fog, revisions); like
  // setTerrain, absent a revealer the effect throws rather than silently
  // no-ops. Immediate phases only.
  | { reveal: { to?: EntitySel; around?: EntitySel; radius?: Expr } }
  // Fan an effect list out over EVERY colocated match, not just the first one a
  // `{ colocated }` selector binds: the inner effects run once per match with
  // "self" rebound to that match (the same rebinding an Aggregate's `where`
  // uses), so a bare `target: "morale"` inside means the *match's* morale -
  // "every helper within a tile gains 3". `pick` is meaningless here and
  // ignored; forEach IS the all-of-them form of the selector. Allowed in a
  // buffered (threshold) phase only while every inner effect is numeric - one
  // structural effect inside keeps the whole forEach out (see validateRule).
  | { forEach: { colocated: TagRef | ColocatedSel; do: Effect[] } };

// Recomputes a stock from an expression every tick, before anything reads it -
// this is how `tick` becomes a calendar (day, season) the rules can branch on.
// Only `priority` applies here, not `chance`/`cooldown`: a calendar must
// recompute every tick without fail, since watch rules elsewhere key off its
// value settling in lockstep with the clock.
export interface DerivedRule {
  id: string;
  description?: string;
  phase: "derived";
  each?: Selector;
  target: NameRef;
  value: Expr;
  priority?: number;
}

// A one-way state change applied immediately after the threshold phase (when a
// stock has settled): death is the canonical case. Because it retags the entity
// out of its selector, its `when` only fires on the tick of the transition.
export interface TransitionRule extends RulePacing {
  id: string;
  description?: string;
  phase: "transition";
  each?: Selector;
  when: Cond;
  do: Effect[];
  emit?: { type: string; text?: string; global?: boolean };
}

// A discrete reaction to an event emitted earlier in this tick. The event's
// entity becomes `self`, and its args become the rule args.
export interface EventRule extends RulePacing {
  id: string;
  description?: string;
  phase: "event";
  on: string;
  when?: Cond;
  do: Effect[];
}

export type Rule =
  | DerivedRule
  | FlowRule
  | ThresholdRule
  | WatchRule
  | TransitionRule
  | EventRule
  | ActionRule
  | Modifier;

// --- Evaluation ---------------------------------------------------------

// Tag membership with kind counted as a distinguished tag: every selector,
// aggregate, and condition that asks "does this entity carry <name>" matches
// the entity's kind as well as its tags, so a rule can target "wolf" whether
// wolf is the entity's kind or an extra tag. This is what keeps kind out of
// the ordered-array business entirely: tags stay a pure set, kind stays
// identity, and rules don't care which slot a name lives in. Structurally
// typed so token refs and claims (which mirror kind+tags) share the check.
export function hasTag(
  e: { kind?: string; tags: string[] },
  tag: string,
): boolean {
  return e.kind === tag || e.tags.includes(tag);
}

// Normalize the entity-selector shorthand: a bare tag (`{colocated:"food"}`),
// an arg-ref, or a nameOf-ref all mean "match this tag on the same tile"; the
// object form is passed through unchanged.
function asColocatedSel(c: TagRef | ColocatedSel): ColocatedSel {
  return typeof c === "string" || "arg" in c || "nameOf" in c ? { tag: c } : c;
}

// Resolve a TagRef to the tag string it names this evaluation: a literal, an
// action arg, or - the runtime form - the id of the entity `{nameOf}` selects.
// Resolution is always against the passed self (the acting/evaluating entity),
// never against whatever entity the surrounding effect or condition targets.
function tagName(
  ref: TagRef,
  world: KernelWorld,
  self: Entity,
  args: Args,
): string {
  if (typeof ref === "string") return ref;
  if ("arg" in ref) return String(args[ref.arg]);
  return resolve(world, self, ref.nameOf, args).id;
}

// A TagRef rendered for an error message, without resolving it (the failure
// being reported may be the resolution itself).
function showTag(ref: TagRef): string {
  return typeof ref === "string" ? ref : JSON.stringify(ref);
}

// An aggregate's domain rendered for an error message: whichever of tag/kind
// names it (both never resolve here - this only labels a failure).
function aggLabel(agg: Aggregate): string {
  return showTag(agg.tag ?? agg.kind ?? "?");
}

// Every entity self is colocated with (or within `sel.range` tiles of) that
// carries `sel.tag` and passes `sel.where`, in entity-insertion order. The
// candidate is the binding "self" while `where` is tested, so a predicate reads
// the *candidate's* stocks - that is what makes "another agent whose infection
// > 0" expressible. Backs the single-match selector (colocatedWith), and the
// `forEach` effect's fan-out.
function colocatedCandidates(
  world: KernelWorld,
  self: Entity,
  sel: ColocatedSel,
  args: Args,
): Entity[] {
  if (sel.tag === undefined && sel.kind === undefined)
    throw new Error(`colocated needs a "tag" or a "kind" to match`);
  let tag =
    sel.tag !== undefined ? tagName(sel.tag, world, self, args) : undefined;
  let kind =
    sel.kind !== undefined ? tagName(sel.kind, world, self, args) : undefined;
  let range = sel.range ?? 0;
  let excludeSelf = sel.other ?? true;
  return Object.values(world.entities).filter((e) => {
    if (excludeSelf && e === self) return false;
    if (!e.pos || !self.pos) return false;
    let dx = Math.abs(e.pos.x - self.pos.x);
    let dy = Math.abs(e.pos.y - self.pos.y);
    if (Math.max(dx, dy) > range) return false;
    if (tag !== undefined && !hasTag(e, tag)) return false;
    if (kind !== undefined && e.kind !== kind) return false;
    if (sel.where && !evalCond(sel.where, world, e, args)) return false;
    return true;
  });
}

// The positional targets an action's `requires` gate wants the actor to reach:
// the tags named by its `colocated` conditions and the terrain kinds named by
// its `nearTerrain` conditions, resolved against the acting self. Implicit
// approach reads these to decide what to walk to when an action fails only
// because the actor stands too far from its target. Walks the whole condition
// tree (all/any/not) and dedupes; a ref it can't resolve is skipped rather than
// throwing, since this only feeds a best-effort convenience.
export interface ApproachTargets {
  tags: string[];
  terrains: string[];
}

export function approachTargets(
  cond: Cond | undefined,
  world: KernelWorld,
  self: Entity,
  args: Args,
): ApproachTargets {
  let tags = new Set<string>();
  let terrains = new Set<string>();
  let addTag = (ref: TagRef) => {
    try {
      tags.add(tagName(ref, world, self, args));
    } catch {
      // an unresolvable {nameOf}/{arg} just contributes no approach target
    }
  };
  // A kind name is walkable-to exactly like a tag: downstream matching is the
  // kind-or-tags union, so both funnel into the one tags set.
  let addSelNames = (sel: ColocatedSel) => {
    if (sel.tag !== undefined) addTag(sel.tag);
    if (sel.kind !== undefined) addTag(sel.kind);
  };
  let visit = (c: Cond | undefined) => {
    if (!c) return;
    if ("colocated" in c) addSelNames(c.colocated);
    else if ("nearTerrain" in c) {
      let type = c.nearTerrain.type;
      for (let t of Array.isArray(type) ? type : [type]) terrains.add(t);
    } else if (
      ("tag" in c || "kind" in c) &&
      c.of &&
      typeof c.of === "object" &&
      "colocated" in c.of
    )
      addSelNames(asColocatedSel(c.of.colocated));
    else if ("all" in c) c.all.forEach(visit);
    else if ("any" in c) c.any.forEach(visit);
    else if ("not" in c) visit(c.not);
  };
  visit(cond);
  return { tags: [...tags], terrains: [...terrains] };
}

// The one entity a colocated selector binds: the first candidate, or - with
// `pick` - the nearest / stock-extreme / seeded-random one. Backs both the
// `colocated` condition and the `{ colocated }` entity selector. Deterministic
// throughout: candidates come back in entity-insertion order, reductions keep
// the earlier candidate on ties (strict comparison), and `random` is an
// addressed noise draw - so a snapshot replays the same match.
function colocatedWith(
  world: KernelWorld,
  self: Entity,
  sel: ColocatedSel,
  args: Args,
): Entity | undefined {
  let candidates = colocatedCandidates(world, self, sel, args);
  let pick = sel.pick;
  if (candidates.length === 0 || !pick) return candidates[0];
  if (pick === "nearest") {
    let dist = (e: Entity) =>
      Math.max(
        Math.abs(e.pos!.x - self.pos!.x),
        Math.abs(e.pos!.y - self.pos!.y),
      );
    return candidates.reduce((best, e) => (dist(e) < dist(best) ? e : best));
  }
  if ("random" in pick) {
    // Namespaced under "pick" so a pick and a `rand` sharing salt keys still
    // draw from independent streams.
    let draw = noise(world, self, ["pick", ...pick.random]);
    return candidates[Math.floor(draw * candidates.length)];
  }
  let stockName = name("lowest" in pick ? pick.lowest : pick.highest, args);
  let value = (e: Entity) => {
    let s = e.stocks[stockName];
    if (!s) throw new Error(`entity "${e.id}" has no stock "${stockName}"`);
    return s.value;
  };
  return "lowest" in pick
    ? candidates.reduce((best, e) => (value(e) < value(best) ? e : best))
    : candidates.reduce((best, e) => (value(e) > value(best) ? e : best));
}

// Normalize the held-selector shorthand: a bare tag (`{held:"axe"}`), an
// arg-ref, or a nameOf-ref all mean "match this tag among what self holds";
// the object form is passed through unchanged. Mirrors asColocatedSel.
function asHeldSel(c: TagRef | HeldSel): HeldSel {
  return typeof c === "string" || "arg" in c || "nameOf" in c ? { tag: c } : c;
}

// Every entity `holder` is holding (heldBy === holder.id) that matches
// `sel.tag`/`sel.kind`/`sel.where`, in entity-insertion order - the
// containment analog of colocatedCandidates. A candidate is bound as "self"
// while `where` is tested, exactly like colocated's.
function heldCandidates(
  world: KernelWorld,
  holder: Entity,
  sel: HeldSel,
  args: Args,
): Entity[] {
  if (sel.tag === undefined && sel.kind === undefined)
    throw new Error(`held needs a "tag" or a "kind" to match`);
  let tag =
    sel.tag !== undefined ? tagName(sel.tag, world, holder, args) : undefined;
  let kind =
    sel.kind !== undefined ? tagName(sel.kind, world, holder, args) : undefined;
  return Object.values(world.entities).filter((e) => {
    if (e.heldBy !== holder.id) return false;
    if (tag !== undefined && !hasTag(e, tag)) return false;
    if (kind !== undefined && e.kind !== kind) return false;
    if (sel.where && !evalCond(sel.where, world, e, args)) return false;
    return true;
  });
}

function resolve(
  world: KernelWorld,
  self: Entity,
  sel?: EntitySel,
  args: Args = {},
): Entity {
  if (!sel || sel === "self") return self;
  if (sel === "world") return world.entities.world;
  if (typeof sel === "object") {
    if ("arg" in sel) {
      let targetId = String(args[sel.arg] ?? "");
      let targetEntity = world.entities[targetId];
      if (!targetEntity)
        throw new Error(`rule references unknown entity from arg "${sel.arg}"`);
      return targetEntity;
    }
    if ("held" in sel) {
      let hsel = asHeldSel(sel.held);
      let e = heldCandidates(world, self, hsel, args)[0];
      if (!e) {
        let wanted = [
          ...(hsel.tag !== undefined
            ? [`tagged "${tagName(hsel.tag, world, self, args)}"`]
            : []),
          ...(hsel.kind !== undefined
            ? [`of kind "${tagName(hsel.kind, world, self, args)}"`]
            : []),
        ].join(" ");
        throw new Error(`"${self.id}" is not holding anything ${wanted}`);
      }
      return e;
    }
    let csel = asColocatedSel(sel.colocated);
    let e = colocatedWith(world, self, csel, args);
    if (!e) {
      let wanted = [
        ...(csel.tag !== undefined
          ? [`tagged "${tagName(csel.tag, world, self, args)}"`]
          : []),
        ...(csel.kind !== undefined
          ? [`of kind "${tagName(csel.kind, world, self, args)}"`]
          : []),
      ].join(" ");
      throw new Error(`no colocated entity ${wanted} for "${self.id}"`);
    }
    return e;
  }
  let e = world.entities[sel];
  if (!e) throw new Error(`rule references unknown entity "${sel}"`);
  return e;
}

function name(ref: NameRef, args: Args): string {
  return typeof ref === "string" ? ref : String(args[ref.arg]);
}

// The placeholders a spawn id may carry. Deliberately tiny: these two are the
// only things that make a built thing unique - who built it, and when - and an
// id is a key, not prose, so the general template vocabulary has no business
// here.
const SPAWN_ID_PLACEHOLDERS = ["self", "tick"];

// Unrendered `{{...}}` placeholders in a spawn id, for the authoring-time
// check. Returns the unknown ones; an empty list means every placeholder in the
// string is one spawnId can render.
export function unknownSpawnIdPlaceholders(id: string): string[] {
  let bad: string[] = [];
  for (let m of id.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g))
    if (!SPAWN_ID_PLACEHOLDERS.includes(m[1]) && !bad.includes(m[1]))
      bad.push(m[1]);
  return bad;
}

// A spawn's id, with `{{self}}`/`{{tick}}` rendered. This is the one NameRef
// site that interpolates, and it exists because the alternative is silent
// corruption: `name()` hands back a string ref verbatim, so genesis run
// cc3d1956 spawned an entity literally called "shelter-{{self}}-{{tick}}".
// That made every structure a global singleton (the second build threw
// "already exists" after charging the builder), leaked raw braces into
// character-facing prose, and taught both characters to navigate to the broken
// name as if it were a landmark.
//
// The Oracle reaches for this syntax unprompted because `{{ ... }}` renders
// everywhere else in the system (descriptions, signs, refusal text), so the
// fix is to make the reflex work rather than to train it away. An unknown
// placeholder still throws - a typo'd `{{owner}}` would otherwise bake itself
// into a key that nothing can address.
function spawnId(
  ref: NameRef,
  world: KernelWorld,
  self: Entity,
  args: Args,
): string {
  let raw = name(ref, args);
  if (!raw.includes("{{")) return raw;
  let unknown = unknownSpawnIdPlaceholders(raw);
  if (unknown.length)
    throw new Error(
      `spawn: id "${raw}" uses unknown placeholder${unknown.length === 1 ? "" : "s"} ${unknown.map((u) => `{{${u}}}`).join(", ")} - only ${SPAWN_ID_PLACEHOLDERS.map((p) => `{{${p}}}`).join(" and ")} render in an id. Omit \`id\` entirely for an auto-numbered one.`,
    );
  return raw.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, key: string) =>
    key === "self" ? self.id : String(world.tick),
  );
}

// One axis of an entity's tile, for the posX/posY expressions. A positionless
// entity (the world singleton, an item never placed) has no coordinate to read,
// so - like reading a stock it never held - this throws rather than inventing a
// zero that would quietly seed spawns at the origin.
function posComponent(
  world: KernelWorld,
  self: Entity,
  sel: EntitySel,
  args: Args,
  axis: "x" | "y",
): number {
  let e = resolve(world, self, sel, args);
  if (!e.pos) throw new Error(`entity "${e.id}" has no position`);
  return e.pos[axis];
}

function readStock(
  world: KernelWorld,
  self: Entity,
  stockName: string,
  of?: EntitySel,
  args: Args = {},
) {
  let e = resolve(world, self, of, args);
  let s = e.stocks[stockName];
  if (!s) throw new Error(`entity "${e.id}" has no stock "${stockName}"`);
  return s.value;
}

// The room left before a stock hits its ceiling. Like readStock, the source must
// exist - asking the headroom of a stock an entity never held is a real error,
// not zero room.
function readHeadroom(
  world: KernelWorld,
  self: Entity,
  stockName: string,
  of?: EntitySel,
  args: Args = {},
  maxIfMissing?: number,
) {
  let e = resolve(world, self, of, args);
  let s = e.stocks[stockName];
  if (!s && maxIfMissing !== undefined) return maxIfMissing;
  if (!s) throw new Error(`entity "${e.id}" has no stock "${stockName}"`);
  return s.max - s.value;
}

// The entities a reduction folds over: those carrying `tag` that also pass
// `where` (evaluated with the candidate as "self", so a filter can read the
// candidate's own stocks/tags), bounded to `near` tiles of the evaluating self
// when set. Shared by count/sum/avg/max_of/min_of.
function aggregateMatches(
  agg: Aggregate,
  world: KernelWorld,
  self: Entity,
  args: Args,
): Entity[] {
  if (agg.tag === undefined && agg.kind === undefined)
    throw new Error(`aggregate needs a "tag" or a "kind" for its domain`);
  if (agg.near !== undefined && !self.pos)
    throw new Error(
      `aggregate over "${aggLabel(agg)}" uses "near" but "${self.id}" has no position`,
    );
  let tag =
    agg.tag !== undefined ? tagName(agg.tag, world, self, args) : undefined;
  let kind =
    agg.kind !== undefined ? tagName(agg.kind, world, self, args) : undefined;
  return Object.values(world.entities).filter((e) => {
    if (tag !== undefined && !hasTag(e, tag)) return false;
    if (kind !== undefined && e.kind !== kind) return false;
    if (agg.other && e === self) return false;
    if (agg.near !== undefined) {
      if (!e.pos) return false;
      let dx = Math.abs(e.pos.x - self.pos!.x);
      let dy = Math.abs(e.pos.y - self.pos!.y);
      if (Math.max(dx, dy) > agg.near) return false;
    }
    return !agg.where || evalCond(agg.where, world, e, args);
  });
}

// The stock values a reduction folds. Reading a stock that isn't there is a
// real authoring error (as elsewhere), so a missing stock throws rather than
// silently counting as zero.
function aggregateValues(
  agg: Aggregate,
  world: KernelWorld,
  self: Entity,
  args: Args,
): number[] {
  if (!agg.stock)
    throw new Error(
      `aggregate over "${aggLabel(agg)}" needs a "stock" to reduce`,
    );
  let stockName = name(agg.stock, args);
  return aggregateMatches(agg, world, self, args).map((e) => {
    let s = e.stocks[stockName];
    if (!s) throw new Error(`entity "${e.id}" has no stock "${stockName}"`);
    return s.value;
  });
}

// Terrain is the host's spatial grid, not part of the kernel's entity model, so
// it can't ride on KernelWorld (which must stay structured-clone-able for
// snapshots - a function would throw). Instead the host installs a lookup for
// the duration of one synchronous kernel call (evaluation never yields, so a
// module-scoped slot is safe and re-entrant set/restore handles nesting).
export type TerrainLookup = (x: number, y: number) => string | undefined;

let terrainLookup: TerrainLookup | undefined;

// The set of stock names the ruleset marks stockpilable. Unlike terrain, which
// varies per position within a single call, this is a global property of the
// ruleset that only changes when the GM edits stock defaults - so the host
// installs it once (see the engine's syncStockpilable) rather than threading it
// through every commit signature. Evaluation is synchronous, so a module slot is
// safe. The `stockpilable` condition reads it.
let stockpilableStocks: ReadonlySet<string> = new Set();

export function setStockpilable(names: Iterable<string>): void {
  stockpilableStocks = new Set(names);
}

// The set of stock names a legitimate path has introduced somewhere in this
// ruleset (a scenario/agent template default, a GM's set_stock_default, a
// spawn spec's declared stocks, ...). This is what closes the stock
// namespace: a rule effect may only *write* a name already known here, so a
// typo'd target ("self" meant "of":"self") errors at the point it would
// otherwise have minted a phantom stock, instead of silently doing so. Kept
// separate from stockpilableStocks (a much narrower "may be hauled" flag) -
// this is the full vocabulary, that is a subset of it that opts into hauling.
// Undefined (the default, and every bare-kernel caller that never installs
// one) means "no registry configured" - lenient, today's auto-vivify
// behavior - so a host-less test world isn't forced to declare every stock
// up front. The engine always installs one (see syncKnownStocks).
let knownStocks: ReadonlySet<string> | undefined;

export function setKnownStocks(names: Iterable<string> | undefined): void {
  knownStocks = names ? new Set(names) : undefined;
}

function withTerrain<T>(terrain: TerrainLookup | undefined, fn: () => T): T {
  let prev = terrainLookup;
  terrainLookup = terrain;
  try {
    return fn();
  } finally {
    terrainLookup = prev;
  }
}

// Whether an entity may stand on a tile - the host's passability oracle (on-map
// and not blocked terrain). Installed for the same synchronous span as the
// terrain lookup. Only `moveToward` consults it, so a chaser routes around walls
// instead of phasing through them; `move` (relative drift) and `moveTo`
// (teleport) deliberately ignore it, so a roaming hazard can cross water a
// character can't. Absent, `moveToward` falls back to its on-map-only guard.
export type PassableLookup = (x: number, y: number) => boolean;

let passableLookup: PassableLookup | undefined;

function withPassable<T>(passable: PassableLookup | undefined, fn: () => T): T {
  let prev = passableLookup;
  passableLookup = passable;
  try {
    return fn();
  } finally {
    passableLookup = prev;
  }
}

// The write counterpart to TerrainLookup: the host installs it for a kernel call
// so the `setTerrain` effect can rewrite a tile. The kernel stays ignorant of
// what a terrain change entails - the host's writer owns passability, route
// invalidation, and the map revision. Installed for the same synchronous span as
// the lookup (see withTerrain); absent, `setTerrain` throws rather than silently
// no-op, so a misconfigured host surfaces instead of swallowing the change.
export type TerrainWriter = (x: number, y: number, terrain: string) => void;

let terrainWriter: TerrainWriter | undefined;

function withTerrainWriter<T>(
  writer: TerrainWriter | undefined,
  fn: () => T,
): T {
  let prev = terrainWriter;
  terrainWriter = writer;
  try {
    return fn();
  } finally {
    terrainWriter = prev;
  }
}

// The host hook behind the `reveal` effect: light radius `radius` around
// (x, y) in agent `to`'s map knowledge. The kernel stays ignorant of fog -
// what revelation means (per-agent fog writes, dashboard revisions) is the
// host's business. Installed per kernel call like the terrain hooks; absent,
// `reveal` throws so a misconfigured host surfaces instead of swallowing it.
export type Revealer = (
  to: string,
  x: number,
  y: number,
  radius: number,
) => void;

let revealer: Revealer | undefined;

function withRevealer<T>(hook: Revealer | undefined, fn: () => T): T {
  let prev = revealer;
  revealer = hook;
  try {
    return fn();
  } finally {
    revealer = prev;
  }
}

// --- Seeded noise: randomness without nondeterminism --------------------
//
// The kernel is the substrate for deterministic save/restore: a snapshot must
// replay tick-for-tick. A conventional sequential PRNG would defeat that - its
// cursor would have to live on KernelWorld and advance in perfect lockstep with
// every branch of evaluation, and a single reordered rule would desync the
// stream. So randomness here is a pure *hash* of coordinates the world already
// carries (seed, tick, the bound entity's id, author salt keys) rather than a
// running sequence. White noise, addressable instead of sequential: the same
// world at the same tick always yields the same draw, so a raid that fired on
// tick 412 fires again on replay; distinct keys give independent streams.

// cyrb53: a small, well-distributed string hash. Its 53-bit output maps cleanly
// into a JS double's integer range, so dividing by 2^53 gives a uniform [0,1)
// without pulling in a PRNG dependency. (Public-domain hash by bryc.)
function cyrb53(str: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    let ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

// A reproducible pseudo-random draw in [0,1), addressed by the world seed, the
// current tick, the bound entity, and the author's salt keys. JSON.stringify
// gives an unambiguous address (quoted, comma-delimited) so "a"+"bc" can't
// collide with "ab"+"c".
function noise(world: KernelWorld, self: Entity, keys: NoiseKey[]): number {
  let addr = JSON.stringify([world.seed ?? 0, world.tick, self.id, ...keys]);
  return cyrb53(addr) / 9007199254740992; // 2^53
}

function evalExpr(
  expr: Expr,
  world: KernelWorld,
  self: Entity,
  args: Args,
): number {
  if (typeof expr === "number") return expr;
  if ("stock" in expr)
    return readStock(world, self, name(expr.stock, args), expr.of, args);
  if ("headroom" in expr)
    return readHeadroom(
      world,
      self,
      name(expr.headroom, args),
      expr.of,
      args,
      expr.maxIfMissing,
    );
  if ("tick" in expr) return world.tick;
  if ("arg" in expr) return Number(args[expr.arg]);
  if ("posX" in expr) return posComponent(world, self, expr.posX, args, "x");
  if ("posY" in expr) return posComponent(world, self, expr.posY, args, "y");
  if ("lookup" in expr)
    return expr.lookup.table[String(args[expr.lookup.on])] ?? 0;
  if ("add" in expr)
    return expr.add.reduce(
      (sum: number, e) => sum + evalExpr(e, world, self, args),
      0,
    );
  if ("sub" in expr) {
    if (expr.sub.length === 0)
      throw new Error("sub needs at least one operand");
    return expr.sub
      .map((e) => evalExpr(e, world, self, args))
      .reduce((a, b) => a - b);
  }
  if ("mul" in expr)
    return expr.mul.reduce(
      (prod: number, e) => prod * evalExpr(e, world, self, args),
      1,
    );
  if ("min" in expr)
    return Math.min(...expr.min.map((e) => evalExpr(e, world, self, args)));
  if ("max" in expr)
    return Math.max(...expr.max.map((e) => evalExpr(e, world, self, args)));
  if ("floor" in expr)
    return Math.floor(evalExpr(expr.floor, world, self, args));
  if ("ceil" in expr) return Math.ceil(evalExpr(expr.ceil, world, self, args));
  if ("round" in expr)
    return Math.round(evalExpr(expr.round, world, self, args));
  if ("abs" in expr) return Math.abs(evalExpr(expr.abs, world, self, args));
  if ("sqrt" in expr) return Math.sqrt(evalExpr(expr.sqrt, world, self, args));
  if ("sign" in expr) return Math.sign(evalExpr(expr.sign, world, self, args));
  if ("div" in expr)
    return (
      evalExpr(expr.div[0], world, self, args) /
      evalExpr(expr.div[1], world, self, args)
    );
  if ("mod" in expr)
    return (
      evalExpr(expr.mod[0], world, self, args) %
      evalExpr(expr.mod[1], world, self, args)
    );
  if ("pow" in expr)
    return Math.pow(
      evalExpr(expr.pow[0], world, self, args),
      evalExpr(expr.pow[1], world, self, args),
    );
  if ("clamp" in expr)
    return clamp(
      evalExpr(expr.clamp[0], world, self, args),
      evalExpr(expr.clamp[1], world, self, args),
      evalExpr(expr.clamp[2], world, self, args),
    );
  if ("noise" in expr) return noise(world, self, expr.noise);
  if ("rand" in expr) {
    let [lo, hi, ...keys] = expr.rand;
    let a = evalExpr(lo, world, self, args);
    let b = evalExpr(hi, world, self, args);
    // Namespaced under "rand" so a `rand` and a `noise` sharing the same salt
    // still draw from independent streams.
    return a + (b - a) * noise(world, self, ["rand", ...keys]);
  }
  if ("if" in expr)
    return evalCond(expr.if[0], world, self, args)
      ? evalExpr(expr.if[1], world, self, args)
      : evalExpr(expr.if[2], world, self, args);
  if ("count" in expr)
    return aggregateMatches(expr.count, world, self, args).length;
  if ("sum" in expr)
    return aggregateValues(expr.sum, world, self, args).reduce(
      (a, b) => a + b,
      0,
    );
  if ("avg" in expr) {
    let xs = aggregateValues(expr.avg, world, self, args);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  }
  if ("max_of" in expr) {
    let xs = aggregateValues(expr.max_of, world, self, args);
    return xs.length ? Math.max(...xs) : 0;
  }
  if ("min_of" in expr) {
    let xs = aggregateValues(expr.min_of, world, self, args);
    return xs.length ? Math.min(...xs) : 0;
  }
  throw new Error(`malformed expression: ${JSON.stringify(expr)}`);
}

function evalCond(
  cond: Cond,
  world: KernelWorld,
  self: Entity,
  args: Args,
): boolean {
  if ("cmp" in cond) {
    let l = evalExpr(cond.left, world, self, args);
    let r = evalExpr(cond.right, world, self, args);
    switch (cond.cmp) {
      case "gte":
        return l >= r;
      case "gt":
        return l > r;
      case "lte":
        return l <= r;
      case "lt":
        return l < r;
      case "eq":
        return l === r;
    }
  }
  if ("tag" in cond)
    return hasTag(
      resolve(world, self, cond.of, args),
      tagName(cond.tag, world, self, args),
    );
  if ("kind" in cond)
    return (
      resolve(world, self, cond.of, args).kind ===
      tagName(cond.kind, world, self, args)
    );
  if ("colocated" in cond)
    return colocatedWith(world, self, cond.colocated, args) !== undefined;
  if ("holds" in cond) {
    let holder = resolve(world, self, cond.of, args);
    return (
      heldCandidates(world, holder, asHeldSel(cond.holds), args).length > 0
    );
  }
  if ("nearTerrain" in cond) {
    if (!self.pos) return false;
    if (!terrainLookup)
      throw new Error(
        `nearTerrain condition needs a terrain lookup, but none was installed for this call`,
      );
    let types =
      typeof cond.nearTerrain.type === "string"
        ? [cond.nearTerrain.type]
        : cond.nearTerrain.type;
    let range = cond.nearTerrain.range ?? 0;
    for (let dy = -range; dy <= range; dy++)
      for (let dx = -range; dx <= range; dx++) {
        let t = terrainLookup(self.pos.x + dx, self.pos.y + dy);
        if (t !== undefined && types.includes(t)) return true;
      }
    return false;
  }
  if ("atMapEdge" in cond) {
    if (!self.pos) return false;
    if (!terrainLookup)
      throw new Error(
        `atMapEdge condition needs a terrain lookup, but none was installed for this call`,
      );
    let offsets: Record<MapEdge, { dx: number; dy: number }> = {
      north: { dx: 0, dy: -1 },
      east: { dx: 1, dy: 0 },
      south: { dx: 0, dy: 1 },
      west: { dx: -1, dy: 0 },
    };
    let offset = offsets[cond.atMapEdge.edge];
    return (
      terrainLookup(self.pos.x + offset.dx, self.pos.y + offset.dy) ===
      undefined
    );
  }
  if ("canSeeMapEdge" in cond) {
    if (!self.pos) return false;
    if (!terrainLookup)
      throw new Error(
        `canSeeMapEdge condition needs a terrain lookup, but none was installed for this call`,
      );
    let offsets: Record<MapEdge, { dx: number; dy: number }> = {
      north: { dx: 0, dy: -1 },
      east: { dx: 1, dy: 0 },
      south: { dx: 0, dy: 1 },
      west: { dx: -1, dy: 0 },
    };
    let offset = offsets[cond.canSeeMapEdge.edge];
    let within = cond.canSeeMapEdge.within;
    return (
      terrainLookup(
        self.pos.x + offset.dx * within,
        self.pos.y + offset.dy * within,
      ) === undefined
    );
  }
  if ("stockpilable" in cond)
    return stockpilableStocks.has(name(cond.stockpilable, args));
  if ("stockpileAccepts" in cond) {
    let stockName = name(cond.stockpileAccepts, args);
    let entity = resolve(world, self, cond.of, args);
    return [...stockpilableStocks].every(
      (candidate) =>
        candidate === stockName || !entity.stocks[candidate]?.value,
    );
  }
  if ("all" in cond)
    return cond.all.every((c) => evalCond(c, world, self, args));
  if ("any" in cond)
    return cond.any.some((c) => evalCond(c, world, self, args));
  if ("not" in cond) return !evalCond(cond.not, world, self, args);
  throw new Error(`malformed condition: ${JSON.stringify(cond)}`);
}

// Fold every active modifier registered on a channel into a base amount, in
// declaration order: scales multiply, adds offset.
function applyChannel(
  base: number,
  channel: string | undefined,
  modifiers: Modifier[],
  world: KernelWorld,
): number {
  if (!channel) return base;
  let v = base;
  for (let m of modifiers) {
    if (m.channel !== channel) continue;
    if (m.when && !evalCond(m.when, world, world.entities.world, {})) continue;
    let mv = evalExpr(m.value, world, world.entities.world, {});
    v = m.op === "scale" ? v * mv : v + mv;
  }
  return v;
}

// --- The delta buffer (continuous phases) -------------------------------
//
// Adjusts accumulate (additively) so several rules touching the same stock in
// one phase compose; a `set` overrides. Clamping happens once, on commit.
class DeltaBuffer {
  private adds = new Map<Entity, Map<string, number>>();
  private sets = new Map<
    Entity,
    Map<string, { value: number; conflict: SetConflict }>
  >();

  add(entity: Entity, stock: string, delta: number) {
    let m = this.adds.get(entity) ?? new Map();
    m.set(stock, (m.get(stock) ?? 0) + delta);
    this.adds.set(entity, m);
  }

  // `conflict` resolves a second (or later) set on the same (entity, stock)
  // within this buffer this phase: "override" (default) always takes the new
  // value, reproducing the historical "last set in evaluation order wins"
  // behavior exactly when nothing opts into anything else; "highest"/
  // "lowest" instead keep the more extreme of the new value and whatever is
  // already buffered, regardless of which one ran first - so those cooperate
  // with each other, but any "override" set that runs still clobbers them
  // outright (it means "my value wins unconditionally if I fire").
  set(
    entity: Entity,
    stock: string,
    value: number,
    conflict: SetConflict = "override",
  ) {
    let m = this.sets.get(entity) ?? new Map();
    let existing = m.get(stock);
    let resolved =
      !existing || conflict === "override"
        ? value
        : conflict === "highest"
          ? Math.max(existing.value, value)
          : Math.min(existing.value, value);
    m.set(stock, { value: resolved, conflict });
    this.sets.set(entity, m);
  }

  // Fold another buffer's deltas into this one. Used by fault isolation: each
  // (rule, entity) pair buffers into a scratch buffer first, so a throw partway
  // through its effects discards only that pair's half-applied deltas instead of
  // poisoning the shared phase buffer. All reads in a phase hit the pre-commit
  // world, so accumulation order doesn't change the result.
  merge(other: DeltaBuffer) {
    for (let [entity, m] of other.adds)
      for (let [stock, delta] of m) this.add(entity, stock, delta);
    for (let [entity, m] of other.sets)
      for (let [stock, { value, conflict }] of m)
        this.set(entity, stock, value, conflict);
  }

  commit() {
    for (let [entity, m] of this.adds)
      for (let [stock, delta] of m)
        writeStock(entity, stock, entity.stocks[stock].value + delta);
    for (let [entity, m] of this.sets)
      for (let [stock, { value }] of m) writeStock(entity, stock, value);
  }
}

function writeStock(entity: Entity, stockName: string, value: number) {
  let s = entity.stocks[stockName];
  if (!s) throw new Error(`entity "${entity.id}" has no stock "${stockName}"`);
  s.value = clamp(value, s.min, s.max);
}

// A practically-unbounded ceiling for a stock that holds a count rather than a
// gauge - item piles, stockpiles. Kept finite (not Infinity) so a stock still
// round-trips cleanly through JSON.
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

// Ensure a *transfer destination* stock exists before we add to it, so a
// character can receive an item type its template never declared (pick up
// berries it has never held) and a freshly spawned crate can be filled. Gated
// on the known-stocks registry (see setKnownStocks) when one is installed: a
// transfer may only mint a destination for a name the ruleset actually
// declared somewhere, so "gather clay" doesn't quietly invent a resource
// nobody registered - it throws instead, the same as any other unknown-stock
// write. `adjust`/`set` never call this: an increment/assignment names an
// exact target the rule author chose, so a typo there (`target:"self"`) is
// exactly the phantom-stock bug this registry exists to catch, and
// requireStock below rejects it. Reads and the source side of a transfer
// still throw on a missing stock regardless of the registry, because taking
// what isn't there is a real error, not an empty pocket.
function ensureStock(entity: Entity, stockName: string, max = UNBOUNDED): void {
  if (entity.stocks[stockName]) return;
  if (knownStocks && !knownStocks.has(stockName))
    throw new Error(
      `transfer: "${stockName}" is not a known resource - declare it (set_stock_default, a spawn's stocks) before rules can mint it`,
    );
  entity.stocks[stockName] = stock(0, 0, max);
}

// The write-side counterpart to readStock: a stock effect (adjust, set, or a
// transfer's source) may only touch a stock the target entity already
// carries. Unlike ensureStock this never vivifies - an increment or
// assignment names an exact, chosen target, so a name that isn't there is an
// authoring error (most often an entity id typo'd into a stock name, as
// "self" once was) and should surface exactly like reading a missing stock
// does, not mint a new one silently.
function requireStock(entity: Entity, stockName: string): void {
  if (!entity.stocks[stockName])
    throw new Error(`entity "${entity.id}" has no stock "${stockName}"`);
}

// Instantiate a spawn's declared stocks. Mirrors the host's template
// instantiation but lives here so the kernel can spawn without reaching into the
// scenario layer; an unset max is UNBOUNDED rather than the gauge default of 100.
function instantiateStocks(
  specs: NonNullable<SpawnSpec["stocks"]>,
): Record<string, Stock> {
  let out: Record<string, Stock> = {};
  for (let [n, s] of Object.entries(specs))
    out[n] = stock(s.value, s.min ?? 0, s.max ?? UNBOUNDED);
  return out;
}

// Distinguish the literal-coordinate form of a spawn anchor from an entity
// selector: only the coordinate form carries an `x`.
function spawnAtCoords(at: SpawnSpec["at"]): at is { x: Expr; y: Expr } {
  return at !== undefined && typeof at === "object" && "x" in at;
}

// Mint a collision-free id "<prefix>-<n>" by scanning upward for the first free
// suffix. Deterministic given the current entity set (no clock, no randomness),
// so a snapshot replays identically.
export function freshId(world: KernelWorld, prefix: string): string {
  for (let n = 1; ; n += 1) {
    let id = `${prefix}-${n}`;
    if (!world.entities[id]) return id;
  }
}

// A structural effect restructures the world (flips tags, clears an action,
// spawns or destroys an entity) rather than nudging a number. Such effects only
// make sense in an immediate phase (action/event/transition); a buffered phase batches
// numeric deltas and has nowhere to put a structural change. A forEach is as
// structural as the worst effect it wraps.
function isStructuralEffect(effect: Effect): boolean {
  if ("forEach" in effect) return effect.forEach.do.some(isStructuralEffect);
  return (
    "tag" in effect ||
    "kind" in effect ||
    "clearAction" in effect ||
    "spawn" in effect ||
    "destroy" in effect ||
    "take" in effect ||
    "release" in effect ||
    "move" in effect ||
    "moveToward" in effect ||
    "moveTo" in effect ||
    "regenerate" in effect ||
    "growWorld" in effect ||
    "setTerrain" in effect ||
    "reveal" in effect
  );
}

// Reject a rule whose effects can't run in its phase *before* it enters the live
// set, so a GM gets an immediate, explanatory error instead of a paused clock
// when bufferEffect later trips over the same rule mid-tick. Only `threshold`
// carries a free-form `do` into a buffered phase; flow rules can't express a
// structural effect by type, and action/event/transition phases apply immediately.
let RULE_PHASES = [
  "derived",
  "event",
  "flow",
  "threshold",
  "watch",
  "transition",
];
let RULE_KINDS = ["action", "modifier"];
let SET_CONFLICTS = ["override", "highest", "lowest"];

export function validateRule(rule: Rule): void {
  if (!rule || typeof rule !== "object") return;
  // A rule is dispatched by exactly one of `phase` or `kind`; an unrecognized
  // (or typo'd) value is silently ignored by every phase runner, so the rule
  // never fires - or worse, a misclassified body throws mid-tick and pauses the
  // shared clock. Reject it at add time with an explanatory error instead.
  let phase = (rule as { phase?: unknown }).phase;
  let kind = (rule as { kind?: unknown }).kind;
  if (phase === undefined && kind === undefined)
    throw new Error(
      `rule "${rule.id}" needs a "phase" (${RULE_PHASES.join("|")}) or a "kind" (${RULE_KINDS.join("|")})`,
    );
  if (phase !== undefined && !RULE_PHASES.includes(phase as string))
    throw new Error(
      `rule "${rule.id}" has unknown phase "${String(phase)}" — expected one of ${RULE_PHASES.join("|")}`,
    );
  if (kind !== undefined && !RULE_KINDS.includes(kind as string))
    throw new Error(
      `rule "${rule.id}" has unknown kind "${String(kind)}" — expected ${RULE_KINDS.join(" or ")}`,
    );

  // An each with neither tag nor kind would silently bind nothing - reject it
  // at add time like every other silent-no-op shape.
  let each = (rule as { each?: unknown }).each;
  if (each !== undefined) {
    let sel = each as { tag?: unknown; kind?: unknown };
    if (typeof sel?.tag !== "string" && typeof sel?.kind !== "string")
      throw new Error(
        `rule "${rule.id}": "each" needs a "tag" or a "kind" (plain string)`,
      );
  }

  // Pacing fields are additive metadata a phase runner reads directly, with no
  // shape check of its own - so a bad value would be a silent no-op (or a
  // NaN-poisoned noise draw) at tick time rather than a caught authoring
  // error. Validate them here instead, the same philosophy as the
  // structural-effect-in-threshold check below.
  let priority = (rule as { priority?: unknown }).priority;
  if (
    priority !== undefined &&
    (typeof priority !== "number" || !Number.isFinite(priority))
  )
    throw new Error(`rule "${rule.id}": "priority" must be a finite number`);
  // An actor holds at most one action at a time, matched 1:1 to its rule by
  // committed intent type - there is no run-order ambiguity for priority to
  // resolve, so a declared one would be a silent no-op. Reject it loudly.
  if (priority !== undefined && (rule as { kind?: unknown }).kind === "action")
    throw new Error(
      `rule "${rule.id}": "priority" does not apply to an action rule - actions are picked by the actor, not run in order`,
    );

  let chance = (rule as { chance?: unknown }).chance;
  if (chance !== undefined) {
    if (phase === undefined || phase === "derived")
      throw new Error(
        `rule "${rule.id}": "chance" only applies to a flow/threshold/watch/transition/event rule` +
          (phase === "derived"
            ? ` - a "derived" rule must recompute every tick`
            : ""),
      );
    if (typeof chance !== "number" || !(chance >= 0 && chance <= 1))
      throw new Error(
        `rule "${rule.id}": "chance" must be a number between 0 and 1`,
      );
  }

  let cooldown = (rule as { cooldown?: unknown }).cooldown;
  if (cooldown !== undefined) {
    if (phase === undefined || phase === "derived")
      throw new Error(
        `rule "${rule.id}": "cooldown" only applies to a flow/threshold/watch/transition/event rule` +
          (phase === "derived"
            ? ` - a "derived" rule must recompute every tick`
            : ""),
      );
    if (
      typeof cooldown !== "number" ||
      !Number.isFinite(cooldown) ||
      cooldown < 0
    )
      throw new Error(
        `rule "${rule.id}": "cooldown" must be a non-negative number of ticks`,
      );
  }

  let conflict = (rule as { conflict?: unknown }).conflict;
  if (conflict !== undefined) {
    if (phase !== "threshold")
      throw new Error(
        `rule "${rule.id}": "conflict" only applies to a "threshold" rule's buffered set effects`,
      );
    if (!SET_CONFLICTS.includes(conflict as string))
      throw new Error(
        `rule "${rule.id}" has unknown conflict policy "${String(conflict)}" — expected one of ${SET_CONFLICTS.join("|")}`,
      );
  }

  if (phase !== "threshold") return;
  let effects = (rule as ThresholdRule).do;
  if (!Array.isArray(effects)) return;
  for (let eff of effects)
    if (isStructuralEffect(eff))
      throw new Error(
        `rule "${rule.id}": structural effects (tag/clearAction/spawn/destroy/take/release/move/moveToward/moveTo/regenerate/growWorld/setTerrain/reveal) cannot run in a buffered "threshold" phase — use phase "transition" instead`,
      );
}

// Buffered application - for the continuous flow/threshold phases. `conflict`
// is the owning rule's set-conflict policy (only a threshold rule ever
// carries one); it rides along through a forEach fan-out so every inner `set`
// resolves by the same policy as the rule that authored it.
function bufferEffect(
  effect: Effect,
  world: KernelWorld,
  self: Entity,
  args: Args,
  modifiers: Modifier[],
  buffer: DeltaBuffer,
  conflict?: SetConflict,
) {
  if ("forEach" in effect) {
    let sel = asColocatedSel(effect.forEach.colocated);
    // Matches are read from the pre-delta state, like every other read in a
    // buffered phase; the inner effects land in the same buffer as the rest.
    for (let match of colocatedCandidates(world, self, sel, args))
      for (let eff of effect.forEach.do)
        bufferEffect(eff, world, match, args, modifiers, buffer, conflict);
    return;
  }
  let numeric = applyNumericEffect(effect, world, self, args, modifiers, {
    add: (entity, stockName, amount) => {
      buffer.add(entity, stockName, amount);
      return amount;
    },
    set: (entity, stockName, value) => {
      buffer.set(entity, stockName, value, conflict);
      return value;
    },
  });
  if (numeric !== null) return;
  if (isStructuralEffect(effect))
    throw new Error(
      "structural effects (tag/clearAction/spawn/destroy/take/release/move/moveToward/moveTo/regenerate/growWorld/setTerrain/reveal) belong to an action, event, or transition phase, not a buffered one",
    );
}

interface NumericEffectWriter {
  add(entity: Entity, stockName: string, amount: number): number;
  set(entity: Entity, stockName: string, value: number): number;
}

function applyNumericEffect(
  effect: Effect,
  world: KernelWorld,
  self: Entity,
  args: Args,
  modifiers: Modifier[],
  writer: NumericEffectWriter,
  captures?: Record<string, string>,
): number | null {
  if ("adjust" in effect) {
    let { target, of, by, channel, as } = effect.adjust;
    let entity = resolve(world, self, of, args);
    if (as && captures) captures[as] = entity.id;
    let stockName = name(target, args);
    let amount = applyChannel(
      evalExpr(by, world, self, args),
      channel,
      modifiers,
      world,
    );
    requireStock(entity, stockName);
    writer.add(entity, stockName, amount);
    return 0;
  }
  if ("set" in effect) {
    let { target, of, to } = effect.set;
    let entity = resolve(world, self, of, args);
    let stockName = name(target, args);
    requireStock(entity, stockName);
    writer.set(entity, stockName, evalExpr(to, world, self, args));
    return 0;
  }
  if (!("transfer" in effect)) return null;

  let { from, to, amount } = effect.transfer;
  let quantity = evalExpr(amount, world, self, args);
  let source = resolve(world, self, from.of, args);
  let destination = resolve(world, self, to.of, args);
  if (from.as && captures) captures[from.as] = source.id;
  if (to.as && captures) captures[to.as] = destination.id;
  let sourceName = name(from.stock, args);
  let destinationName = name(to.stock, args);
  requireStock(source, sourceName);
  ensureStock(destination, destinationName, to.maxIfMissing);
  writer.add(source, sourceName, -quantity);
  return writer.add(destination, destinationName, quantity);
}

// Drop a held item back onto the grid: clears heldBy and gives it the
// vacating tile with occupancy:"tile", so it becomes a visible, reachable
// token again (see space.ts syncTokens). When there is no tile to land on
// (a positionless holder was destroyed), the item stays positionless too
// rather than inventing a coordinate - it simply becomes an ownerless,
// off-grid entity, matchable only through its own `held`/`holds` (which will
// no longer find it, since nothing holds it) or a direct id reference.
// Every entity a holder is carrying, in a stable order (by id) - the plain
// containment scan behind a character's inventory view, drop's candidate
// list, and the drop-everything-on-death sweep. Sorted rather than left in
// entity order so every reader agrees and a snapshot replays identically.
export function heldBy(world: KernelWorld, holderId: string): Entity[] {
  return Object.values(world.entities)
    .filter((e) => e.heldBy === holderId)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function releaseHeld(item: Entity, at?: { x: number; y: number }): void {
  delete item.heldBy;
  if (at) {
    item.pos = { ...at };
    item.occupancy = "tile";
  } else {
    item.pos = undefined;
    delete item.occupancy;
  }
}

// Immediate application - for discrete action completions, which resolve one
// after another (each sees the running stockpile), like the old engine. Returns
// the quantity a `transfer` actually moved into its destination (0 for every
// other effect), so the caller can report the real amount in the action's event
// - the gather yield is `min(rate, what's left)`, not the nominal rate.
function applyEffectNow(
  effect: Effect,
  world: KernelWorld,
  self: Entity,
  args: Args,
  modifiers: Modifier[],
  captures?: Record<string, string>,
): number {
  if ("forEach" in effect) {
    // The candidate list is fixed before any inner effect runs, so an inner
    // destroy/spawn can't skip or double-visit a match mid-fan-out.
    let sel = asColocatedSel(effect.forEach.colocated);
    let total = 0;
    for (let match of colocatedCandidates(world, self, sel, args))
      for (let eff of effect.forEach.do)
        total += applyEffectNow(eff, world, match, args, modifiers, captures);
    return total;
  }
  if ("tag" in effect) {
    let e = resolve(world, self, effect.tag.of, args);
    if (effect.tag.remove) {
      let removed = tagName(effect.tag.remove, world, self, args);
      // An entity's kind is not a removable tag - identity changes go through
      // the `kind` effect. Throw rather than silently keep matching.
      if (removed === e.kind)
        throw new Error(
          `tag: "${removed}" is ${e.id}'s kind, not a tag - change it with the kind effect`,
        );
      e.tags = e.tags.filter((t) => t !== removed);
    }
    if (effect.tag.add) {
      let added = tagName(effect.tag.add, world, self, args);
      // These three used to BE the occupancy model. They are inert strings now,
      // so adding one would look like it worked and change nothing - exactly the
      // silent no-op the field was introduced to kill. Say so instead.
      if (RETIRED_OCCUPANCY_TAGS.has(added))
        throw new Error(
          `tag: "${added}" is no longer a tag - how an entity sits on its tile is the \`occupancy\` field ("tile" or "blocking")`,
        );
      if (!hasTag(e, added)) e.tags.push(added);
    }
    return 0;
  }
  if ("kind" in effect) {
    let e = resolve(world, self, effect.kind.of, args);
    e.kind = tagName(effect.kind.set, world, self, args);
    return 0;
  }
  if ("clearAction" in effect) {
    resolve(world, self, effect.clearAction.of, args).action = null;
    return 0;
  }
  if ("spawn" in effect) {
    let spec = effect.spawn;
    let kind = spec.kind ? tagName(spec.kind, world, self, args) : undefined;
    // A kind repeated in tags is stripped: hasTag already counts kind as a
    // tag, so the duplicate would only be noise in views.
    let tags = (spec.tags ?? [])
      .map((t) => tagName(t, world, self, args))
      .filter((t) => t !== kind);
    for (let t of tags)
      if (RETIRED_OCCUPANCY_TAGS.has(t))
        throw new Error(
          `spawn: "${t}" is no longer a tag - set \`occupancy\` ("tile" or "blocking") instead`,
        );
    // Auto-id prefix: kind is the natural name for what's being minted. The
    // tags[0] fallback is legacy (pre-kind rulepacks) - cosmetic only, so it
    // stays lenient rather than breaking old spawns on boot.
    let id = spec.id
      ? spawnId(spec.id, world, self, args)
      : freshId(world, spec.idPrefix ?? kind ?? tags[0] ?? "entity");
    if (world.entities[id])
      throw new Error(`spawn: entity "${id}" already exists`);
    // A held spawn is off-grid by construction - it ignores `at` entirely and
    // takes no ground, the same way a crafted axe lands in a hand, not on a
    // tile.
    if (spec.heldBy !== undefined) {
      let holder = resolve(world, self, spec.heldBy, args);
      world.entities[id] = {
        id,
        kind,
        tags,
        stocks: instantiateStocks(spec.stocks ?? {}),
        heldBy: holder.id,
        action: null,
        ...(spec.text !== undefined
          ? { text: validInscription(spec.text) }
          : {}),
      };
      return 0;
    }
    let pos: { x: number; y: number } | undefined;
    if (spawnAtCoords(spec.at)) {
      let x = Math.round(evalExpr(spec.at.x, world, self, args));
      let y = Math.round(evalExpr(spec.at.y, world, self, args));
      // Unlike a move step (dropped silently), an off-map spawn is by default an
      // authoring error: throw so it surfaces as a rule_error instead of minting
      // an entity syncSites can't index. A spread that opts into `skipOffMap`
      // instead treats an off-map roll as a quiet no-op (the diffusion just
      // doesn't cross the frontier this time). With no lookup installed we can't
      // tell on-map from off, so the coordinates are taken at face value.
      if (terrainLookup && terrainLookup(x, y) === undefined) {
        if (spec.at.skipOffMap) return 0;
        throw new Error(`spawn: (${x}, ${y}) is off the map`);
      }
      // Relocate a blocked landing to the nearest passable tile: growing
      // Chebyshev rings, row-major within each ring, so the same roll always
      // snaps the same way. A ring with no on-map tile means no larger ring
      // has one either - the whole map is blocked, which is an authoring
      // error worth a loud rule_error, not an unreachable entity.
      if (
        spec.at.snapToPassable &&
        terrainLookup &&
        passableLookup &&
        !passableLookup(x, y)
      ) {
        let found = false;
        for (let radius = 1; !found; radius += 1) {
          let anyOnMap = false;
          for (let ny = y - radius; ny <= y + radius && !found; ny += 1)
            for (let nx = x - radius; nx <= x + radius && !found; nx += 1) {
              if (Math.max(Math.abs(nx - x), Math.abs(ny - y)) !== radius)
                continue;
              if (terrainLookup(nx, ny) === undefined) continue;
              anyOnMap = true;
              if (passableLookup(nx, ny)) {
                x = nx;
                y = ny;
                found = true;
              }
            }
          if (!found && !anyOnMap)
            throw new Error(`spawn: no passable tile to snap (${x}, ${y}) to`);
        }
      }
      pos = { x, y };
    } else {
      let anchor = resolve(world, self, spec.at, args);
      pos = anchor.pos ? { ...anchor.pos } : undefined;
    }
    world.entities[id] = {
      id,
      kind,
      tags,
      stocks: instantiateStocks(spec.stocks ?? {}),
      pos,
      action: null,
      ...(spec.occupancy ? { occupancy: spec.occupancy } : {}),
      ...(spec.text !== undefined ? { text: validInscription(spec.text) } : {}),
    };
    return 0;
  }
  if ("destroy" in effect) {
    let e = resolve(world, self, effect.destroy.of, args);
    if (e.id === "world")
      throw new Error("destroy: the world entity cannot be removed");
    // Release whatever the destroyed entity was holding onto its tile first,
    // rather than leaving a dangling heldBy pointing at an id that no longer
    // exists - a corpse's axe should land beside it, not vanish with it.
    for (let held of Object.values(world.entities))
      if (held.heldBy === e.id) releaseHeld(held, e.pos);
    delete world.entities[e.id];
    return 0;
  }
  if ("take" in effect) {
    let item = resolve(world, self, effect.take.item, args);
    let by = resolve(world, self, effect.take.by, args);
    // Taking puts the item off-grid and reachable only through its holder, so
    // three shapes have to be refused outright or they strand an entity where
    // nothing can ever reach it again: the world singleton (everything reads
    // its stocks), taking yourself, and a cycle (A holds B holds A - both go
    // positionless, and destroy's release path has no tile to drop them on).
    // A god-DSL authoring slip, not a player move, but silent and permanent.
    if (item.id === "world")
      throw new Error("take: the world entity cannot be held");
    if (item.id === by.id)
      throw new Error(`take: "${by.id}" cannot hold itself`);
    for (let holder: Entity | undefined = by; holder;) {
      if (holder.id === item.id)
        throw new Error(
          `take: "${by.id}" is already held (directly or not) by "${item.id}" - holding it back would strand both off the grid`,
        );
      holder = holder.heldBy ? world.entities[holder.heldBy] : undefined;
    }
    item.heldBy = by.id;
    item.pos = undefined;
    delete item.occupancy;
    return 0;
  }
  if ("release" in effect) {
    let item = resolve(world, self, effect.release.item, args);
    let by = resolve(world, self, effect.release.by, args);
    if (item.heldBy !== by.id)
      throw new Error(`release: "${by.id}" is not holding "${item.id}"`);
    let at = effect.release.at
      ? resolve(world, self, effect.release.at, args)
      : by;
    releaseHeld(item, at.pos);
    return 0;
  }
  if ("move" in effect) {
    let e = resolve(world, self, effect.move.of, args);
    if (!e.pos) throw new Error(`move: entity "${e.id}" has no position`);
    let dx = Math.round(evalExpr(effect.move.dx, world, self, args));
    let dy = Math.round(evalExpr(effect.move.dy, world, self, args));
    let x = e.pos.x + dx;
    let y = e.pos.y + dy;
    // Drop a step that would leave the grid. terrainLookup returns undefined
    // off-map, so an undefined here is the bounds guard that keeps syncSites from
    // indexing a tile that doesn't exist. With no lookup installed we can't tell
    // on-map from off, so the move is skipped rather than risk a bad write.
    if (terrainLookup && terrainLookup(x, y) !== undefined) e.pos = { x, y };
    return 0;
  }
  if ("moveToward" in effect) {
    let e = resolve(world, self, effect.moveToward.of, args);
    let target = resolve(world, self, effect.moveToward.target, args);
    if (!e.pos) throw new Error(`moveToward: entity "${e.id}" has no position`);
    if (!target.pos)
      throw new Error(`moveToward: target "${target.id}" has no position`);
    let steps =
      effect.moveToward.steps === undefined
        ? 1
        : Math.max(
            0,
            Math.round(evalExpr(effect.moveToward.steps, world, self, args)),
          );
    // A step is takeable if it stays on the map and (when the host installs a
    // passability oracle) lands on walkable terrain. Without a lookup we can't
    // tell on-map from off, so - like `move` - the walk ends rather than risk a
    // bad write. Passability is only enforced when the oracle is present, so
    // pure-kernel callers keep the old on-map-only behavior.
    let takeable = (x: number, y: number): boolean => {
      if (!terrainLookup || terrainLookup(x, y) === undefined) return false;
      return passableLookup ? passableLookup(x, y) : true;
    };
    for (let i = 0; i < steps; i += 1) {
      let dx = Math.sign(target.pos.x - e.pos.x);
      let dy = Math.sign(target.pos.y - e.pos.y);
      if (dx === 0 && dy === 0) break; // arrived
      // Greedy wall-slide: try the direct step first, then - if it's a diagonal
      // blocked by a wall - fall back to sliding along whichever single axis is
      // open, so a chaser hugs the wall toward its target instead of stopping
      // dead or cutting the corner. A blocked straight (cardinal) approach has no
      // slide that still closes distance, so it just stops. Not full A*: it can
      // still get stuck in a concave pocket, which is fine for a homing creature.
      let slides: Array<[number, number]> =
        dx !== 0 && dy !== 0
          ? [
              [dx, dy],
              [dx, 0],
              [0, dy],
            ]
          : [[dx, dy]];
      let stepped = false;
      for (let [sx, sy] of slides) {
        let x: number = e.pos.x + sx;
        let y: number = e.pos.y + sy;
        if (takeable(x, y)) {
          e.pos = { x, y };
          stepped = true;
          break;
        }
      }
      if (!stepped) break; // walled in on every candidate this step
    }
    return 0;
  }
  if ("moveTo" in effect) {
    let e = resolve(world, self, effect.moveTo.of, args);
    let to = effect.moveTo.to;
    let x: number;
    let y: number;
    if (spawnAtCoords(to)) {
      x = Math.round(evalExpr(to.x, world, self, args));
      y = Math.round(evalExpr(to.y, world, self, args));
    } else {
      let anchor = resolve(world, self, to, args);
      if (!anchor.pos)
        throw new Error(`moveTo: target "${anchor.id}" has no position`);
      x = anchor.pos.x;
      y = anchor.pos.y;
    }
    // Unlike a `move`/`moveToward` step (dropped silently off-map), a teleport to
    // an off-map tile is an authoring error: throw so it surfaces as a rule_error
    // rather than parking an entity on a tile syncSites can't index. With no
    // lookup installed we can't tell on-map from off, so coords are taken as-is.
    if (terrainLookup && terrainLookup(x, y) === undefined)
      throw new Error(`moveTo: (${x}, ${y}) is off the map`);
    e.pos = { x, y };
    return 0;
  }
  if ("regenerate" in effect) {
    // Record the request only - the host rebuilds the world after the tick, so
    // the rest of this `do` (and every other rule) finishes against the old
    // world first. Last write wins if two regenerates fire in one tick.
    world.pendingRegen = Math.round(
      evalExpr(effect.regenerate.seed, world, self, args),
    );
    return 0;
  }
  if ("growWorld" in effect) {
    let by = Math.max(
      0,
      Math.round(evalExpr(effect.growWorld.by, world, self, args)),
    );
    let directions: MapEdge[] = effect.growWorld.direction
      ? [effect.growWorld.direction]
      : ["east", "south"];
    world.pendingGrow ??= {};
    for (let direction of directions)
      world.pendingGrow[direction] = (world.pendingGrow[direction] ?? 0) + by;
    return 0;
  }
  if ("setTerrain" in effect) {
    let e = resolve(world, self, effect.setTerrain.of, args);
    if (!e.pos) throw new Error(`setTerrain: entity "${e.id}" has no position`);
    if (!terrainWriter)
      throw new Error(
        "setTerrain needs a terrain writer, but none was installed for this call",
      );
    terrainWriter(e.pos.x, e.pos.y, name(effect.setTerrain.to, args));
    return 0;
  }
  if ("reveal" in effect) {
    let to = resolve(world, self, effect.reveal.to, args);
    let around = effect.reveal.around
      ? resolve(world, self, effect.reveal.around, args)
      : to;
    if (!around.pos)
      throw new Error(`reveal: entity "${around.id}" has no position`);
    let radius =
      effect.reveal.radius === undefined
        ? 1
        : Math.max(
            0,
            Math.round(evalExpr(effect.reveal.radius, world, self, args)),
          );
    if (!revealer)
      throw new Error(
        "reveal needs a revealer, but none was installed for this call",
      );
    revealer(to.id, around.pos.x, around.pos.y, radius);
    return 0;
  }
  let numeric = applyNumericEffect(
    effect,
    world,
    self,
    args,
    modifiers,
    {
      add: (entity, stockName, amount) => {
        let before = entity.stocks[stockName].value;
        writeStock(entity, stockName, before + amount);
        return entity.stocks[stockName].value - before;
      },
      set: (entity, stockName, value) => {
        writeStock(entity, stockName, value);
        return 0;
      },
    },
    captures,
  );
  if (numeric !== null) return numeric;
  throw new Error(`malformed effect: ${JSON.stringify(effect)}`);
}

// Entities a rule binds to: the world singleton, or every matching entity.
// An each with neither tag nor kind is an authoring error validateRule
// rejects; if one slips through it binds nothing rather than everything.
function bind(world: KernelWorld, each?: Selector): Entity[] {
  if (!each) return [world.entities.world];
  if (each.tag === undefined && each.kind === undefined) return [];
  return Object.values(world.entities).filter(
    (e) =>
      (each.tag === undefined || hasTag(e, each.tag)) &&
      (each.kind === undefined || e.kind === each.kind),
  );
}

// Run one rule-binding body in isolation. A throw on a single (rule, entity)
// pair - a read of a missing stock, a malformed expression - is captured as a
// structured `rule_error` event and the pair is skipped, so the rest of the
// tick (and every other character) carries on. Without this one bad rule on one
// agent would unwind the whole tick and the host would pause the shared clock
// for everyone. Returns true if the body ran clean, false if it threw.
function isolate(
  rule: Rule,
  self: Entity,
  world: KernelWorld,
  events: KernelEvent[],
  body: () => void,
): boolean {
  try {
    body();
    return true;
  } catch (err) {
    events.push({
      tick: world.tick,
      type: "rule_error",
      entity: self.id === "world" ? undefined : self.id,
      text: err instanceof Error ? err.message : String(err),
      args: { rule: rule.id },
    });
    return false;
  }
}

// A rule bound to `each: { tag: "agent" }` that throws fails once per character,
// so a single broken rule would emit one error per agent every tick (and the
// messages differ only by the bound entity's id). Collapse a tick's rule_errors
// to one per rule - enough for the GM to see which rule is broken without
// burying the log - keeping the first occurrence's message and entity as the
// representative.
function dedupeRuleErrors(events: KernelEvent[]) {
  let seen = new Set<string>();
  let kept = events.filter((e) => {
    if (e.type !== "rule_error") return true;
    let key = String(e.args?.rule ?? "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  events.length = 0;
  events.push(...kept);
}

// Stable-sort rules by descending priority (unset reads as 0) so a phase or a
// channel fold runs higher-priority rules first, ties keeping each rule's
// original array position (JS's Array.sort is a stable sort). A rule set
// where nothing declares priority is therefore an identity sort - this
// reproduces today's plain array-order behavior exactly for every existing
// scenario. Priority only ever reorders within the caller's own list - it never
// reaches across the fixed phase pipeline.
function byPriority<T>(rules: T[]): T[] {
  let of = (rule: T) => (rule as { priority?: number }).priority ?? 0;
  return [...rules].sort((a, b) => of(b) - of(a));
}

// Whether `rule`'s pacing gates let it fire for `self` this tick - call only
// after `when` has already passed. `chance` is a seeded, reproducible draw
// (the same addressed-noise mechanism as `rand`/`noise`, keyed by this rule's
// id) so a replay rolls the identical outcome on the identical tick; omitted,
// it always passes. `cooldown` reads world.cooldowns, keyed by (rule, self),
// so a rule that already fired inside the window skips instead of firing
// again.
function pacingAllows(
  rule: { id: string; chance?: number; cooldown?: number },
  world: KernelWorld,
  self: Entity,
): boolean {
  if (
    rule.chance !== undefined &&
    noise(world, self, ["chance", rule.id]) >= rule.chance
  )
    return false;
  if (rule.cooldown !== undefined) {
    let last = world.cooldowns?.[`${rule.id}:${self.id}`];
    if (last !== undefined && world.tick - last < rule.cooldown) return false;
  }
  return true;
}

// Stamp that `rule` fired for `self` this tick, for a later cooldown check.
// A no-op for a rule with no cooldown, so a world with no cooldown rules
// never grows a cooldowns map.
function markFired(
  rule: { id: string; cooldown?: number },
  world: KernelWorld,
  self: Entity,
): void {
  if (rule.cooldown === undefined) return;
  world.cooldowns ??= {};
  world.cooldowns[`${rule.id}:${self.id}`] = world.tick;
}

function runPhase(
  world: KernelWorld,
  rules: Rule[],
  phase: "flow" | "threshold",
  modifiers: Modifier[],
  events: KernelEvent[],
) {
  let buffer = new DeltaBuffer();
  for (let rule of rules) {
    if (!("phase" in rule) || rule.phase !== phase) continue;
    for (let self of bind(world, rule.each)) {
      // Buffer this pair's effects into a scratch buffer and only fold them into
      // the phase buffer if the whole pair succeeds, so a throw midway through a
      // multi-effect threshold doesn't commit half of it.
      let scratch = new DeltaBuffer();
      let ok = isolate(rule, self, world, events, () => {
        if (rule.when && !evalCond(rule.when, world, self, {})) return;
        if (!pacingAllows(rule, world, self)) return;
        let effects: Effect[] =
          rule.phase === "flow"
            ? [
                {
                  adjust: {
                    target: rule.target,
                    by: rule.rate,
                    channel: rule.channel,
                  },
                },
              ]
            : rule.do;
        let conflict = rule.phase === "threshold" ? rule.conflict : undefined;
        for (let eff of effects)
          bufferEffect(eff, world, self, {}, modifiers, scratch, conflict);
        markFired(rule, world, self);
      });
      if (ok) buffer.merge(scratch);
    }
  }
  buffer.commit();
}

// Resolve every action that completes this tick, in commit order, before the
// continuous phases (so a finished tend_fire raises the fire before it cools).
function runActions(
  world: KernelWorld,
  rules: Rule[],
  modifiers: Modifier[],
  events: KernelEvent[],
) {
  let actionRules = rules.filter(
    (r): r is ActionRule => "kind" in r && r.kind === "action",
  );
  let due = Object.values(world.entities)
    .filter((e) => e.action && e.action.endTick <= world.tick)
    .sort(
      (a, b) =>
        a.action!.startTick - b.action!.startTick || a.id.localeCompare(b.id),
    );

  for (let actor of due) {
    let act = actor.action!;
    let rule = actionRules.find((r) => r.id === act.type);
    // Not a stock action (e.g. a movement intent) - leave it for the subsystem
    // that owns it rather than clearing it out from under them.
    if (!rule) continue;
    actor.action = null;

    // Cleared the action above before the body runs, so an action that throws is
    // reported once and dropped rather than re-attempted on the next tick.
    isolate(rule, actor, world, events, () => {
      if (
        rule.fizzleWhen &&
        evalCond(rule.fizzleWhen, world, actor, act.args)
      ) {
        events.push({
          tick: world.tick,
          type: "action_failed",
          entity: actor.id,
          text: rule.fizzleReason,
          args: { action: act.type, ...act.args },
        });
        return;
      }
      // Sum what the action's transfers actually moved, so the event can report
      // the real yield (a gather on a near-empty token moves less than its rate).
      let moved = 0;
      let hadTransfer = false;
      // An `adjust` effect tagged `as: "targetId"` drops the entity it resolved
      // here, so the emitted event's describeEvent template can name it (e.g.
      // "strikes at {{ ctx.args.targetName }}") instead of only naming the actor.
      let captures: Record<string, string> = {};
      for (let eff of rule.do) {
        let delta = applyEffectNow(
          eff,
          world,
          actor,
          act.args,
          modifiers,
          captures,
        );
        if ("transfer" in eff) {
          hadTransfer = true;
          moved += delta;
        }
      }
      if (rule.emit)
        events.push({
          tick: world.tick,
          type: rule.emit.type,
          entity: actor.id,
          ...(rule.emit.global ? { global: true } : {}),
          args: {
            ...act.args,
            ...(hadTransfer ? { amount: roundStock(moved) } : {}),
            ...captures,
          },
        });
    });
  }
}

function runEventRules(
  world: KernelWorld,
  rules: Rule[],
  modifiers: Modifier[],
  events: KernelEvent[],
  startIndex = 0,
): number {
  let eventRules = rules.filter(
    (rule): rule is EventRule => "phase" in rule && rule.phase === "event",
  );
  if (!eventRules.length || startIndex >= events.length) return events.length;

  let sourceEvents = events.slice(startIndex);
  for (let event of sourceEvents) {
    for (let rule of eventRules) {
      if (rule.on !== event.type) continue;
      let self = event.entity
        ? world.entities[event.entity]
        : world.entities.world;
      if (!self) continue;
      let args = event.args ?? {};
      isolate(rule, self, world, events, () => {
        if (rule.when && !evalCond(rule.when, world, self, args)) return;
        if (!pacingAllows(rule, world, self)) return;
        for (let effect of rule.do)
          applyEffectNow(effect, world, self, args, modifiers);
        markFired(rule, world, self);
      });
    }
  }
  return events.length;
}

// Recompute derived stocks (the calendar) before anything reads them.
function runDerived(world: KernelWorld, rules: Rule[], events: KernelEvent[]) {
  for (let rule of rules) {
    if (!("phase" in rule) || rule.phase !== "derived") continue;
    for (let self of bind(world, rule.each))
      isolate(rule, self, world, events, () =>
        writeStock(
          self,
          name(rule.target, {}),
          evalExpr(rule.value, world, self, {}),
        ),
      );
  }
}

// Apply one-way state changes (death) immediately, after stocks have settled.
function runTransitions(
  world: KernelWorld,
  rules: Rule[],
  modifiers: Modifier[],
  events: KernelEvent[],
) {
  for (let rule of rules) {
    if (!("phase" in rule) || rule.phase !== "transition") continue;
    for (let self of bind(world, rule.each))
      isolate(rule, self, world, events, () => {
        if (!evalCond(rule.when, world, self, {})) return;
        if (!pacingAllows(rule, world, self)) return;
        // An `adjust`/`transfer` effect tagged `as: "someKey"` drops the entity
        // it resolved here, so the emitted event's describeEvent template can
        // name it instead of only naming self.
        let captures: Record<string, string> = {};
        for (let eff of rule.do)
          applyEffectNow(eff, world, self, {}, modifiers, captures);
        markFired(rule, world, self);
        if (rule.emit)
          events.push({
            tick: world.tick,
            type: rule.emit.type,
            entity: self.id === "world" ? undefined : self.id,
            text: rule.emit.text,
            ...(rule.emit.global ? { global: true } : {}),
            args: Object.keys(captures).length ? captures : undefined,
          });
      });
  }
}

function runWatches(
  world: KernelWorld,
  rules: Rule[],
  before: KernelWorld,
  events: KernelEvent[],
) {
  for (let rule of rules) {
    if (!("phase" in rule) || rule.phase !== "watch") continue;
    for (let self of bind(world, rule.each))
      isolate(rule, self, world, events, () => {
        if (!evalCond(rule.when, world, self, {})) return;
        // Compare against the same entity as it was at the start of the tick.
        let was = before.entities[self.id];
        if (was && evalCond(rule.when, before, was, {})) return; // not a fresh crossing
        if (!pacingAllows(rule, world, self)) return;
        events.push({
          tick: world.tick,
          type: rule.emit.type,
          entity: self.id === "world" ? undefined : self.id,
          text: rule.emit.text,
          ...(rule.emit.global ? { global: true } : {}),
          ...(rule.emit.interrupt ? { interrupt: rule.emit.interrupt } : {}),
        });
        markFired(rule, world, self);
      });
  }
}

// Commit intent: validates the commit-time gate, then occupies the actor until
// the action completes.
export function commit(
  world: KernelWorld,
  rules: Rule[],
  actorId: string,
  type: string,
  args: Args = {},
  terrain?: TerrainLookup,
  tokenAt?: (x: number, y: number) => Entity | undefined,
): { ok: boolean; error?: string; endsInTicks?: number } {
  let actor = world.entities[actorId];
  if (!actor) throw new Error(`no entity "${actorId}"`);
  let rule = rules.find(
    (r): r is ActionRule => "kind" in r && r.kind === "action" && r.id === type,
  );
  if (!rule) throw new Error(`unknown action "${type}"`);

  if (
    rule.requires &&
    !withTerrain(terrain, () => evalCond(rule.requires!, world, actor, args))
  )
    return {
      ok: false,
      error: withTerrain(terrain, () => refusalFor(rule, world, actor, args)),
    };

  let reserved = occupiedGroundRefusal(rule, actor, tokenAt);
  if (reserved) return { ok: false, error: reserved };

  actor.action = {
    type,
    args,
    startTick: world.tick,
    endTick: world.tick + rule.duration,
  };
  return { ok: true, endsInTicks: rule.duration };
}

// Every action rule in a rule set - the registry a host advertises and routes
// committed action intents against.
export function actionRules(rules: Rule[]): ActionRule[] {
  return rules.filter(
    (r): r is ActionRule => "kind" in r && r.kind === "action",
  );
}

// Whether an action is worth doing right now: its commit gate holds and it
// would not immediately fizzle. This is what availableActions reports, so a
// data-rule action's applicability falls out of its own conditions.
export function actionApplicable(
  world: KernelWorld,
  rules: Rule[],
  actorId: string,
  type: string,
  args: Args = {},
  terrain?: TerrainLookup,
): boolean {
  return checkAction(world, rules, actorId, type, args, terrain).applicable;
}

// Read a `requires` back as the sentence a character needs: which clause
// failed, and what it wanted. `requireReason` is the author's own words and
// always wins - this is the fallback for when nobody wrote one, which in
// practice is most GM-minted rules (genesis run 32d46bd9: 13 of 13 actions had
// no requireReason, so every refusal read "cannot build_log_pile right now" and
// Fable spent ~200 ticks guessing whether the rule was even finished).
//
// Only the leaf shapes that gate real actions are rendered; anything more
// exotic falls back to the caller's generic phrasing rather than inventing a
// half-true explanation.
function explainRefusal(
  cond: Cond,
  world: KernelWorld,
  self: Entity,
  args: Args,
): string | undefined {
  if ("cmp" in cond) {
    let have = tryEval(() => evalExpr(cond.left, world, self, args));
    let want = tryEval(() => evalExpr(cond.right, world, self, args));
    if (have === undefined || want === undefined) return undefined;
    let subject = describeExpr(cond.left, args);
    if (!subject) return undefined;
    let comparison =
      cond.cmp === "gte"
        ? `at least ${want}`
        : cond.cmp === "gt"
          ? `more than ${want}`
          : cond.cmp === "lte"
            ? `at most ${want}`
            : cond.cmp === "lt"
              ? `less than ${want}`
              : `exactly ${want}`;
    return `you need ${subject} ${comparison} (you have ${round(have)})`;
  }
  if ("colocated" in cond) {
    let sel =
      typeof cond.colocated === "string" || "arg" in (cond.colocated as object)
        ? { tag: cond.colocated as TagRef }
        : (cond.colocated as ColocatedSel);
    let what = describeTagRef(sel.kind ?? sel.tag, args);
    if (!what) return undefined;
    let range = sel.range ?? 0;
    return range === 0
      ? `you must be standing on a ${what}`
      : `you must be within ${range} of a ${what}`;
  }
  if ("nearTerrain" in cond) {
    let kinds = cond.nearTerrain.type;
    let what = Array.isArray(kinds) ? kinds.join(" or ") : kinds;
    let range = cond.nearTerrain.range ?? 0;
    return range === 0
      ? `you must be standing on ${what}`
      : `you must be within ${range} of ${what}`;
  }
  // A conjunction refuses for its first unmet clause - the one thing to go fix.
  if ("all" in cond) {
    for (let part of cond.all) {
      if (tryEval(() => evalCond(part, world, self, args)) === false)
        return explainRefusal(part, world, self, args);
    }
    return undefined;
  }
  // A disjunction refuses because none held, so name every route back in.
  if ("any" in cond) {
    let routes = cond.any.map((part) =>
      explainRefusal(part, world, self, args),
    );
    if (!routes.length || routes.some((r) => !r)) return undefined;
    return routes.join(", or ");
  }
  return undefined;
}

function tryEval<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

function round(value: number) {
  return Number.isInteger(value) ? value : Math.round(value * 10) / 10;
}

function describeExpr(expr: Expr, args: Args): string | undefined {
  if (typeof expr === "number") return undefined;
  if ("stock" in expr && !expr.of) return name(expr.stock, args);
  if ("headroom" in expr && !expr.of)
    return `room for more ${name(expr.headroom, args)}`;
  return undefined;
}

function describeTagRef(ref: TagRef | undefined, args: Args) {
  if (ref === undefined) return undefined;
  if (typeof ref === "string") return ref;
  if ("arg" in ref) return String(args[ref.arg]);
  return undefined;
}

// The refusal a character actually reads: the author's requireReason when there
// is one, otherwise the gate read back in plain terms, otherwise the generic.
function refusalFor(
  rule: { requires?: Cond; requireReason?: string; id: string },
  world: KernelWorld,
  self: Entity,
  args: Args,
) {
  if (rule.requireReason) return rule.requireReason;
  let explained = rule.requires
    ? explainRefusal(rule.requires, world, self, args)
    : undefined;
  return explained ?? `cannot ${rule.id} right now`;
}

// Why an action is unavailable right now, or undefined if it applies. Mirrors
// actionApplicable's gates, but hands back the rule's own requireReason /
// fizzleReason so the action menu can say *why* an action is greyed out instead
// of leaving a model to infer the precondition from prose.
export function actionUnavailableReason(
  world: KernelWorld,
  rules: Rule[],
  actorId: string,
  type: string,
  args: Args = {},
  terrain?: TerrainLookup,
): string | undefined {
  return checkAction(world, rules, actorId, type, args, terrain)
    .unavailableReason;
}

// Whether an action rule would put something that takes ground on the actor's
// own tile - the build-anywhere pattern: a spawn effect carrying `occupancy`
// with no anchor (or an explicit "self"). Because occupancy is a static enum
// rather than a TagRef, this is knowable before the action commits; a spawn
// without it wants no ground and never competes for the slot.
function spawnsOccupantAtSelf(rule: ActionRule): boolean {
  return rule.do.some(
    (eff) =>
      "spawn" in eff &&
      (eff.spawn.at === undefined || eff.spawn.at === "self") &&
      eff.spawn.occupancy !== undefined,
  );
}

// Held ground: anything with `occupancy` holds its tile, so an action that
// would raise a second occupant where the actor stands is refused up front -
// before time or materials are spent - rather than letting the spawn fall off
// the grid under the one-token-per-tile law. There is no exemption: a tile
// shows one token, so a build that "succeeds" onto occupied ground can only
// ever charge the builder for nothing. (An upgrade-in-place action that
// destroys the holder in the same tick would need an explicit destroy-aware
// carve-out here; nothing wants one yet.) Shared by checkAction (the
// menu/approach probe) and commit (the gate that actually starts the action),
// so they can never disagree.
function occupiedGroundRefusal(
  rule: ActionRule,
  actor: Entity,
  tokenAt?: (x: number, y: number) => Entity | undefined,
): string | undefined {
  if (!tokenAt || !actor.pos || !spawnsOccupantAtSelf(rule)) return undefined;
  let holder = tokenAt(actor.pos.x, actor.pos.y);
  if (holder && holder.id !== actor.id && holder.occupancy)
    return `${holder.id} stands here and holds this ground; step off it first`;
  return undefined;
}

export function checkAction(
  world: KernelWorld,
  rules: Rule[],
  actorId: string,
  type: string,
  args: Args = {},
  terrain?: TerrainLookup,
  tokenAt?: (x: number, y: number) => Entity | undefined,
): ActionCheck {
  let actor = world.entities[actorId];
  if (!actor)
    return { applicable: false, unavailableReason: "you are not in the world" };
  let rule = actionRules(rules).find((r) => r.id === type);
  if (!rule)
    return {
      applicable: false,
      unavailableReason: `unknown action "${type}"`,
    };
  return withTerrain(terrain, () => {
    if (rule.requires && !evalCond(rule.requires, world, actor, args))
      return {
        applicable: false,
        unavailableReason: refusalFor(rule, world, actor, args),
      };
    if (rule.fizzleWhen && evalCond(rule.fizzleWhen, world, actor, args))
      return {
        applicable: false,
        unavailableReason: rule.fizzleReason ?? `cannot ${type} right now`,
      };
    let reserved = occupiedGroundRefusal(rule, actor, tokenAt);
    if (reserved) return { applicable: false, unavailableReason: reserved };
    return { applicable: true };
  });
}

export function beginTick(world: KernelWorld): KernelWorld {
  world.tick += 1;
  return structuredClone(world);
}

export function runRulesForTick(
  world: KernelWorld,
  rules: Rule[],
  before: KernelWorld,
  events: KernelEvent[] = [],
  terrain?: TerrainLookup,
  writeTerrain?: TerrainWriter,
  reveal?: Revealer,
  passable?: PassableLookup,
): KernelEvent[] {
  return withTerrain(terrain, () =>
    withTerrainWriter(writeTerrain, () =>
      withRevealer(reveal, () =>
        withPassable(passable, () => {
          // Sorted once, by priority, and threaded through every phase runner
          // below (as well as the modifier-channel fold) so a GM's explicit
          // ordering applies wherever this tick's rules can observe each
          // other's effects. Unset priority everywhere is an identity sort.
          let ordered = byPriority(rules);
          let modifiers = ordered.filter(
            (r): r is Modifier => "kind" in r && r.kind === "modifier",
          );
          runDerived(world, ordered, events);
          let processedEventCount = runEventRules(
            world,
            ordered,
            modifiers,
            events,
          );
          runActions(world, ordered, modifiers, events);
          processedEventCount = runEventRules(
            world,
            ordered,
            modifiers,
            events,
            processedEventCount,
          );
          runPhase(world, ordered, "flow", modifiers, events);
          runPhase(world, ordered, "threshold", modifiers, events);
          runWatches(world, ordered, before, events);
          runTransitions(world, ordered, modifiers, events);
          runEventRules(world, ordered, modifiers, events, processedEventCount);
          dedupeRuleErrors(events);
          return events;
        }),
      ),
    ),
  );
}

// Advance a rules-only world one tick. Hosts with shared spatial behavior call
// beginTick(), update space, then runRulesForTick().
export function step(world: KernelWorld, rules: Rule[]): KernelEvent[] {
  return runRulesForTick(world, rules, beginTick(world));
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

// Round a stock value for anything a player or dashboard reads. Storage stays
// full-precision (a rule may park a raw noise draw in a stock), but tick math
// accumulates binary-float drift (0.1 + 0.2 !== 0.3), so projections round to
// one decimal lest a health of 28 surface as 28.000000000000004.
export function roundStock(v: number): number {
  return Math.round(v * 10) / 10;
}

export function stock(value: number, min = 0, max = 100): Stock {
  return { value, min, max };
}
