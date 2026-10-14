<script setup lang="ts">
import type { TileTooltip, TooltipStock } from "../map";

defineProps<{ tip: TileTooltip; pinned: boolean }>();
defineEmits<{ (e: "close"): void }>();

function stockLine(stock: TooltipStock) {
  return `${stock.value}`;
}

function visibleStocks(stocks: TooltipStock[]) {
  return stocks.filter((stock) => stock.value !== 0);
}
</script>

<template>
  <div class="tip panel" :class="{ 'tip--pinned': pinned }">
    <button
      v-if="pinned"
      class="tip__close"
      aria-label="Close inspector"
      @click="$emit('close')"
    >
      ×
    </button>
    <div v-if="tip.fogged" class="tip__fogged">
      Outside this character's explored world
    </div>

    <div v-for="agent in tip.agents" :key="agent.id" class="tip__row">
      <span class="tip__name" :style="{ color: agent.color }">{{
        agent.name
      }}</span>
    </div>

    <div v-if="tip.token" class="tip__row">
      <span class="tip__name">{{ tip.token.label }}</span>
      <span class="tip__stocks">
        <span
          v-for="stock in visibleStocks(tip.token.stocks)"
          :key="stock.name"
          class="tip__stock"
        >
          {{ stock.name }} {{ stockLine(stock) }}
        </span>
      </span>
      <div v-if="tip.token.text" class="tip__inscription">
        "{{ tip.token.text }}"
      </div>
    </div>

    <div v-for="entity in tip.entities" :key="entity.id" class="tip__row">
      <span class="tip__name">{{ entity.label }}</span>
      <span class="tip__stocks">
        <span
          v-for="stock in visibleStocks(entity.stocks)"
          :key="stock.name"
          class="tip__stock"
        >
          {{ stock.name }} {{ stockLine(stock) }}
        </span>
      </span>
      <div v-if="entity.text" class="tip__inscription">"{{ entity.text }}"</div>
    </div>

    <div class="tip__context">{{ tip.terrain }}</div>
  </div>
</template>
