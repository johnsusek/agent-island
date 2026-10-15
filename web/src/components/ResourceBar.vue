<script setup lang="ts">
import { computed } from "vue";
import { statIconVisual } from "../icons";
import type { AdminPayload } from "../types";

// The world's shared stocks, top left, the way a strategy game shows its
// resources: an icon, a name, an amber number, and a thin gauge when the
// stock is bounded.
const props = defineProps<{ payload: AdminPayload | null }>();

let stocks = computed(() => {
  let visuals = props.payload?.state.scenario?.kindVisuals ?? {};
  let display = props.payload?.state.scenario?.display ?? {};
  return Object.entries(props.payload?.state.world.stocks ?? {}).map(
    ([name, stock]) => {
      let visual = statIconVisual(name, visuals);
      let span = stock.max - stock.min;
      let bounded =
        Number.isFinite(stock.min) && Number.isFinite(stock.max) && span > 0;
      let position = bounded ? (stock.value - stock.min) / span : 0;
      return {
        name,
        label: visuals[name]?.label ?? display[name]?.label ?? name,
        value: Math.round(stock.value),
        max: Math.round(stock.max),
        bounded,
        fill: Math.round(Math.min(1, Math.max(0, position)) * 100),
        color: visual?.color ?? visuals[name]?.color ?? "var(--spec)",
        iconUrl: visual?.url,
      };
    },
  );
});
</script>

<template>
  <div v-if="stocks.length" class="resources panel">
    <span
      v-for="stock in stocks"
      :key="stock.name"
      class="resource"
      :style="{ '--stock-color': stock.color }"
      :title="
        stock.bounded
          ? `${stock.label}: ${stock.value} / ${stock.max}`
          : `${stock.label}: ${stock.value}`
      "
    >
      <span
        v-if="stock.iconUrl"
        class="resource__icon"
        :style="{ maskImage: `url(${stock.iconUrl})` }"
      ></span>
      <span class="resource__name">{{ stock.label }}</span>
      <span class="resource__readout">
        <b class="resource__value">{{ stock.value }}</b>
        <span v-if="stock.bounded" class="resource__track" aria-hidden="true">
          <span
            class="resource__fill"
            :style="{ width: `${stock.fill}%` }"
          ></span>
        </span>
      </span>
    </span>
  </div>
</template>
