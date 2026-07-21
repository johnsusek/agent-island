<script setup lang="ts">
import type { LawCard, WishCard } from "../useWorldState";

defineProps<{
  laws: LawCard[];
  wishes: WishCard[];
  metrics: {
    laws: number;
    wishesOpen: number;
    medianLatency: number | null;
    agentOriginatedPct: number | null;
    gated: number;
  };
}>();

defineEmits<{ (e: "selectName", name: string): void }>();
</script>

<template>
  <aside class="ledger">
    <header class="ledger__head">
      <h2 class="ledger__title">The Ledger</h2>
      <div class="ledger__metrics">
        <span class="metric" title="Laws minted this run">
          <b>{{ metrics.laws }}</b> laws
        </span>
        <span class="metric" title="Verbs wished for that no law answers yet">
          <b>{{ metrics.wishesOpen }}</b> open
        </span>
        <span
          class="metric"
          title="Median ticks from first wish to minted law - latency is the enemy"
        >
          <b>{{ metrics.medianLatency ?? "-" }}</b
          >t mint
        </span>
        <span
          class="metric"
          title="Share of live verbs that characters wished into existence"
        >
          <b>{{ metrics.agentOriginatedPct ?? "-" }}%</b> theirs
        </span>
      </div>
    </header>

    <div class="ledger__scroll">
      <section v-if="wishes.length" class="ledger__section">
        <h3 class="ledger__heading">standing wishes</h3>
        <article v-for="wish in wishes" :key="wish.verb" class="wish">
          <div class="wish__line">
            <span class="wish__verb">{{ wish.verb }}</span>
            <span class="wish__count">x{{ wish.count }}</span>
            <span class="wish__ticks"
              >t{{ wish.firstTick }}-{{ wish.lastTick }}</span
            >
          </div>
          <div class="wish__who">
            <button
              v-for="name in wish.wishers"
              :key="name"
              class="namelink"
              @click="$emit('selectName', name)"
            >
              {{ name }}
            </button>
          </div>
          <blockquote v-if="wish.expectation" class="wish__hope">
            "{{ wish.expectation }}"
          </blockquote>
        </article>
      </section>

      <section class="ledger__section">
        <h3 class="ledger__heading">laws</h3>
        <p v-if="!laws.length" class="ledger__empty">
          No physics has been wished into being yet. When a character tries a
          verb the world doesn't know and the Oracle ratifies it, the law lands
          here.
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
              title="No requires gate - a free wish"
              >free</span
            >
            <span
              v-if="law.latency != null"
              class="law__latency"
              :class="{ 'law__latency--slow': law.latency > 100 }"
              :title="`wished t${law.firstWishTick}, minted t${law.mintTick}`"
            >
              {{ law.latency }}t
            </span>
          </div>
          <div v-if="law.aliases.length" class="law__aliases">
            also answers: {{ law.aliases.join(", ") }}
          </div>
          <p v-if="law.description" class="law__desc">{{ law.description }}</p>
          <div v-if="law.wishers.length" class="law__who">
            wished by
            <button
              v-for="name in law.wishers"
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
