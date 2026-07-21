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
        <h3 class="ledger__heading">speculations</h3>
        <article v-for="spec in speculations" :key="spec.verb" class="spec">
          <div class="spec__line">
            <span class="spec__verb">{{ spec.verb }}</span>
            <span class="spec__count">x{{ spec.count }}</span>
            <span class="spec__ticks"
              >t{{ spec.firstTick }}-{{ spec.lastTick }}</span
            >
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
        </article>
      </section>

      <section class="ledger__section">
        <h3 class="ledger__heading">laws</h3>
        <p v-if="!laws.length" class="ledger__empty">
          No physics has been speculated into being yet. When a character tries
          a verb the world doesn't know and the Oracle ratifies it, the law
          lands here.
        </p>
        <article v-for="law in laws" :key="law.id" class="law">
          <div class="law__line">
            <span class="law__verb">{{ law.id }}</span>
            <span
              v-if="law.gated"
              class="law__badge law__badge--gated"
              title="Has a requires gate - it can refuse"
              >priced</span
            >
            <span
              v-else
              class="law__badge law__badge--free"
              title="No requires gate - a free grant"
              >free</span
            >
            <span
              v-if="law.latency != null"
              class="law__latency"
              :class="{ 'law__latency--slow': law.latency > 100 }"
              :title="`speculated t${law.firstSpeculationTick}, minted t${law.mintTick}`"
            >
              {{ law.latency }}t
            </span>
          </div>
          <div v-if="law.aliases.length" class="law__aliases">
            also answers: {{ law.aliases.join(", ") }}
          </div>
          <p v-if="law.description" class="law__desc">{{ law.description }}</p>
          <div v-if="law.speculators.length" class="law__who">
            speculated by
            <button
              v-for="name in law.speculators"
              :key="name"
              class="namelink"
              @click="$emit('selectName', name)"
            >
              {{ name }}
            </button>
            <span class="law__attempts">({{ law.attempts }} attempts)</span>
          </div>
          <div v-else class="law__who law__who--gm">
            authored by the Oracle unprompted
          </div>
        </article>
      </section>
    </div>
  </aside>
</template>
