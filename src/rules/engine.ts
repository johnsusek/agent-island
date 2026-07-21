// The generic host: the rule kernel and the space subsystem, wrapped in the
// surface a server needs - a seq-cursored event log with visibility, free
// communication, and the observation/admin/map
// projections. It is handed a Scenario and knows nothing of hunger, foraging, or
// characters: stocks are a generic map, liveness is the "agent" tag, and an
// event's prose comes from the scenario (or a generic fallback).

import {
  actionRules,
  approachTargets,
  beginTick,
  checkAction,
  clamp,
  commit,
  freshId,
  hasTag,
  roundStock,
  runRulesForTick,
  setStockpilable,
  stock,
  validateRule,
  validInscription,
  type Args,
  type Entity,
  type KernelEvent,
  type KernelWorld,
  type MapEdge,
  type Rule,
  type Stock,
} from "./kernel.js";
import { assertValidRule } from "./rule-schema.js";
import {
  advanceSpace,
  chebyshev,
  commitMove,
  compass,
  EARSHOT,
  expandWorldGen,
  extendTerrain,
  frontier,
  knownTokens,
  planMove,
  makeSpace,
  movementActions,
  growGrid,
  passable,
  pickSpawn,
  freeSpawnNear,
  revealAround,
  revealAt,
  replanRoutesForTerrain,
  replanRoutesForSolids,
  routeTo,
  setTerrainAt,
  SIGHT,
  tokenNameAt,
  scatterOnGrid,
  spawn,
  syncTokens,
  tileAt,
  unionKnownTiles,
  knownTiles,
  WHISPER_RANGE,
  TOUCH_RANGE,
  worldgenWithTerrainPolicy,
  type BlobGen,
  type Grid,
  type Position,
  type Space,
  type TerrainLayer,
  type TokenRef,
  type TokenScatter,
  type Terrain,
  type WorldGenConnect,
} from "./space.js";
import {
  assertValidTerrainSpec,
  assertValidVisual,
  renderTemplate,
  type DisplayHint,
  type EntityTemplate,
  type Scenario,
  type StockSpec,
  type TerrainSpec,
  type Visual,
} from "./scenario.js";
import { type OrderState } from "./orders.js";
import { dryRunRule, type DryRunReport } from "./dryrun.js";
import {
  bandedStocks,
  bandSentence,
  VITAL_BANDS,
  type VitalBand,
} from "./vitals.js";
import {
  actionCanStart as canStartAction,
  intentArgs,
  isMovementActionName,
  listAvailableActions as availableActionsFor,
  validateActionArgs,
  type ActionInput,
  type ActionDescriptor,
  type AvailableAction,
  type EngineActionContext,
} from "./engine-actions.js";
import {
  advanceEngineOrders,
  cancelEngineOrder,
  cancelRunningOrder as cancelOrderRuntime,
  getEngineOrder,
  interruptRunningOrder,
  orderView as engineOrderView,
  setEngineOrder,
  type EngineOrderContext,
} from "./engine-orders.js";

export type {
  ActionInput,
  ActionDescriptor,
  AvailableAction,
  EntityTargetOption,
} from "./engine-actions.js";

// A self-describing action, as advertised to clients in availableActions.
// What spawnEntity reports back: the entity, whether it actually landed on the
// grid as a token (false if the tile was occupied), and which characters it was
// revealed to (empty unless `reveal` was requested).
export interface SpawnResult {
  entity: Entity;
  onMap: boolean;
  revealedTo: string[];
}

export interface GameEvent {
  seq: number;
  tick: number;
  type: string;
  wake?: "routine" | "decision";
  agentId?: string;
  text?: string;
  audience?: string[]; // for place-local events: who shared the actor's tile
  global?: boolean; // opt in to colony-wide reach (world-level happenings)
  target?: string; // for whispers
  message?: string; // raw speech/whisper text
  verb?: string; // speculative_attempt / speculation_realized: the word that was tried
  verbs?: string[]; // speculation_realized: every synonym this one wake settles
  expectation?: string; // speculative_attempt: what the actor said would happen
  args?: Record<string, string | number>; // speculative_attempt: the rest of the attempted args
}

export interface VisibleEventsOptions {
  includeRoutine?: boolean;
}

// An entry in the GM's audit trail - every god-power the director exercises, kept
// apart from the character GameEvent log. Characters never see these (the design
// keeps GM edits invisible; they only feel the new rules bite), so this is purely
// for the admin dashboard's "GM Activity" feed. `summary` is a ready-to-render
// one-liner; `detail` carries the structured payload (before/after deltas, the
// rule body, the spawned spec) for a drill-down.
export interface GmEvent {
  seq: number;
  tick: number;
  kind:
    | "rule_added"
    | "rule_removed"
    | "rule_tweaked"
    | "stock_set"
    | "stock_default_set"
    | "entity_spawned"
    | "terrain_registered"
    | "terrain_painted"
    | "world_regenerated"
    | "world_grew"
    | "announced"
    | "game_over"
    | "gm_joined"
    | "gm_left";
  summary: string;
  target?: string; // the rule/entity/agent id the action touched
  detail?: Record<string, unknown>;
}

// One per-tick sample of the world-scoped numbers a dashboard charts over time:
// every world stock's value plus the living population. Recorded each tick into a
// bounded ring (see HISTORY_CAP) so the UI can draw trend sparklines without
// reconstructing history from the event log.
export interface StockSample {
  tick: number;
  population: number;
  stocks: Record<string, number>;
}

// The tension digest a GM client (a resident director) reads instead of pulling
// whole world state: "is anything happening, and how hard should I intervene?"
// Computed on demand from the in-memory logs and the trend ring, so it costs
// nothing per tick.
// Window-bounded fields look back `window` ticks; the ticksSince* fields are
// null when the thing has never happened this run.
export interface Pulse {
  tick: number;
  window: number;
  population: number;
  deathsInWindow: number;
  ticksSinceLastDeath: number | null;
  stockTrends: Record<string, { now: number; delta: number }>;
  chatInWindow: number;
  ticksSinceLastGmAction: number | null;
  ticksSinceLastDecisionEvent: number | null;
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,19}$/;

export function normalizeId(name: unknown): string {
  if (typeof name !== "string") throw new Error("Name must be text.");
  let id = name.trim().toLowerCase().replace(/\s+/g, "-");
  if (!idPattern.test(id))
    throw new Error(
      "Name must be 1 to 20 characters: letters, digits, or hyphens.",
    );
  return id;
}

function validText(message: unknown): string {
  let text = typeof message === "string" ? message.trim() : "";
  if (!text || text.length > 160)
    throw new Error("Message must be 1 to 160 characters.");
  return text;
}

// Speech has physics: an ordinary spoken message carries EARSHOT tiles, a
// whisper requires leaning in (WHISPER_RANGE). Where characters stand when they
// talk is a decision, and anything longer-range (a signal fire, a horn) is
// scenario content with a cost. Speak is free, but to stop a free channel from
// flooding nearby characters' context each speaker may only send a bounded
// number of messages per tick.
const SPEAK_BUDGET_PER_TICK = 3;
// Writing is deliberate work, not chatter: one inscription per character per
// tick keeps a free channel from papering the map in a single frozen moment.
const INSCRIBE_BUDGET_PER_TICK = 1;
// How many of the latest chat messages to fold into every observation, so a
// busy character reads the channel for free and need only choose whether to reply.
const RECENT_CHAT_LIMIT = 8;

// Substrate events whose audience is only the actor: action lifecycle and an
// agent's own movement/scouting. Keeping these private is noise control, not
// realism - a character's routine order churn shouldn't spam the shared feed.
// Everything else is directed (whispers) or colony-wide (chat, arrivals and
// departures, the scenario's witnessed activity events).
// Real capabilities that live on the MCP surface rather than in an order:
// speak, whisper, inscribe, and sense. See commitSpeculativeAttempt.
const TOOL_VERBS = new Set(["speak", "whisper", "inscribe", "sense"]);

const SUBSTRATE_ACTOR_ONLY = new Set([
  "action_started",
  "action_abandoned",
  "action_failed",
  "order_started",
  "order_completed",
  "order_blocked",
  "order_interrupted",
  "order_cancelled",
  "arrived",
  "scanned",
  "speculative_attempt",
  "vitals_alarm",
  "speculation_realized",
  "order_note",
]);

interface AgentMeta {
  name: string;
  spawnTick: number;
  diedAt: number | null;
}

// A plain-JSON image of all mutable runtime state. The space subsystem's Maps
// and the grid's impassable Set are flattened to arrays so the whole thing
// round-trips through JSON.stringify; restore() rebuilds them. The scenario's
// worldgen and prose are not part of the snapshot - they are the fixed program
// the state runs on, so restore refuses a snapshot from another one. The rule
// set is *mostly* program too, but the GM can edit it at runtime, so a small
// overlay of those edits rides along (see RuleOverlay).
export interface EngineSnapshot {
  version: number;
  scenario: string;
  world: KernelWorld;
  space: {
    grid: Omit<Grid, "impassable" | "terrainCost"> & {
      impassable: Terrain[];
      terrainCost: [Terrain, number][];
    };
    fog: [string, [string, number][]][];
    fogRevision?: number;
    moves: [string, { path: Position[]; index: number; progress: number }][];
  };
  meta: [string, AgentMeta][];
  log: GameEvent[];
  nextSeq: number;
  // The GM audit trail. Optional and absent in pre-GM-Activity snapshots, which
  // restore to an empty trail (the run's history before the feature simply isn't
  // recoverable).
  gmLog?: GmEvent[];
  nextGmSeq?: number;
  // GM rule edits layered over the scenario's baseline rules. Optional and
  // absent in pre-GM snapshots, which restore to the pristine scenario rule set.
  // Persisting only the diff (not the whole live array) means edits to the
  // scenario file's untouched rules still take effect on the next restore.
  overlay?: RuleOverlay;
  orders?: [string, OrderState][];
}

// The GM's divergence from scenario.rules: rules it added plus the current
// (patched) form of any baseline rule it changed, and the ids of baseline rules
// it removed. Everything else is reconstructed fresh from the scenario. Exported
// so a host can persist it on its own (separate from the world snapshot) and
// re-apply it after a world reset - house rules that outlive the world.
export interface RuleOverlay {
  dynamicRules: Rule[];
  removedBaseIds: string[];
  // Per-agent stock defaults the GM registered (see setStockDefault). They ride
  // in the overlay rather than the bare snapshot because they are house rules
  // too: a GM rule that reads `warmth` is only safe if every character is seeded
  // with `warmth`, so the default has to outlive the world alongside the rule
  // that needs it. Optional and absent in pre-default overlays.
  stockDefaults?: Record<string, StockSpec>;
  // Global stocks authored by a scenario (the world singleton's winter clock, a
  // shared stockpile, ...). Seeded onto the world entity only where the stock is
  // absent, so a snapshot restore keeps live values and only a fresh/reset world
  // gets the authored starting value. The scenario itself declares none - world
  // stocks are "make these on startup" authoring, and this is where it lives.
  worldStocks?: Record<string, StockSpec>;
  // GM-spawned entities (see spawnEntity), captured as the specs that created
  // them so a colony reset can replay them onto the fresh world. A director's
  // fixtures - a dropped crate, a new ruin - are authoring, not colony state, so
  // they return after a reset alongside the rule edits instead of vanishing with
  // the world. Optional and absent in overlays authored before fixtures persisted.
  fixtures?: FixtureSpec[];
  // Terrain kinds the GM registered at runtime (see registerTerrain), keyed by
  // name - the divergence from the scenario's own terrainSpecs. Like the visual
  // registry, only the GM's additions ride the overlay; the scenario base is
  // reconstructed on the next load. Absent in overlays authored before this.
  terrainSpecs?: Record<string, TerrainSpec>;
  // Map recipe a scenario owns: what terrain the grid starts as and the patches
  // painted over it. Terrain *placement* lives with the scenario (beside terrainSpecs,
  // which is terrain *definition*) so each game type shapes its own island; the
  // world file keeps only the shared canvas (width/height/seed). Every terrain
  // named here must be defined in the merged terrainSpecs (checked at boot/reset).
  defaultTerrain?: Terrain;
  blobs?: BlobGen[];
  // The layered map recipe (see TerrainLayer): ordered paint passes over the
  // fill, each a generator + terrain + optional mask. Replaces `blobs` when
  // present. Like the other placement fields it is a whole-recipe value - the
  // last overlay to declare one wins outright.
  terrainLayers?: TerrainLayer[];
  // Post-paint connectivity guarantee: carve corridors so every passable tile
  // is reachable. `true` carves with the fill terrain, {carve} names one.
  connect?: WorldGenConnect;
  // Kind-tag icons/colors the GM added at runtime (set_stock_default's icon/color,
  // a terrain coupling's icon) - the divergence from the scenario's kindVisuals.
  kindVisuals?: Record<string, Visual>;
  // Setup directives authored by a scenario. They run after a fresh world is
  // built and are skipped for already-existing generated ids on snapshot restore.
  setup?: SetupDirective[];
  // Prose templates for events the overlay's own rules emit, keyed by event
  // type ({{ ... }} templates rendered against the DescribeContext, exactly like
  // scenario.describeEvent). A scenario's rules and their prose travel together.
  describeEvent?: Record<string, string>;
  // Dashboard hints for the stocks the overlay introduces (label, tone, world
  // pill vs agent bar), keyed by stock name - the overlay's slice of
  // scenario.display, so a scenario's stocks and their presentation travel together.
  display?: Record<string, DisplayHint>;
}

export type SetupDirective = { scatter: TokenScatter };

// A GM-spawned entity captured as the spec that created it. Only the persistent
// fields - not the one-shot `reveal` side effect, which has no characters to act
// on when replayed onto a freshly reset world.
export interface FixtureSpec {
  id: string;
  kind?: string; // identity: what sprite/label the entity draws with
  tags?: string[];
  stocks?: Record<string, StockSpec>;
  pos?: Position;
  // Place at the world's spawn tile, wherever this run's worldgen rolled it -
  // how a scenario anchors camp furniture (a hearth, the coordination ledger)
  // without knowing coordinates at authoring time. Ignored when `pos` is given.
  atSpawn?: boolean;
  discoverable?: boolean;
  // A pre-written inscription (see Entity.text) - GM-seeded lore, a posted
  // notice. Persistent like the rest of the fixture, so it survives a reset.
  text?: string;
}

const SNAPSHOT_VERSION = 1;

// How many recent ticks of world-stock history the engine retains for the
// dashboard's trend charts. In-memory only (not snapshotted): it rebuilds as the
// world ticks, and a few minutes of trail is all the UI draws.
const HISTORY_CAP = 360;

const DEFAULT_AGENT_TEMPLATE: EntityTemplate = { tags: ["agent"], stocks: {} };

