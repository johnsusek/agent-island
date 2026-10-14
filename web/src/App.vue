<script setup lang="ts">
import { computed, ref } from "vue";
import ClockStrip from "./components/ClockStrip.vue";
import DossierDrawer from "./components/DossierDrawer.vue";
import FeedStrip from "./components/FeedStrip.vue";
import LedgerRail from "./components/LedgerRail.vue";
import WorldMap from "./components/WorldMap.vue";
import { useWorldState } from "./useWorldState";

let world = useWorldState();

// One selection for the whole observatory: a character. Selecting narrows the
// map's fog to their personal knowledge and opens their dossier over the
// ledger; clicking empty ground (or the dossier's close) restores the wide view.
// The map fills the window; every panel floats over it in the HUD layer.
let selectedAgentId = ref<string | null>(null);
let feedHeight = ref(
  Math.round(Math.min(176, Math.max(128, window.innerHeight * 0.2))),
);

let selectedAgent = computed(() => {
  let id = selectedAgentId.value;
  return id ? (world.agents.value[id] ?? null) : null;
});

</script>

<template>
  <div class="observatory" :style="{ '--feed-height': `${feedHeight}px` }">
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
      :tick="world.payload.value?.state.tick ?? 0"
      @select="(id) => (selectedAgentId = id)"
    />

    <div class="hud">
      <ClockStrip
        class="hud__top"
        :payload="world.payload.value"
        :liveness="world.liveness.value"
        :error="world.stateError.value"
        :agents="world.agents.value"
        @select="(id) => (selectedAgentId = id)"
      />

      <div class="hud__rail">
        <DossierDrawer
          v-if="selectedAgent"
          :agent="selectedAgent"
          :display="world.display.value"
          :kind-visuals="world.kindVisuals.value"
          :chat="world.chat.value"
          :feed="world.feed.value"
          @close="selectedAgentId = null"
        />
        <LedgerRail v-else :laws="world.laws.value" />
      </div>

      <FeedStrip
        class="hud__feed"
        :feed="world.feed.value"
        :chat="world.chat.value"
        :height="feedHeight"
        @select="(id) => (selectedAgentId = id)"
        @resize="(height) => (feedHeight = height)"
      />
    </div>
  </div>
</template>
