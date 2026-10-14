<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Announcer from "./components/Announcer.vue";
import DossierDrawer from "./components/DossierDrawer.vue";
import FeedStrip from "./components/FeedStrip.vue";
import LedgerRail from "./components/LedgerRail.vue";
import PartyFrames from "./components/PartyFrames.vue";
import ResourceBar from "./components/ResourceBar.vue";
import TimeWidget from "./components/TimeWidget.vue";
import WorldMap from "./components/WorldMap.vue";
import { useWorldState } from "./useWorldState";

let world = useWorldState();

// The island fills the window and the interface is a game HUD over it:
// resources top left, the clock and speed top right, the party down the left
// edge, the selected character's sheet down the right, the log bottom left
// and the dock bottom right. The Ledger opens as a book over the map.
//
// One selection for the whole observatory: a character. Selecting narrows the
// map's fog to their personal knowledge and opens their sheet; clicking empty
// ground (or the sheet's close, or Esc) restores the wide view.
let selectedAgentId = ref<string | null>(null);
let ledgerOpen = ref(false);
let logCollapsed = ref(false);
let keysOpen = ref(false);
let feedHeight = ref(
  Math.round(Math.min(200, Math.max(136, window.innerHeight * 0.22))),
);

let selectedAgent = computed(() => {
  let id = selectedAgentId.value;
  return id ? (world.agents.value[id] ?? null) : null;
});

let scenario = computed(() => world.payload.value?.state.scenario?.name ?? "");
let tick = computed(() => world.payload.value?.state.tick ?? 0);

// The world's name belongs in the tab, not in a header on screen.
watch(
  scenario,
  (name) => {
    document.title = name ? `${name} · Agent Island` : "Agent Island";
  },
  { immediate: true },
);

// Party order for cycling: living characters first, by name, matching the
// party frames.
let partyOrder = computed(() =>
  Object.values(world.agents.value)
    .sort(
      (a, b) =>
        Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name),
    )
    .map((agent) => agent.id),
);

function cycleSelection(step: number) {
  let order = partyOrder.value;
  if (!order.length) return;
  let index = selectedAgentId.value
    ? order.indexOf(selectedAgentId.value)
    : -1;
  let next =
    index === -1
      ? step > 0
        ? 0
        : order.length - 1
      : (index + step + order.length) % order.length;
  selectedAgentId.value = order[next];
}

// World controls only: pause and cadence. Resets and crews belong to the CLI.
async function post(path: string, body: Record<string, unknown>) {
  try {
    await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // the poll surfaces connection problems
  }
}

function togglePause() {
  void post("/api/pause", { paused: !world.liveness.value.paused });
}

// Picking a speed while paused also resumes, the way a game's speed buttons do.
function setSpeed(ms: number) {
  void post("/api/clock", { realTimeMs: ms });
  if (world.liveness.value.paused) void post("/api/pause", { paused: false });
}

const SPEED_KEYS: Record<string, number> = { 1: 0, 2: 5000, 3: 2000, 4: 1000 };

const KEYS = [
  { key: "Space", action: "Pause / resume" },
  { key: "1-4", action: "Turn-based, slow, normal, fast" },
  { key: "[ ]", action: "Previous / next character" },
  { key: "L", action: "Open the Ledger" },
  { key: "C", action: "Collapse the log" },
  { key: "Esc", action: "Close / deselect" },
  { key: "?", action: "Show these keys" },
];

