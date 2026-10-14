<script setup lang="ts">
import { ref } from "vue";
import type { LawCard } from "../useWorldState";

defineProps<{
  laws: LawCard[];
}>();

// The ledger folds down to its title bar so it can get out of the map's way.
let collapsed = ref(false);
</script>

<template>
  <aside class="ledger panel" :class="{ 'panel--collapsed': collapsed }">
    <header class="ledger__head panel__bar">
      <h2 class="ledger__title panel__title">The Ledger</h2>
      <span class="panel__count">{{ laws.length }}</span>
      <button
        class="panel__fold"
        :aria-expanded="!collapsed"
        :aria-label="collapsed ? 'Expand the Ledger' : 'Collapse the Ledger'"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? "+" : "-" }}
      </button>
    </header>

    <div v-show="!collapsed" class="ledger__scroll">
      <p v-if="!laws.length" class="ledger__empty">No laws yet.</p>
      <section v-else class="ledger__section">
        <h3 class="ledger__heading">Laws</h3>
        <article v-for="law in laws" :key="law.id" class="law">
          <div class="law__line">
            <span class="law__verb">{{ law.id }}</span>
          </div>

          <p v-if="law.description" class="law__desc">{{ law.description }}</p>
        </article>
      </section>
    </div>
  </aside>
</template>
