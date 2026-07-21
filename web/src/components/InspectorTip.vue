<script setup lang="ts">
import type { TileTooltip, TooltipStock } from "../map";

defineProps<{ tip: TileTooltip; pinned: boolean }>();
defineEmits<{ (e: "close"): void }>();

function stockLine(stock: TooltipStock) {
  return stock.max != null ? `${stock.value}/${stock.max}` : `${stock.value}`;
}
</script>

<template>
  <div class="tip" :class="{ 'tip--pinned': pinned }">
    <div class="tip__head">
      <span class="tip__terrain">
        <i class="tip__swatch" :style="{ background: tip.terrainColor }"></i>
        {{ tip.terrain }}
      </span>
      <span class="tip__pos">{{ tip.x }},{{ tip.y }}</span>
      <button v-if="pinned" class="tip__close" @click="$emit('close')">
        x
      </button>
    </div>
    <div v-if="tip.fogged" class="tip__fogged">
      unexplored by the selected character
    </div>

    <div v-for="agent in tip.agents" :key="agent.id" class="tip__row">
      <span class="tip__name" :style="{ color: agent.color }">{{
        agent.name
      }}</span>
      <span class="tip__stocks">
        <span
          v-for="stock in agent.stocks"
          :key="stock.name"
          class="tip__stock"
        >
          {{ stock.name }} {{ stockLine(stock) }}
        </span>
      </span>
    </div>

    <div v-if="tip.token" class="tip__row">
      <span class="tip__name">{{ tip.token.kind ?? tip.token.name }}</span>
      <span class="tip__tags">{{ tip.token.tags.join(" ") }}</span>
      <span class="tip__stocks">
        <span
          v-for="stock in tip.token.stocks"
          :key="stock.name"
          class="tip__stock"
        >
          {{ stock.name }} {{ stockLine(stock) }}
        </span>
      </span>
      <div v-if="tip.token.text" class="tip__inscription">
        "{{ tip.token.text }}"
      </div>
      <div v-if="tip.token.missingSprite" class="tip__missing">
        no art for kind "{{ tip.token.missingSprite }}"
      </div>
    </div>

    <div v-for="entity in tip.entities" :key="entity.id" class="tip__row">
      <span class="tip__name" :style="{ color: entity.color }">{{
        entity.label
      }}</span>
      <span class="tip__tags">{{ entity.tags.join(" ") }}</span>
      <span class="tip__stocks">
        <span
          v-for="stock in entity.stocks"
          :key="stock.name"
          class="tip__stock"
        >
          {{ stock.name }} {{ stockLine(stock) }}
        </span>
      </span>
      <div v-if="entity.text" class="tip__inscription">"{{ entity.text }}"</div>
      <div v-if="entity.missingSprite" class="tip__missing">
        no art for kind "{{ entity.missingSprite }}"
      </div>
    </div>
  </div>
</template>
