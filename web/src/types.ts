// Shapes returned by GET /api/state (AdminPayload). Mirrors the server's
// coordinator.getAdminPayload() output - kept in sync by hand.

export interface Position {
  x: number;
  y: number;
}

export interface WorldDimensions {
  width: number;
  height: number;
}

export interface Stock {
  value: number;
  min: number;
  max: number;
}

// What a stock IS to a character (mirrors the engine's scenario.StockRole).
export type StockRole = "vital" | "stat" | "pack";

// How a per-character stock starts out (mirrors the engine's scenario.StockSpec).
// `icon` is the game-icons slug it draws with. The overview payload strips the
// prose fields (label/bands) - they ride `display` instead - so most of
// these are only present on the full section. Direction isn't a field: every
// gauge reads up as good, so harm always sits toward the floor.
export interface StockSpec {
  value: number;
  min?: number;
  max?: number;
  icon?: string;
  color?: string;
  stockpilable?: boolean;
  role?: StockRole;
  label?: string;
  bands?: Partial<Record<"pressing" | "serious" | "critical", string>>;
}

// The reader-facing view of one stock (mirrors the server's StockDisplay,
// built by its stockDisplay projection). `role` classifies the stock; `scope`
// says which registry declared it.
export interface StockDisplay {
  role: StockRole;
  scope: "world" | "agent";
  label?: string;
  bands?: Partial<Record<"pressing" | "serious" | "critical", string>>;
}

// A discrete item a character is holding (mirrors the server's agentView.held).
export interface HeldItem {
  id: string;
  kind?: string;
  text?: string;
}

// The inline sprite DSL (palette + character grid), mirroring the server's
// src/rules/sprite.ts. The server validates; the map bakes it to a texture.
export interface SpriteSpec {
  size: [number, number];
  kind?: "token" | "terrain";
  palette: Record<string, string>;
  grid: string[];
  mirror?: "horizontal" | "vertical" | "none";
  anchor?: { x: number; y: number };
}

// Server-authored appearance for a terrain or kind tag. `sprite` is the world
// art; icon/color/label feed the HUD (legend, tooltips, pills) only - a visual
// with no sprite renders as the missing-sprite checker on the map.
export interface VisualSpec {
  sprite?: SpriteSpec;
  color?: string;
  icon?: string;
  label?: string;
}

// How a terrain kind behaves (mirrors the engine's scenario.TerrainSpec).
export interface TerrainSpec {
  passable?: boolean;
  moveCost?: number;
  visual?: VisualSpec;
}

// A pre-placed world fixture (mirrors the engine's FixtureSpec).
export interface FixtureSpec {
  id: string;
  kind?: string;
  tags?: string[];
  stocks?: Record<string, StockSpec>;
  pos?: Position;
  atSpawn?: boolean;
  discoverable?: boolean;
}

// One scatter recipe run at world setup (mirrors the engine's TokenScatter).
export interface TokenScatter {
  namePrefix: string;
  kind?: string;
  tags: string[];
  count?: number;
  density?: number;
  edgeDensity?: number;
  onTerrain?: string[];
  terrain?: string;
  minSpacing?: number;
  spawnKeepout?: number;
  stocks?: Record<string, unknown>;
}

export interface SetupDirective {
  scatter: TokenScatter;
}

export interface ActionView {
  type: string;
  endsInTicks: number;
  goal?: string;
  direction?: string;
  // For travel/explore: how many tiles remain on the planned path.
  remainingTiles?: number;
  args?: Record<string, unknown>;
}

export interface AgentView {
  id: string;
  name: string;
  position: Position;
  at: string | null;
  kind?: string;
  tags: string[];
  alive: boolean;
  stocks: Record<string, Stock>;
  // Discrete items the character is carrying (see the server's Entity.heldBy),
  // distinct from the fungible counts in `stocks`.
  held: HeldItem[];
  ticksLived: number;
  action: ActionView | null;
  order: OrderView | null;
}

export interface OrderView {
  id: string;
  kind: "repeat" | "sequence";
  status: "running" | "completed" | "blocked" | "interrupted" | "cancelled";
  summary: string;
  startedTick: number;
  updatedTick: number;
  stepIndex?: number;
  repeats?: number;
  reason?: string;
}

export interface Controller {
  connected: boolean;
}

export interface MapToken {
  name: string;
  // The token's identity - the kindVisuals key its sprite and label draw from.
  kind?: string;
  tags: string[];
  // How it sits on its tile; mirrors the server's Entity.occupancy.
  occupancy?: "tile" | "blocking";
}

export interface MapTile {
  x: number;
  y: number;
  terrain: string;
}

// One entry of the token stream: a token and the tile it stands on. Sparse -
// only occupied tiles - so the whole layer rides inline in the admin poll.
export interface PositionedToken {
  x: number;
  y: number;
  token: MapToken;
}

export interface KnownMapTile {
  x: number;
  y: number;
}

