import type { WorldEngine } from "./rules/engine.js";
import type { JournalHealth } from "./journal.js";
import { controllersView } from "./coordinator-admin.js";

export interface InspectQuery {
  include?: string[];
  agent?: string;
  entity?: string;
  rule?: string;
  area?: { around?: string; x?: number; y?: number; radius?: number };
}

export interface InspectionContext {
  engine: WorldEngine;
  worldId: string;
  running: boolean;
  lastTickAt: number | null;
  lastTickError: string | null;
  journalHealth: JournalHealth;
  seats: Map<string, string>;
}

export function buildInspection(
  context: InspectionContext,
  query: InspectQuery = {},
) {
  let {
    engine,
    worldId,
    running,
    lastTickAt,
    lastTickError,
    journalHealth,
    seats,
  } = context;
  let state = engine.getAdminState();
  let entities = engine.getEntities();
  let rules = engine.getRules();
  let roster = Object.values(state.agents) as any[];

  let values = (stocks: Record<string, any>) =>
    Object.fromEntries(
      Object.entries(stocks).map(([stockName, stockView]) => [
        stockName,
        stockView.value,
      ]),
    );

  let resolveEntityId = (queryText: string) => {
    if (entities[queryText]) return queryText;
    let normalized = queryText.trim().toLowerCase();
    return (
      Object.keys(entities).find(
        (entityId) => entityId.toLowerCase() === normalized,
      ) ?? null
    );
  };

  let resolveAgentId = (queryText: string) => {
    let normalized = queryText.trim().toLowerCase();
    return (
      (Object.entries(state.agents) as [string, any][]).find(
        ([agentId, agentView]) =>
          agentId.toLowerCase() === normalized ||
          agentView.name.toLowerCase() === normalized,
      )?.[0] ?? null
    );
  };

  let overview = {
    world: state.world,
    // A north-up ASCII minimap of the whole grid, so a director reads geography
    // and directional language off the picture instead of guessing an axis from
    // raw coordinates. Its `orientation` line is the source of truth for which
    // edge is north/south/east/west.
    minimap: engine.getMinimap(),
    agents: roster.map((agentView) => ({
      name: agentView.name,
      at: agentView.at,
      pos: agentView.position,
      alive: agentView.alive,
      doing: agentView.action ? agentView.action.type : "idle",
      vitals: values(agentView.stocks),
    })),
    entities: Object.values(entities)
      // Agents have their own roster above; everything else is listed. Only
      // "agent" is filtered - it is kernel vocabulary. Hiding a class of entity
      // behind a scenario's own tag would make the overview lie by omission to
      // any world that happened to use that word.
      .filter((entityView: any) => !entityView.tags.includes("agent"))
      .map((entityView: any) => {
        let stocks = values(entityView.stocks);
        return {
          id: entityView.id,
          ...(entityView.kind ? { kind: entityView.kind } : {}),
          tags: entityView.tags,
          ...(entityView.pos ? { pos: entityView.pos } : {}),
          ...(Object.keys(stocks).length ? { stocks } : {}),
        };
      }),
    rules: rules.map((ruleView: any) => ({
      id: ruleView.id,
      ...(ruleView.phase ? { phase: ruleView.phase } : {}),
      ...(ruleView.kind ? { kind: ruleView.kind } : {}),
      description: ruleView.description,
    })),
    events: engine.recentEvents(30),
  };

  let focus: Record<string, unknown> = {};
  if (query.agent) {
    let agentId = resolveAgentId(query.agent);
    focus.agent = agentId
      ? {
          ...state.agents[agentId],
          observation: engine.getObservation(agentId),
        }
      : { error: `No agent named "${query.agent}".` };
  }
  if (query.entity) {
    let entityId = resolveEntityId(query.entity);
    focus.entity = entityId
      ? entities[entityId]
      : { error: `No entity "${query.entity}".` };
  }
  if (query.rule) {
    focus.rule =
      rules.find((ruleView: any) => ruleView.id === query.rule) ??
      ({ error: `No rule "${query.rule}".` } as any);
  }
  if (query.area) {
    let { around, x: tileX, y: tileY, radius } = query.area;
    let center =
      around != null
        ? (() => {
            let entityId = resolveEntityId(around);
            return entityId ? entities[entityId]?.pos : undefined;
          })()
        : typeof tileX === "number" && typeof tileY === "number"
          ? { x: tileX, y: tileY }
          : undefined;
    focus.area = center
      ? engine.getMapRegion(center.x, center.y, radius ?? 4)
      : {
          error: `Area needs numeric x/y or an "around" target with a position.`,
        };
  }

  let fullSections: Record<string, () => unknown> = {
    agents: () => state.agents,
    entities: () => entities,
    rules: () => rules,
    ruleMeta: () => engine.getRuleMeta(),
    map: () => engine.getMap(),
    observations: () =>
      Object.fromEntries(
        engine
          .agentIds()
          .map((agentId) => [agentId, engine.getObservation(agentId)]),
      ),
    history: () => engine.getHistory(),
    controllers: () => controllersView(engine, seats),
    pulse: () => engine.getPulse(),
    dormant: () => engine.getDormantVerbs(),
  };
  let includeNames = query.include?.includes("all")
    ? Object.keys(fullSections)
    : (query.include ?? []).filter(
        (sectionName) => sectionName in fullSections,
      );
  let full: Record<string, unknown> = {};
  for (let sectionName of includeNames)
    full[sectionName] = fullSections[sectionName]();

  // The GM overview keeps the scenario block lean: identity and the map-drawing
  // registries a director needs at a glance, minus the authored-furniture detail
  // (fixtures/setup/terrainSpecs) that only the dashboard's Scenario inspector
  // reads. Inline sprite grids are web-renderer material and the heaviest part
  // of the visual registries, so each visual collapses its sprite to `true` -
  // enough for a director to spot kinds still missing art.
  let { fixtures, setup, terrainSpecs, ...scenarioOverview } = state.scenario;
  void fixtures;
  void setup;
  void terrainSpecs;
  let leanVisuals = (visuals: unknown) =>
    Object.fromEntries(
      Object.entries(
        (visuals ?? {}) as Record<string, { sprite?: unknown }>,
      ).map(([name, visual]) => [
        name,
        { ...visual, ...(visual.sprite ? { sprite: true } : {}) },
      ]),
    );

  // stockDefaults' own label/bands are authoring data, not something a
  // director reading the overview needs twice - the same presentation already
  // rides the scenario block's `display` (the engine's stockDisplay
  // projection), and a vital's bands alone can be several sentences per band.
  // Keep the mechanical bits (bounds/icon/color/stockpilable/role) a director
  // might still want at a glance; strip the prose duplicate.
  const PROSE_FIELDS = ["label", "bands"];
  let leanStockDefaults = (defaults: unknown) =>
    Object.fromEntries(
      Object.entries((defaults ?? {}) as Record<string, object>).map(
        ([name, spec]) => [
          name,
          Object.fromEntries(
            Object.entries(spec).filter(([key]) => !PROSE_FIELDS.includes(key)),
          ),
        ],
      ),
    );

  return {
    worldId,
    tick: state.tick,
    scenario: {
      ...scenarioOverview,
      kindVisuals: leanVisuals((scenarioOverview as any).kindVisuals),
      terrainVisuals: leanVisuals((scenarioOverview as any).terrainVisuals),
      stockDefaults: leanStockDefaults((scenarioOverview as any).stockDefaults),
    },
    population: state.population,
    liveness: {
      running,
      lastTickAt,
      lastTickError,
      journal: journalHealth,
      gmConnected: true,
    },
    ...overview,
    ...full,
    ...(Object.keys(focus).length ? { focus } : {}),
    drilldown: {
      agent:
        'inspect_world({agent:"Ada"}) - one agent, full state + observation',
      entity:
        'inspect_world({entity:"meadow-1"}) - one entity, full stocks/tags',
      rule: 'inspect_world({rule:"satiation-falls"}) - one rule, full body',
      area: 'inspect_world({area:{around:"meadow-1",radius:4}}) - local map tiles + occupants',
      include: `inspect_world({include:[...]}) - full sections: ${Object.keys(fullSections).join(", ")}, or "all"`,
    },
  };
}
