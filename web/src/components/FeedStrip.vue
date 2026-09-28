<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { nameTint } from "../glyphs";
import { useStickToBottom } from "../useStickToBottom";
import type { ChatItem, FeedItem } from "../useWorldState";

let props = defineProps<{
  feed: FeedItem[];
  chat: ChatItem[];
  height: number;
}>();

let emit = defineEmits<{
  (event: "select", id: string): void;
  (event: "resize", height: number): void;
}>();

type Filter = "all" | "talk" | "world";
let filter = ref<Filter>("all");
let resizeSession = ref<{
  pointerId: number;
  startHeight: number;
  startY: number;
} | null>(null);

let minimumFeedHeight = 96;
let maximumFeedHeight = computed(() =>
  Math.round(Math.min(480, window.innerHeight * 0.55)),
);

function clampedFeedHeight(height: number) {
  return Math.round(
    Math.min(maximumFeedHeight.value, Math.max(minimumFeedHeight, height)),
  );
}

function beginResize(event: PointerEvent) {
  if (event.button !== 0) return;
  resizeSession.value = {
    pointerId: event.pointerId,
    startHeight: props.height,
    startY: event.clientY,
  };
  window.addEventListener("pointermove", continueResize);
  window.addEventListener("pointerup", endResize);
  window.addEventListener("pointercancel", endResize);
  document.body.classList.add("feed-resizing");
  event.preventDefault();
}

function continueResize(event: PointerEvent) {
  let session = resizeSession.value;
  if (!session || session.pointerId !== event.pointerId) return;
  emit(
    "resize",
    clampedFeedHeight(session.startHeight + session.startY - event.clientY),
  );
}

function endResize(event: PointerEvent) {
  let session = resizeSession.value;
  if (!session || session.pointerId !== event.pointerId) return;
  stopResize();
}

function stopResize() {
  resizeSession.value = null;
  window.removeEventListener("pointermove", continueResize);
  window.removeEventListener("pointerup", endResize);
  window.removeEventListener("pointercancel", endResize);
  document.body.classList.remove("feed-resizing");
}

function resizeWithKeyboard(event: KeyboardEvent) {
  let step = event.shiftKey ? 48 : 16;
  if (event.key === "ArrowUp") {
    emit("resize", clampedFeedHeight(props.height + step));
  } else if (event.key === "ArrowDown") {
    emit("resize", clampedFeedHeight(props.height - step));
  } else if (event.key === "Home") {
    emit("resize", minimumFeedHeight);
  } else if (event.key === "End") {
    emit("resize", maximumFeedHeight.value);
  } else {
    return;
  }
  event.preventDefault();
}

onBeforeUnmount(stopResize);

type Row = ({ rowKind: "feed" } & FeedItem) | ({ rowKind: "chat" } & ChatItem);

// The merged stream, oldest first; each poll appends, the scroller sticks to
// the bottom unless the viewer has scrolled up to read history.
let rows = computed<Row[]>(() => {
  let out: Row[] = [];
  if (filter.value !== "talk") {
    for (let item of props.feed) out.push({ rowKind: "feed", ...item });
  }
  if (filter.value === "all" || filter.value === "talk") {
    for (let item of props.chat) out.push({ rowKind: "chat", ...item });
  }
  return out.sort((a, b) => Number(a.key) - Number(b.key));
});

let { scrollHost } = useStickToBottom(() => rows.value.length);

let FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "talk", label: "Talk" },
  { key: "world", label: "World" },
];
</script>

<template>
  <section class="feed">
    <div
      class="feed__splitter"
      role="separator"
      aria-label="Resize Feed"
      aria-orientation="horizontal"
      :aria-valuemin="minimumFeedHeight"
      :aria-valuemax="maximumFeedHeight"
      :aria-valuenow="height"
      tabindex="0"
      @pointerdown="beginResize"
      @keydown="resizeWithKeyboard"
    ></div>
    <header class="feed__head">
      <h2 class="feed__title">Feed</h2>
      <nav class="feed__filters">
        <button
          v-for="f in FILTERS"
          :key="f.key"
          class="chip"
          :class="{ 'chip--on': filter === f.key }"
          @click="filter = f.key"
        >
          {{ f.label }}
        </button>
      </nav>
    </header>
    <div ref="scrollHost" class="feed__scroll">
      <template v-for="row in rows" :key="row.rowKind + row.key">
        <div v-if="row.rowKind === 'chat'" class="row row--chat">
          <span class="row__tick">t{{ row.tick }}</span>
          <button
            class="row__name"
            :style="{ color: nameTint(row.speaker) }"
            @click="row.speakerId && emit('select', row.speakerId)"
          >
            {{ row.speaker }}
          </button>
          <span v-if="row.whisper" class="row__whisper"
            >whispers to {{ row.target }}</span
          >
          <span class="row__text">{{ row.message }}</span>
        </div>
        <div v-else class="row row--event" :class="`row--${row.type}`">
          <span class="row__tick">t{{ row.tick }}</span>
          <span class="row__text">{{ row.text }}</span>
        </div>
      </template>
    </div>
  </section>
</template>
