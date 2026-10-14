<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { nameTint } from "../glyphs";
import { spriteDataUrl } from "../sprites";
import type { AgentView, StockDisplay, VisualSpec } from "../types";

// The party: one frame per character down the left edge, like an RPG's unit
// frames. A frame is the character's portrait, name and vitals at a glance;
// clicking it selects them (and clicking the selected one lets go).
const props = defineProps<{
  agents: Record<string, AgentView>;
  display: Record<string, StockDisplay>;
  kindVisuals: Record<string, VisualSpec>;
  selectedAgentId: string | null;
}>();

const emit = defineEmits<{ (e: "select", id: string | null): void }>();

// Every character shares the scenario's one character sprite, so the portrait
// is that sprite's head and the frame's tint is what tells them apart.
let portrait = computed(() => spriteDataUrl(props.kindVisuals.agent?.sprite));

// Sprites sit on a tall canvas with empty rows above the head, so find the
// first painted row and crop the 4x portrait from there.
const PORTRAIT_SCALE = 4;
let headRow = ref(0);
let spriteWidth = ref(16);
watch(
  portrait,
  (url) => {
    headRow.value = 0;
    if (!url) return;
    let image = new Image();
    image.onload = () => {
      spriteWidth.value = image.width;
      let canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      let context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0);
      let { data } = context.getImageData(0, 0, image.width, image.height);
      for (let y = 0; y < image.height; y += 1)
        for (let x = 0; x < image.width; x += 1)
          if (data[(y * image.width + x) * 4 + 3] > 0) {
            headRow.value = y;
            return;
          }
    };
    image.src = url;
  },
  { immediate: true },
);
let portraitStyle = computed(() => ({
  width: `${spriteWidth.value * PORTRAIT_SCALE}px`,
  marginTop: `${4 - headRow.value * PORTRAIT_SCALE}px`,
}));

let frames = computed(() =>
  Object.values(props.agents)
    .sort(
      (a, b) =>
        Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name),
    )
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      alive: agent.alive,
      tint: nameTint(agent.name),
      busy: Boolean(
        agent.action || (agent.order && agent.order.status === "running"),
      ),
      vitals: Object.entries(agent.stocks)
        .filter(([name]) => props.display[name]?.role === "vital")
        .map(([name, stock]) => {
          let span = stock.max - stock.min;
          let fill = span > 0 ? (stock.value - stock.min) / span : 0;
          fill = Math.min(1, Math.max(0, fill));
          return {
            name,
            label: props.display[name]?.label ?? name,
            fill: Math.round(fill * 100),
            tone: fill < 0.15 ? "danger" : fill < 0.4 ? "warn" : "ok",
          };
        }),
    })),
);

function pick(id: string) {
  emit("select", props.selectedAgentId === id ? null : id);
}
</script>

<template>
  <nav v-if="frames.length" class="party" aria-label="Characters">
    <button
      v-for="frame in frames"
      :key="frame.id"
      class="party__frame panel"
      :class="{
        'party__frame--on': frame.id === selectedAgentId,
        'party__frame--dead': !frame.alive,
      }"
      :style="{ '--tint': frame.tint }"
      :aria-pressed="frame.id === selectedAgentId"
      :title="`${frame.name}${frame.alive ? '' : ' (dead)'} - [ ] to cycle`"
      @click="pick(frame.id)"
    >
      <span class="party__portrait">
        <img v-if="portrait" :src="portrait" :style="portraitStyle" alt="" />
        <span
          v-if="!frame.alive"
          class="party__skull"
          aria-hidden="true"
        ></span>
      </span>
      <span class="party__body">
        <span class="party__name">
          {{ frame.name }}
          <span v-if="frame.busy && frame.alive" class="party__busy"></span>
        </span>
        <span
          v-for="vital in frame.vitals"
          :key="vital.name"
          class="party__vital"
          :title="`${vital.label} ${vital.fill}%`"
        >
          <span
            class="party__vital-fill"
            :class="`party__vital-fill--${vital.tone}`"
            :style="{ width: `${vital.fill}%` }"
          ></span>
        </span>
      </span>
    </button>
  </nav>
</template>
