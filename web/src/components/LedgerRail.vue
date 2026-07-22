<script setup lang="ts">
import type { LawCard, SpeculationCard } from "../useWorldState";

defineProps<{
  laws: LawCard[];
  speculations: SpeculationCard[];
}>();

defineEmits<{ (e: "selectName", name: string): void }>();
</script>

<template>
  <aside class="ledger">
    <header class="ledger__head">
      <h2 class="ledger__title">The Ledger</h2>
    </header>

    <div class="ledger__scroll">
      <section v-if="speculations.length" class="ledger__section">
        <h3 class="ledger__heading">Speculations</h3>
        <article v-for="spec in speculations" :key="spec.verb" class="spec">
          <div class="spec__line">
            <span class="spec__verb">{{ spec.verb }}</span>
            <span v-if="spec.count > 1" class="spec__count">
              ×{{ spec.count }}
            </span>
          </div>
          <div class="spec__who">
            <button v-for="name in spec.speculators" :key="name" class="namelink" @click="$emit('selectName', name)">
              {{ name }}
            </button>
          </div>
          <blockquote v-if="spec.expectation" class="spec__hope">
            "{{ spec.expectation }}"
          </blockquote>
        </article>
      </section>

      <section class="ledger__section">
        <h3 v-if="laws.length" class="ledger__heading">Laws</h3>
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