export function createWorld(scenario: Scenario) {
  let agentTemplate = scenario.agentTemplate ?? DEFAULT_AGENT_TEMPLATE;

  let world: KernelWorld;
  let space: Space;
  // The terrain lookup the kernel borrows for terrain-aware conditions
  // (`nearTerrain`). Closes over the mutable `space`, so it tracks a restore that
  // rebinds the grid; returns undefined off-map rather than throwing.
  let terrainAt = (x: number, y: number): string | undefined =>
    x >= (space.grid.origin?.x ?? 0) &&
    y >= (space.grid.origin?.y ?? 0) &&
    x < (space.grid.origin?.x ?? 0) + space.grid.width &&
    y < (space.grid.origin?.y ?? 0) + space.grid.height
      ? tileAt(space.grid, x, y).terrain
      : undefined;
  // The passability oracle the kernel borrows for the `moveToward` effect, so a
  // chasing creature routes around impassable terrain instead of phasing through
  // it. Closes over the live `space`, so it tracks a regenerate/grow/restore that
  // rebinds the grid. On-map-and-walkable; off-map or blocked terrain is false.
  let passableAt = (x: number, y: number): boolean =>
    passable(space.grid, x, y);
  // The terrain writer the kernel borrows for the `setTerrain` effect. Closes
  // over the mutable `space`/`world`; writes the tile, re-plans any route the
  // change blocks, and bumps the map revision so the dashboard refetches - the
  // host-side consequences the kernel leaves to us.
  let writeTerrain = (x: number, y: number, terrain: string): void => {
    requireTerrain(terrain);
    if (setTerrainAt(space, world, x, y, terrain)) terrainRevision += 1;
  };
  // The revealer the kernel borrows for the `reveal` effect: light radius
  // `radius` around (x, y) in one agent's fog. revealAround owns the
  // fogRevision bump that tells the dashboard new ground appeared.
  let revealFog = (to: string, x: number, y: number, radius: number): void => {
    revealAround(space, to, { x, y }, radius, world.tick);
  };
  let meta: Map<string, AgentMeta>;
  let log: GameEvent[];
  let nextSeq: number;
  // Per-character speak send count for the current tick, reset lazily when the
  // tick rolls over (see speak). Ephemeral - never snapshotted; a restart
  // simply starts everyone fresh on this tick's budget.
  let speakUse = new Map<string, { tick: number; count: number }>();
  // Same lazy-reset shape for inscribe: one writing per character per tick.
  let inscribeUse = new Map<string, { tick: number; count: number }>();
  // Which band each character's gauges last stood in, so only a crossing raises
  // an alarm (see raiseVitalAlarms). Ephemeral - a restart re-announces
  // whatever is already dire, which is the safe direction to be wrong in.
  let lastVitalBands = new Map<string, Record<string, VitalBand>>();
  // The GM's audit trail (see GmEvent): a separate, admin-only log of every
  // god-power the director exercises. Snapshotted alongside the world so the trail
  // survives a restart, but reset with a new world - it is the story of this run.
  let gmLog: GmEvent[];
  let nextGmSeq: number;
  // The live rule set. Seeded from the scenario but engine-owned and mutable, so
  // a GM can add, drop, or tweak rules at runtime (see addRule/removeRule/
  // patchRule). A shallow copy keeps the shared scenario singleton untouched.
  let rules: Rule[];
  // Ids the GM has touched (added, removed, or patched) since the baseline. This
  // is what snapshot() distills into a RuleOverlay so edits survive a restart.
  let dirtyRuleIds: Set<string>;
  // The pristine baseline rule ids for the current scenario - used to tell a
  // GM-added rule from a patched/removed baseline one when building the overlay.
  let baselineIds = new Set(scenario.rules.map((r) => r.id));
  // Bounded ring of per-tick world-stock samples for the dashboard's trend
  // charts (see StockSample). Engine-owned, reset on init, never snapshotted.
  let history: StockSample[];
  // The map ships to the dashboard as three independently-revisioned streams so
  // a walking character's reveal or a wolf's hop no longer invalidates the heavy
  // terrain payload. `terrainRevision` bumps only when the ground itself changes
  // (paint, growth, regeneration) - the rare, bakeable stream; `tokenRevision`
  // bumps when the token layer moves - per-tick but sparse; fog rides its own
  // `space.fogRevision`, bumped per revealed tile. All engine-owned, reset on
  // init, never snapshotted.
  let terrainRevision: number;
  let tokenRevision: number;
  let orders: Map<string, OrderState>;
  // Per-agent stock defaults the GM has introduced at runtime (e.g. `warmth`,
  // `wood`). Every agent - those alive when the default is set, and every future
  // joiner - is seeded with these so a GM rule that reads the stock never hits a
  // character that lacks it (a missing stock throws and freezes the whole tick).
  let stockDefaults: Record<string, StockSpec>;
  // GM-spawned fixtures captured as their creating specs (see spawnEntity), so a
  // reset can replay them onto the fresh world. Engine-owned and rides the rule
  // overlay into persistence, so it outlives the world like the GM's rule edits.
  let spawnedFixtures: FixtureSpec[];
  // The setup directives applied to the current world (from the active overlay),
  // retained so the dashboard can show a scenario's authored scatter recipes.
  let appliedSetup: SetupDirective[];
  // The live terrain registry: how each terrain kind behaves (see TerrainSpec).
  // Seeded from the scenario at init and extended at runtime by registerTerrain;
  // each entry is expanded into grid passability, move cost, and a map tint.
  let terrainSpecs: Record<string, TerrainSpec>;
  let knownTerrains: Set<string>;
  // The scenario's own terrain specs, fixed for the life of the engine - kept
  // apart from terrainSpecs so the GM's runtime additions can be reconstructed as
  // the divergence, and re-applied on top of the base after a reset (like
  // baseKindVisuals vs kindVisuals).
  let baseTerrainSpecs: Record<string, TerrainSpec>;
  // The live terrain -> visual registry the dashboard draws from: the scenario's
  // terrainVisuals, plus any a GM-registered TerrainSpec supplies. Kept live so a
  // GM-minted terrain can carry its own color/icon.
  let terrainVisuals: Record<string, Visual>;
  // The live kind-tag -> visual registry (icons/colors for entities and stocks),
  // and its scenario base. Live so a GM introducing a resource (set_stock_default,
  // or a terrain coupling) can give it a map icon; the base is kept apart so the
  // runtime additions can be distilled for the overlay and re-layered after reset.
  let kindVisuals: Record<string, Visual>;
  let baseKindVisuals: Record<string, Visual>;
  // The icons/colors owned by stock defaults, rules, fixtures, and GM edits - the
  // base that kindVisuals is rebuilt from whenever one of those changes.
  let authoredKindVisuals: Record<string, Visual>;
  // The live event-type -> prose-template registry: the scenario's own
  // describeEvent plus whatever the applied overlay carries (a scenario's rules
  // and their prose travel together). enrich() renders event text from here.
  let describeTemplates: Record<string, string>;
  // The live stock -> dashboard-hint registry, layered the same way.
  let displayHints: Record<string, DisplayHint>;
  // The tick each action was introduced, for actions the GM conjured at runtime.
  // A character's observation flags an action newer than its last look so a fresh
  // capability (chop, once the GM adds wood) actually catches the eye instead of
  // blending into a list it has skimmed a hundred times. Baseline and restored
  // actions are absent here and read as intro tick 0, so they never flash "new".
  let actionIntroTick: Map<string, number>;

  // The worldgen seed currently in effect. Starts at the scenario's own seed;
  // reset() can override it with a fresh one to reroll the map, spawn, and
  // tokens without touching the scenario's baked-in default.
  let activeSeed = scenario.worldgen?.seed ?? 1;
  let spawnPos = scenario.spawn;

  function init(seedOverride?: number) {
    if (seedOverride !== undefined) activeSeed = seedOverride;
    // A reroll needs its own spawn too - a fixed scenario.spawn would keep
    // characters landing in the same spot on a map that just changed shape.
    let effectiveWorldgen = scenario.worldgen
      ? worldgenWithTerrainPolicy(
          { ...scenario.worldgen, seed: activeSeed },
          scenario.terrainSpecs,
        )
      : worldgenWithTerrainPolicy(undefined, scenario.terrainSpecs);
    spawnPos =
      seedOverride !== undefined && effectiveWorldgen
        ? pickSpawn(effectiveWorldgen)
        : scenario.spawn;

    // The world singleton starts with no stocks of its own - global stocks are
    // overlay authoring (a scenario's worldStocks, a GM's set_stock), seeded by
    // applyOverlay once the world stands. Each token becomes a positioned, tagged
    // entity so the kernel's `colocated` gate can match it; a token's declared
    // reserves become stocks on that entity, so gathering can drain it dry.
    let entities: Record<string, Entity> = {
      world: {
        id: "world",
        tags: ["world"],
        stocks: {},
      },
    };
    // Resolve procedural tokenScatter into concrete tokens once, then drive both the
    // drainable token entities and the grid from the same expanded gen so they
    // agree on names, positions, and reserves.
    let worldgen = effectiveWorldgen
      ? expandWorldGen(effectiveWorldgen, spawnPos)
      : undefined;
    for (let s of worldgen?.tokens ?? [])
      entities[s.name] = {
        id: s.name,
        kind: s.kind,
        tags: s.tags,
        stocks: instantiate(s.stocks ?? {}),
        pos: { x: s.x, y: s.y },
      };

    // Seed the kernel's noise expressions from the active worldgen seed (so a
    // given world both looks and rolls the same on replay).
    world = { tick: 0, seed: activeSeed, entities };
    space = makeSpace(spawnPos, worldgen);
    resetKnownTerrains();
    meta = new Map();
    log = [];
    nextSeq = 0;
    gmLog = [];
    nextGmSeq = 0;
    rules = [...scenario.rules];
    dirtyRuleIds = new Set();
    history = []; // fills from the first tick onward
    terrainRevision = 0;
    tokenRevision = 0;
    orders = new Map();
    stockDefaults = {};
    spawnedFixtures = [];
    appliedSetup = [];
    actionIntroTick = new Map();
    // Expand the scenario's terrain kinds last, once the world and grid exist:
    // each spec sets its grid passability and move cost. GM-registered terrain
    // rides the overlay and is layered back on afterward by applyOverlay, which
    // re-applies the specs. Terrain colors ride the specs themselves
    // (TerrainSpec.visual), so the registry starts empty and fills as each spec
    // lands - there is no separate scenario terrainVisuals map anymore.
    terrainVisuals = {};
    for (let [kind, visual] of Object.entries(scenario.kindVisuals ?? {}))
      assertValidVisual(`kind "${kind}"`, visual);
    baseKindVisuals = structuredClone(scenario.kindVisuals ?? {});
    // A stock's look rides its own spec (StockSpec.icon/color) - sweep every
    // stock the scenario declares (the agent template, each generated token's
    // reserves, and each build action's spawn), so a resource declared there
    // needs no separate kindVisuals entry. An explicit kindVisuals entry wins.
    collectSpecVisuals(baseKindVisuals, agentTemplate.stocks);
    for (let s of worldgen?.tokens ?? [])
      collectSpecVisuals(baseKindVisuals, s.stocks);
    for (let rule of scenario.rules)
      if ("kind" in rule && rule.kind === "action" && Array.isArray(rule.do))
        for (let effect of rule.do)
          if (effect && typeof effect === "object" && "spawn" in effect)
            collectSpecVisuals(baseKindVisuals, effect.spawn.stocks);
    authoredKindVisuals = { ...baseKindVisuals };
    kindVisuals = { ...authoredKindVisuals };
    describeTemplates = { ...(scenario.describeEvent ?? {}) };
    displayHints = { ...(scenario.display ?? {}) };
    baseTerrainSpecs = structuredClone(scenario.terrainSpecs ?? {});
    terrainSpecs = {};
    reapplyTerrainSpecs(baseTerrainSpecs);
  }
  init();

  // --- entity/state helpers ---------------------------------------------

  let entity = (id: string) => world.entities[id];
  let isAlive = (id: string) => {
    let e = entity(id);
    return Boolean(e && hasTag(e, "agent"));
  };
  let hasAgent = (id: string) => meta.has(id);
  let isDead = (id: string) => hasAgent(id) && !isAlive(id);
  let diedAt = (id: string) => meta.get(id)?.diedAt ?? null;
  let agentIds = () => [...meta.keys()];
  let livingIds = () => agentIds().filter(isAlive);
  let stocksOf = (id: string) => entity(id).stocks;
  let posOf = (id: string) => entity(id).pos!;
  let worldStocks = () => world.entities.world.stocks;
  let displayName = (id: string) => meta.get(id)?.name ?? id;

  // Everything a player, GM, or dashboard reads shows stocks to one decimal.
  // The kernel keeps full precision internally (a rule may park a raw noise
  // draw in a stock), but tick math accumulates binary-float drift, and no
  // readout should ever show a health of 28.000000000000004.
  function roundedStocks(stocks: Record<string, Stock>): Record<string, Stock> {
    let out: Record<string, Stock> = {};
    for (let [name, s] of Object.entries(stocks))
      out[name] = { ...s, value: roundStock(s.value) };
    return out;
  }

  function requireAgent(id: string) {
    if (!meta.has(id)) throw new Error(`No agent named ${id}.`);
  }

  function instantiate(specs: EntityTemplate["stocks"]): Record<string, Stock> {
    let stocks: Record<string, Stock> = {};
    for (let [name, s] of Object.entries(specs))
      stocks[name] = stock(s.value, s.min, s.max);
    return stocks;
  }

  // --- terrain kinds: passability, move cost, tint ----------------------
  //
  // A TerrainSpec is expanded into concrete behavior here. This is the terrain
  // analog of the stock-visual / stock-default machinery: scenario specs are
  // applied at init; the GM's runtime additions (registerTerrain) ride the overlay
  // and are layered back after a reset. Everything an expansion touches - grid
  // passability, move cost, the map tint - is idempotent, so applying a spec twice
  // (a reset that re-projects onto an already-populated world, a snapshot restore)
  // is a no-op rather than a duplication. Terrain is only ground; anything
  // harvestable is a token on top, so a tile has no per-tile stock of its own.

  function rebuildKindVisuals() {
    kindVisuals = { ...authoredKindVisuals };
  }

  // Reconcile the complete terrain registry in one pass. Omitted fields restore
  // their defaults, removed specs lose all derived behavior, and policy changes
  // replan routes that still cross the affected terrain kind.
  function reconcileTerrainSpecs(nextSpecs: Record<string, TerrainSpec>) {
    for (let [name, spec] of Object.entries(nextSpecs))
      assertValidTerrainSpec(name, spec);

    let names = new Set([
      ...Object.keys(terrainSpecs),
      ...Object.keys(nextSpecs),
    ]);
    let policyChanges: string[] = [];
    for (let name of names) {
      let spec = nextSpecs[name];
      let wasImpassable = space.grid.impassable.has(name);
      let previousCost = space.grid.terrainCost.get(name) ?? 1;

      if (spec) terrainSpecs[name] = structuredClone(spec);
      else delete terrainSpecs[name];

      if (spec?.passable === false) space.grid.impassable.add(name);
      else space.grid.impassable.delete(name);
      if (spec?.moveCost !== undefined)
        space.grid.terrainCost.set(name, spec.moveCost);
      else space.grid.terrainCost.delete(name);
      if (spec?.visual) terrainVisuals[name] = structuredClone(spec.visual);
      else delete terrainVisuals[name];

      let isImpassable = space.grid.impassable.has(name);
      let nextCost = space.grid.terrainCost.get(name) ?? 1;
      if (wasImpassable !== isImpassable || previousCost !== nextCost)
        policyChanges.push(name);
    }

    resetKnownTerrains();
    rebuildKindVisuals();
    for (let name of policyChanges) replanRoutesForTerrain(space, world, name);
  }

  function applyTerrainSpec(name: string, spec: TerrainSpec) {
    reconcileTerrainSpecs({ ...terrainSpecs, [name]: spec });
  }

  function reapplyTerrainSpecs(all: Record<string, TerrainSpec>) {
    reconcileTerrainSpecs(all);
  }

  // The GM's runtime terrain additions: every spec that diverges from the scenario
  // base, so only the divergence rides the overlay (same discipline as the rule
  // and glyph diffs).
  function runtimeTerrainSpecs(): Record<string, TerrainSpec> {
    let out: Record<string, TerrainSpec> = {};
    for (let [name, spec] of Object.entries(terrainSpecs))
      if (JSON.stringify(baseTerrainSpecs[name]) !== JSON.stringify(spec))
        out[name] = structuredClone(spec);
    return out;
  }

  // Register (or replace) a terrain kind at runtime - the engine method the GM's
  // register_terrain tool drives. Applies it immediately and, because terrainSpecs
  // now diverges from the base, it rides the overlay onto the next reset.
  function registerTerrain(name: string, spec: TerrainSpec): { name: string } {
    if (!name || typeof name !== "string")
      throw new Error("registerTerrain: a terrain name is required.");
    assertValidTerrainSpec(name, spec);
    applyTerrainSpec(name, spec);
    recordGm("terrain_registered", `registered terrain "${name}"`, {
      target: name,
      detail: { terrain: name, spec },
    });
    return { name };
  }

  function registerKindVisual(
    kind: string,
    visual: Visual,
  ): {
    kind: string;
    visual: Visual;
  } {
    let normalized = kind.trim();
    if (!normalized) throw new Error("A kind name is required.");
    if (!visual.sprite && !visual.icon && !visual.color && !visual.label)
      throw new Error(`Kind "${normalized}" needs at least one visual field.`);
    assertValidVisual(`kind "${normalized}"`, visual);
    authoredKindVisuals[normalized] = {
      ...authoredKindVisuals[normalized],
      ...visual,
    };
    rebuildKindVisuals();
    return { kind: normalized, visual: { ...kindVisuals[normalized] } };
  }

  // Paint a set of tiles to a terrain kind - the GM's set_terrain tool. Repaints
  // via the route-aware setTerrainAt. Painted terrain is world state (it rides the
  // snapshot), not overlay authoring, so a full colony reset - which rebuilds the
  // map from worldgen - starts it over.
  function setTerrainTiles(
    positions: Position[],
    terrain: string,
  ): { changed: number } {
    if (!terrain || typeof terrain !== "string")
      throw new Error("set_terrain: a terrain name is required.");
    requireTerrain(terrain);
    if (!Array.isArray(positions) || positions.length === 0)
      throw new Error("set_terrain: at least one tile is required.");
    let changed = 0;
    for (let p of positions)
      if (setTerrainAt(space, world, p.x, p.y, terrain)) changed += 1;
    if (changed) terrainRevision += 1;
    recordGm("terrain_painted", `painted ${changed} tile(s) to ${terrain}`, {
      target: terrain,
      detail: { terrain, tiles: positions.length, changed },
    });
    return { changed };
  }

  function requireTerrain(name: string) {
    if (!knownTerrains.has(name))
      throw new Error(
        `Unknown terrain "${name}". Register it before painting.`,
      );
  }

  function resetKnownTerrains() {
    let grid = space.grid;
    knownTerrains = new Set([
      grid.fill,
      ...grid.impassable,
      ...grid.terrainCost.keys(),
    ]);
    for (let row of grid.tiles)
      for (let tile of row) knownTerrains.add(tile.terrain);
    // Registered specs stay known even when passable, cost-1, and unpainted -
    // the grid alone carries no trace of them. (terrainSpecs is still unset
    // the first time init() runs; reapplyTerrainSpecs re-resets right after.)
    for (let name of Object.keys(terrainSpecs ?? {})) knownTerrains.add(name);
  }

  // Harvest icon/color off a record of stock specs into the kind-tag registry,
  // skipping specs that carry neither and tags that already have an entry
  // (first-wins, per the StockSpec contract - later mentions of the same
  // resource share the established look).
  function collectSpecVisuals(
    into: Record<string, Visual>,
    specs?: Record<string, { icon?: string; color?: string }>,
  ) {
    for (let [name, s] of Object.entries(specs ?? {})) {
      if (name in into) continue;
      if (!s?.icon && !s?.color) continue;
      into[name] = {
        ...(s.icon ? { icon: s.icon } : {}),
        ...(s.color ? { color: s.color } : {}),
      };
    }
  }

  function stockVisual(
    stockName: string,
    icon?: string,
    color?: string,
  ): Visual | undefined {
    if (icon !== undefined) {
      let normalizedIcon = typeof icon === "string" ? icon.trim() : "";
      if (!normalizedIcon || !/^[a-z0-9-]+$/.test(normalizedIcon))
        throw new Error(
          `An icon for "${stockName}" must be a game-icons.net slug (lowercase letters, digits, dashes - e.g. "wheat"), not "${String(icon)}".`,
        );
      icon = normalizedIcon;
    }
    if (!icon && !color) return undefined;
    return {
      ...(icon ? { icon } : {}),
      ...(color ? { color } : {}),
    };
  }

  // Record a non-terrain owner of a resource's look. The live registry is then
  // rebuilt with terrain-derived visuals underneath these explicit sources.
  function registerStockVisual(
    stockName: string,
    icon?: string,
    color?: string,
  ) {
    let visual = stockVisual(stockName, icon, color);
    if (!visual) return;
    authoredKindVisuals[stockName] = {
      ...authoredKindVisuals[stockName],
      ...visual,
    };
    rebuildKindVisuals();
  }

  // Gate the introduction of a resource on having an icon for it. If the caller
  // supplied one, register it; otherwise it's only allowed when the resource is
  // already known. This is what makes a GM choose an icon the moment they bring
  // a brand-new resource into the world, while leaving edits to an existing one
  // (set fire to 0) icon-free.
  function ensureIconFor(stockName: string, icon?: string, color?: string) {
    let visual = stockVisual(stockName, icon, color);
    if (!visual?.icon && !kindVisuals[stockName]?.icon)
      throw new Error(
        `Introducing the new resource "${stockName}" needs an "icon" — a game-icons.net slug (e.g. "wheat") to represent it on the dashboard.`,
      );
    if (visual) registerStockVisual(stockName, visual.icon, visual.color);
  }

  // Fill in any GM-registered per-agent stock the template didn't already supply.
  // Template stocks win - a default never clobbers a scenario stock like health -
  // so this only adds the GM's additive layer (warmth, wood, ...) to a fresh set.
  function withStockDefaults(
    stocks: Record<string, Stock>,
  ): Record<string, Stock> {
    for (let [name, s] of Object.entries(stockDefaults))
      if (!stocks[name]) stocks[name] = stock(s.value, s.min, s.max);
    return stocks;
  }

  // --- event log --------------------------------------------------------

  function push(
    event: Omit<GameEvent, "seq" | "tick" | "wake"> & {
      wake?: GameEvent["wake"];
    },
  ) {
    log.push({
      seq: nextSeq,
      tick: world.tick,
      wake: event.wake ?? "decision",
      ...event,
    });
    nextSeq += 1;
    if (log.length > 50_000) log.shift();
  }

  function recentEvents(limit = 200) {
    return structuredClone(log.slice(-limit));
  }

  // Speculative-physics feed: every attempt at a verb no rule defines yet,
  // clustered by verb so a synthesis seat can see consensus at a glance
  // instead of wading through the general event log for it. Reads the same
  // `log` every other GM query draws from - no separate storage, and the
  // usual 50k trim bounds it like everything else here.
  function getSpeculativeAttempts() {
    let clusters = new Map<
      string,
      {
        verb: string;
        count: number;
        distinctActors: string[];
        firstTick: number;
        lastTick: number;
        expectations: string[];
        sampleArgs: Record<string, string | number>[];
      }
    >();
    for (let event of log) {
      if (event.type !== "speculative_attempt" || !event.verb) continue;
      let cluster = clusters.get(event.verb);
      if (!cluster) {
        cluster = {
          verb: event.verb,
          count: 0,
          distinctActors: [],
          firstTick: event.tick,
          lastTick: event.tick,
          expectations: [],
          sampleArgs: [],
        };
        clusters.set(event.verb, cluster);
      }
      cluster.count += 1;
      cluster.lastTick = event.tick;
      if (event.agentId && !cluster.distinctActors.includes(event.agentId))
        cluster.distinctActors.push(event.agentId);
      if (
        event.expectation &&
        cluster.expectations.length < 8 &&
        !cluster.expectations.includes(event.expectation)
      )
        cluster.expectations.push(event.expectation);
      if (event.args && cluster.sampleArgs.length < 8)
        cluster.sampleArgs.push(event.args);
    }
    return [...clusters.values()].sort((a, b) => b.count - a.count);
  }

  // The other half of speculative physics: minting a verb has to reach the
  // people who speculated it. An attempt is a standing intent, not a one-off -
  // so when a rule arrives answering to a word someone tried, every living
  // attempter is told, in fiction, that the world learned it.
  //
  // News, not an alarm. The event carries a `decision` wake, which is enough to
  // pull a parked character out of wait_for_change on its own; their in-flight
  // action and running order are left alone. Stopping their hands for this
  // would be the world insisting they care right now, when a granted speculation is
  // something to weigh against whatever they are already doing. For the same
  // reason we do not replay the action for them: the attempt was made in a
  // world that refused it, and re-forming the intent under the physics that now
  // exists is the character's call. The telling is the whole fix - without it a
  // granted speculation sits undiscovered (genesis run 5d121c3a: build_tower ratified
  // at tick 2253 after three petitions, then used zero times in the 1,200 ticks
  // that followed, because nobody told Haven).
  //
  // The event log is the ledger for both halves - attempts and their
  // redemptions - so this survives a restore and cannot double-fire when a
  // later tweak_rule re-sends the same alias list. A redemption records every
  // word it settles in `verbs`, not just the one it names: somebody who tried
  // three synonyms for one idea gets one wake, and all three words are spent.
  function redeemSpeculativeAttempts(rule: Rule): string[] {
    if (!("kind" in rule) || rule.kind !== "action") return [];
    let names = new Set<string>([rule.id, ...(rule.aliases ?? [])]);
    let claimed = new Set<string>();
    for (let event of log) {
      if (event.type !== "speculation_realized") continue;
      if (event.verb) claimed.add(event.verb);
      for (let verb of event.verbs ?? []) claimed.add(verb);
    }
    // Every unclaimed word each attempter tried, oldest first, so the news can
    // name their most recent guess rather than the canonical name they never
    // used - while still spending the earlier synonyms.
    let owed = new Map<string, string[]>();
    for (let event of log) {
      if (event.type !== "speculative_attempt" || !event.verb) continue;
      if (!names.has(event.verb) || claimed.has(event.verb)) continue;
      if (!event.agentId || !isAlive(event.agentId)) continue;
      let words = owed.get(event.agentId);
      if (!words) owed.set(event.agentId, (words = []));
      if (!words.includes(event.verb)) words.push(event.verb);
    }
    for (let [id, verbs] of owed) {
      let verb = verbs[verbs.length - 1];
      let news =
        verb === rule.id
          ? `the world has learned ${verb} - what you tried before will take now`
          : `the world has learned ${rule.id}, the thing you were reaching for when you tried ${verb} - it will take now`;
      push({
        type: "speculation_realized",
        agentId: id,
        verb,
        ...(verbs.length > 1 ? { verbs } : {}),
        text: `${displayName(id)} feels the world give: ${news}.`,
        wake: "decision",
      });
    }
    return [...owed.keys()];
  }

  // Append to the GM audit trail. Called by the god-power methods below (which
  // carry the before/after detail) and by the host for session bookends
  // (gm_joined / gm_left). Bounded like the character log, but far smaller - a GM
  // acts a few times a session, not many times a tick.
  function recordGm(
    kind: GmEvent["kind"],
    summary: string,
    fields: Pick<GmEvent, "target" | "detail"> = {},
  ) {
    gmLog.push({ seq: nextGmSeq, tick: world.tick, kind, summary, ...fields });
    nextGmSeq += 1;
    if (gmLog.length > 5_000) gmLog.shift();
  }

  function recentGmEvents(limit = 200) {
    return structuredClone(gmLog.slice(-limit));
  }

  // The GM-stream half of a GM waiter's cursor pair (see gmCursor). The trail is
  // capped at 5k and a GM acts a few times a session, so a linear filter is fine.
  function gmEventsSince(cursor: number): GmEvent[] {
    return structuredClone(gmLog.filter((e) => e.seq >= cursor));
  }

  // Append a sample of the current world stocks and population to the trend ring,
  // dropping the oldest once the cap is reached.
  function recordHistory() {
    let stocks: Record<string, number> = {};
    for (let [name, s] of Object.entries(worldStocks()))
      stocks[name] = roundStock(s.value);
    history.push({ tick: world.tick, population: livingIds().length, stocks });
    if (history.length > HISTORY_CAP) history.shift();
  }

  function eventsSince(cursor: number): GameEvent[] {
    let lo = 0;
    let hi = log.length;
    while (lo < hi) {
      let mid = (lo + hi) >> 1;
      if (log[mid].seq < cursor) lo = mid + 1;
      else hi = mid;
    }
    return log.slice(lo);
  }

  function getEventsSince(cursor: number) {
    return structuredClone(eventsSince(cursor));
  }

  // The oldest seq still retained in the in-memory ring - a cursor older than
  // this has fallen off the ring (trimmed at 50k) and needs the journal to
  // fill the gap. Equal to the live cursor when the log is empty (nothing has
  // fallen off because nothing has happened yet).
  function oldestSeq(): number {
    return log.length ? log[0].seq : nextSeq;
  }

  // The cursor that replays roughly the last `ticks` ticks of history. Used to
  // backfill a returning (reincarnated) character: its body kept living while its
  // session was away, so on rejoin we rewind its cursor to here and let the
  // normal delivery hand back what changed during the gap, visibility-filtered
  // as usual. Clamped to the live cursor for a non-positive or empty window.
  function backfillCursor(ticks: number): number {
    if (ticks <= 0) return nextSeq;
    let floor = world.tick - ticks;
    for (let event of log) if (event.tick >= floor) return event.seq;
    return nextSeq;
  }

  // Whether a logged event reaches a given agent. Rule errors and join/leave
  // bookkeeping are GM-only; a character's own action lifecycle is actor-only;
  // whispers are directed; speech and witnessed activity are scoped to the tiles
  // they happened on (earshot for words, SIGHT for deeds). Only world-level
  // events with no located actor stay colony-wide.
  function visibleTo(event: GameEvent, agentId: string | null): boolean {
    // Engine diagnostics: a broken rule is the GM's problem to fix, not
    // something a character perceives in-world. It rides the global log the GM
    // dashboard reads (recentEvents), but reaches no character's observe stream.
    if (event.type === "rule_error") return false;
    // Arrivals and departures are session bookkeeping, not in-world drama. Under
    // the reincarnation loop a player routinely ends a session and rejoins later,
    // so surfacing every join/leave would spam the shared feed with churn no
    // character should react to. They still ride the GM dashboard log
    // (recentEvents); they just never reach a character's observe stream.
    if (event.type === "joined" || event.type === "left") return false;
    // A character's own action lifecycle and scouting stay private to the actor -
    // noise control, not realism: broadcasting every "begins to gather (3s)" to
    // the whole colony would bury the shared feed.
    if (SUBSTRATE_ACTOR_ONLY.has(event.type)) return event.agentId === agentId;
    // Speech carries EARSHOT tiles: heard by the speaker and whoever the
    // audience stamp caught within range at the moment of speech.
    if (event.type === "said")
      return (
        event.agentId === agentId ||
        (event.audience ?? []).includes(agentId as string)
      );
    // Whisper is the private channel: heard only by sender and target.
    if (event.type === "whispered")
      return event.agentId === agentId || event.target === agentId;
    // A GM herald: world-wide with no audience, or addressed to named characters.
    if (event.type === "announced")
      return (
        event.audience === undefined ||
        (event.audience ?? []).includes(agentId as string)
      );
    // Everything else is the scenario's witnessed activity (`ate`, `chopped`,
    // `fought`, ...) and world happenings. These default to LOCAL: perceived
    // only by the actor and whoever stood within SIGHT when it happened (the
    // audience stamp from witnessAudience) - the same locus model speech uses,
    // one tenet ("you know only what you have seen") applied to deeds as well as
    // words. Colony-wide reach is opt-in: a scenario marks an event `global`
    // when it is a world-level happening no one stands at (a season turning, a
    // victory declared). Local is the safe default - a newly authored event type
    // is scoped unless it explicitly opts out, so visibility can't silently leak.
    if (event.global) return true;
    return (
      event.agentId === agentId ||
      (event.audience ?? []).includes(agentId as string)
    );
  }

  // Who witnessed a located act: the living characters within SIGHT of the actor
  // when it happened, stamped onto the event like the earshot audience on
  // speech. Returns undefined when there is no located actor - a world-level
  // event (a stock threshold, weather, a victory) or an actor destroyed in the
  // same breath it emitted - so such events keep their colony-wide reach.
  function witnessAudience(actorId: string | undefined): string[] | undefined {
    if (!actorId) return undefined;
    let pos = entity(actorId)?.pos;
    if (!pos) return undefined;
    return livingIds().filter(
      (o) =>
        o !== actorId &&
        chebyshev(pos.x, pos.y, posOf(o).x, posOf(o).y) <= SIGHT,
    );
  }

  // Render a raw kernel/space event into a host event with a name, prose, and
  // visibility. Substrate spatial events are rendered here; the scenario's own
  // events get their text from scenario.describeEvent, then the rule's emit
  // text, then a generic fallback.
  function enrich(raw: KernelEvent) {
    let id = raw.entity;
    let name = id ? displayName(id) : undefined;

    if (raw.type === "moved") return;

    if (raw.type === "arrived") {
      push({
        type: raw.type,
        agentId: id,
        text: `${name} ${raw.text}.`,
        wake: eventWakeFor(id),
      });
      return;
    }
    if (raw.type === "scanned") {
      push({
        type: raw.type,
        agentId: id,
        text: `${name} scans the area.`,
        wake: eventWakeFor(id),
      });
      return;
    }
    if (raw.type === "action_failed") {
      push({
        type: raw.type,
        agentId: id,
        text: `${name}'s action could not complete${raw.text ? `: ${raw.text}` : ""}.`,
        wake: eventWakeFor(id),
      });
      return;
    }
    if (raw.type === "rule_error") {
      // visibleTo keeps this off every character's stream; it surfaces only in
      // the GM dashboard's log so a director can spot and fix the bad rule while
      // the colony keeps ticking around it.
      let rule = raw.args?.rule;
      let who = name ? ` on ${name}` : "";
      push({
        type: raw.type,
        agentId: id,
        text: `Rule "${rule}" failed${who}: ${raw.text ?? "unknown error"}.`,
        wake: "routine",
      });
      return;
    }

    let template = describeTemplates[raw.type];
    // An `adjust` effect tagged `as: "targetId"` (or any other `*Id` capture)
    // resolves here to a `*Name` a describeEvent template can interpolate, e.g.
    // "{{ ctx.name }} strikes at {{ ctx.args.targetName }}."
    let args = { ...(raw.args ?? {}) };
    for (let key of Object.keys(args)) {
      if (!key.endsWith("Id") || typeof args[key] !== "string") continue;
      let nameKey = `${key.slice(0, -2)}Name`;
      if (!(nameKey in args)) args[nameKey] = displayName(args[key] as string);
    }
    // The emitting entity may already be gone: a rule can destroy itself and
    // emit in the same breath (a deer starving, a building collapsing), so its
    // stocks render as empty rather than crashing the tick.
    let prose =
      template &&
      renderTemplate(template, {
        name: name ?? id ?? "",
        stocks: id && entity(id) ? roundedStocks(stocksOf(id)) : {},
        world: roundedStocks(worldStocks()),
        args,
      });
    let text =
      (prose || undefined) ?? raw.text ?? `${name ?? "the world"} ${raw.type}`;
    let audience = witnessAudience(id);
    push({
      type: raw.type,
      agentId: id,
      ...(audience === undefined ? {} : { audience }),
      ...(raw.global ? { global: true } : {}),
      text,
      wake: eventWakeFor(id),
    });
  }

  function eventWakeFor(agentId: string | undefined): GameEvent["wake"] {
    if (!agentId) return "decision";
    return orders.get(agentId)?.status === "running" ? "routine" : "decision";
  }

  // A rule emit marked `interrupt` is an alarm loud enough to stop hands: the
  // subject's in-flight action is abandoned, their running order finishes as
  // "interrupted", and the reason rides along so the wake that follows is a
  // decision point, not a mystery. Watch rules fire on fresh crossings only,
  // so the alarm cannot trip again against the recovery order it just forced -
  // it re-arms once the condition clears.
  function applyEmittedInterrupt(raw: KernelEvent) {
    let id = raw.entity;
    if (!raw.interrupt || !id || !isAlive(id)) return;
    interruptAgent(id, raw.interrupt);
  }

  // Stop one agent's hands and force a decision wake. Shared by the watch-rule
  // alarm above and by speculation redemption, which is the other thing in this
  // world urgent enough to be worth breaking an order for.
  function interruptAgent(id: string, reason: string) {
    if (!isAlive(id)) return;
    let actor = entity(id);
    if (actor.action) {
      push({
        type: "action_abandoned",
        agentId: id,
        text: `${displayName(id)} abandons ${actor.action.type}: ${reason}.`,
      });
      // Stopping mid-stride also drops the path, exactly as committing a new
      // action would.
      actor.action = null;
      space.moves.delete(id);
    }
    interruptRunningOrder(orderContext(), id, reason);
  }

  // --- the clock --------------------------------------------------------

  function tick() {
    let from = nextSeq;
    let before = beginTick(world);
    let raw = advanceSpace(space, world, []);
    let live = rules;
    runRulesForTick(
      world,
      live,
      before,
      raw,
      terrainAt,
      writeTerrain,
      revealFog,
      passableAt,
    );
    // Project any entities the rules spawned/destroyed this tick onto the grid,
    // so a built structure becomes a discoverable token and a razed one vanishes.
    // A token that changed may have blocked a tile (a wall raised, a hearth
    // built), so re-route anyone whose path now runs through solid ground.
    if (syncTokens(space, world)) {
      tokenRevision += 1;
      replanRoutesForSolids(space, world);
    }
    for (let event of raw) enrich(event);
    // Alarms loud enough to stop hands (a watch emit marked `interrupt`) land
    // after the prose so the feed reads cause then effect, and before orders
    // advance so an interrupted order commits nothing further this tick.
    for (let event of raw) applyEmittedInterrupt(event);
    // An agent that lost its "agent" tag this tick (a scenario death rule) is now
    // gone from the living roster; stamp the moment for ticksLived.
    for (let id of agentIds()) {
      let m = meta.get(id)!;
      if (m.diedAt === null && !isAlive(id)) m.diedAt = world.tick;
    }
    // A rule this tick may have requested a world reroll (the `regenerate`
    // effect, deferred so every other effect settled against the old world
    // first). Perform it now, before orders advance - the survivors are about to
    // be relocated and their orders cleared, so stepping them once more would be
    // wasted motion on a map that no longer exists.
    if (world.pendingRegen !== undefined) {
      let seed = world.pendingRegen;
      delete world.pendingRegen;
      regenerate(seed);
    }
    // A rule may also have asked to extend the frontier (`growWorld`). Runs after
    // any regenerate, so a reroll-then-grow in one tick grows the fresh map.
    if (world.pendingGrow !== undefined) {
      let growth = world.pendingGrow;
      delete world.pendingGrow;
      growWorld(growth);
    }
    // Alarms before orders advance: a character whose thirst just turned
    // critical should be awake to re-plan this tick, not one tick late.
    raiseVitalAlarms();
    advanceEngineOrders(orderContext());
    recordHistory();
    return { tick: world.tick, events: getEventsSince(from) };
  }

  // The escalation ladder. A character reads its gauges only when something
  // wakes it, so a band it crosses while parked is a band it never learns
  // about - the run where Ara sat from tick 9 to tick 2001 woke exactly once,
  // at the scenario's own starving rule, long past the point of acting on it.
  // Every worsening crossing is decision-grade; recovery is silent, and a band
  // already announced never repeats until the gauge climbs back out of it.
  function raiseVitalAlarms() {
    for (let id of agentIds()) {
      if (!isAlive(id)) {
        lastVitalBands.delete(id);
        continue;
      }
      let previous = lastVitalBands.get(id) ?? {};
      let current: Record<string, VitalBand> = {};
      for (let { name, band } of bandedStocks(
        entity(id).stocks,
        displayHints,
      )) {
        current[name] = band;
        // Lower index is worse: only a step DOWN the ladder is news.
        if (VITAL_BANDS.indexOf(band) < rankOfBand(previous[name]))
          push({
            type: "vitals_alarm",
            agentId: id,
            text: bandSentence(name, band, displayHints[name]),
            wake: "decision",
          });
      }
      lastVitalBands.set(id, current);
    }
  }

  // An unbanded gauge is the best possible standing, so it ranks past the
  // worst band - anything entering a band at all is a worsening.
  function rankOfBand(band: VitalBand | undefined): number {
    return band ? VITAL_BANDS.indexOf(band) : VITAL_BANDS.length;
  }

  // --- roster -----------------------------------------------------------

  function addAgent(name: string) {
    let id = normalizeId(name);
    if (meta.has(id)) throw new Error(`${id} is already taken.`);
    let tags = agentTemplate.tags.includes("agent")
      ? [...agentTemplate.tags]
      : ["agent", ...agentTemplate.tags];
    // Standing is exclusive, so a character joining a clearing that already holds
    // others fans out to the nearest open tile instead of stacking on the spawn.
    let taken = Object.values(world.entities)
      .filter((e) => hasTag(e, "agent") && e.pos)
      .map((e) => e.pos!);
    world.entities[id] = {
      id,
      kind: agentTemplate.kind,
      tags,
      stocks: withStockDefaults(instantiate(agentTemplate.stocks)),
      pos: freeSpawnNear(space.grid, spawnPos, taken),
      action: null,
    };
    // A fresh character perceives only what ordinary sight reaches from spawn;
    // it must explore to find food and everything else.
    spawn(space, id, world.tick);
    meta.set(id, {
      name: name.trim(),
      spawnTick: world.tick,
      diedAt: null,
    });
    // A join is a colony-wide event under the co-op framing: the whole team sees
    // a new character arrive, the way a co-op lobby shows a player joining.
    push({
      type: "joined",
      agentId: id,
      text: `${name.trim()} joins the colony.`,
    });
    return { id, observation: getObservation(id) };
  }

  // Voluntary departure: a living character leaves the world cleanly. Unlike
  // death it leaves no corpse - the entity, its metadata, and its spatial state
  // are erased, so it stops being ticked (no more starving while the owner is
  // gone) and its name frees up for a fresh join. Like a join, the departure is
  // a colony-wide event: the whole team sees a character leave.
  function removeAgent(id: string) {
    requireAgent(id);
    let lived = ticksLived(id);
    let name = displayName(id);
    push({
      type: "left",
      agentId: id,
      text: `${name} departs.`,
    });
    delete world.entities[id];
    meta.delete(id);
    orders.delete(id);
    space.fog.delete(id);
    // The departed character's fog book is gone; nudge the fog stream so the
    // dashboard drops their reveal (and any tiles only they had seen from the
    // union) on its next poll. Terrain and tokens are untouched by a departure.
    space.fogRevision += 1;
    space.moves.delete(id);
    return { id, ticksLived: lived };
  }

  // --- actions ----------------------------------------------------------

  // give is a native verb (like travel), not a scenario rule - it walks to a
  // named character and hands over a resource. Registering it here makes it a
  // first-class, order-schedulable action alongside the scenario's own verbs.
  const giveAction: ActionDescriptor = {
    name: "give",
    kind: "give",
    description:
      "Hand a carried resource to another character, walking to them first if they are out of arm's reach; moves as much as their pack can hold.",
    params: [
      {
        name: "target",
        type: "entity",
        required: true,
        description: "the character to hand it to",
        match: { tag: "agent", includeSelf: false, visible: false },
      },
      {
        name: "item",
        type: "enum",
        from: "stockpilable",
        required: true,
        description: "which carried resource to hand over",
      },
    ],
  };

  function actionRegistry(): ActionDescriptor[] {
    return [
      ...movementActions.map((m) => ({ ...m, kind: "movement" as const })),
      giveAction,
      ...actionRules(rules).map((r) => ({
        name: r.id,
        kind: "stock" as const,
        description: r.description ?? r.id,
        params: r.params ?? [],
        ...(r.aliases?.length ? { aliases: r.aliases } : {}),
      })),
    ];
  }

  function actionContext(): EngineActionContext {
    return {
      world,
      space,
      rules,
      actionIntroTick,
      actionRegistry,
      entity,
      displayName,
      stockpilableStockNames,
      terrainAt,
    };
  }

  function orderContext(): EngineOrderContext {
    return {
      orders,
      tick: () => world.tick,
      nextSeq: () => nextSeq,
      livingIds,
      requireAgent,
      isAlive,
      agentHasAction: (id) => Boolean(entity(id).action),
      displayName,
      stocksOf,
      worldStocks,
      locationOf: (id) => tokenNameAt(space.grid, posOf(id)) ?? undefined,
      commitPrimitiveIntent,
      visibleEventsSince: (id, cursor) => visibleEventsSince(id, cursor),
      actionCanStart,
      push,
    };
  }

  // Canonical names win over aliases, so a later action can never shadow an
  // existing one by aliasing its name (addRule refuses that collision anyway).
  function findAction(name: string): ActionDescriptor | undefined {
    let registry = actionRegistry();
    return (
      registry.find((a) => a.name === name) ??
      registry.find((a) => a.aliases?.includes(name))
    );
  }

  // Every name an action answers to must be unique across the whole registry -
  // two actions claiming "mine" would make which one runs an ordering accident.
  // `replacing` exempts the rule being patched from colliding with itself.
  function assertActionNamesFree(rule: Rule, replacing?: string) {
    if (!("kind" in rule) || rule.kind !== "action") return;
    let taken = new Map<string, string>();
    for (let action of actionRegistry()) {
      if (action.name === replacing) continue;
      taken.set(action.name, action.name);
      for (let alias of action.aliases ?? []) taken.set(alias, action.name);
    }
    for (let name of [rule.id, ...(rule.aliases ?? [])]) {
      let owner = taken.get(name);
      if (owner)
        throw new Error(
          `The action name "${name}" is already taken by "${owner}".`,
        );
    }
  }

  function commitIntent(id: string, action: ActionInput) {
    return commitPrimitiveIntent(id, action, "decision", () =>
      cancelOrderRuntime(orderContext(), id, "manual action"),
    );
  }

  // Whether another standing character occupies a tile - a tile they hold is one
  // this actor cannot stop on (standing is exclusive).
  function tileHeldByOther(tile: Position, exceptId: string): boolean {
    return Object.values(world.entities).some(
      (e) =>
        e.id !== exceptId &&
        hasTag(e, "agent") &&
        e.pos?.x === tile.x &&
        e.pos?.y === tile.y,
    );
  }

  // Where the actor would actually end up if it walked to `tile`: the tile
  // itself when free, else the first free passable neighbour (matching the
  // runtime's arrival sidestep), or null when nothing there is stand-able.
  function reachableStand(id: string, tile: Position): Position | null {
    if (!tileHeldByOther(tile, id)) return tile;
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        let n = { x: tile.x + dx, y: tile.y + dy };
        if (passable(space.grid, n.x, n.y) && !tileHeldByOther(n, id)) return n;
      }
    return null;
  }

  // The entity occupying a tile's token slot, if any - the occupancy oracle
  // checkAction uses to refuse raising a token on exclusive ground (a sign).
  function tokenEntityAt(x: number, y: number): Entity | undefined {
    let name = tokenNameAt(space.grid, { x, y });
    return name ? world.entities[name] : undefined;
  }

  // Would `type` pass its commit gate if the actor stood at `tile`? Re-checks
  // with the actor hypothetically moved there, restoring its real position
  // afterwards. This is how implicit approach knows whether walking somewhere
  // would actually unblock the action, so it never walks toward a failure that
  // isn't about distance (an empty pack, the wrong season).
  function actionWouldApplyAt(
    id: string,
    type: string,
    args: Args,
    tile: Position,
  ): boolean {
    let actor = entity(id);
    let saved = actor.pos;
    actor.pos = { x: tile.x, y: tile.y };
    try {
      return checkAction(world, rules, id, type, args, terrainAt, tokenEntityAt)
        .applicable;
    } finally {
      actor.pos = saved;
    }
  }

  // RTS smart-command: when an action fails only because its target is out of
  // reach, find the nearest thing worth walking to and return the travel
  // location that would close the gap - or null when no walk fixes it. Reads
  // the action's `requires` for the tags/terrains it gates on, gathers the
  // matching places the actor knows, and only commits to one whose arrival tile
  // would actually satisfy the gate.
  function approachLocationFor(
    id: string,
    type: string,
    args: Args,
  ): string | null {
    let rule = actionRules(rules).find((r) => r.id === type);
    if (!rule?.requires) return null;
    let actor = entity(id);
    if (!actor.pos) return null;
    let want = approachTargets(rule.requires, world, actor, args);
    if (!want.tags.length && !want.terrains.length) return null;

    let candidates: { location: string; distance: number }[] = [];
    for (let token of knownTokens(space, id, actor.pos, world.tick))
      if (want.tags.some((tag) => hasTag(token, tag)))
        candidates.push({ location: token.name, distance: token.distance });
    for (let other of Object.values(world.entities)) {
      if (other.id === id || !other.pos || !hasTag(other, "agent")) continue;
      if (want.tags.some((tag) => hasTag(other, tag)))
        candidates.push({
          location: other.id,
          distance: chebyshev(
            actor.pos.x,
            actor.pos.y,
            other.pos.x,
            other.pos.y,
          ),
        });
    }
    for (let terrain of want.terrains)
      candidates.push({ location: terrain, distance: Number.MAX_SAFE_INTEGER });
    candidates.sort((a, b) => a.distance - b.distance);

    for (let candidate of candidates) {
      let plan = planMove(space, world, id, "travel", {
        location: candidate.location,
      });
      if (!plan.ok || !plan.path?.length) continue;
      let stand = reachableStand(id, plan.path[plan.path.length - 1]);
      if (stand && actionWouldApplyAt(id, type, args, stand))
        return candidate.location;
    }
    return null;
  }

  // Speculative physics: the actor tried a verb no currently-loaded rule
  // defines. Rather than hard-fail the order, journal the attempt (verb, the
  // actor's stated expectation if it gave one, and the rest of its args) and
  // hand back an in-fiction non-event - the world doesn't understand yet, but
  // nothing breaks and the order carries on. A synthesis seat reads
  // getSpeculativeAttempts() and may later add_rule the verb into existence;
  // once that happens this same call path just finds a spec and proceeds
  // normally. See docs/speculative-physics.md.
  // Both events this can emit are decision-grade regardless of how the attempt
  // arrived, so it takes no wake from its caller.
  function commitSpeculativeAttempt(
    id: string,
    type: string,
    action: ActionInput,
  ) {
    let { expectation, ...rest } = intentArgs(action) as Args & {
      expectation?: string | number;
    };
    let name = displayName(id);
    // Capabilities the actor already has, just not as order steps: reaching for
    // one is a protocol slip, not a guess about physics. Correct it in fiction
    // and keep it out of the attempt feed, which a director reads as demand.
    if (TOOL_VERBS.has(type)) {
      let text = `${name} means to ${type}, but that is something you do directly, not an order step.`;
      // Decision-grade whatever the caller's wake was: a correction only works
      // if the actor reads it, and routine churn is folded into a count.
      push({ type: "order_note", agentId: id, text, wake: "decision" });
      return {
        accepted: false as const,
        speculative: true as const,
        approaching: false,
        verb: type,
        message: text,
      };
    }
    let text = `${name} tries to ${type}. Nothing happens. The world does not respond to that... yet.`;
    push({
      type: "speculative_attempt",
      agentId: id,
      text,
      // The speculation is the whole point of the paradigm, so the speculator must SEE
      // that it went unanswered - an order step that folds into "(+2 routine)"
      // reads as success, and the agent re-orders a verb that does not exist.
      // Decision-grade regardless of how the attempt was made.
      wake: "decision",
      verb: type,
      ...(expectation !== undefined
        ? { expectation: String(expectation) }
        : {}),
      ...(Object.keys(rest).length ? { args: rest } : {}),
    });
    return {
      accepted: false as const,
      speculative: true as const,
      approaching: false,
      verb: type,
      message: text,
    };
  }

  function commitPrimitiveIntent(
    id: string,
    action: ActionInput,
    wake: GameEvent["wake"],
    onAccepted?: () => void,
  ) {
    requireAgent(id);
    if (!isAlive(id)) throw new Error(`${id} is no longer active.`);
    if (!action || typeof action !== "object")
      throw new Error("Action must be one object.");

    let requested = action.type;
    let spec = findAction(requested);
    if (!spec) return commitSpeculativeAttempt(id, requested, action);
    // A synonym resolves to the action's real name here, so everything
    // downstream - the kernel, the event text, order bookkeeping - only ever
    // sees canonical verbs, and the actor learns the world's word for it.
    let type = spec.name;

    let prior = entity(id).action;
    let args = intentArgs(action);
    validateActionArgs(actionContext(), id, spec, action);
    // give is a native hand-off, not a scenario stock rule: route it to its own
    // commit path, which transfers in arm's reach or walks to the recipient.
    if (spec.kind === "give")
      return commitGiveIntent(id, args, prior, wake, onAccepted);
    let result: { ok: boolean; error?: string; endsInTicks?: number };
    // When an implicit approach fires, the action we actually commit is a travel
    // toward the target; the caller (an order step) holds the original action
    // and retries it on arrival.
    let approachTo: string | null = null;
    if (spec.kind === "movement") {
      if (!isMovementActionName(type))
        throw new Error(`Unknown action "${type}".`);
      result = commitMove(space, world, id, type, {
        location: args.location as string,
        direction: args.direction as string,
        terrain: args.terrain as string | undefined,
      });
    } else {
      result = commit(world, rules, id, type, args, terrainAt, tokenEntityAt);
      if (!result.ok) {
        approachTo = approachLocationFor(id, type, args);
        if (approachTo) {
          let moved = commitMove(space, world, id, "travel", {
            location: approachTo,
          });
          if (moved.ok) result = moved;
          else approachTo = null;
        }
      }
    }

    if (!result.ok)
      throw new Error(result.error ?? `Cannot ${type} right now.`);

    onAccepted?.();
    let name = displayName(id);
    let committedType = approachTo ? "travel" : type;
    if (prior)
      push({
        type: "action_abandoned",
        agentId: id,
        text: `${name} abandons ${prior.type} to ${committedType}.`,
        wake,
      });
    let duration = result.endsInTicks!;
    push({
      type: "action_started",
      agentId: id,
      text: approachTo
        ? `${name} sets out to ${type}, approaching ${approachTo} (${duration}s).`
        : `${name} begins to ${type} (${duration}s).`,
      wake,
    });

    return {
      accepted: true,
      approaching: approachTo !== null,
      action: approachTo
        ? { type: "travel", params: { location: approachTo } }
        : { type, params: args },
      duration,
      endTick: world.tick + duration,
      endsInTicks: duration,
    };
  }

  // --- durable orders ---------------------------------------------------

  function setOrder(id: string, input: unknown) {
    return setEngineOrder(orderContext(), id, input);
  }

  function cancelOrder(id: string) {
    return cancelEngineOrder(orderContext(), id);
  }

  function getOrder(id: string) {
    return getEngineOrder(orderContext(), id);
  }

  function visibleEventsSince(
    id: string | null,
    cursor: number,
    options: VisibleEventsOptions = {},
  ) {
    let includeRoutine = options.includeRoutine ?? true;
    return structuredClone(
      eventsSince(cursor).filter(
        (event) =>
          (includeRoutine || event.wake !== "routine") && visibleTo(event, id),
      ),
    );
  }

  function actionCanStart(id: string, action: ActionInput | undefined) {
    return canStartAction(actionContext(), id, action);
  }

  // --- communication (free, instantaneous) ------------------------------

  // Speak: one short message heard by whoever stands within EARSHOT when it is
  // said - a shout across camp, not a broadcast. The hearers are stamped on the
  // event at the moment of speech (speech doesn't chase people who walk away).
  // Free and instant, but bounded by a per-tick send budget so a flood of free
  // chatter can't drown out the world. Speaking to empty air is allowed and
  // comes back with an empty heardBy - gathering listeners is part of the game.
  function speak(id: string, message: unknown) {
    requireAgent(id);
    if (!isAlive(id)) throw new Error(`${id} is no longer active.`);
    let text = validText(message);
    let use = speakUse.get(id);
    if (!use || use.tick !== world.tick) {
      use = { tick: world.tick, count: 0 };
      speakUse.set(id, use);
    }
    if (use.count >= SPEAK_BUDGET_PER_TICK)
      throw new Error(
        `Channel quiet: you may send at most ${SPEAK_BUDGET_PER_TICK} messages per tick. Wait for the world to advance.`,
      );
    use.count += 1;
    let here = posOf(id);
    let audience = livingIds().filter(
      (o) =>
        o !== id &&
        chebyshev(here.x, here.y, posOf(o).x, posOf(o).y) <= EARSHOT,
    );
    push({
      type: "said",
      agentId: id,
      audience,
      message: text,
      text: `${displayName(id)} says: "${text}"`,
    });
    return {
      ok: true,
      heardBy: audience.map((o) => displayName(o)),
      remaining: SPEAK_BUDGET_PER_TICK - use.count,
    };
  }

  // Whisper: a private message to one named character, heard by no one else.
  // Whispering means leaning in - the target must be within WHISPER_RANGE.
  // The trade against speak is privacy, not reach.
  function whisper(id: string, targetName: unknown, message: unknown) {
    requireAgent(id);
    if (!isAlive(id)) throw new Error(`${id} is no longer active.`);
    let target = normalizeId(typeof targetName === "string" ? targetName : "");
    if (target === id) throw new Error("Whisper target must be another agent.");
    if (!meta.has(target)) throw new Error(`No agent named ${target}.`);
    if (!isAlive(target))
      throw new Error(`${displayName(target)} is no longer active.`);
    let text = validText(message);
    let here = posOf(id);
    let there = posOf(target);
    let gap = chebyshev(here.x, here.y, there.x, there.y);
    if (gap > WHISPER_RANGE)
      throw new Error(
        `${displayName(target)} is too far away to whisper to (${gap} tiles, ${compass(there.x - here.x, there.y - here.y)}). Move onto their tile, or speak up.`,
      );
    push({
      type: "whispered",
      agentId: id,
      target,
      message: text,
      text: `${displayName(id)} whispers to ${displayName(target)}: "${text}"`,
    });
    return { ok: true, to: target };
  }

  // Inscribe: the durable member of the speak family. Writes (or rewrites) the
  // sign on the tile the writer stands on - a token entity carrying free text
  // that outlives its author and is read by whoever walks up to it later. The
  // sign itself is unsigned: the words carry whatever attribution they claim,
  // and only witnesses within SIGHT at the moment of writing (the event's
  // audience stamp) and the journal know who really held the chisel. Free and
  // instant like speech, but bounded to one writing per tick.
  function inscribe(id: string, message: unknown) {
    requireAgent(id);
    if (!isAlive(id)) throw new Error(`${id} is no longer active.`);
    let text = validInscription(message);
    let use = inscribeUse.get(id);
    if (!use || use.tick !== world.tick) {
      use = { tick: world.tick, count: 0 };
      inscribeUse.set(id, use);
    }
    if (use.count >= INSCRIBE_BUDGET_PER_TICK)
      throw new Error(
        "You have already written this tick. Wait for the world to advance.",
      );
    let here = posOf(id);
    let tokenHere = tokenNameAt(space.grid, here);
    let sign: Entity;
    let rewrote = false;
    if (tokenHere) {
      sign = entity(tokenHere);
      // Only a sign takes new writing. Any other token owns the tile's slot -
      // one token per tile is grid law, so the writer must step elsewhere.
      if (!hasTag(sign, "sign"))
        throw new Error(
          `${tokenHere} already stands here; move to an open tile to raise a sign.`,
        );
      rewrote = sign.text !== undefined;
    } else {
      let signId = freshId(world, "sign");
      // "exclusive" is the sign's ground-law: walkable (no "solid"), but the
      // tile is reserved - checkAction refuses to raise another token here.
      sign = {
        id: signId,
        kind: "sign",
        tags: ["token", "exclusive"],
        stocks: {},
        pos: { x: here.x, y: here.y },
        action: null,
      };
      world.entities[signId] = sign;
      if (syncTokens(space, world)) tokenRevision += 1;
    }
    use.count += 1;
    sign.text = text;
    // Witnesses see the act, never the words - reading takes walking up. The
    // journal keeps the true author under the command record.
    push({
      type: "inscribed",
      agentId: id,
      audience: witnessAudience(id),
      text: `${displayName(id)} ${rewrote ? "rewrites the words on" : "writes on"} ${sign.id}.`,
    });
    return { ok: true, sign: sign.id, rewrote };
  }

  // Validate a hand-off: the target must be another living character, the
  // resource must be transferable (stockpilable, so needs and status gauges are
  // barred), and the giver must actually carry some.
  function validateGive(
    id: string,
    targetName: unknown,
    stockName: unknown,
  ): { target: string; resource: string; source: Stock; destination: Stock } {
    requireAgent(id);
    if (!isAlive(id)) throw new Error(`${id} is no longer active.`);
    let target = normalizeId(typeof targetName === "string" ? targetName : "");
    if (target === id) throw new Error("Give target must be another agent.");
    if (!meta.has(target)) throw new Error(`No agent named ${target}.`);
    if (!isAlive(target))
      throw new Error(`${displayName(target)} is no longer active.`);

    let resource = typeof stockName === "string" ? stockName.trim() : "";
    if (!stockpilableStockNames().includes(resource))
      throw new Error(`${resource || "That stock"} cannot be transferred.`);

    let source = stocksOf(id)[resource];
    let destination = stocksOf(target)[resource];
    if (!source || !destination)
      throw new Error(`Both agents must be able to carry ${resource}.`);
    // Nothing to give means nothing walking would fix - fail now rather than
    // set out on a pointless approach.
    if (source.value - source.min <= 0)
      throw new Error(`You have no ${resource} to give.`);
    return { target, resource, source, destination };
  }

  // Move as much of the resource as will fit between two adjacent packs (the
  // caller has confirmed reach) - the deposit/gather idiom. Emits the
  // witnessed hand-off event.
  function transferStock(
    id: string,
    target: string,
    resource: string,
    source: Stock,
    destination: Stock,
  ): number {
    let moved = Math.min(
      Math.max(0, source.value - source.min),
      Math.max(0, destination.max - destination.value),
    );
    if (moved <= 0)
      throw new Error(`No ${resource} can move between these agents.`);

    source.value = clamp(source.value - moved, source.min, source.max);
    destination.value = clamp(
      destination.value + moved,
      destination.min,
      destination.max,
    );
    let transferred = roundStock(moved);
    // A handoff is a witnessed deed like any other: scoped to who stood within
    // SIGHT of the giver. The recipient is at TOUCH_RANGE, so always in the
    // audience; a distant character never sees the exchange.
    push({
      type: "given",
      agentId: id,
      target,
      audience: witnessAudience(id),
      text: `${displayName(id)} gives ${displayName(target)} ${transferred} ${resource}.`,
    });
    return transferred;
  }

  // give's commit path: the only way goods change hands, scheduled like any
  // other action (a one-off is a single-step sequence order). Out of reach it
  // approaches through the order-retry loop so the step re-fires on arrival
  // like any action that walked to its target. In reach it hands off at once -
  // instantaneous, so the order advances the same tick.
  function commitGiveIntent(
    id: string,
    args: Args,
    prior: Entity["action"],
    wake: GameEvent["wake"],
    onAccepted?: () => void,
  ) {
    let { target, resource, source, destination } = validateGive(
      id,
      args.target,
      args.item,
    );
    let name = displayName(id);
    let here = posOf(id);
    let there = posOf(target);
    if (chebyshev(here.x, here.y, there.x, there.y) > TOUCH_RANGE) {
      let moved = commitMove(space, world, id, "travel", { location: target });
      if (!moved.ok)
        throw new Error(
          `${displayName(target)} is too far away to receive ${resource}, and no route reaches them.`,
        );
      onAccepted?.();
      if (prior)
        push({
          type: "action_abandoned",
          agentId: id,
          text: `${name} abandons ${prior.type} to travel.`,
          wake,
        });
      push({
        type: "action_started",
        agentId: id,
        text: `${name} sets out to give, approaching ${displayName(
          target,
        )} (${moved.endsInTicks}s).`,
        wake,
      });
      return {
        accepted: true,
        approaching: true,
        action: { type: "travel", params: { location: target } },
        duration: moved.endsInTicks!,
        endTick: world.tick + moved.endsInTicks!,
        endsInTicks: moved.endsInTicks!,
      };
    }
    onAccepted?.();
    let transferred = transferStock(id, target, resource, source, destination);
    return {
      accepted: true,
      approaching: false,
      action: { type: "give", params: args },
      duration: 0,
      endTick: world.tick,
      endsInTicks: 0,
      transferred,
    };
  }

  // The GM's herald: a diegetic world voice with no body. Unlike speak it is not
  // tied to a tile - with no audience it reaches every character; addressed to
  // named characters it reaches only them. The text is delivered verbatim so the
  // director controls the tone (an omen, a season's turn), and like all
  // communication it is free and never advances the clock.
  function announce(message: unknown, audience?: unknown) {
    let text = validText(message);
    let to: string[] | undefined;
    if (audience !== undefined) {
      if (!Array.isArray(audience))
        throw new Error("announce audience must be a list of agent names.");
      to = audience.map((n) => normalizeId(n));
      for (let id of to)
        if (!meta.has(id)) throw new Error(`No agent named ${id}.`);
    }
    push({ type: "announced", audience: to, message: text, text });
    recordGm(
      "announced",
      to
        ? `announced to ${to ? to.join(", ") : "everyone"}: "${text}"`
        : `${text}`,
      { detail: { text, audience: to ?? null } },
    );
    return { ok: true, reached: to ? to.length : livingIds().length };
  }

  // --- free spatial reads -----------------------------------------------

  // Known tokens, with a token's remaining reserve attached for any token this
  // character is perceiving this tick. A token carries its resource as a stock
  // named after one of its tags (a "wood" token has a wood stock); we expose how
  // much is left so a character can tell a full tree from a nearly-chopped one -
  // but only when they can actually see the token (lastSeenTicksAgo === 0), so a
  // depletion figure is a live personal sighting, never read from stale memory.
  function knownTokensView(id: string, p: Position) {
    return knownTokens(space, id, p, world.tick).map((s) => {
      if (s.lastSeenTicksAgo !== 0) return s;
      let ent = world.entities[s.name];
      if (!ent) return s;
      // An inscription is served only from arm's reach, and only as a live
      // sighting: at SIGHT you see that a sign stands there, and remembering
      // what it said after walking away is the reader's own job (their memory
      // file), never the server's.
      let inscription =
        ent.text !== undefined && s.distance <= TOUCH_RANGE
          ? { inscription: ent.text }
          : {};
      // The token's resource: a stock named after one of its tags (or its
      // kind, for a token that IS its resource - a "wood" crate).
      let resource = [...(s.kind ? [s.kind] : []), ...s.tags].find(
        (t) => ent.stocks[t],
      );
      if (!resource) return { ...s, ...inscription };
      let stk = ent.stocks[resource];
      return {
        ...s,
        ...inscription,
        resource,
        remaining: roundStock(stk.value),
        capacity: stk.max,
      };
    });
  }

  function knownLocations(id: string) {
    requireAgent(id);
    let p = posOf(id);
    return structuredClone({
      tick: world.tick,
      locations: knownTokensView(id, p),
    });
  }

  function route(id: string, location: string) {
    requireAgent(id);
    return routeTo(space, id, posOf(id), location, world);
  }

  // What this character does NOT know: coverage, nearest never-seen ground,
  // most-unknown directions, stalest sector.
  function frontierView(id: string) {
    requireAgent(id);
    let view = frontier(space, id, posOf(id), world.tick);
    return structuredClone({
      sense: "frontier",
      tick: world.tick,
      ...view,
    });
  }

  // Sensing is reconciling the world against what this agent knows, and the
  // modes are the decision-shaped questions an agent actually asks - not data
  // buckets. `changes` (what happened since my cursor) lives in the
  // coordinator, which owns per-session cursors; everything else answers from
  // the agent's own knowledge, free, never advancing the world.
  function senseView(id: string, mode: string, arg?: string) {
    requireAgent(id);
    let p = posOf(id);
    switch (mode) {
      // Where am I, how am I, what's pressing - the envelope, and the same
      // composition the wake report renders.
      case "situation":
        return structuredClone({
          sense: "situation",
          tick: world.tick,
          you: agentView(id),
          here: tileSummary(p),
          // Every payload that carries `you` carries this too: without it prose
          // cannot tell a vital from a pack slot, and reads a full health bar
          // as cargo.
          display: displayHints,
          others: visibleOthers(id),
          heard: recentlyHeard(id).slice(-3),
          colony: coordinationLedger(id),
        });
      // What's around me right now - the sight map, plus live reserves only.
      // The map is the sole spatial channel: no bearing/distance prose rides
      // alongside for anything the grid already shows.
      case "surroundings":
        return structuredClone({
          sense: "surroundings",
          tick: world.tick,
          you: agentView(id),
          here: tileSummary(p),
          display: displayHints,
          grid: sightGrid(id),
          // Live reserves only; the map carries WHERE, so the bearing fields
          // are stripped rather than riding along in structuredContent.
          inSight: knownTokensView(id, p)
            .filter((t) => t.lastSeenTicksAgo === 0)
            .map(({ distance, direction, ...t }) => t),
          colony: coordinationLedger(id),
        });
      // Nearest <what> I know of - by resource tag or name fragment, plus
      // where I haven't looked, so "not found" points somewhere useful.
      case "find": {
        if (!arg)
          throw new Error(
            'sense find needs `what`: a resource tag like "wood" or a name fragment.',
          );
        let want = arg.trim().toLowerCase();
        let matches = knownTokensView(id, p).filter(
          (l) =>
            l.name.toLowerCase().includes(want) ||
            l.kind?.toLowerCase() === want ||
            l.tags.some((t) => t.toLowerCase() === want),
        );
        let fr = frontier(space, id, p, world.tick);
        return structuredClone({
          sense: "find",
          tick: world.tick,
          what: want,
          matches: matches.slice(0, 5),
          totalKnown: matches.length,
          unsearched: fr.unexplored.slice(0, 2).map((u) => u.direction),
        });
      }
      // Everything I know, age-stamped, plus how much of the world that
      // actually is.
      case "atlas": {
        let fr = frontier(space, id, p, world.tick);
        return structuredClone({
          sense: "atlas",
          tick: world.tick,
          locations: knownTokensView(id, p),
          coverage: fr.coverage,
        });
      }
      case "frontier":
        return frontierView(id);
      case "route": {
        if (!arg)
          throw new Error(
            "sense route needs `to`: a token name or terrain kind.",
          );
        return structuredClone({
          sense: "route",
          tick: world.tick,
          ...route(id, arg),
        });
      }
      default:
        throw new Error(
          `Unknown sense mode "${mode}". Modes: situation, surroundings, find, atlas, frontier, route, changes.`,
        );
    }
  }

  // --- projections ------------------------------------------------------

  function tileSummary(p: Position) {
    let tile = tileAt(space.grid, p.x, p.y);
    return {
      terrain: tile.terrain,
      token: tile.token ? { ...tile.token } : null,
    };
  }

  // An ego-centric ASCII slice of what's in sight: you at dead center, north
  // up, one glyph per tile. The compass+distance prose reads precisely but
  // forces the model to rebuild a mental grid; this hands it the grid directly.
  // Glyphs are assigned per render and spelled out in a legend, so any
  // scenario's terrains and token kinds render without a fixed table. Kept
  // single-char and separator-free so a full SIGHT slice stays compact.
  function sightGrid(id: string) {
    let p = posOf(id);
    let r = SIGHT;

    // The map is the only description of the surroundings, so identity must
    // ride on it: each visible character gets their own named legend entry
    // (tiles are standing-exclusive, so one occupant per tile).
    let agentTiles = new Map<string, string>(); // "x,y" -> display name
    for (let o of livingIds())
      if (o !== id) {
        let q = posOf(o);
        if (chebyshev(p.x, p.y, q.x, q.y) <= r)
          agentTiles.set(`${q.x},${q.y}`, displayName(o));
      }

    let legend = new Map<string, string>(); // glyph -> label
    let byLabel = new Map<string, string>(); // label -> glyph, for reuse
    let used = new Set<string>(["@", ".", " "]);
    let pool = "abcdefghijklmnopqrstuvwxyz0123456789+*=%#$?!";

    // Hand out a stable glyph for a label, preferring its own first letter.
    // Tokens ask for uppercase, terrain for lowercase, so the two rarely
    // collide; the legend is the source of truth either way.
    function glyphFor(label: string, upper: boolean): string {
      let existing = byLabel.get(label);
      if (existing) return existing;
      let first = (label[0] ?? "?").toLowerCase();
      let preferred = upper ? first.toUpperCase() : first;
      let glyph =
        /[a-z0-9]/i.test(preferred) && !used.has(preferred) ? preferred : "";
      if (!glyph)
        for (let c of pool)
          if (!used.has(c)) {
            glyph = c;
            break;
          }
      if (!glyph) glyph = "?";
      used.add(glyph);
      legend.set(glyph, label);
      byLabel.set(label, glyph);
      return glyph;
    }

    let rows: string[] = [];
    for (let dy = -r; dy <= r; dy += 1) {
      let row = "";
      for (let dx = -r; dx <= r; dx += 1) {
        let x = p.x + dx;
        let y = p.y + dy;
        if (dx === 0 && dy === 0) {
          row += "@";
          continue;
        } // you
        if (terrainAt(x, y) === undefined) {
          row += " ";
          continue;
        } // off-map
        let occupant = agentTiles.get(`${x},${y}`);
        if (occupant) {
          row += glyphFor(occupant, true);
          continue;
        }
        let tile = tileAt(space.grid, x, y);
        if (tile.token) {
          let label =
            tile.token.kind ??
            tile.token.tags.find((t) => t !== "token") ??
            tile.token.name;
          row += glyphFor(label, true);
          continue;
        }
        if (tile.terrain === space.grid.fill) {
          row += ".";
          continue;
        } // open
        row += glyphFor(String(tile.terrain), false);
      }
      rows.push(row);
    }

    return {
      radius: r,
      rows,
      legend: [...legend].map(([glyph, label]) => ({ glyph, label })),
    };
  }

  // Who is in sight and what they are doing - identity and activity only.
  // WHERE they are is the map's job (sense surroundings names them in its
  // legend); no bearing/distance prose rides here.
  function visibleOthers(id: string) {
    let { x, y } = posOf(id);
    return livingIds()
      .filter(
        (o) => o !== id && chebyshev(x, y, posOf(o).x, posOf(o).y) <= SIGHT,
      )
      .map((o) => ({
        id: o,
        name: displayName(o),
        doing: entity(o).action ? entity(o).action!.type : "idle",
      }));
  }

  // The coordination ledger: the deliberate exception to per-agent perception.
  // "Who is working on what" is knowable cheaply - by standing at a
  // ledger-tagged entity (the camp message board, scenario content) - because
  // hiding intentions produces beer-game task-pileup structurally, and the
  // real-world fix is a shared ledger, not omniscience. Scoped to coordination
  // state ONLY: each character's name and declared work, never positions or
  // world knowledge. A scout's map stays in the scout's head; what they're
  // *doing* is on the board.
  const LEDGER_REACH = 1; // stand at or beside the ledger to read it

  function coordinationLedger(selfId: string) {
    let here = posOf(selfId);
    let board = Object.values(world.entities).find(
      (e) =>
        e.pos &&
        hasTag(e, "ledger") &&
        chebyshev(here.x, here.y, e.pos.x, e.pos.y) <= LEDGER_REACH,
    );
    if (!board) return { atLedger: false as const };
    return {
      atLedger: true as const,
      ledger: board.id,
      roster: livingIds().map((o) => {
        let order = engineOrderView(orderContext(), o);
        let action = entity(o).action;
        return {
          name: displayName(o),
          self: o === selfId,
          doing: order ? order.summary : action ? action.type : "idle",
          status: order?.status,
        };
      }),
    };
  }

  function actionView(id: string) {
    let action = entity(id).action;
    if (!action) return null;
    let view: any = {
      type: action.type,
      endsInTicks: Math.max(0, action.endTick - world.tick),
    };
    if (action.type === "travel" || action.type === "explore") {
      view.goal = action.args.goal ?? action.args.direction;
      let mv = space.moves.get(id);
      view.remainingTiles = mv ? Math.max(0, mv.path.length - mv.index) : 0;
    } else if (action.type === "scan") view.direction = action.args.direction;
    else if (action.args && Object.keys(action.args).length)
      view.args = { ...action.args };
    return view;
  }

  // The action menu, derived from the registry and live state: each action with
  // its parameters, whether it applies right now, and (where it narrows the
  // choice) the currently-valid argument values. A scenario rule action appears
  // here automatically - no per-action code.
  function listAvailableActions(
    id: string,
    sinceTick: number,
    includeActionDetails: boolean,
  ): AvailableAction[] {
    return availableActionsFor(
      actionContext(),
      id,
      sinceTick,
      includeActionDetails,
    );
  }

  function ticksLived(id: string) {
    let m = meta.get(id)!;
    return (isAlive(id) ? world.tick : (m.diedAt ?? world.tick)) - m.spawnTick;
  }

  function agentView(id: string) {
    let p = posOf(id);
    return {
      id,
      name: displayName(id),
      position: { ...p },
      at: tokenNameAt(space.grid, p),
      kind: entity(id).kind,
      tags: [...entity(id).tags],
      alive: isAlive(id),
      stocks: roundedStocks(stocksOf(id)),
      ticksLived: ticksLived(id),
      action: actionView(id),
      order: engineOrderView(orderContext(), id),
    };
  }

  // `sinceTick` is the tick the caller last delivered an observation to this
  // agent; an action introduced after it is flagged `isNew`. Defaults to the
  // current tick so admin/dashboard reads (which have no per-agent cursor) never
  // spuriously flag anything new.
  function getObservation(
    id: string,
    sinceTick: number = world.tick,
    includeActionDetails = true,
  ) {
    requireAgent(id);
    let p = posOf(id);
    return structuredClone({
      tick: world.tick,
      you: agentView(id),
      here: tileSummary(p),
      grid: sightGrid(id),
      // The scenario's own reading of its stocks - which way is bad ("down" for
      // a hunger that climbs, "up" for a health that falls). Prose needs it to
      // know which gauge is in trouble without knowing what any stock is called.
      display: displayHints,
      colony: coordinationLedger(id),
      world: { stocks: roundedStocks(worldStocks()) },
      known: {
        locations: knownTokensView(id, p),
      },
      heard: recentlyHeard(id),
      availableActions: listAvailableActions(
        id,
        sinceTick,
        includeActionDetails,
      ),
    });
  }

  // The latest speech this character was in earshot of (their own words
  // included), newest last, folded into every observation so a character reads
  // the conversation around them for free - the act of replying (via the speak
  // tool) is the only deliberate, optional step.
  function recentlyHeard(id: string) {
    let out = [];
    for (
      let i = log.length - 1;
      i >= 0 && out.length < RECENT_CHAT_LIMIT;
      i -= 1
    ) {
      let event = log[i];
      if (event.type !== "said") continue;
      if (event.agentId !== id && !(event.audience ?? []).includes(id))
        continue;
      out.push({
        tick: event.tick,
        from: displayName(event.agentId as string),
        text: event.message ?? "",
      });
    }
    return out.reverse();
  }

  // --- admin / dashboard ------------------------------------------------

  function getAdminState() {
    return structuredClone({
      tick: world.tick,
      scenario: {
        name: scenario.name,
        display: displayHints,
        // The per-character stock defaults: the stocks (with bounds) every character
        // is stamped out with and future joiners inherit. Published so the dashboard
        // can show the authored character economy alongside the world stocks.
        stockDefaults,
        // The authored world furniture, for the Scenario inspector: pre-placed
        // fixtures (hearths, ledgers, GM-spawned entities), the scatter setup
        // recipes, and the terrain-kind behaviour. terrainSpecs drops each spec's
        // `visual` here - the sprite already rides terrainVisuals, and duplicating
        // the grids would bloat the GM inspection overview that embeds this block.
        fixtures: spawnedFixtures,
        setup: appliedSetup,
        terrainSpecs: Object.fromEntries(
          Object.entries(terrainSpecs).map(([name, spec]) => [
            name,
            {
              ...(spec.passable !== undefined
                ? { passable: spec.passable }
                : {}),
              ...(spec.moveCost !== undefined
                ? { moveCost: spec.moveCost }
                : {}),
            },
          ]),
        ),
        // Map iconography as data: how each terrain kind and each entity/stock
        // kind-tag draws (color + icon). The renderer resolves from these instead
        // of a hardcoded palette, so terrain colors and icons are scenario/GM-owned.
        // terrainVisuals is the live registry (scenario base + GM-registered
        // terrain), so a GM-minted terrain carries its own color.
        terrainVisuals,
        kindVisuals,
      },
      world: { stocks: roundedStocks(worldStocks()) },
      population: livingIds().length,
      agents: Object.fromEntries(agentIds().map((id) => [id, agentView(id)])),
    });
  }

  // The GM's god-view of the raw kernel: every entity with its tags, stocks
  // (value + bounds), position, and any action in progress - unredacted. This is
  // the single place a director can read what `agents` and the map leave out: a
  // spawned predator's health and a token's remaining reserve. Keyed by id, so
  // the wolf and oakwood sit alongside the characters and the world singleton.
  function getEntities() {
    let out = structuredClone(world.entities);
    for (let e of Object.values(out)) e.stocks = roundedStocks(e.stocks);
    return out;
  }

  function getMapEntities() {
    let out = structuredClone(
      Object.fromEntries(
        Object.entries(world.entities).filter(
          ([, entity]) =>
            entity.pos &&
            !hasTag(entity, "agent") &&
            // Tokens are drawn from the map's own token layer (name + icon), not
            // from here - except tokens that carry a live running stock (stockpile
            // reserves, berry/wood reserves on resource tokens), which the map
            // badges each poll. Their icon still comes from the token layer;
            // letting the entity through is only so its reserve reaches the
            // dashboard between map revisions (stock changes don't bump one).
            // An inscribed token (a sign) rides through for the same reason:
            // its words change without bumping a map revision, and the
            // dashboard reads them from the tile card.
            (!hasTag(entity, "token") ||
              hasTag(entity, "stockpile") ||
              entity.text !== undefined ||
              Object.keys(entity.stocks).length > 0),
        ),
      ),
    );
    for (let e of Object.values(out)) e.stocks = roundedStocks(e.stocks);
    return out;
  }

  // The static terrain stream: ground only, no tokens, no fog. It is the heavy
  // payload (one entry per tile, grows with area) but the rarely-changing one,
  // so it rides `terrainRevision` and the dashboard bakes it to a texture once
  // per change rather than refetching it on every reveal or token hop.
  function getMap() {
    let g = space.grid;
    return structuredClone({
      width: g.width,
      height: g.height,
      origin: g.origin ?? { x: 0, y: 0 },
      spawn: g.spawn,
      tiles: g.tiles.flatMap((row, rowIndex) =>
        row.map((tile, columnIndex) => ({
          x: (g.origin?.x ?? 0) + columnIndex,
          y: (g.origin?.y ?? 0) + rowIndex,
          terrain: tile.terrain,
        })),
      ),
    });
  }

  // A whole-map ASCII minimap for the GM/director view. The full grid is
  // thousands of tiles, so it downsamples into blocks - one glyph per block -
  // and the director reads geography and directional language off it directly
  // instead of inferring orientation from raw coordinates (and guessing the
  // axis backwards). North is up, matching the character sight grid and the web
  // renderer: row 0 is the y-origin edge, y grows downward/southward. Each
  // block shows, in priority order, a living character (@), else the most common
  // token kind in the block (uppercase), else its dominant terrain (lowercase,
  // "." for open fill). Glyphs are assigned per render and spelled in a legend,
  // so any scenario's terrains and kinds render without a fixed table.
  function getMinimap(maxDim = 24) {
    let g = space.grid;
    let origin = g.origin ?? { x: 0, y: 0 };
    let block = Math.max(1, Math.ceil(Math.max(g.width, g.height) / maxDim));
    let cols = Math.ceil(g.width / block);
    let rows = Math.ceil(g.height / block);

    let legend = new Map<string, string>(); // glyph -> label
    let byLabel = new Map<string, string>(); // label -> glyph, for reuse
    let used = new Set<string>(["@", ".", " "]);
    let pool = "abcdefghijklmnopqrstuvwxyz0123456789+*=%#$?!";
    function glyphFor(label: string, upper: boolean): string {
      let existing = byLabel.get(label);
      if (existing) return existing;
      let first = (label[0] ?? "?").toLowerCase();
      let preferred = upper ? first.toUpperCase() : first;
      let glyph =
        /[a-z0-9]/i.test(preferred) && !used.has(preferred) ? preferred : "";
      if (!glyph)
        for (let c of pool)
          if (!used.has(c)) {
            glyph = c;
            break;
          }
      if (!glyph) glyph = "?";
      used.add(glyph);
      legend.set(glyph, label);
      byLabel.set(label, glyph);
      return glyph;
    }

    // Which blocks hold a living character - the director's primary pacing read,
    // so an occupied block shows @ over whatever token or terrain sits under it.
    let agentBlocks = new Set<string>();
    for (let id of livingIds()) {
      let p = posOf(id);
      let bc = Math.floor((p.x - origin.x) / block);
      let br = Math.floor((p.y - origin.y) / block);
      agentBlocks.add(`${bc},${br}`);
    }

    let topKey = (counts: Map<string, number>): string => {
      let best = "";
      let bestN = -1;
      for (let [key, n] of counts)
        if (n > bestN) {
          best = key;
          bestN = n;
        }
      return best;
    };

    let gridRows: string[] = [];
    for (let br = 0; br < rows; br += 1) {
      let row = "";
      for (let bc = 0; bc < cols; bc += 1) {
        if (agentBlocks.has(`${bc},${br}`)) {
          row += "@";
          continue;
        }
        let tokenCounts = new Map<string, number>();
        let terrainCounts = new Map<string, number>();
        let x0 = origin.x + bc * block;
        let y0 = origin.y + br * block;
        for (let y = y0; y < y0 + block; y += 1)
          for (let x = x0; x < x0 + block; x += 1) {
            if (terrainAt(x, y) === undefined) continue; // off-map clamp
            let tile = tileAt(g, x, y);
            if (tile.token) {
              let label =
                tile.token.kind ??
                tile.token.tags.find((t) => t !== "token") ??
                tile.token.name;
              tokenCounts.set(label, (tokenCounts.get(label) ?? 0) + 1);
            } else {
              terrainCounts.set(
                tile.terrain,
                (terrainCounts.get(tile.terrain) ?? 0) + 1,
              );
            }
          }
        if (tokenCounts.size) {
          row += glyphFor(topKey(tokenCounts), true);
          continue;
        }
        if (terrainCounts.size) {
          let label = topKey(terrainCounts);
          row += label === g.fill ? "." : glyphFor(String(label), false);
          continue;
        }
        row += " ";
      }
      gridRows.push(row);
    }

    return {
      orientation:
        `north up, one glyph per ${block}x${block}-tile block. ` +
        `row 0 = north (y=${origin.y}), last row = south (y=${origin.y + g.height - 1}); ` +
        `col 0 = west (x=${origin.x}), last col = east (x=${origin.x + g.width - 1}).`,
      world: { width: g.width, height: g.height },
      block,
      cols,
      rows,
      grid: gridRows,
      legend: [...legend].map(([glyph, label]) => ({ glyph, label })),
    };
  }

  // The token layer as a sparse list of occupied tiles - hundreds of entries,
  // not one-per-tile - so it ships inline in the per-poll admin payload and
  // re-renders (as live sprites over the baked ground) only when the token
  // layer actually moves, gated by `tokenRevision`.
  function getMapTokens() {
    let g = space.grid;
    let tokens: { x: number; y: number; token: TokenRef }[] = [];
    let origin = g.origin ?? { x: 0, y: 0 };
    for (let rowIndex = 0; rowIndex < g.height; rowIndex += 1)
      for (let columnIndex = 0; columnIndex < g.width; columnIndex += 1) {
        let token = g.tiles[rowIndex][columnIndex].token;
        if (!token) continue;
        tokens.push({
          x: origin.x + columnIndex,
          y: origin.y + rowIndex,
          token: { ...token },
        });
      }
    return structuredClone(tokens);
  }

  // The per-agent fog stream: each character's own reveal (there is no shared
  // colony vision, so the map masks to one character's set when selected) plus
  // `known`, the union, for the default full-reveal view. It changes every step
  // a character explores, so it rides `space.fogRevision` on its own endpoint
  // rather than dragging the terrain payload along with it.
  function getFog() {
    let knownByAgent: Record<string, { x: number; y: number }[]> = {};
    for (let id of space.fog.keys()) knownByAgent[id] = knownTiles(space, id);
    return structuredClone({
      known: unionKnownTiles(space),
      knownByAgent,
    });
  }

  // A sub-region of the grid around a point, so a GM can pull just the area it
  // cares about instead of the whole 2025-tile map. Returns the tiles in the
  // Chebyshev box (terrain + token) plus any agents and positioned entities
  // standing inside it - the local picture a director steers by. Clamped to the
  // grid, and the radius is capped so one call can't reconstruct the full map.
  function getMapRegion(cx: number, cy: number, radius = 4) {
    let g = space.grid;
    let r = Math.max(0, Math.min(Math.floor(radius), 10));
    let origin = g.origin ?? { x: 0, y: 0 };
    let x0 = Math.max(origin.x, cx - r);
    let y0 = Math.max(origin.y, cy - r);
    let x1 = Math.min(origin.x + g.width - 1, cx + r);
    let y1 = Math.min(origin.y + g.height - 1, cy + r);
    let tiles = [];
    for (let y = y0; y <= y1; y += 1)
      for (let x = x0; x <= x1; x += 1) {
        let tile = tileAt(g, x, y);
        tiles.push({
          x,
          y,
          terrain: tile.terrain,
          token: tile.token ? { ...tile.token } : null,
        });
      }
    let inBox = (p?: { x: number; y: number }) =>
      !!p && p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
    return structuredClone({
      center: { x: cx, y: cy },
      radius: r,
      bounds: { x0, y0, x1, y1 },
      tiles,
      agents: agentIds()
        .filter((id) => inBox(entity(id).pos))
        .map((id) => agentView(id)),
      entities: Object.values(world.entities)
        .filter((e) => !hasTag(e, "agent") && inBox(e.pos))
        .map((e) => e),
    });
  }

  // A bare reset rebuilds the exact same world (same seed, same spawn, same
  // map). Passing a seed rerolls the map, spawn, and every procedural token
  // around it. Passing a complete scenario replaces the engine's program and
  // every derived baseline before rebuilding, so runtime scenario switches use
  // the same lifecycle as a fresh createWorld().
  function reset(options?: { seed?: number; scenario?: Scenario }) {
    if (options?.scenario) {
      scenario = options.scenario;
      agentTemplate = scenario.agentTemplate ?? DEFAULT_AGENT_TEMPLATE;
      baselineIds = new Set(scenario.rules.map((rule) => rule.id));
      if (options.seed === undefined) activeSeed = scenario.worldgen?.seed ?? 1;
    }
    init(options?.seed);
  }

  // The "next floor" reroll behind the `regenerate` effect - deferred here from
  // the kernel and run after the tick settles. Unlike reset()/init() this is a
  // *surgical* reroll: it rebuilds only the physical world (terrain grid,
  // procedural tokens, spawn tile) and carries the live run forward untouched -
  // the rule set and GM overlay, the logs and history, the tick clock, agent
  // metadata and the trend ring all persist. The carry-over policy is the whole
  // design: living characters keep their tags and stocks and land on the new
  // spawn; the world entity keeps its stocks (else the counter that drove the
  // reroll would die in the reroll it caused); every other entity - old tokens,
  // corpses, GM fixtures, dropped items - is cleared and rebuilt by worldgen and
  // the scenario's own spawn rules over the ticks that follow.
  function regenerate(seed: number) {
    activeSeed = seed;
    let effectiveWorldgen = scenario.worldgen
      ? worldgenWithTerrainPolicy(
          { ...scenario.worldgen, seed: activeSeed },
          scenario.terrainSpecs,
        )
      : worldgenWithTerrainPolicy(undefined, scenario.terrainSpecs);
    // A reroll always needs a fresh spawn - a fixed spawn on a map that just
    // changed shape could land characters in a wall or a pond.
    spawnPos = effectiveWorldgen
      ? pickSpawn(effectiveWorldgen)
      : scenario.spawn;
    let worldgen = effectiveWorldgen
      ? expandWorldGen(effectiveWorldgen, spawnPos)
      : undefined;

    // Snapshot the two things that survive the reroll before rebuilding the
    // entity set: the world entity's stocks (same objects, kept whole) and each
    // living character's identity (tags + stocks). Dead agents are physical-world
    // detritus that the reroll clears; their metadata stays for ticksLived.
    let preservedWorldStocks = world.entities.world.stocks;
    let survivors = livingIds().map((id) => ({
      id,
      kind: world.entities[id].kind,
      tags: [...world.entities[id].tags],
      stocks: world.entities[id].stocks,
    }));

    let entities: Record<string, Entity> = {
      world: { id: "world", tags: ["world"], stocks: preservedWorldStocks },
    };
    for (let s of worldgen?.tokens ?? [])
      entities[s.name] = {
        id: s.name,
        kind: s.kind,
        tags: s.tags,
        stocks: instantiate(s.stocks ?? {}),
        pos: { x: s.x, y: s.y },
      };
    for (let s of survivors)
      entities[s.id] = {
        id: s.id,
        kind: s.kind,
        tags: s.tags,
        stocks: s.stocks,
        pos: { ...spawnPos },
        action: null,
      };

    // Mutate the world in place so the tick clock, cooldowns, and every closure
    // over `world` carry forward; only its contents reroll.
    world.entities = entities;
    world.seed = activeSeed;

    space = makeSpace(spawnPos, worldgen);
    // Re-apply the live terrain kinds (scenario base + GM overlay) onto the fresh
    // grid: draining the registry to empty first forces a clean reconcile against
    // the new grid rather than a diff against the old one.
    let liveTerrainSpecs = terrainSpecs;
    terrainSpecs = {};
    reapplyTerrainSpecs(liveTerrainSpecs);

    // Each survivor wakes on the new floor: drop any order that was steering it
    // across the old map, and seed fresh fog so it perceives only what sight
    // reaches from the new spawn and must explore the floor over again.
    for (let s of survivors) {
      orders.delete(s.id);
      spawn(space, s.id, world.tick);
    }
    terrainRevision += 1;
    // A loud line in the GM feed: a bad `when` on a regenerate transition is a
    // world-thrashing loop, and it must be visible the instant it starts.
    recordGm("world_regenerated", `regenerated the world (seed ${seed})`, {
      detail: { seed, spawn: { ...spawnPos } },
    });
  }

  function growWorld(growth: Partial<Record<MapEdge, number>>) {
    // The world rectangle before any edge grows - fresh frontier is everything
    // outside it, which extendTerrain repaints from the same layer recipe.
    let priorOrigin = space.grid.origin ?? { x: 0, y: 0 };
    let original = {
      x: priorOrigin.x,
      y: priorOrigin.y,
      width: space.grid.width,
      height: space.grid.height,
    };
    let applied: Partial<Record<MapEdge, number>> = {};
    for (let direction of ["north", "east", "south", "west"] as const) {
      let by = growth[direction] ?? 0;
      let result = growGrid(space.grid, by, direction);
      if (result.grew) applied[direction] = by;
    }
    if (Object.keys(applied).length === 0) return;
    // Continue the map's own terrain onto the new tiles instead of flat fill,
    // resampling the noise/fill layers at their world coordinates.
    if (scenario.worldgen?.terrainLayers?.length)
      extendTerrain(
        space.grid,
        { terrainLayers: scenario.worldgen.terrainLayers, seed: activeSeed },
        original,
      );
    resetKnownTerrains();
    terrainRevision += 1;
    let origin = space.grid.origin ?? { x: 0, y: 0 };
    let summary = Object.entries(applied)
      .map(([direction, by]) => `${direction} by ${by}`)
      .join(", ");
    recordGm(
      "world_grew",
      `world grew ${summary} to ${space.grid.width}x${space.grid.height}`,
      {
        detail: {
          growth: applied,
          width: space.grid.width,
          height: space.grid.height,
          origin,
        },
      },
    );
  }

  // --- GM mutation (god-powers) -----------------------------------------
  //
  // The authoring surface a director/GM client drives: read and reshape the live
  // rule set, poke a stock, conjure an entity. These operate on the same plain
  // data the kernel evaluates each tick, so a change lands on the very next tick
  // with no engine code aware of what it means. They validate shape and identity
  // but not deep semantics - a malformed expression inside a rule will surface as
  // a kernel error on the tick it runs, not here.

  // Every live rule, cloned so a caller can't mutate the set out from under us.
  function getRules(): Rule[] {
    return structuredClone(rules);
  }

  // Which live rules came from the scenario baseline vs. the GM. `baselineIds`
  // are the original scenario rule ids; `dirtyIds` are the ones the GM has added,
  // patched, or removed. A dashboard crosses these to label each rule's origin
  // (a baseline id in dirtyIds was tweaked; an id in neither set is GM-added).
  function getRuleMeta() {
    return { baselineIds: [...baselineIds], dirtyIds: [...dirtyRuleIds] };
  }

  // The trend ring, cloned for the same reason as the rules.
  function getHistory(): StockSample[] {
    return structuredClone(history);
  }

  // The GM's tension digest (see Pulse). Every field is derived on demand
  // from state the engine already keeps - the agent meta map, the event log
  // tail, the GM trail, and the trend ring - so a director can poll this
  // instead of pulling whole world state to ask "is anything happening?".
  function getPulse(windowTicks = 100): Pulse {
    let tick = world.tick;
    let window = Math.max(1, Math.floor(windowTicks));
    let floor = tick - window;

    let deathsInWindow = 0;
    let lastDeath: number | null = null;
    for (let m of meta.values()) {
      if (m.diedAt === null) continue;
      if (m.diedAt > floor) deathsInWindow += 1;
      if (lastDeath === null || m.diedAt > lastDeath) lastDeath = m.diedAt;
    }

    // Trend baseline: the oldest retained sample inside the window. The ring
    // holds HISTORY_CAP ticks, so a wider window silently truncates to what
    // survives; a stock the baseline hasn't seen yet reads as delta 0.
    let baseline: StockSample | undefined;
    for (let sample of history)
      if (sample.tick >= floor) {
        baseline = sample;
        break;
      }
    let stockTrends: Pulse["stockTrends"] = {};
    for (let [name, s] of Object.entries(worldStocks())) {
      let now = roundStock(s.value);
      let then = baseline?.stocks[name] ?? now;
      stockTrends[name] = { now, delta: roundStock(now - then) };
    }

    // Backwards scans of the event tail stop at the window edge, so a long
    // log costs nothing. Chat volume counts the free speech channel plus GM
    // heralds; the decision scan is the flatline detector - how long since
    // anything worth waking anyone for happened.
    let chatInWindow = 0;
    let ticksSinceLastDecisionEvent: number | null = null;
    for (let i = log.length - 1; i >= 0; i -= 1) {
      let event = log[i];
      if (
        ticksSinceLastDecisionEvent === null &&
        (event.wake ?? "decision") !== "routine"
      )
        ticksSinceLastDecisionEvent = tick - event.tick;
      if (event.tick <= floor) {
        if (ticksSinceLastDecisionEvent !== null) break;
        continue;
      }
      if (event.type === "said" || event.type === "announced")
        chatInWindow += 1;
    }

    let ticksSinceLastGmAction: number | null = null;
    for (let i = gmLog.length - 1; i >= 0; i -= 1) {
      let kind = gmLog[i].kind;
      if (kind === "gm_joined" || kind === "gm_left") continue;
      ticksSinceLastGmAction = tick - gmLog[i].tick;
      break;
    }

    return {
      tick,
      window,
      population: livingIds().length,
      deathsInWindow,
      ticksSinceLastDeath: lastDeath === null ? null : tick - lastDeath,
      stockTrends,
      chatInWindow,
      ticksSinceLastGmAction,
      ticksSinceLastDecisionEvent,
    };
  }

  // Append a new rule. Ids must be unique across the whole set (the kernel keys
  // actions, modifiers, and watches by id), so a clashing id is rejected.
  function addRule(rule: Rule): { id: string; redeemed?: string[] } {
    if (
      !rule ||
      typeof rule !== "object" ||
      typeof (rule as Rule).id !== "string"
    )
      throw new Error("A rule must be an object with a string id.");
    if (rules.some((r) => r.id === rule.id))
      throw new Error(`A rule with id "${rule.id}" already exists.`);
    validateRule(rule);
    assertValidRule(rule);
    assertActionNamesFree(rule);
    rules.push(structuredClone(rule));
    dirtyRuleIds.add(rule.id);
    // Stamp a runtime-added action with the current tick so characters see it as
    // a newly available capability until each has looked past it once.
    if ("kind" in rule && rule.kind === "action")
      actionIntroTick.set(rule.id, world.tick);
    recordGm(
      "rule_added",
      `added rule ${rule.id}${rule.description ? ` — ${rule.description}` : ""}`,
      { target: rule.id, detail: { rule: structuredClone(rule) } },
    );
    let redeemed = redeemSpeculativeAttempts(rule);
    return { id: rule.id, ...(redeemed.length ? { redeemed } : {}) };
  }

  // Drop a rule by id - how a GM retires a challenge once it has served its turn.
  function removeRule(id: string): { id: string } {
    let index = rules.findIndex((r) => r.id === id);
    if (index === -1) throw new Error(`No rule with id "${id}".`);
    // remove_rule retires GM-added rules. A baseline rule is part of the
    // scenario's core loop (death, the metabolism drains, the action rules);
    // splicing one out can break the game for every character, so refuse and
    // point at the non-destructive lever instead. To change a baseline rule's
    // behavior, tweak_rule it (or layer a modifier); it cannot be deleted.
    if (baselineIds.has(id))
      throw new Error(
        `"${id}" is a baseline rule and cannot be removed — tweak_rule it (or add a modifier) instead of deleting the core loop.`,
      );
    let [removed] = rules.splice(index, 1);
    dirtyRuleIds.add(id);
    // Forget its intro tick so a later re-add is flagged new again, not stale.
    actionIntroTick.delete(id);
    recordGm("rule_removed", `removed rule ${id}`, {
      target: id,
      detail: { rule: structuredClone(removed) },
    });
    return { id };
  }

  // Shallow-merge fields into an existing rule - the lightweight "fire burns
  // faster" tweak (patch its `rate`) without re-sending the whole rule. The id is
  // immutable: changing it would orphan any in-flight action keyed to it.
  function patchRule(id: string, fields: Partial<Rule>): Rule {
    let rule = rules.find((r) => r.id === id);
    if (!rule) throw new Error(`No rule with id "${id}".`);
    if ("id" in fields && fields.id !== id)
      throw new Error("A rule's id cannot be changed.");
    // Capture the prior value of each field being changed, so the audit trail can
    // show before -> after rather than just the new state.
    let before: Record<string, unknown> = {};
    let current = rule as unknown as Record<string, unknown>;
    for (let key of Object.keys(fields))
      before[key] = structuredClone(current[key]);
    // Validate a *copy* of the merged rule before committing, so a tweak that
    // would put a structural effect into a buffered phase is rejected without
    // leaving the live rule half-patched.
    let merged = { ...rule, ...structuredClone(fields) } as Rule;
    validateRule(merged);
    assertValidRule(merged);
    assertActionNamesFree(merged, id);
    Object.assign(rule, structuredClone(fields));
    dirtyRuleIds.add(id);
    // Adding an alias is how a director catches stragglers - the words people
    // tried that the first mint missed - so a tweak redeems its attempts too.
    let redeemed = redeemSpeculativeAttempts(rule);
    recordGm(
      "rule_tweaked",
      `tweaked rule ${id} (${Object.keys(fields).join(", ")})`,
      {
        target: id,
        detail: {
          before,
          after: structuredClone(fields),
          ...(redeemed.length ? { redeemed } : {}),
        },
      },
    );
    return structuredClone(rule);
  }

  // Lint a live rule by simulation: run the current rule set (plus the
  // synthesized terrain transitions, for fidelity with the real tick) for a
  // handful of ticks on a disposable clone of the world, and report the
  // rule_errors attributable to `id` plus softer notes (matched nothing, did
  // nothing). Read-only with respect to the live world. The coordinator calls
  // this right after addRule/patchRule so the GM hears about a broken body in
  // the submitting tool's own result instead of finding rule_errors in the
  // event log later.
  function dryRunLiveRule(id: string, ticks?: number): DryRunReport {
    let live = rules;
    let report = dryRunRule(world, live, id, {
      terrain: space.grid.tiles.map((row) => row.map((t) => t.terrain)),
      agents: livingIds(),
      ticks,
    });
    for (let kind of unillustratedSpawns(live.find((r) => r.id === id)))
      report.warnings.push(
        `"${id}" spawns a ${kind}, which has no sprite - it will render as a missing-art box for every character who meets it. register_kind_visual({kind: "${kind}", sprite: ...}) in this same pass.`,
      );
    return report;
  }

  // Kinds a rule puts into the world that nothing has drawn yet. There is no
  // fallback art, so an unillustrated spawn is a box on the map - and the miss
  // is easy: genesis run 32d46bd9 shipped six sprites and still left
  // dropped_stone bare, because the verb that spawns it was minted 900 ticks
  // before the one that spawns dropped_wood.
  function unillustratedSpawns(rule: Rule | undefined): string[] {
    if (!rule || !("do" in rule) || !Array.isArray(rule.do)) return [];
    let missing: string[] = [];
    for (let effect of rule.do) {
      let spawn = (effect as { spawn?: { kind?: unknown } }).spawn;
      let kind = spawn?.kind;
      if (typeof kind !== "string") continue; // a dynamic kind resolves per-actor
      if (kindVisuals[kind]?.icon || kindVisuals[kind]?.sprite) continue;
      if (!missing.includes(kind)) missing.push(kind);
    }
    return missing;
  }

  // Distil the GM's edits into the overlay that snapshot() persists: the current
  // form of every touched-and-still-present rule (added rules + patched baseline
  // rules), and the ids of baseline rules the GM removed. A GM rule that was
  // added then removed nets out - it is in neither list.
  function ruleOverlay(): RuleOverlay {
    let present = new Set(rules.map((r) => r.id));
    return {
      dynamicRules: structuredClone(
        rules.filter((r) => dirtyRuleIds.has(r.id)),
      ),
      removedBaseIds: [...dirtyRuleIds].filter(
        (id) => baselineIds.has(id) && !present.has(id),
      ),
      stockDefaults: structuredClone(stockDefaults),
      fixtures: structuredClone(spawnedFixtures),
      terrainSpecs: runtimeTerrainSpecs(),
      kindVisuals: runtimeKindVisuals(),
    };
  }

  // The kind-tag icons/colors the GM added at runtime: the divergence from the
  // scenario's kindVisuals, so only the additions ride the overlay.
  function runtimeKindVisuals(): Record<string, Visual> {
    let out: Record<string, Visual> = {};
    for (let [tag, visual] of Object.entries(authoredKindVisuals))
      if (JSON.stringify(baseKindVisuals[tag]) !== JSON.stringify(visual))
        out[tag] = structuredClone(visual);
    return out;
  }

  // Rebuild the live rule set from the scenario baseline plus an overlay. Baseline
  // rules the GM removed or replaced are dropped; the overlay's rules (added or
  // patched) are appended. Untouched baseline rules come straight from the current
  // scenario, so editing the scenario file still takes effect across a restart.
  function applyOverlay(overlay: RuleOverlay | undefined) {
    if (!overlay) {
      rules = [...scenario.rules];
      dirtyRuleIds = new Set();
      stockDefaults = {};
      spawnedFixtures = [];
      appliedSetup = [];
      authoredKindVisuals = { ...baseKindVisuals };
      kindVisuals = { ...authoredKindVisuals };
      describeTemplates = { ...(scenario.describeEvent ?? {}) };
      displayHints = { ...(scenario.display ?? {}) };
      reapplyTerrainSpecs(baseTerrainSpecs);
      return;
    }
    stockDefaults = structuredClone(overlay.stockDefaults ?? {});
    // Rebuild in the live engine's exact order: baseline rules in scenario order
    // (a patched one substituted in place, never moved to the end), then the
    // GM-added rules appended in add order. Order is load-bearing - modifiers on a
    // shared channel fold in declaration order, and derived stocks can read each
    // other - so reordering here would make a restored world diverge from the one
    // that was snapshotted.
    let removed = new Set(overlay.removedBaseIds);
    let patched = new Map(overlay.dynamicRules.map((rule) => [rule.id, rule]));
    let merged: Rule[] = [];
    for (let rule of scenario.rules) {
      if (removed.has(rule.id)) continue;
      merged.push(patched.get(rule.id) ?? rule); // patched baseline keeps position
    }
    for (let rule of overlay.dynamicRules)
      if (!baselineIds.has(rule.id)) merged.push(rule); // genuinely new, appended
    rules = structuredClone(merged);
    dirtyRuleIds = new Set([...patched.keys(), ...overlay.removedBaseIds]);

    // Layer the GM's runtime kind icons/colors back on over the kindVisuals base.
    authoredKindVisuals = {
      ...baseKindVisuals,
      ...(overlay.kindVisuals ?? {}),
    };
    // A scenario's character and world stocks carry their own icon/color on their
    // StockSpec, exactly like the scenario stocks swept at init. Harvest them
    // so a scenario-introduced resource (warmth, morale, wood, season, ...) shows
    // its icon on the dashboard instead of a bare fallback marker. Runs after
    // the explicit map above, and the collector skips names already present,
    // so an explicit kindVisuals entry still wins.
    collectSpecVisuals(authoredKindVisuals, overlay.stockDefaults);
    collectSpecVisuals(authoredKindVisuals, overlay.worldStocks);
    describeTemplates = {
      ...(scenario.describeEvent ?? {}),
      ...(overlay.describeEvent ?? {}),
    };
    displayHints = { ...(scenario.display ?? {}), ...(overlay.display ?? {}) };
    // A buildable's structure isn't on the map at world start, so its stock
    // look rides the spawning action's spec (see the init sweep). With all
    // rules arriving via overlays now, sweep the merged live rules too so a
    // scenario's build actions register the same way scenario rules would have.
    for (let rule of rules)
      if ("kind" in rule && rule.kind === "action" && Array.isArray(rule.do))
        for (let effect of rule.do)
          if (effect && typeof effect === "object" && "spawn" in effect)
            collectSpecVisuals(authoredKindVisuals, effect.spawn.stocks);
    reapplyTerrainSpecs({
      ...baseTerrainSpecs,
      ...(overlay.terrainSpecs ?? {}),
    });

    // Re-seed the GM's fixtures and replay any not already in the world. On a
    // reset the world was just rebuilt clean, so each one is placed afresh; on a
    // snapshot restore the entities are already present (restore sets the world
    // before applying the overlay), so the skip-if-exists guard makes replay a
    // no-op there. Placement stays silent - the GM log is the story of the run,
    // not a transcript of every reset re-applying the same authoring.
    spawnedFixtures = structuredClone(overlay.fixtures ?? []);
    for (let fixture of spawnedFixtures)
      if (!world.entities[fixture.id]) placeFixture(fixture);
    applyWorldStocks(overlay.worldStocks);
    seedStockDefaults();
    appliedSetup = structuredClone(overlay.setup ?? []);
    applySetup(overlay.setup);
  }

  // Land the overlay's per-agent stock defaults on characters already alive,
  // filling gaps only - the same discipline setStockDefault applies at runtime,
  // and the same reason: a scenario rule that reads `warmth` must never meet a
  // character who lacks it. Future joiners are covered by withStockDefaults in
  // addAgent; on a snapshot restore everyone already carries their stocks, so
  // this is a no-op. A spec's look registers like a world stock's, without
  // displacing an explicit kindVisuals entry.
  function seedStockDefaults() {
    for (let [name, spec] of Object.entries(stockDefaults)) {
      if ((spec.icon || spec.color) && !authoredKindVisuals[name])
        registerStockVisual(name, spec.icon, spec.color);
      for (let id of agentIds()) {
        let e = entity(id);
        if (e && !e.stocks[name]) {
          let min = spec.min ?? 0;
          let max = spec.max ?? 100;
          e.stocks[name] = stock(clamp(spec.value, min, max), min, max);
        }
      }
    }
    syncStockpilable();
  }

  // Publish which stocks the ruleset marks stockpilable to the kernel, so the
  // `stockpilable` condition and the deposit/withdraw choice lists agree on one
  // source of truth. Called wherever stockDefaults changes: every overlay apply
  // (via seedStockDefaults) and every runtime setStockDefault.
  function syncStockpilable() {
    setStockpilable(
      Object.entries(stockDefaults)
        .filter(([, spec]) => spec.stockpilable)
        .map(([name]) => name),
    );
  }

  // The stockpilable resources, in stable declaration order - the choice list a
  // `from: "stockpilable"` enum param offers.
  function stockpilableStockNames(): string[] {
    return Object.entries(stockDefaults)
      .filter(([, spec]) => spec.stockpilable)
      .map(([name]) => name);
  }

  // Seed a scenario's global stocks onto the world singleton. Skip-if-present,
  // like the fixture replay: on a fresh or reset world every stock lands at its
  // authored value; on a snapshot restore the live values are already there and
  // this is a no-op. The spec's look registers the same way a
  // set_stock_default's would.
  function applyWorldStocks(specs: RuleOverlay["worldStocks"]) {
    for (let [name, spec] of Object.entries(specs ?? {})) {
      if ((spec.icon || spec.color) && !authoredKindVisuals[name])
        registerStockVisual(name, spec.icon, spec.color);
      let stocks = world.entities.world.stocks;
      if (stocks[name]) continue;
      let min = spec.min ?? 0;
      let max = spec.max ?? 100;
      stocks[name] = stock(clamp(spec.value, min, max), min, max);
    }
  }

  function applySetup(setup: SetupDirective[] | undefined) {
    let scatter = (setup ?? [])
      .filter((directive) => directive.scatter)
      .map((directive) => directive.scatter);
    if (!scatter.length) return;

    let occupied = Object.values(world.entities)
      .filter((entity) => entity.pos)
      .map((entity) => entity.pos!);
    let generated = scatterOnGrid(
      space.grid,
      spawnPos,
      scatter,
      activeSeed ^ 0x6d2b79f5,
      occupied,
    );
    for (let token of generated) {
      if (world.entities[token.name]) continue;
      if (
        token.terrain !== undefined &&
        setTerrainAt(space, world, token.x, token.y, token.terrain)
      )
        terrainRevision += 1;
      for (let [name, stockSpec] of Object.entries(token.stocks ?? {}))
        registerStockVisual(name, stockSpec.icon, stockSpec.color);
      placeFixture({
        id: token.name,
        kind: token.kind,
        tags: token.tags,
        stocks: token.stocks,
        pos: { x: token.x, y: token.y },
      });
    }
  }

  // Set a stock on any entity (the world singleton, an agent, a token). Creates
  // the stock if absent - so a GM can introduce a brand-new resource on an entity
  // mid-game - using any supplied bounds, else the existing or default (0..100)
  // bounds. The value is clamped into range, as every stock write is.
  function setStock(
    entityId: string,
    stockName: string,
    value: number,
    bounds?: { min?: number; max?: number },
    visual?: { icon?: string; color?: string },
  ): Stock {
    let e = world.entities[entityId];
    if (!e) throw new Error(`No entity "${entityId}".`);
    if (typeof value !== "number" || Number.isNaN(value))
      throw new Error("A stock value must be a number.");
    let existing = e.stocks[stockName];
    let min = bounds?.min ?? existing?.min ?? 0;
    let max = bounds?.max ?? existing?.max ?? 100;
    if (min > max) throw new Error(`Stock "${stockName}" min exceeds max.`);
    // A brand-new resource needs an icon; an update to one already on the entity
    // (or already registered) doesn't. Validate before writing so a missing
    // icon rejects cleanly rather than half-applying the stock.
    if (!existing) ensureIconFor(stockName, visual?.icon, visual?.color);
    else registerStockVisual(stockName, visual?.icon, visual?.color);
    let prior = existing ? roundStock(existing.value) : null;
    e.stocks[stockName] = stock(clamp(value, min, max), min, max);
    let now = e.stocks[stockName].value;
    recordGm(
      "stock_set",
      prior === null
        ? `set ${entityId}.${stockName} = ${now} (new)`
        : `set ${entityId}.${stockName}: ${prior} -> ${now}`,
      {
        target: entityId,
        detail: { stock: stockName, before: prior, after: now },
      },
    );
    return structuredClone(e.stocks[stockName]);
  }

  // Register a per-agent stock default and seed it onto every character at once -
  // both those alive now and, via withStockDefaults in addAgent, every future
  // joiner. This is how a GM introduces a brand-new per-character need (warmth,
  // wood, mood) safely: without it, a rule that reads the stock throws the moment
  // it touches a character who lacks it (a newcomer, or one reincarnated fresh),
  // and a single missing stock fails the whole tick for everyone. The default
  // never overwrites a stock a character already has - re-running it, or setting a
  // default for a stock some already carry, only fills the gaps.
  function setStockDefault(
    stockName: string,
    spec: StockSpec,
  ): {
    stock: string;
    spec: { value: number; min: number; max: number };
    seeded: string[];
  } {
    if (typeof stockName !== "string" || !stockName.trim())
      throw new Error("A stock name is required.");
    let value = spec?.value;
    if (typeof value !== "number" || Number.isNaN(value))
      throw new Error("A stock default needs a numeric value.");
    let min = spec?.min ?? 0;
    let max = spec?.max ?? 100;
    if (min > max) throw new Error(`Stock "${stockName}" min exceeds max.`);
    // Introducing a per-character resource registers its icon, just like
    // setStock; icon/color are presentation data, folded into the live
    // kindVisuals registry so every renderer uses the GM's choice.
    ensureIconFor(stockName, spec?.icon, spec?.color);
    let resolved = { value: clamp(value, min, max), min, max };
    stockDefaults[stockName] = {
      ...resolved,
      ...(spec.stockpilable ? { stockpilable: true } : {}),
    };
    syncStockpilable();
    let seeded: string[] = [];
    for (let id of agentIds()) {
      let e = entity(id);
      if (e && !e.stocks[stockName]) {
        e.stocks[stockName] = stock(resolved.value, resolved.min, resolved.max);
        seeded.push(id);
      }
    }
    recordGm(
      "stock_default_set",
      `default ${stockName} = ${resolved.value} [${resolved.min}..${resolved.max}] for all agents${seeded.length ? ` (seeded ${seeded.length})` : ""}`,
      { detail: { stock: stockName, spec: resolved, seeded } },
    );
    return { stock: stockName, spec: resolved, seeded };
  }

  // Conjure a kernel entity: an id, tags the rules can bind to, optional stocks,
  // and an optional grid position so a `colocated` gate can match it. This is the
  // kernel-level spawn. A positioned, non-agent entity is then projected onto the
  // grid by syncTokens, so it becomes a discoverable token (subject to fog and the
  // one-token-per-tile rule) and shows in look_around and the map - the same bridge
  // a rule-driven spawn effect rides on the next tick.
  // Write a fixture's entity record into the world and project it onto the grid.
  // Shared by the live spawnEntity path and the overlay replay that re-creates GM
  // fixtures after a reset, so both land an entity the same way. Returns whether a
  // positioned token actually took a grid tile (syncTokens leaves it off the grid if
  // the tile already shows another token - a silent drop the caller surfaces).
  // Resolve `atSpawn` to a concrete tile: the nearest passable, token-free
  // tile BESIDE the spawn, ring by ring. Not the spawn tile itself - characters
  // stand there, and camp furniture squatting the exact center would block
  // build-anywhere gameplay where everyone starts. Reading range (LEDGER_REACH
  // and colocation gates) treats adjacent as "at", so nothing is lost.
  function nearSpawnTile(): Position {
    let s = space.grid.spawn;
    for (let radius = 1; radius <= 3; radius += 1)
      for (let y = s.y - radius; y <= s.y + radius; y += 1)
        for (let x = s.x - radius; x <= s.x + radius; x += 1) {
          if (Math.max(Math.abs(x - s.x), Math.abs(y - s.y)) !== radius)
            continue;
          if (terrainAt(x, y) === undefined) continue;
          let tile = tileAt(space.grid, x, y);
          if (space.grid.impassable.has(tile.terrain)) continue;
          if (tile.token) continue;
          return { x, y };
        }
    return { ...s };
  }

  function placeFixture(spec: FixtureSpec): boolean {
    // `discoverable` is the ergonomic spelling of the "token" tag: the tag is what
    // syncTokens projects onto the grid, but the GM shouldn't have to know that.
    let tags = spec.tags ? [...spec.tags] : [];
    if (spec.discoverable && !tags.includes("token")) tags.push("token");
    let pos = spec.pos ?? (spec.atSpawn ? nearSpawnTile() : undefined);
    world.entities[spec.id] = {
      id: spec.id,
      kind: spec.kind,
      tags,
      stocks: instantiate(spec.stocks ?? {}),
      pos: pos ? { x: pos.x, y: pos.y } : undefined,
      ...(spec.text !== undefined ? { text: validInscription(spec.text) } : {}),
    };
    if (syncTokens(space, world)) tokenRevision += 1;
    return pos ? tokenNameAt(space.grid, pos) === spec.id : false;
  }

  function spawnEntity(spec: {
    id: string;
    kind?: string;
    tags?: string[];
    stocks?: Record<string, StockSpec>;
    pos?: Position;
    discoverable?: boolean;
    reveal?: boolean;
    icon?: string;
    color?: string;
    text?: string;
    allowImpassable?: boolean;
  }): SpawnResult {
    if (!spec || typeof spec.id !== "string")
      throw new Error("An entity needs a string id.");
    if (world.entities[spec.id])
      throw new Error(`Entity "${spec.id}" already exists.`);
    if (spec.icon && !spec.color)
      throw new Error(`Entity "${spec.id}" icon needs a color.`);
    // Refuse to sink a token into ground nobody can stand on. Characters reach a
    // token on impassable terrain only from an adjacent bank, and can never
    // build, stand, or work on its tile - so a stone outcrop in the middle of
    // the lake is almost always a slip, not a design. Deliberate exceptions (a
    // boat, a bridge pier, a fish) say so with `allowImpassable`.
    if (spec.pos && !spec.allowImpassable) {
      let terrain = terrainAt(spec.pos.x, spec.pos.y);
      if (terrain === undefined)
        throw new Error(
          `Entity "${spec.id}" is off the map at (${spec.pos.x}, ${spec.pos.y}).`,
        );
      if (space.grid.impassable.has(terrain))
        throw new Error(
          `Entity "${spec.id}" would sit on "${terrain}" at (${spec.pos.x}, ${spec.pos.y}), which nobody can walk onto - it could only be reached from an adjacent tile, and never stood or built on. Pick a passable tile, or pass allowImpassable:true if it truly belongs in the ${terrain}.`,
        );
    }
    // Register the icon for any resource carried in the spawn's stocks. A
    // token's reserve usually reuses a resource that already has one (a
    // meadow's food); a spec that names one explicitly registers or refreshes it.
    for (let [name, s] of Object.entries(spec.stocks ?? {}))
      registerStockVisual(name, s?.icon, s?.color);
    // Remember the fixture as GM authoring (minus the one-shot `reveal`) so it
    // rides the overlay into persistence and returns after a colony reset.
    let fixture: FixtureSpec = {
      id: spec.id,
      kind: spec.kind,
      tags: spec.tags ? [...spec.tags] : undefined,
      stocks: spec.stocks,
      pos: spec.pos ? { x: spec.pos.x, y: spec.pos.y } : undefined,
      discoverable: spec.discoverable,
      text: spec.text,
    };
    let onMap = placeFixture(fixture);
    spawnedFixtures.push(structuredClone(fixture));
    // An icon/color describes the entity's *kind*, not this one instance, so it
    // is folded into kindVisuals keyed by the entity's declared kind - the same
    // name the map draws with (see visualFor in web/src/icons.ts).
    if (spec.icon || spec.color) {
      if (!spec.kind)
        throw new Error(
          `Entity "${spec.id}" needs a kind for its icon to key off.`,
        );
      authoredKindVisuals[spec.kind] = {
        ...authoredKindVisuals[spec.kind],
        ...(spec.icon ? { icon: spec.icon } : {}),
        ...(spec.color ? { color: spec.color } : {}),
      };
      rebuildKindVisuals();
    }
    // Optionally make it known to the colony right now, rather than waiting for
    // someone to wander within sight. Only meaningful for a token that's on the grid.
    let revealedTo: string[] = [];
    if (spec.reveal && onMap && spec.pos) {
      for (let e of Object.values(world.entities))
        if (hasTag(e, "agent") && e.pos) {
          revealAt(space, e.id, spec.pos, world.tick);
          revealedTo.push(e.id);
        }
    }
    let placed = world.entities[spec.id];
    let named = [...(placed.kind ? [placed.kind] : []), ...placed.tags];
    recordGm(
      "entity_spawned",
      `spawned ${spec.id}${named.length ? ` [${named.join(", ")}]` : ""}${spec.pos ? ` @ (${spec.pos.x}, ${spec.pos.y})` : ""}${spec.pos && hasTag(placed, "token") && !onMap ? " (tile occupied - not on map)" : ""}`,
      {
        target: spec.id,
        detail: { entity: structuredClone(placed) },
      },
    );
    return {
      entity: structuredClone(world.entities[spec.id]),
      onMap,
      revealedTo,
    };
  }

  // --- persistence ------------------------------------------------------

  // Capture every mutable structure as plain JSON. The live `log` array is
  // handed over by reference rather than cloned - callers stringify it
  // immediately and JSON.stringify is synchronous, so it can't tear - which
  // keeps a 50k-event log cheap to snapshot.
  function snapshot(): EngineSnapshot {
    return {
      version: SNAPSHOT_VERSION,
      scenario: scenario.name,
      world: structuredClone(world),
      space: {
        grid: {
          ...space.grid,
          impassable: [...space.grid.impassable],
          terrainCost: [...space.grid.terrainCost],
        },
        fog: [...space.fog].map(([id, seen]) => [id, [...seen]]),
        fogRevision: space.fogRevision,
        moves: [...space.moves].map(([id, mv]) => [id, mv]),
      },
      meta: [...meta],
      log,
      nextSeq,
      gmLog,
      nextGmSeq,
      overlay: ruleOverlay(),
      orders: [...orders],
    };
  }

  // Rehydrate from a snapshot, rebuilding the Maps/Set the flattened image
  // dropped. Refuses a snapshot taken against a different scenario (its grid and
  // stocks wouldn't match this program) and an unknown version; returns whether
  // it took, so a host can fall back to a fresh world.
  function restore(snap: EngineSnapshot | null | undefined): boolean {
    if (!snap || snap.version !== SNAPSHOT_VERSION) return false;
    if (snap.scenario !== scenario.name) return false;
    let clone = structuredClone(snap);
    world = clone.world;
    space = {
      grid: {
        ...clone.space.grid,
        impassable: new Set(clone.space.grid.impassable),
        terrainCost: new Map(clone.space.grid.terrainCost),
      },
      fog: new Map(clone.space.fog.map(([id, seen]) => [id, new Map(seen)])),
      fogRevision: clone.space.fogRevision ?? 0,
      moves: new Map(clone.space.moves),
    };
    // The snapshot carries its own map, so the spawn tile and seed came with it.
    // Re-sync the closures init() set at createWorld time: addAgent places a
    // joining character at `spawnPos`, not grid.spawn, so a stale spawnPos (the
    // scenario's default pick, chosen against the config seed) would drop new
    // characters on a tile the restored map - rolled under a different seed - may
    // have made water. Adopt the restored grid's spawn instead.
    spawnPos = space.grid.spawn;
    if (typeof world.seed === "number") activeSeed = world.seed;
    resetKnownTerrains();
    meta = new Map(clone.meta);
    log = clone.log;
    nextSeq = clone.nextSeq;
    gmLog = clone.gmLog ?? [];
    nextGmSeq = clone.nextGmSeq ?? 0;
    orders = new Map(clone.orders ?? []);
    applyOverlay(clone.overlay);
    terrainRevision = 0;
    tokenRevision = 0;
    return true;
  }

  return {
    tick,
    get scenarioName() {
      return scenario.name;
    },
    addAgent,
    removeAgent,
    hasAgent,
    isAlive,
    isDead,
    diedAt,
    displayName,
    agentIds,
    commitIntent,
    setOrder,
    cancelOrder,
    getOrder,
    speak,
    whisper,
    inscribe,
    announce,
    visibleTo,
    visibleEventsSince,
    getObservation,
    knownLocations,
    frontierView,
    sense: senseView,
    route,
    getAdminState,
    getEntities,
    getMapEntities,
    getMap,
    getMinimap,
    getMapTokens,
    getFog,
    terrainRevision: () => terrainRevision,
    tokenRevision: () => tokenRevision,
    fogRevision: () => space.fogRevision,
    getMapRegion,
    getRules,
    getRuleMeta,
    getHistory,
    // The GM's edits distilled to a portable diff, and the inverse: re-seed the
    // live rule set from the scenario baseline plus such a diff. A host uses this
    // pair to persist GM rules apart from the world and re-apply them on reset.
    getOverlay: ruleOverlay,
    applyOverlay,
    addRule,
    removeRule,
    patchRule,
    dryRunRule: dryRunLiveRule,
    setStock,
    setStockDefault,
    getStockDefaults: () => structuredClone(stockDefaults),
    getTerrainSpecs: () => structuredClone(terrainSpecs),
    registerTerrain,
    registerKindVisual,
    setTerrainTiles,
    spawnEntity,
    recentEvents,
    getSpeculativeAttempts,
    recordGm,
    recentGmEvents,
    gmEventsSince,
    gmCursor: () => nextGmSeq,
    getPulse,
    getEventsSince,
    oldestSeq,
    backfillCursor,
    cursor: () => nextSeq,
    currentTick: () => world.tick,
    reset,
    snapshot,
    restore,
  };
}

export type WorldEngine = ReturnType<typeof createWorld>;