// The static terrain stream: ground only, its own revision, fetched from
// /api/map and baked to a texture once per change.
export interface MapView {
  width: number;
  height: number;
  origin: Position;
  spawn: Position;
  tiles: MapTile[];
}

// The per-agent fog stream: the union reveal plus each character's own book,
// fetched from /api/fog on its own revision.
export interface FogView {
  known?: KnownMapTile[];
  // Each character's own fog: the tiles that character has personally seen.
  // There is no shared vision, so the map masks to one character's set when
  // they are selected. `known` (the union) is only the default full-reveal view.
  knownByAgent?: Record<string, KnownMapTile[]>;
}

export interface GraphicsConfig {
  scale: number;
}

// A raw kernel entity, as the god-view (coordinator.getEntities) reports it.
export interface EntityView {
  id: string;
  // The entity's identity - the kindVisuals key its sprite and label draw from.
  kind?: string;
  // Words written on the thing (a sign's inscription), when it carries any.
  text?: string;
  tags: string[];
  // Set when the entity takes ground; such entities are drawn from the token
  // layer, so the object layer skips them.
  occupancy?: "tile" | "blocking";
  stocks: Record<string, Stock>;
  pos?: Position;
  action?: unknown;
  // The id of the entity holding this one, when it is a carried item (off-grid,
  // so it never appears on the token layer).
  heldBy?: string;
}

export interface WorldState {
  tick: number;
  population: number;
  scenario: {
    name: string;
    display: Record<string, StockDisplay>;
    stockDefaults?: Record<string, StockSpec>;
    fixtures?: FixtureSpec[];
    setup?: SetupDirective[];
    terrainSpecs?: Record<string, TerrainSpec>;
    terrainVisuals?: Record<string, VisualSpec>;
    kindVisuals?: Record<string, VisualSpec>;
  };
  world: { stocks: Record<string, Stock> };
  agents: Record<string, AgentView>;
}

export interface EventView {
  seq: number;
  tick: number;
  type: string;
  wake?: "routine" | "decision";
  text?: string;
  agentId?: string;
  message?: string;
  target?: string;
  // speculative_attempt / speculation_realized rows carry the word(s) involved
  // and, for attempts, what the character expected to happen.
  verb?: string;
  verbs?: string[];
  expectation?: string;
}

// An entry in the GM audit trail (mirrors the server's GmEvent).
export interface GmEventView {
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
  target?: string;
  detail?: Record<string, unknown>;
}

// One per-tick sample of the world-scoped numbers.
export interface StockSample {
  tick: number;
  population: number;
  stocks: Record<string, number>;
}

// A live rule, kept open: rules are plain JSON the GM authors freely, so the UI
// reads a few common fields (id, phase/kind, aliases, requires) and leaves the
// rest as the raw object.
export interface RuleView {
  id: string;
  description?: string;
  phase?: string;
  kind?: string;
  aliases?: string[];
  requires?: unknown;
  each?: { tag?: string; kind?: string };
  [field: string]: unknown;
}

export interface RuleMeta {
  baselineIds: string[];
  dirtyIds: string[];
  customIds?: string[];
  customSources?: Record<string, string>;
}

// One verb-cluster of the speculative-attempt feed - the same shape the
// Oracle's list_speculative_attempts returns.
export interface SpeculativeCluster {
  verb: string;
  count: number;
  distinctActors: string[];
  firstTick: number;
  lastTick: number;
  expectations: string[];
  sampleArgs: Record<string, string | number>[];
}

// One noun-cluster of the companion feed - a thing characters reached for that
// doesn't exist yet, with the verbs it was reached for through.
export interface SpeculativeNoun {
  noun: string;
  count: number;
  verbs: string[];
  distinctActors: string[];
  firstTick: number;
  lastTick: number;
}

// Wall-clock health of the logical clock (see coordinator.getAdminPayload).
export interface Liveness {
  running: boolean;
  // 0 = the lockstep barrier (world freezes while agents think); > 0 = the
  // real-time clock's tick cadence in ms.
  realTimeMs: number;
  paused: boolean;
  ended: boolean;
  endedAt: number | null;
  lastTickAt: number | null;
  lastTickError: string | null;
  activeCount: number;
  parkedCount: number;
  gmConnected: boolean;
}

export interface AdminPayload {
  worldId: string;
  maxWaitMs: number;
  terrainRevision: number;
  tokenRevision: number;
  fogRevision: number;
  tokens: PositionedToken[];
  state: WorldState;
  entities: Record<string, EntityView>;
  controllers: Record<string, Controller>;
  eventLog: EventView[];
  gmEventLog: GmEventView[];
  history: StockSample[];
  rules: RuleView[];
  ruleMeta: RuleMeta;
  speculative: SpeculativeCluster[];
  speculativeNouns: SpeculativeNoun[];
  liveness: Liveness;
}

export interface MapPayload {
  worldId: string;
  terrainRevision: number;
  map: MapView;
  graphics: GraphicsConfig;
}

export interface FogPayload {
  worldId: string;
  fogRevision: number;
  fog: FogView;
}
