import type { RuleOverlay, WorldEngine } from "@agent-island/engine/engine";
import type { JournalHealth } from "./journal.js";
import type { GraphicsConfig } from "./world-file.js";
import { overlayRuleIds } from "@agent-island/engine/overlays";

export interface AdminSessionView {
  waiter: unknown;
  isGm: boolean;
}

export interface AdminPayloadContext {
  engine: WorldEngine;
  worldId: string;
  maxWaitMs: number;
  minTurnMs: number;
  // 0 = the lockstep barrier; > 0 = the real-time clock's tick cadence in ms.
  realTimeMs: number;
  // Operator pause: when true, no driver advances the world. Surfaced so the HUD
  // pause button reflects the current state.
  paused: boolean;
  running: boolean;
  lastTickAt: number | null;
  lastTickError: string | null;
  // The victory lifecycle, surfaced so the dashboard can badge a won/concluded
  // world. `victoryTick` is when a scenario rule declared victory (null if the
  // game is still live and unwon); `endedAt` is when the grace window elapsed
  // and the world froze (null until then); `victoryGraceTicks` is the configured
  // window between the two.
  victoryTick: number | null;
  endedAt: number | null;
  victoryGraceTicks: number;
  activeSessions: AdminSessionView[];
  sessions: AdminSessionView[];
  seats: Map<string, string>;
  customRules: RuleOverlay;
  customRuleSources: Record<string, string>;
  savedRules: RuleOverlay | null;
  journalHealth: JournalHealth;
}

// Which agents currently have a live MCP session driving them - shared by the
// admin payload and the GM inspection tool, both of which project it the same way.
export function controllersView(
  engine: WorldEngine,
  seats: Map<string, string>,
) {
  return Object.fromEntries(
    engine
      .agentIds()
      .map((agentId) => [agentId, { connected: seats.has(agentId) }]),
  );
}

export function buildAdminPayload(context: AdminPayloadContext) {
  let {
    engine,
    worldId,
    maxWaitMs,
    minTurnMs,
    realTimeMs,
    paused,
    running,
    lastTickAt,
    lastTickError,
    victoryTick,
    endedAt,
    victoryGraceTicks,
    activeSessions,
    sessions,
    seats,
    customRules,
    customRuleSources,
    savedRules,
    journalHealth,
  } = context;
  let state = engine.getAdminState();
  let ruleMeta = engine.getRuleMeta();
  return {
    worldId,
    maxWaitMs,
    minTurnMs,
    // Three independent map revisions: terrain (rare, its own /api/map fetch),
    // fog (per-step, its own /api/fog fetch), and tokens - which ride inline
    // here because the token layer is sparse and cheap to ship every poll.
    terrainRevision: engine.terrainRevision(),
    tokenRevision: engine.tokenRevision(),
    fogRevision: engine.fogRevision(),
    tokens: engine.getMapTokens(),
    state,
    entities: engine.getMapEntities(),
    controllers: controllersView(engine, seats),
    eventLog: engine.recentEvents(200),
    history: engine.getHistory(),
    rules: engine.getRules(),
    ruleMeta: {
      ...ruleMeta,
      customIds: overlayRuleIds(customRules),
      customSources: customRuleSources,
      dirtyIds: overlayRuleIds(savedRules ?? undefined),
    },
    gmEventLog: engine.recentGmEvents(200),
    liveness: {
      running,
      // The clock driver: 0 means the lockstep barrier is in force; a positive
      // value is the real-time tick cadence in ms.
      realTimeMs,
      // Operator pause: the world holds still under whichever driver until this
      // clears. The dashboard's pause button reflects and toggles it.
      paused,
      // A won world reports `ended: true` once its grace window has closed and
      // its clock is frozen; `victoryTick`/`victoryGraceTicks` let the UI show
      // "victory — colony winding down" during the grace window in between.
      ended: endedAt !== null,
      endedAt,
      victoryTick,
      victoryGraceTicks,
      lastTickAt,
      lastTickError,
      journal: journalHealth,
      activeCount: activeSessions.length,
      parkedCount: activeSessions.filter((session) => session.waiter !== null)
        .length,
      gmConnected: sessions.some((session) => session.isGm),
    },
  };
}

export function buildMapPayload(
  engine: WorldEngine,
  worldId: string,
  graphics: GraphicsConfig,
) {
  // Sprites ride inline in the terrain/kind visuals now, so graphics is just
  // presentation config (the default zoom scale) - there are no asset packs.
  return {
    worldId,
    terrainRevision: engine.terrainRevision(),
    map: engine.getMap(),
    graphics,
  };
}

export function buildFogPayload(engine: WorldEngine, worldId: string) {
  return {
    worldId,
    fogRevision: engine.fogRevision(),
    fog: engine.getFog(),
  };
}
