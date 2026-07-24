<script setup lang="ts">
import { computed, ref } from "vue";
import type { LawCard, SpeculationCard } from "../useWorldState";

let props = defineProps<{
  laws: LawCard[];
  speculations: SpeculationCard[];
}>();

defineEmits<{ (e: "selectName", name: string): void }>();

type SpeculationFilter = "open" | "rejected";

let speculationFilter = ref<SpeculationFilter>("open");
let filteredSpeculations = computed(() =>
  props.speculations.filter((speculation) =>
    speculationFilter.value === "rejected"
      ? speculation.rejected !== null
      : speculation.rejected === null,
  ),
);
</script>

<template>
  <aside class="ledger">
    <header class="ledger__head">
      <h2 class="ledger__title">The Ledger</h2>
    </header>

    <div class="ledger__scroll">
      <section v-if="laws.length" class="ledger__section">
        <h3 class="ledger__heading">Laws</h3>
        <article v-for="law in laws" :key="law.id" class="law">
          <div class="law__line">
            <span class="law__verb">{{ law.id }}</span>
          </div>

          <p v-if="law.description" class="law__desc">{{ law.description }}</p>
        </article>
      </section>

      <section v-if="speculations.length" class="ledger__section">
        <div class="ledger__section-head">
          <h3 class="ledger__heading">Speculations</h3>
          <div class="segmented" role="group" aria-label="Filter speculations">
            <button
              class="segmented__button"
              :class="{ 'segmented__button--on': speculationFilter === 'open' }"
              :aria-pressed="speculationFilter === 'open'"
              @click="speculationFilter = 'open'"
            >
              Open
            </button>
            <button
              class="segmented__button"
              :class="{
                'segmented__button--on': speculationFilter === 'rejected',
              }"
              :aria-pressed="speculationFilter === 'rejected'"
              @click="speculationFilter = 'rejected'"
            >
              Rejected
            </button>
          </div>
        </div>
        <p v-if="!filteredSpeculations.length" class="ledger__empty">
          No {{ speculationFilter }} speculations.
        </p>
        <article
          v-for="spec in filteredSpeculations"
          :key="spec.verb"
          class="spec"
        >
          <div class="spec__line">
            <span class="spec__verb">{{ spec.verb }}</span>
            <span v-if="spec.count > 1" class="spec__count">
              ×{{ spec.count }}
            </span>
          </div>
          <div class="spec__who">
            <button
              v-for="name in spec.speculators"
              :key="name"
              class="namelink"
              @click="$emit('selectName', name)"
            >
              {{ name }}
            </button>
          </div>
          <blockquote v-if="spec.expectation" class="spec__hope">
            "{{ spec.expectation }}"
          </blockquote>
          <p v-if="spec.rejected" class="spec__rejected">
            Rejected: {{ spec.rejected }}
          </p>
        </article>
      </section>
    </div>
  </aside>
</template>
