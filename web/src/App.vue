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
let selectedAgentId = ref<string | null>(null);
let feedHeight = ref(
  Math.round(Math.min(136, Math.max(112, window.innerHeight * 0.17))),
);

let selectedAgent = computed(() => {
  let id = selectedAgentId.value;
  return id ? (world.agents.value[id] ?? null) : null;
});

function selectByName(name: string) {
  let match = Object.values(world.agents.value).find(
    (agent) => agent.name === name,
  );
  if (match) selectedAgentId.value = match.id;
}
</script>

<template>
  <div class="observatory" :style="{ '--feed-height': `${feedHeight}px` }">
    <ClockStrip
      :payload="world.payload.value"
      :liveness="world.liveness.value"
      :error="world.stateError.value"
      :agents="world.agents.value"
      @select="(id) => (selectedAgentId = id)"
    />

    <main class="observatory__main">
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

      <div class="observatory__rail">
        <DossierDrawer
          v-if="selectedAgent"
          :agent="selectedAgent"
          :display="world.display.value"
          :chat="world.chat.value"
          :feed="world.feed.value"
          :laws="world.laws.value"
          :speculations="world.speculations.value"
          @close="selectedAgentId = null"
        />
        <LedgerRail
          v-else
          :laws="world.laws.value"
          :speculations="world.speculations.value"
          @select-name="selectByName"
        />
      </div>
    </main>

    <FeedStrip
      :feed="world.feed.value"
      :chat="world.chat.value"
      :height="feedHeight"
      @select="(id) => (selectedAgentId = id)"
      @resize="(height) => (feedHeight = height)"
    />
  </div>
</template>
