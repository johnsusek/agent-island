<script setup lang="ts">
import type { LawCard } from "../useWorldState";

// The world's laws: a floating panel under the stocks, opened from the Laws
// chip (or L) and closed with its X or Esc. It doesn't dim the map, so the
// laws can stay open while the world runs.
defineProps<{
  laws: LawCard[];
}>();

defineEmits<{ (event: "close"): void }>();

// "drink-at-camp" reads as "Drink At Camp"; the verb itself stays in the
// tooltip, since it's what the characters actually call.
function title(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
</script>

<template>
  <aside class="laws panel" aria-labelledby="laws-title">
    <header class="panel__bar">
      <h2 id="laws-title" class="panel__title">Laws</h2>
      <span class="panel__count">{{ laws.length }}</span>
      <button
        class="panel__close"
        aria-label="Close the laws"
        title="Close (Esc)"
        @click="$emit('close')"
      >
        ×
      </button>
    </header>

    <div class="ledger__scroll">
      <p v-if="!laws.length" class="ledger__empty">
        No laws yet. When the characters speculate a new action into being, it
        is written here.
      </p>
      <article
        v-for="law in laws"
        :key="law.id"
        class="law"
        :title="`Verb: ${law.id}`"
      >
        <div class="law__line">
          <span class="law__verb">{{ title(law.id) }}</span>
          <span v-if="law.gated" class="law__tag" title="Can refuse">
            gated
          </span>
          <span v-if="law.mintTick != null" class="law__tick"
            >t{{ law.mintTick }}</span
          >
        </div>
        <p v-if="law.description" class="law__desc">
          {{ law.description }}
        </p>
        <p v-if="law.aliases.length" class="law__aliases">
          also: {{ law.aliases.join(", ") }}
        </p>
      </article>
    </div>
  </aside>
</template>
