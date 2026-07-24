<script setup lang="ts">
import { computed, ref } from "vue";
import { nameTint } from "../glyphs";
import { statIconVisual } from "../icons";
import type { AdminPayload, AgentView } from "../types";
import type { LivenessView } from "../useWorldState";

const props = defineProps<{
  payload: AdminPayload | null;
  liveness: LivenessView;
  error: string;
  agents: Record<string, AgentView>;
}>();

const emit = defineEmits<{ (e: "select", id: string): void }>();

let tick = computed(() => props.payload?.state.tick ?? 0);
let population = computed(() => props.payload?.state.population ?? 0);
let scenario = computed(() => props.payload?.state.scenario?.name ?? "");

let worldStocks = computed(() => {
  let visuals = props.payload?.state.scenario?.kindVisuals ?? {};
  return Object.entries(props.payload?.state.world.stocks ?? {}).map(
    ([name, stock]) => {
      let visual = statIconVisual(name, visuals);
      let span = stock.max - stock.min;
      let bounded =
        Number.isFinite(stock.min) && Number.isFinite(stock.max) && span > 0;
      let position = bounded ? (stock.value - stock.min) / span : 0;
      return {
        name,
        label: visuals[name]?.label ?? name,
        value: Math.round(stock.value),
        max: Math.round(stock.max),
        bounded,
        fill: Math.round(Math.min(1, Math.max(0, position)) * 100),
        color: visual?.color ?? visuals[name]?.color ?? "var(--spec)",
        iconUrl: visual?.url,
      };
    },
  );
});

// The population popover: every agent ever seen, living first.
let rosterOpen = ref(false);
let roster = computed(() =>
  Object.values(props.agents).sort(
    (a, b) => Number(b.alive) - Number(a.alive) || a.name.localeCompare(b.name),
  ),
);

function pickAgent(id: string) {
  rosterOpen.value = false;
  emit("select", id);
}

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
      <span class="clock__world" :title="payload?.worldId">{{ scenario }}</span>
    </div>

    <div class="clock__mid">
      <span class="clock__tick"
        >t<b>{{ tick }}</b></span
      >
      <span class="clock__roster">
        <button
          class="clock__pop"
          title="Show characters"
          @click="rosterOpen = !rosterOpen"
        >
          {{ population }} alive
        </button>
        <div v-if="rosterOpen" class="roster">
          <button
            v-for="agent in roster"
            :key="agent.id"
            class="roster__row"
            @click="pickAgent(agent.id)"
          >
            <span class="roster__name" :style="{ color: nameTint(agent.name) }">
              {{ agent.name }}
            </span>
            <span v-if="!agent.alive" class="roster__dead">dead</span>
          </button>
          <p v-if="!roster.length" class="roster__empty">no agents yet</p>
        </div>
      </span>
      <span v-if="worldStocks.length" class="clock__stocks">
        <span
          v-for="stock in worldStocks"
          :key="stock.name"
          class="clock__stock"
          :style="{ '--stock-color': stock.color }"
          :title="
            stock.bounded
              ? `${stock.label}: ${stock.value} / ${stock.max}`
              : `${stock.label}: ${stock.value}`
          "
        >
          <span
            v-if="stock.iconUrl"
            class="clock__stock-icon"
            :style="{ maskImage: `url(${stock.iconUrl})` }"
          ></span>
          <span class="clock__stock-readout">
            <span class="clock__stock-line">
              <span class="clock__stock-name">{{ stock.label }}</span>
              <b class="clock__stock-value">{{ stock.value }}</b>
            </span>
            <span
              v-if="stock.bounded"
              class="clock__stock-track"
              aria-hidden="true"
            >
              <span
                class="clock__stock-fill"
                :style="{ width: `${stock.fill}%` }"
              ></span>
            </span>
          </span>
        </span>
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
