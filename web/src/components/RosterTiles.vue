<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { nameTint } from "../glyphs";
import { onSheetsLoaded, sheetsVersion, spriteDataUrl } from "../sprites";
import type { AgentView, StockDisplay, VisualSpec } from "../types";

// The roster: a row of portrait tiles above the log, one per character. A
// tile is the portrait, the name and the lowest vital as one thin bar; a "!"
// flags someone who needs attention (a vital running out, or an order that
// is stuck). Clicking a tile selects them and opens their sheet (clicking the
// selected one lets go).
const props = defineProps<{
  agents: Record<string, AgentView>;
  display: Record<string, StockDisplay>;
  kindVisuals: Record<string, VisualSpec>;
  selectedAgentId: string | null;
}>();

const emit = defineEmits<{ (e: "select", id: string | null): void }>();

// Every character shares the scenario's one character sprite, so the portrait
// is that sprite's head and the frame's tint is what tells them apart.
// A sprite cut from a tileset has no data URL until its sheet loads, so
// recompute when one lands.
let sheetsSeen = ref(sheetsVersion());
onBeforeUnmount(onSheetsLoaded(() => (sheetsSeen.value = sheetsVersion())));
let portrait = computed(() => {
  void sheetsSeen.value;
  return spriteDataUrl(props.kindVisuals.agent?.sprite);
});

// Sprites sit on a tall canvas with empty rows above the head, so find the
// first painted row and crop the 3x portrait from there.
const PORTRAIT_SCALE = 3;
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
  marginTop: `${3 - headRow.value * PORTRAIT_SCALE}px`,
}));

const DANGER = 0.15;
const WARN = 0.4;

let tiles = computed(() =>
  Object.values(props.agents)
    .sort(
      (a, b) =>
        Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name),
    )
    .map((agent) => {
      let vitals = Object.entries(agent.stocks)
        .filter(([name]) => props.display[name]?.role === "vital")
        .map(([name, stock]) => {
          let span = stock.max - stock.min;
          let fill = span > 0 ? (stock.value - stock.min) / span : 0;
          return {
            label: props.display[name]?.label ?? name,
            fill: Math.min(1, Math.max(0, fill)),
          };
        });
      let lowest = vitals.reduce<(typeof vitals)[number] | null>(
        (low, vital) => (!low || vital.fill < low.fill ? vital : low),
        null,
      );
      let blocked = agent.order?.status === "blocked";
      let alerts = [
        ...vitals
          .filter((vital) => vital.fill < DANGER)
          .map((vital) => `${vital.label} is running out`),
        ...(blocked
          ? [`Order blocked: ${agent.order?.reason ?? "stuck"}`]
          : []),
      ];
      return {
        id: agent.id,
        name: agent.name,
        alive: agent.alive,
        tint: nameTint(agent.name),
        busy: Boolean(
          agent.action || (agent.order && agent.order.status === "running"),
        ),
        alerts: agent.alive ? alerts : [],
        lowest: lowest && {
          label: lowest.label,
          fill: Math.round(lowest.fill * 100),
          tone:
            lowest.fill < DANGER
              ? "danger"
              : lowest.fill < WARN
                ? "warn"
                : "ok",
        },
      };
    }),
);

function describe(tile: (typeof tiles.value)[number]): string {
  let lines = [tile.alive ? tile.name : `${tile.name} (dead)`];
  if (tile.alive && tile.lowest)
    lines.push(`Lowest: ${tile.lowest.label} ${tile.lowest.fill}%`);
  lines.push(...tile.alerts, "[ ] to cycle");
  return lines.join("\n");
}

// Keep the selected tile in view when the strip scrolls sideways (a narrow
// window, a big cast, or [ and ] cycling). Only the strip scrolls, never the
// page.
let strip = ref<HTMLElement | null>(null);
watch(
  () => props.selectedAgentId,
  async (id) => {
    await nextTick();
    let tile = strip.value?.querySelector<HTMLElement>(`[data-id="${id}"]`);
    if (!id || !strip.value || !tile) return;
    let { scrollLeft, clientWidth } = strip.value;
    let left = tile.offsetLeft - strip.value.offsetLeft;
    let right = left + tile.offsetWidth;
    if (left < scrollLeft) strip.value.scrollLeft = left - 8;
    else if (right > scrollLeft + clientWidth)
      strip.value.scrollLeft = right - clientWidth + 8;
  },
);

function pick(id: string) {
  emit("select", props.selectedAgentId === id ? null : id);
}
</script>

<template>
  <nav v-if="tiles.length" ref="strip" class="roster" aria-label="Characters">
    <button
      v-for="tile in tiles"
      :key="tile.id"
      :data-id="tile.id"
      class="roster__tile panel"
      :class="{
        'roster__tile--on': tile.id === selectedAgentId,
        'roster__tile--alert': tile.alerts.length,
        'roster__tile--dead': !tile.alive,
      }"
      :style="{ '--tint': tile.tint }"
      :aria-pressed="tile.id === selectedAgentId"
      :title="describe(tile)"
      @click="pick(tile.id)"
    >
      <span class="roster__portrait">
        <img v-if="portrait" :src="portrait" :style="portraitStyle" alt="" />
        <span
          v-if="!tile.alive"
          class="roster__skull"
          aria-hidden="true"
        ></span>
        <span
          v-if="tile.busy && tile.alive"
          class="roster__busy"
          aria-hidden="true"
        ></span>
      </span>
      <span class="roster__name">{{ tile.name }}</span>
      <span v-if="tile.lowest && tile.alive" class="roster__vital">
        <span
          class="roster__vital-fill"
          :class="`roster__vital-fill--${tile.lowest.tone}`"
          :style="{ width: `${tile.lowest.fill}%` }"
        ></span>
      </span>
      <span v-if="tile.alerts.length" class="roster__alert" aria-hidden="true"
        >!</span
      >
    </button>
  </nav>
</template>
