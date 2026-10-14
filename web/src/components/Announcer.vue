<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { FeedItem, LawCard, LivenessView } from "../useWorldState";

// Everything the game says out loud, top centre: a title card naming the
// world when it loads, toasts for the moments worth looking up for (a new
// law, a death, a vote, someone arriving or leaving), and a standing banner
// while the world is paused or over. The world's name lives here and in the
// tab title, not in a permanent header.
const props = defineProps<{
  worldId: string;
  scenario: string;
  tick: number;
  feed: FeedItem[];
  laws: LawCard[];
  liveness: LivenessView;
}>();

const emit = defineEmits<{
  (e: "select", id: string): void;
  (e: "ledger"): void;
}>();

interface Toast {
  key: string;
  tone: "law" | "danger" | "director" | "plain";
  kicker: string;
  text: string;
  agentId?: string;
  law?: boolean;
}

const TOAST_MS = 6000;
const MAX_TOASTS = 4;

const EVENT_TOASTS: Record<string, { tone: Toast["tone"]; kicker: string }> = {
  died: { tone: "danger", kicker: "Death" },
  death: { tone: "danger", kicker: "Death" },
  announced: { tone: "director", kicker: "Announcement" },
  motion_proposed: { tone: "plain", kicker: "Motion" },
  motion_passed: { tone: "law", kicker: "Motion passed" },
  motion_failed: { tone: "danger", kicker: "Motion failed" },
  joined: { tone: "plain", kicker: "Arrival" },
  left: { tone: "plain", kicker: "Departure" },
};

let toasts = ref<Toast[]>([]);
let timers = new Map<string, number>();

function push(toast: Toast) {
  if (toasts.value.some((t) => t.key === toast.key)) return;
  toasts.value = [...toasts.value, toast].slice(-MAX_TOASTS);
  timers.set(
    toast.key,
    window.setTimeout(() => dismiss(toast.key), TOAST_MS),
  );
}

function dismiss(key: string) {
  toasts.value = toasts.value.filter((t) => t.key !== key);
  window.clearTimeout(timers.get(key));
  timers.delete(key);
}

function open(toast: Toast) {
  if (toast.agentId) emit("select", toast.agentId);
  else if (toast.law) emit("ledger");
  dismiss(toast.key);
}

// The title card: the world's name, big, for a few seconds after it loads.
let titleCard = ref(false);
let titleTimer = 0;
function showTitleCard() {
  titleCard.value = true;
  window.clearTimeout(titleTimer);
  titleTimer = window.setTimeout(() => (titleCard.value = false), 3500);
}

// Only what happens while watching is news: whatever history the first poll
// brings in (or a freshly loaded world brings in) sets the baseline silently.
let seenWorld = "";
let lastFeedSeq = Infinity;
let knownLaws: Set<string> | null = null;

watch(
  () => [props.worldId, props.feed, props.laws] as const,
  ([worldId, feed, laws]) => {
    if (!worldId) return;
    if (worldId !== seenWorld) {
      seenWorld = worldId;
      lastFeedSeq = Infinity;
      knownLaws = null;
      toasts.value = [];
      showTitleCard();
    }
    let newestSeq = feed.length ? Number(feed[feed.length - 1].key) : -1;
    if (lastFeedSeq === Infinity) {
      lastFeedSeq = newestSeq;
    } else {
      for (let item of feed) {
        if (Number(item.key) <= lastFeedSeq) continue;
        let style = EVENT_TOASTS[item.type];
        if (style)
          push({
            key: `event-${item.key}`,
            tone: style.tone,
            kicker: style.kicker,
            text: item.text,
            agentId: item.agentId,
          });
      }
      lastFeedSeq = Math.max(lastFeedSeq, newestSeq);
    }
    if (!knownLaws) {
      knownLaws = new Set(laws.map((law) => law.id));
    } else {
      for (let law of laws) {
        if (knownLaws.has(law.id)) continue;
        knownLaws.add(law.id);
        push({
          key: `law-${law.id}`,
          tone: "law",
          kicker: "New law",
          text: law.description ? `${law.id}: ${law.description}` : law.id,
          law: true,
        });
      }
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.clearTimeout(titleTimer);
  for (let timer of timers.values()) window.clearTimeout(timer);
});
</script>

<template>
  <div class="announcer" aria-live="polite">
    <Transition name="title-card">
      <div v-if="titleCard && scenario" class="title-card">
        <span class="title-card__kicker">Agent Island</span>
        <span class="title-card__name">{{ scenario }}</span>
        <span class="title-card__tick">Tick {{ tick }}</span>
      </div>
    </Transition>

    <div
      v-if="liveness.status === 'ended' || liveness.paused"
      class="banner"
      :class="{ 'banner--ended': liveness.status === 'ended' }"
    >
      {{ liveness.status === "ended" ? "Game over" : "Paused" }}
    </div>

    <TransitionGroup name="toast" tag="div" class="toasts">
      <button
        v-for="toast in toasts"
        :key="toast.key"
        class="toast panel"
        :class="`toast--${toast.tone}`"
        @click="open(toast)"
      >
        <span class="toast__kicker">{{ toast.kicker }}</span>
        <span class="toast__text">{{ toast.text }}</span>
      </button>
    </TransitionGroup>
  </div>
</template>