function onKey(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  let target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable]")) return;
  let key = event.key;
  if (key === "Escape") {
    if (keysOpen.value) keysOpen.value = false;
    else if (ledgerOpen.value) ledgerOpen.value = false;
    else selectedAgentId.value = null;
  } else if (key === " ") {
    // Space on a focused button should press the button, not pause.
    if (target?.closest("button")) return;
    togglePause();
  } else if (key in SPEED_KEYS) {
    setSpeed(SPEED_KEYS[key]);
  } else if (key === "]") {
    cycleSelection(1);
  } else if (key === "[") {
    cycleSelection(-1);
  } else if (key === "l" || key === "L") {
    ledgerOpen.value = !ledgerOpen.value;
  } else if (key === "c" || key === "C") {
    logCollapsed.value = !logCollapsed.value;
  } else if (key === "?") {
    keysOpen.value = !keysOpen.value;
  } else {
    return;
  }
  event.preventDefault();
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="observatory">
    <WorldMap
      class="observatory__map"
      :map="world.mapView.value"
      :world-id="world.worldId.value"
      :terrain-revision="world.terrainRevision.value"
      :tokens="world.mapTokens.value"
      :token-revision="world.tokenRevision.value"
      :fog="world.fog.value"
      :fog-revision="world.fogRevision.value"
      :graphics="world.graphics.value"
      :agents="world.agents.value"
      :entities="world.entities.value"
      :terrain-visuals="world.terrainVisuals.value"
      :kind-visuals="world.kindVisuals.value"
      :selected-agent-id="selectedAgentId"
      :shared-fog="world.sharedFog.value"
      :chat="world.chat.value"
      :tick="tick"
      @select="(id) => (selectedAgentId = id)"
    />

    <div class="hud" :class="{ 'hud--selected': selectedAgent }">
      <div class="hud__top">
        <ResourceBar :payload="world.payload.value" />
        <TimeWidget
          :tick="tick"
          :liveness="world.liveness.value"
          :error="world.stateError.value"
          @pause="togglePause"
          @speed="setSpeed"
        />
      </div>

      <Announcer
        class="hud__announcer"
        :world-id="world.worldId.value"
        :scenario="scenario"
        :tick="tick"
        :feed="world.feed.value"
        :laws="world.laws.value"
        :liveness="world.liveness.value"
        @select="(id) => (selectedAgentId = id)"
        @ledger="ledgerOpen = true"
      />

      <PartyFrames
        class="hud__party"
        :agents="world.agents.value"
        :display="world.display.value"
        :kind-visuals="world.kindVisuals.value"
        :selected-agent-id="selectedAgentId"
        @select="(id) => (selectedAgentId = id)"
      />

      <div v-if="selectedAgent" class="hud__sheet">
        <DossierDrawer
          :key="selectedAgent.id"
          :agent="selectedAgent"
          :display="world.display.value"
          :kind-visuals="world.kindVisuals.value"
          :chat="world.chat.value"
          :feed="world.feed.value"
          @close="selectedAgentId = null"
        />
      </div>

      <FeedStrip
        class="hud__log"
        :feed="world.feed.value"
        :chat="world.chat.value"
        :height="feedHeight"
        :collapsed="logCollapsed"
        @select="(id) => (selectedAgentId = id)"
        @resize="(height) => (feedHeight = height)"
        @toggle="logCollapsed = !logCollapsed"
      />

      <nav class="hud__dock dock" aria-label="Menus">
        <button
          class="dock__btn"
          :class="{ 'dock__btn--on': ledgerOpen }"
          title="The Ledger (L)"
          @click="ledgerOpen = !ledgerOpen"
        >
          <span class="dock__icon dock__icon--book" aria-hidden="true"></span>
          <span class="dock__label">Ledger</span>
          <span class="dock__key">L</span>
          <span v-if="world.laws.value.length" class="dock__badge">{{
            world.laws.value.length
          }}</span>
        </button>
        <button
          class="dock__btn"
          :class="{ 'dock__btn--on': keysOpen }"
          title="Keys (?)"
          @click="keysOpen = !keysOpen"
        >
          <span class="dock__label">Keys</span>
          <span class="dock__key">?</span>
        </button>
        <div v-if="keysOpen" class="keys panel">
          <div v-for="k in KEYS" :key="k.key" class="keys__row">
            <kbd class="keys__cap">{{ k.key }}</kbd>
            <span>{{ k.action }}</span>
          </div>
        </div>
      </nav>
    </div>

    <LedgerRail
      v-if="ledgerOpen"
      :laws="world.laws.value"
      @close="ledgerOpen = false"
    />
  </div>
</template>
