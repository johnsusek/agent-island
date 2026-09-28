<script setup lang="ts">
import type { LawCard } from "../useWorldState";

defineProps<{
  laws: LawCard[];
}>();
</script>

<template>
  <aside class="ledger">
    <header class="ledger__head">
      <h2 class="ledger__title">The Ledger</h2>
    </header>

    <div class="ledger__scroll">
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
