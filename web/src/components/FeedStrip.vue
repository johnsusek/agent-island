<script setup lang="ts">
import { computed, ref } from "vue";
import { nameTint } from "../glyphs";
import { useStickToBottom } from "../useStickToBottom";
import type { ChatItem, FeedItem } from "../useWorldState";

const props = defineProps<{
  feed: FeedItem[];
  chat: ChatItem[];
}>();

const emit = defineEmits<{ (e: "select", id: string): void }>();

type Filter = "all" | "speculations" | "talk" | "world";
let filter = ref<Filter>("all");

type Row = ({ rowKind: "feed" } & FeedItem) | ({ rowKind: "chat" } & ChatItem);

// The merged stream, oldest first; each poll appends, the scroller sticks to
// the bottom unless the viewer has scrolled up to read history.
let rows = computed<Row[]>(() => {
  let out: Row[] = [];
  if (filter.value !== "talk") {
    for (let item of props.feed) {
      if (filter.value === "speculations" && item.kind === "event") continue;
      if (filter.value === "world" && item.kind !== "event") continue;
      out.push({ rowKind: "feed", ...item });
    }
  }
  if (filter.value === "all" || filter.value === "talk") {
    for (let item of props.chat) out.push({ rowKind: "chat", ...item });
  }
  return out.sort((a, b) => Number(a.key) - Number(b.key));
});

let { scrollHost } = useStickToBottom(() => rows.value.length);

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "speculations", label: "speculations" },
  { key: "talk", label: "talk" },
  { key: "world", label: "world" },
];
</script>

<template>
  <section class="feed">
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
        <div v-else-if="row.kind === 'speculation'" class="row row--spec">
          <span class="row__tick">t{{ row.tick }}</span>
          <button
            v-if="row.name"
            class="row__name"
            :style="{ color: nameTint(row.name) }"
            @click="row.agentId && emit('select', row.agentId)"
          >
            {{ row.name }}
          </button>
          <span class="row__text">
            speculates <b class="row__verb">{{ row.verb ?? row.text }}</b>
            <span v-if="row.expectation" class="row__hope">
              - "{{ row.expectation }}"</span
            >
          </span>
        </div>
        <div v-else-if="row.kind === 'law'" class="row row--law">
          <span class="row__tick">t{{ row.tick }}</span>
          <span class="row__text">
            <b class="row__verb">{{ row.verb ?? "" }}</b>
            became real<template v-if="row.name">
              -
              <button
                class="row__name"
                :style="{ color: nameTint(row.name) }"
                @click="row.agentId && emit('select', row.agentId)"
              >
                {{ row.name }}</button
              >'s speculation granted</template
            >
          </span>
        </div>
        <div v-else class="row row--event" :class="`row--${row.type}`">
          <span class="row__tick">t{{ row.tick }}</span>
          <span class="row__text">{{ row.text }}</span>
        </div>
      </template>
    </div>
  </section>
</template>
