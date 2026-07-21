<script setup lang="ts">
import { computed } from "vue";
import type { AdminPayload } from "../types";
import type { LivenessView } from "../useWorldState";

const props = defineProps<{
  payload: AdminPayload | null;
  liveness: LivenessView;
  error: string;
}>();

let tick = computed(() => props.payload?.state.tick ?? 0);
let population = computed(() => props.payload?.state.population ?? 0);
let worldId = computed(() => (props.payload?.worldId ?? "").slice(0, 8));
let scenario = computed(() => props.payload?.state.scenario?.name ?? "");

let worldStocks = computed(() =>
  Object.entries(props.payload?.state.world.stocks ?? {}).map(
    ([name, stock]) => ({ name, value: Math.round(stock.value) }),
  ),
);

// World controls only: pause and cadence. Resets and crews belong to the CLI.
async function post(path: string, body: Record<string, unknown>) {
  try {
    await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // the poll surfaces connection problems
  }
}

function togglePause() {
  void post("/api/pause", { paused: !props.liveness.paused });
}

const CADENCES = [
  { ms: 0, label: "lockstep" },
  { ms: 1000, label: "1s" },
  { ms: 2000, label: "2s" },
  { ms: 5000, label: "5s" },
];

function setCadence(ms: number) {
  void post("/api/clock", { realTimeMs: ms });
}
</script>

<template>
  <header class="clock">
    <div class="clock__brand">
      <span class="clock__logo">AGENT ISLAND</span>
      <span class="clock__world" :title="payload?.worldId"
        >{{ scenario }} / {{ worldId }}</span
      >
    </div>

    <div class="clock__mid">
      <span class="dot" :class="`dot--${liveness.status}`"></span>
      <span class="clock__status">{{ liveness.status }}</span>
      <span class="clock__tick"
        >t<b>{{ tick }}</b></span
      >
      <span class="clock__pop" title="living population"
        >{{ population }} alive</span
      >
      <span
        v-if="liveness.gmConnected"
        class="clock__oracle"
        title="A director holds the GM seat"
        >oracle seated</span
      >
      <span v-for="s in worldStocks" :key="s.name" class="clock__stock">
        {{ s.name }} {{ s.value }}
      </span>
      <span v-if="error" class="clock__error">{{ error }}</span>
    </div>

    <div class="clock__controls">
      <button class="chip" @click="togglePause">
        {{ liveness.paused ? "resume" : "pause" }}
      </button>
      <button
        v-for="c in CADENCES"
        :key="c.ms"
        class="chip"
        :class="{ 'chip--on': liveness.realTimeMs === c.ms }"
        @click="setCadence(c.ms)"
      >
        {{ c.label }}
      </button>
    </div>
  </header>
</template>
