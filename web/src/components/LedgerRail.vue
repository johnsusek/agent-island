<script setup lang="ts">
import type { LawCard } from "../useWorldState";

// The Ledger as an in-game book: a centred window over a dimmed map, opened
// from the dock (or L) and closed with Esc, its close button, or a click
// outside. Laws are reference reading, not something to watch every tick.
defineProps<{
  laws: LawCard[];
}>();

defineEmits<{ (event: "close"): void }>();
</script>

<template>
  <div class="modal" @click.self="$emit('close')">
    <aside
      class="ledger panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ledger-title"
    >
      <header class="ledger__head panel__bar">
        <h2 id="ledger-title" class="ledger__title panel__title">The Ledger</h2>
        <span class="panel__count">{{ laws.length }}</span>
        <button
          class="panel__close"
          aria-label="Close the Ledger"
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
        <section v-else class="ledger__section">
          <article v-for="law in laws" :key="law.id" class="law">
            <div class="law__line">
              <span class="law__verb">{{ law.id }}</span>
              <span v-if="law.gated" class="law__tag" title="Can refuse">
                gated
              </span>
              <span v-if="law.mintTick != null" class="law__tick"
                >t{{ law.mintTick }}</span
              >
            </div>
            <p v-if="law.aliases.length" class="law__aliases">
              also: {{ law.aliases.join(", ") }}
            </p>
            <p v-if="law.description" class="law__desc">
              {{ law.description }}
            </p>
          </article>
        </section>
      </div>
    </aside>
  </div>
</template>
