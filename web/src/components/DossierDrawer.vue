<script setup lang="ts">
import { computed } from "vue";
import { nameTint } from "../glyphs";
import { statIconVisual } from "../icons";
import type {
  AgentView,
  Stock,
  StockDisplay,
  StockRole,
  VisualSpec,
} from "../types";
import type { ChatItem, FeedItem } from "../useWorldState";

const props = defineProps<{
  agent: AgentView;
  display: Record<string, StockDisplay>;
  kindVisuals: Record<string, VisualSpec>;
  chat: ChatItem[];
  feed: FeedItem[];
}>();

defineEmits<{ (event: "close"): void }>();

// A stock's role, straight off the server's projection - an undeclared stock
// reads as pack, exactly as it does there.
function roleOf(name: string): StockRole {
  return props.display[name]?.role ?? "pack";
}

// Every meter fills toward safety - up is always healthier, so the raw
// position on the gauge is the wellbeing.
function conditionMeter(name: string, stock: Stock) {
  let hint = props.display[name] ?? {};
  let span = stock.max - stock.min;
  let position = span > 0 ? (stock.value - stock.min) / span : 0;
  let wellbeing = Math.min(1, Math.max(0, position));
  let badness = 1 - wellbeing;
  return {
    name,
    stock,
    fill: Math.round(wellbeing * 100),
    tone: badness > 0.85 ? "danger" : badness > 0.6 ? "warn" : "ok",
    label: hint.label ?? name,
    icon: statIconVisual(name, props.kindVisuals),
  };
}

// Vitals and stats show as bars (a gauge in a band); pack shows as compact
// name/value rows (a carried quantity), and so does hidden bookkeeping - the
// character never perceives it, but a spectator should. Grouping key is the server-projected
// role, so the dashboard reads the same taxonomy as the character's prose.
let vitals = computed(() =>
  Object.entries(props.agent.stocks)
    .filter(([name]) => roleOf(name) === "vital")
    .map(([name, stock]) => conditionMeter(name, stock)),
);
let stats = computed(() =>
  Object.entries(props.agent.stocks)
    .filter(([name]) => roleOf(name) === "stat")
    .map(([name, stock]) => conditionMeter(name, stock)),
);
let pack = computed(() =>
  Object.entries(props.agent.stocks)
    .filter(([name]) => ["pack", "hidden"].includes(roleOf(name)))
    .filter(([, stock]) => stock.value !== 0)
    .map(([name, stock]) => ({
      name,
      label: props.display[name]?.label ?? name,
      value: Math.round(stock.value * 10) / 10,
      icon: statIconVisual(name, props.kindVisuals),
    })),
);
let held = computed(() => props.agent.held ?? []);

let recentTalk = computed(() =>
  props.chat.filter((item) => item.speakerId === props.agent.id).slice(-6),
);

let activity = computed(() => {
  let action = props.agent.action;
  let order = props.agent.order;
  if (order && order.status === "running") return order.summary;
  if (action) return action.goal ?? action.type;
  return "Idle";
});
</script>

<template>
  <aside class="dossier">
    <header class="dossier__head">
      <div class="dossier__identity">
        <h2 class="dossier__name" :style="{ color: nameTint(agent.name) }">
          {{ agent.name }}
        </h2>
        <p class="dossier__activity" :title="activity">{{ activity }}</p>
      </div>
      <span v-if="!agent.alive" class="dossier__dead">dead</span>
      <button
        class="dossier__close"
        aria-label="Close dossier"
        @click="$emit('close')"
      >
        ×
      </button>
    </header>

    <div class="dossier__scroll">
      <section v-if="vitals.length" class="dossier__section">
        <h3 class="ledger__heading">Condition</h3>
        <div v-for="meter in vitals" :key="meter.name" class="bar">
          <span class="bar__label">
            <span
              v-if="meter.icon"
              class="bar__icon"
              :style="{ maskImage: `url(${meter.icon.url})`, color: meter.icon.color }"
            ></span>
            {{ meter.label }}
          </span>
          <span class="bar__track">
            <span
              class="bar__fill"
              :class="`bar__fill--${meter.tone}`"
              :style="{ width: `${meter.fill}%` }"
            ></span>
          </span>
          <span class="bar__value">{{ Math.round(meter.stock.value) }}</span>
        </div>
      </section>

      <section v-if="stats.length" class="dossier__section">
        <h3 class="ledger__heading">Disposition</h3>
        <div v-for="meter in stats" :key="meter.name" class="bar bar--muted">
          <span class="bar__label">
            <span
              v-if="meter.icon"
              class="bar__icon"
              :style="{ maskImage: `url(${meter.icon.url})`, color: meter.icon.color }"
            ></span>
            {{ meter.label }}
          </span>
          <span class="bar__track">
            <span
              class="bar__fill"
              :class="`bar__fill--${meter.tone}`"
              :style="{ width: `${meter.fill}%` }"
            ></span>
          </span>
          <span class="bar__value">{{ Math.round(meter.stock.value) }}</span>
        </div>
      </section>

      <section v-if="held.length || pack.length" class="dossier__section">
        <h3 class="ledger__heading">Carrying</h3>
        <div v-for="item in held" :key="item.id" class="dossier__item">
          <span class="row__verb">{{ item.kind ?? item.id }}</span>
          <span v-if="item.text" class="dossier__item-note"
            >"{{ item.text }}"</span
          >
        </div>
        <div
          v-for="packItem in pack"
          :key="packItem.name"
          class="dossier__pack"
        >
          <span class="dossier__pack-name">
            <span
              v-if="packItem.icon"
              class="dossier__pack-icon"
              :style="{
                maskImage: `url(${packItem.icon.url})`,
                color: packItem.icon.color,
              }"
            ></span>
            {{ packItem.label }}
          </span>
          <span class="dossier__pack-value">{{ packItem.value }}</span>
        </div>
      </section>

      <section v-if="recentTalk.length" class="dossier__section">
        <h3 class="ledger__heading">
          {{ agent.alive ? "Recent talk" : "Last words" }}
        </h3>
        <div v-for="item in recentTalk" :key="item.key" class="dossier__quote">
          <span class="row__tick">t{{ item.tick }}</span>
          <span :class="{ row__whisper: item.whisper }">{{
            item.message
          }}</span>
        </div>
      </section>
    </div>
  </aside>
</template>
