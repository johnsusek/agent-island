import { computed, effectScope, onScopeDispose, ref, shallowRef } from "vue";
import type {
  AdminPayload,
  EventView,
  FogPayload,
  MapPayload,
  GraphicsConfig,
  RuleView,
  SpeculativeCluster,
} from "./types";

// "Is the world live?" - derived from the server's liveness block plus the
// client's own clock, so the "ago" counter keeps climbing while paused.
export interface LivenessView {
  status: "live" | "waiting" | "idle" | "paused" | "ended";
  agoSeconds: number | null;
  active: number;
  parked: number;
  error: string | null;
  paused: boolean;
  realTimeMs: number;
  gmConnected: boolean;
}

export interface ChatMessage {
  key: string;
  tick: number;
  speakerId: string;
  speaker: string;
  target: string;
  whisper: boolean;
  message: string;
}

export type ChatItem = { kind: "chat" } & ChatMessage;

// One row of the observatory feed. `wish` is a speculative attempt, `law` a
// realized wish or a GM mint, `chat` speech, `event` everything else.
export interface FeedItem {
  kind: "event" | "wish" | "law";
  key: string;
  tick: number;
  text: string;
  type: string;
  name?: string;
  agentId?: string;
  verb?: string;
  expectation?: string;
}

// One law of the physics ledger: a runtime-minted action rule with its
// provenance - who wished for it, when, and how fast the Oracle answered.
export interface LawCard {
  id: string;
  aliases: string[];
  description: string | null;
  // A rule with a `requires` gate can refuse; one without is a free wish.
  gated: boolean;
  mintTick: number | null;
  firstWishTick: number | null;
  latency: number | null;
  wishers: string[];
  attempts: number;
}

// A wish still standing: a verb cluster no live action rule answers to.
export interface WishCard {
  verb: string;
  count: number;
  wishers: string[];
  firstTick: number;
  lastTick: number;
  expectation: string | null;
}

function normalizeGraphics(
  graphics: Partial<GraphicsConfig> | null | undefined,
): GraphicsConfig {
  return { scale: graphics?.scale ?? 3 };
}

