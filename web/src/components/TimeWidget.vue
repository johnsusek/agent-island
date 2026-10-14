<script setup lang="ts">
import { computed } from "vue";
import type { LivenessView } from "../useWorldState";

// The game clock, top right: the tick, whether the world is moving, and the
// speed controls (pause plus turn-based or one of three real-time speeds).
const props = defineProps<{
  tick: number;
  liveness: LivenessView;
  error: string;
}>();

const emit = defineEmits<{
  (e: "pause"): void;
  (e: "speed", ms: number): void;
}>();

// Turn-based waits for every character to act; the arrows are real-time
// cadences, more arrows for a faster clock. Keys 1-4 match left to right.
const SPEEDS = [
  {
    ms: 0,
    label: "Turn",
    title: "Turn-based: advance when everyone has acted",
  },
  { ms: 5000, arrows: 1, title: "Slow: one tick every 5s" },
  { ms: 2000, arrows: 2, title: "Normal: one tick every 2s" },
  { ms: 1000, arrows: 3, title: "Fast: one tick every second" },
];

let status = computed(() => {
  if (props.error)
    return { key: "error", label: "Offline", title: props.error };
  let l = props.liveness;
  let label = {
    live: "Live",
    waiting: "Waiting",
    idle: "Idle",
    paused: "Paused",
    ended: "Ended",
  }[l.status];
  let title = l.error
    ? l.error
    : l.agoSeconds == null
      ? label
      : `${label} - last tick ${l.agoSeconds}s ago`;
  return { key: l.status, label, title };
});
</script>

<template>
  <div class="time panel">
    <div class="time__readout" :title="status.title">
      <span class="time__pip" :class="`time__pip--${status.key}`"></span>
      <span class="time__label">Tick</span>
      <b class="time__tick">{{ tick }}</b>
    </div>
    <div class="time__controls" role="group" aria-label="Game speed">
      <button
        class="time__btn"
        :class="{ 'time__btn--on': liveness.paused }"
        :aria-pressed="liveness.paused"
        :title="liveness.paused ? 'Resume (Space)' : 'Pause (Space)'"
        @click="emit('pause')"
      >
        <svg v-if="liveness.paused" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M2 1h1v6H2zM3 2h1v4H3zM4 3h1v2H4z" />
        </svg>
        <svg v-else viewBox="0 0 8 8" aria-hidden="true">
          <path d="M1 1h2v6H1zM5 1h2v6H5z" />
        </svg>
      </button>
      <button
        v-for="(speed, index) in SPEEDS"
        :key="speed.ms"
        class="time__btn"
        :class="{
          'time__btn--on': !liveness.paused && liveness.realTimeMs === speed.ms,
          'time__btn--text': !speed.arrows,
        }"
        :aria-pressed="liveness.realTimeMs === speed.ms"
        :title="`${speed.title} (${index + 1})`"
        @click="emit('speed', speed.ms)"
      >
        <template v-if="speed.label">{{ speed.label }}</template>
        <svg
          v-else
          :viewBox="`0 0 ${speed.arrows! * 4 + 1} 8`"
          :style="{ width: `${(speed.arrows! * 4 + 1) * 2}px` }"
          aria-hidden="true"
        >
          <path
            v-for="arrow in speed.arrows"
            :key="arrow"
            :transform="`translate(${(arrow - 1) * 4} 0)`"
            d="M1 1h1v6H1zM2 2h1v4H2zM3 3h1v2H3z"
          />
        </svg>
      </button>
    </div>
  </div>
</template>
