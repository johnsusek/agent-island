<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import InspectorTip from "./InspectorTip.vue";
import {
  createWorldViewportController,
  type AgentAnchor,
  type TileTooltip,
  type WorldViewportController,
} from "../map";
import { nameTint } from "../glyphs";
import type { ChatItem } from "../useWorldState";
import type {
  AgentView,
  EntityView,
  FogView,
  GraphicsConfig,
  MapView,
  PositionedToken,
  VisualSpec,
} from "../types";

const props = defineProps<{
  map: MapView | null;
  worldId: string;
  terrainRevision: number;
  tokens: PositionedToken[];
  tokenRevision: number;
  fog: FogView | null;
  fogRevision: number;
  graphics: GraphicsConfig;
  agents: Record<string, AgentView>;
  entities: Record<string, EntityView>;
  terrainVisuals: Record<string, VisualSpec>;
  kindVisuals: Record<string, VisualSpec>;
  selectedAgentId: string | null;
  sharedFog: boolean;
  chat: ChatItem[];
  tick: number;
}>();

const emit = defineEmits<{ (e: "select", id: string | null): void }>();

// How many ticks a character's line lingers as a bubble over their token
// before it fades. Short, so the map reads as live speech, not a transcript.
const BUBBLE_TTL_TICKS = 2;

let host = ref<HTMLElement>();
let controller: WorldViewportController | null = null;
let disposed = false;

// The tile under the cursor, and where to float its card. A click pins the
// card in place (so its text can be read and copied); the next click, or its
// close button, releases it.
let hover = ref<TileTooltip | null>(null);
let hoverPos = ref<{ x: number; y: number }>({ x: 0, y: 0 });
let pinned = ref<TileTooltip | null>(null);
let pinnedPos = ref<{ x: number; y: number }>({ x: 0, y: 0 });

function handleHover(
  info: TileTooltip | null,
  clientX: number,
  clientY: number,
) {
  let inspectable =
    info &&
    (info.agents.length > 0 || info.token != null || info.entities.length > 0);
  hover.value = inspectable ? info : null;
  if (hover.value) hoverPos.value = { x: clientX, y: clientY };
}

function floatStyle(pos: { x: number; y: number }) {
  let { x, y } = pos;
  let flipX = x > window.innerWidth - 320;
  let flipY = y > window.innerHeight - 280;
  return {
    left: flipX ? "auto" : `${x + 14}px`,
    right: flipX ? `${window.innerWidth - x + 14}px` : "auto",
    top: flipY ? "auto" : `${y + 14}px`,
    bottom: flipY ? `${window.innerHeight - y + 14}px` : "auto",
  };
}

let tipStyle = computed(() => floatStyle(hoverPos.value));
let pinnedStyle = computed(() => floatStyle(pinnedPos.value));

// Click semantics: a click on a character selects them (dossier); a click on
// anything else pins the tile card; a click on empty ground clears both. A
// drag (camera pan) is not a click.
let downAt: { x: number; y: number } | null = null;

function onPointerDown(event: PointerEvent) {
  downAt = { x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent) {
  if (!downAt) return;
  let moved =
    Math.abs(event.clientX - downAt.x) + Math.abs(event.clientY - downAt.y);
  downAt = null;
  if (moved > 5) return;
  let info = hover.value;
  if (info?.agents.length) {
    emit("select", info.agents[0].id);
    pinned.value = null;
    return;
  }
  if (info && (info.token || info.entities.length)) {
    pinned.value = info;
    pinnedPos.value = { x: event.clientX, y: event.clientY };
    return;
  }
  pinned.value = null;
  emit("select", null);
}

// Live token positions from the controller, refreshed every poll and camera
// move; the speech bubbles are laid out against these.
let anchors = ref<AgentAnchor[]>([]);
function handleAnchors(next: AgentAnchor[]) {
  anchors.value = next;
}

// The most recent line each character spoke within the bubble window.
let recentSpeech = computed(() => {
  let latest = new Map<string, ChatItem>();
  for (let item of props.chat) {
    if (!item.speakerId) continue;
    if (props.tick - item.tick > BUBBLE_TTL_TICKS) continue;
    let prev = latest.get(item.speakerId);
    if (!prev || item.tick >= prev.tick) latest.set(item.speakerId, item);
  }
  return latest;
});

let bubbles = computed(() =>
  anchors.value
    .map((a) => {
      let msg = recentSpeech.value.get(a.id);
      if (!msg) return null;
      return {
        key: a.id,
        name: a.name,
        message: msg.message,
        whisper: msg.whisper,
        color: nameTint(a.name),
        style: {
          left: `${a.x}px`,
          top: `${a.y}px`,
          "--world-scale": `${a.scale}`,
        },
      };
    })
    .filter((b): b is NonNullable<typeof b> => b !== null),
);

onMounted(async () => {
  if (!host.value) return;
  let nextController = await createWorldViewportController(
    host.value,
    handleHover,
    handleAnchors,
    () => {},
  );
  if (disposed) {
    nextController.destroy();
    return;
  }
  controller = nextController;
  if (props.map) pushUpdate();
});

function pushUpdate() {
  if (!controller || !props.map) return;
  controller.update({
    map: props.map,
    worldId: props.worldId,
    terrainRevision: props.terrainRevision,
    tokens: props.tokens,
    tokenRevision: props.tokenRevision,
    fog: props.fog,
    fogRevision: props.fogRevision,
    graphics: props.graphics,
    agents: props.agents,
    entities: props.entities,
    selectedAgentId: props.selectedAgentId,
    terrainVisuals: props.terrainVisuals,
    kindVisuals: props.kindVisuals,
    sharedFog: props.sharedFog,
  });
}

watch(
  () =>
    [
      props.map,
      props.worldId,
      props.terrainRevision,
      props.tokens,
      props.tokenRevision,
      props.fog,
      props.fogRevision,
      props.graphics,
      props.agents,
      props.entities,
      props.selectedAgentId,
      props.terrainVisuals,
      props.kindVisuals,
      props.sharedFog,
    ] as const,
  () => pushUpdate(),
);

onBeforeUnmount(() => {
  disposed = true;
  controller?.destroy();
  controller = null;
});
</script>

<template>
  <div
    class="map-canvas"
    aria-label="World viewport"
    @pointerdown="onPointerDown"
    @pointerup="onPointerUp"
  >
    <div ref="host" class="map-stage"></div>
    <div
      v-for="b in bubbles"
      :key="b.key"
      class="speech"
      :class="{ 'speech--whisper': b.whisper }"
      :style="b.style"
    >
      <span class="speech__name" :style="{ color: b.color }">{{ b.name }}</span>
      <span v-if="b.whisper" class="speech__badge">whisper</span>
      <span class="speech__body">{{ b.message }}</span>
    </div>

    <Teleport to="body">
      <InspectorTip
        v-if="pinned"
        :tip="pinned"
        :pinned="true"
        :style="pinnedStyle"
        @close="pinned = null"
      />
      <InspectorTip
        v-else-if="hover"
        :tip="hover"
        :pinned="false"
        :style="tipStyle"
      />
    </Teleport>
  </div>
</template>