// One poll loop, shared by the whole app. Holds the latest AdminPayload and
// the view-models derived from it; skips reactivity work when nothing changed.
function createWorldState() {
  let payload = shallowRef<AdminPayload | null>(null);
  let mapPayload = shallowRef<MapPayload | null>(null);
  let fogPayload = shallowRef<FogPayload | null>(null);
  let stateError = ref("");
  let stateRequestInFlight = false;
  let mapRequestInFlight = false;
  let fogRequestInFlight = false;
  let lastPayloadJson = "";
  let lastMapJson = "";
  let lastFogJson = "";

  // The full event history, accumulated across polls by `seq` (each poll only
  // carries the server's most recent window). Cleared when worldId changes.
  let eventHistory = shallowRef<EventView[]>([]);
  let lastEventSeq = -1;
  let eventHistoryWorldId = "";

  function resetEventHistory(worldId: string) {
    eventHistoryWorldId = worldId;
    eventHistory.value = [];
    lastEventSeq = -1;
  }

  function mergeEventHistory(body: AdminPayload) {
    if (body.worldId !== eventHistoryWorldId) resetEventHistory(body.worldId);
    let fresh = body.eventLog.filter((e) => e.seq > lastEventSeq);
    if (!fresh.length) return;
    lastEventSeq = fresh[fresh.length - 1].seq;
    eventHistory.value = [...eventHistory.value, ...fresh];
  }

  async function requestState() {
    if (stateRequestInFlight) return;
    stateRequestInFlight = true;
    try {
      let response = await fetch("/api/state");
      let body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Request failed.");
      let json = JSON.stringify(body);
      if (json !== lastPayloadJson) {
        lastPayloadJson = json;
        payload.value = body as AdminPayload;
        mergeEventHistory(payload.value);
      }
      stateError.value = "";
    } catch (error) {
      stateError.value = (error as Error).message || "Request failed.";
    } finally {
      stateRequestInFlight = false;
    }
  }

  async function requestMap() {
    if (mapRequestInFlight) return;
    mapRequestInFlight = true;
    try {
      let response = await fetch("/api/map");
      let body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Map request failed.");
      let json = JSON.stringify(body);
      if (json !== lastMapJson) {
        lastMapJson = json;
        mapPayload.value = body as MapPayload;
      }
    } catch {
      // transient; the next poll retries
    } finally {
      mapRequestInFlight = false;
    }
  }

  async function requestFog() {
    if (fogRequestInFlight) return;
    fogRequestInFlight = true;
    try {
      let response = await fetch("/api/fog");
      let body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Fog request failed.");
      let json = JSON.stringify(body);
      if (json !== lastFogJson) {
        lastFogJson = json;
        fogPayload.value = body as FogPayload;
      }
    } catch {
      // transient; the next poll retries
    } finally {
      fogRequestInFlight = false;
    }
  }

  async function refresh() {
    await requestState();
    if (!payload.value) return;
    let worldChanged = mapPayload.value?.worldId !== payload.value.worldId;
    if (
      worldChanged ||
      mapPayload.value?.terrainRevision !== payload.value.terrainRevision
    )
      await requestMap();
    if (
      worldChanged ||
      fogPayload.value?.fogRevision !== payload.value.fogRevision
    )
      await requestFog();
  }

  void refresh();
  let timer = window.setInterval(refresh, 1_000);
  let now = ref(Date.now());
  let nowTimer = window.setInterval(() => (now.value = Date.now()), 1_000);
  onScopeDispose(() => {
    window.clearInterval(timer);
    window.clearInterval(nowTimer);
  });

  let display = computed(() => payload.value?.state.scenario?.display ?? {});
  let terrainVisuals = computed(
    () => payload.value?.state.scenario?.terrainVisuals ?? {},
  );
  let kindVisuals = computed(
    () => payload.value?.state.scenario?.kindVisuals ?? {},
  );
  let entities = computed(() => payload.value?.entities ?? {});
  let agents = computed(() => payload.value?.state.agents ?? {});

  let mapView = computed(() => mapPayload.value?.map ?? null);
  let worldId = computed(() => mapPayload.value?.worldId ?? "");
  let terrainRevision = computed(() => mapPayload.value?.terrainRevision ?? -1);
  let mapTokens = computed(() => payload.value?.tokens ?? []);
  let tokenRevision = computed(() => payload.value?.tokenRevision ?? -1);
  let fog = computed(() => fogPayload.value?.fog ?? null);
  let fogRevision = computed(() => fogPayload.value?.fogRevision ?? -1);
  let graphics = computed(() => normalizeGraphics(mapPayload.value?.graphics));

  // With connected characters, spectators see only the collective knowledge.
  // With no connected controllers, the island stays fully visible.
  let sharedFog = computed(() =>
    Object.values(payload.value?.controllers ?? {}).some(
      (controller) => controller.connected,
    ),
  );

  let liveness = computed<LivenessView>(() => {
    let l = payload.value?.liveness;
    let lastTickAt = l?.lastTickAt ?? null;
    let active = l?.activeCount ?? 0;
    let parked = l?.parkedCount ?? 0;
    let error = l?.lastTickError ?? null;
    let status: LivenessView["status"] = l?.ended
      ? "ended"
      : l?.paused
        ? "paused"
        : error
          ? "paused"
          : active === 0
            ? "idle"
            : parked < active
              ? "waiting"
              : "live";
    return {
      status,
      agoSeconds:
        lastTickAt == null
          ? null
          : Math.max(0, Math.round((now.value - lastTickAt) / 1000)),
      active,
      parked,
      error,
      paused: l?.paused ?? false,
      realTimeMs: l?.realTimeMs ?? 0,
      gmConnected: l?.gmConnected ?? false,
    };
  });

  let nameOf = (id?: string) => {
    if (!id) return "someone";
    return agents.value[id]?.name || id;
  };

  // --- the physics ledger ------------------------------------------------

  // Which live action rules answer to a given word.
  function answers(rule: RuleView, verb: string) {
    return rule.id === verb || (rule.aliases ?? []).includes(verb);
  }

  let actionRules = computed(() =>
    (payload.value?.rules ?? []).filter((rule) => rule.kind === "action"),
  );

  // Runtime-minted actions: everything not in the scenario baseline. In
  // genesis the baseline ships zero actions, so every law here is
  // agent-originated physics.
  let mintedActions = computed(() => {
    let baseline = new Set(payload.value?.ruleMeta?.baselineIds ?? []);
    let custom = new Set(payload.value?.ruleMeta?.customIds ?? []);
    return actionRules.value.filter(
      (rule) => !baseline.has(rule.id) && !custom.has(rule.id),
    );
  });

  let laws = computed<LawCard[]>(() => {
    let p = payload.value;
    if (!p) return [];
    // The earliest rule_added/rule_tweaked audit row per rule id is its mint.
    let mintTicks = new Map<string, number>();
    for (let event of p.gmEventLog) {
      if (event.kind !== "rule_added" && event.kind !== "rule_tweaked")
        continue;
      if (!event.target) continue;
      if (!mintTicks.has(event.target)) mintTicks.set(event.target, event.tick);
    }
    let clusters = p.speculative ?? [];
    return mintedActions.value
      .map((rule) => {
        let matched = clusters.filter((cluster) => answers(rule, cluster.verb));
        let firstWishTick = matched.length
          ? Math.min(...matched.map((cluster) => cluster.firstTick))
          : null;
        let mintTick = mintTicks.get(rule.id) ?? null;
        let wishers = [
          ...new Set(
            matched.flatMap((cluster) =>
              cluster.distinctActors.map((id) => nameOf(id)),
            ),
          ),
        ];
        return {
          id: rule.id,
          aliases: (rule.aliases ?? []).filter((alias) => alias !== rule.id),
          description: rule.description?.trim() || null,
          gated: rule.requires != null,
          mintTick,
          firstWishTick,
          latency:
            mintTick != null && firstWishTick != null
              ? Math.max(0, mintTick - firstWishTick)
              : null,
          wishers,
          attempts: matched.reduce((sum, cluster) => sum + cluster.count, 0),
        };
      })
      .sort((a, b) => (b.mintTick ?? 0) - (a.mintTick ?? 0));
  });

  // Wishes still standing: clusters no live action answers to.
  let wishes = computed<WishCard[]>(() => {
    let p = payload.value;
    if (!p) return [];
    let rules = actionRules.value;
    return (p.speculative ?? [])
      .filter(
        (cluster: SpeculativeCluster) =>
          !rules.some((rule) => answers(rule, cluster.verb)),
      )
      .map((cluster) => ({
        verb: cluster.verb,
        count: cluster.count,
        wishers: cluster.distinctActors.map((id) => nameOf(id)),
        firstTick: cluster.firstTick,
        lastTick: cluster.lastTick,
        expectation: cluster.expectations[0] ?? null,
      }))
      .sort((a, b) => b.lastTick - a.lastTick);
  });

  let ledgerMetrics = computed(() => {
    let lawList = laws.value;
    let latencies = lawList
      .map((law) => law.latency)
      .filter((latency): latency is number => latency != null)
      .sort((a, b) => a - b);
    let medianLatency = latencies.length
      ? latencies[Math.floor(latencies.length / 2)]
      : null;
    let total = actionRules.value.length;
    return {
      laws: lawList.length,
      wishesOpen: wishes.value.length,
      medianLatency,
      // The headline: what share of the live verbs the characters authored.
      agentOriginatedPct: total
        ? Math.round((mintedActions.value.length / total) * 100)
        : null,
      gated: lawList.filter((law) => law.gated).length,
    };
  });

  // --- the feed ------------------------------------------------------------

  // Chat rows: speech and whispers, kept apart so the map can bubble them and
  // the feed can style them.
  let chat = computed<ChatItem[]>(() =>
    eventHistory.value
      .filter((e) => e.type === "whispered" || e.type === "said")
      .map((e) => ({
        kind: "chat" as const,
        key: String(e.seq),
        tick: e.tick,
        speakerId: e.agentId ?? "",
        speaker: nameOf(e.agentId),
        target: nameOf(e.target),
        whisper: e.type === "whispered",
        message: e.message ?? "",
      })),
  );

  // Everything else, with wishes and realizations pulled out as first-class
  // row kinds - they are the whole show.
  let feed = computed<FeedItem[]>(() =>
    eventHistory.value
      .filter((e) => e.type !== "whispered" && e.type !== "said")
      .filter((e) => e.type !== "arrived")
      .filter((e) => e.type !== "order_completed")
      .filter((e) => e.type !== "order_started")
      .filter(
        (e) => !(e.type === "action_started" && e.text?.includes("begins to")),
      )
      .map((e) => {
        let kind: FeedItem["kind"] =
          e.type === "speculative_attempt"
            ? "wish"
            : e.type === "speculation_realized"
              ? "law"
              : "event";
        return {
          kind,
          key: String(e.seq),
          tick: e.tick,
          type: e.type,
          name: e.agentId ? nameOf(e.agentId) : undefined,
          agentId: e.agentId,
          text: e.text ?? e.type,
          verb: e.verb,
          expectation: e.expectation,
        };
      }),
  );

  return {
    payload,
    stateError,
    display,
    terrainVisuals,
    kindVisuals,
    entities,
    agents,
    mapView,
    worldId,
    terrainRevision,
    mapTokens,
    tokenRevision,
    fog,
    fogRevision,
    graphics,
    sharedFog,
    liveness,
    laws,
    wishes,
    ledgerMetrics,
    chat,
    feed,
    nameOf,
  };
}

// The one shared store, created lazily inside a detached effect scope so its
// poll timers live for the whole app session.
let sharedWorldState: ReturnType<typeof createWorldState> | null = null;

export function useWorldState() {
  if (!sharedWorldState) {
    sharedWorldState = effectScope(true).run(() => createWorldState())!;
  }
  return sharedWorldState;
}
