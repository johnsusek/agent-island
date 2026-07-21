<script setup lang="ts">
import { computed } from "vue";
import { nameTint } from "../glyphs";
import type { AgentView, DisplayHint, Stock } from "../types";
import type { ChatItem, FeedItem, LawCard, WishCard } from "../useWorldState";

const props = defineProps<{
  agent: AgentView;
  display: Record<string, DisplayHint>;
  chat: ChatItem[];
  feed: FeedItem[];
  laws: LawCard[];
  wishes: WishCard[];
}>();

defineEmits<{ (e: "close"): void }>();

// A stock bar's fill and tone. For a "down" stock (hunger) full is bad; for an
// "up" stock (health) empty is bad.
function stockBar(name: string, stock: Stock) {
  let hint = props.display[name] ?? {};
  let span = stock.max - stock.min;
  let fill = span > 0 ? (stock.value - stock.min) / span : 0;
  let badness = hint.tone === "down" ? fill : 1 - fill;
  return {
    fill: Math.round(fill * 100),
    tone: badness > 0.85 ? "danger" : badness > 0.6 ? "warn" : "ok",
    label: hint.label ?? name,
    vital: hint.vital ?? false,
  };
}

let stocks = computed(() =>
  Object.entries(props.agent.stocks).map(([name, stock]) => ({
    name,
    stock,
    ...stockBar(name, stock),
  })),
);

// This character's own wishes: standing ones plus the laws their wishing
// helped mint.
let myWishes = computed(() =>
  props.wishes.filter((wish) => wish.wishers.includes(props.agent.name)),
);
let myLaws = computed(() =>
  props.laws.filter((law) => law.wishers.includes(props.agent.name)),
);

let lastWords = computed(() =>
  props.chat.filter((item) => item.speakerId === props.agent.id).slice(-6),
);

let doing = computed(() => {
  let action = props.agent.action;
  let order = props.agent.order;
  if (order && order.status === "running")
    return `${order.summary} (${order.kind}, since t${order.startedTick})`;
  if (action) return action.goal ?? action.type;
  return "idle";
});
</script>

<template>
  <aside class="dossier">
    <header class="dossier__head">
      <h2 class="dossier__name" :style="{ color: nameTint(agent.name) }">
        {{ agent.name }}
      </h2>
      <span v-if="!agent.alive" class="dossier__dead">dead</span>
      <span class="dossier__pos"
        >{{ agent.position.x }},{{ agent.position.y }}</span
      >
      <button class="tip__close" @click="$emit('close')">x</button>
    </header>

    <div class="dossier__scroll">
      <section class="dossier__section">
        <h3 class="ledger__heading">doing</h3>
        <p class="dossier__doing">{{ doing }}</p>
      </section>

      <section class="dossier__section">
        <h3 class="ledger__heading">condition</h3>
        <div v-for="s in stocks" :key="s.name" class="bar">
          <span class="bar__label">{{ s.label }}</span>
          <span class="bar__track">
            <span
              class="bar__fill"
              :class="`bar__fill--${s.tone}`"
              :style="{ width: `${s.fill}%` }"
            ></span>
          </span>
          <span class="bar__value">{{ Math.round(s.stock.value) }}</span>
        </div>
      </section>

      <section v-if="myWishes.length" class="dossier__section">
        <h3 class="ledger__heading">still wishing for</h3>
        <div v-for="wish in myWishes" :key="wish.verb" class="dossier__wish">
          <b class="row__verb">{{ wish.verb }}</b>
          <span v-if="wish.expectation" class="row__hope">
            "{{ wish.expectation }}"</span
          >
        </div>
      </section>

      <section v-if="myLaws.length" class="dossier__section">
        <h3 class="ledger__heading">wished into law</h3>
        <div v-for="law in myLaws" :key="law.id" class="dossier__wish">
          <b class="row__verb">{{ law.id }}</b>
          <span v-if="law.latency != null" class="law__latency">
            {{ law.latency }}t</span
          >
        </div>
      </section>

      <section v-if="lastWords.length" class="dossier__section">
        <h3 class="ledger__heading">last words</h3>
        <div v-for="item in lastWords" :key="item.key" class="dossier__quote">
          <span class="row__tick">t{{ item.tick }}</span>
          <span :class="{ row__whisper: item.whisper }">{{
            item.message
          }}</span>
        </div>
      </section>
    </div>
  </aside>
</template>
