import { nextTick, onBeforeUnmount, ref, watch } from "vue";

// Keep the latest row of a chat-style feed in view, but only if the user
// hasn't scrolled up to read history. Snapshot the "near bottom" state before
// Vue patches the DOM with the new row, since afterward scrollHeight has grown.
const BOTTOM_SLOP = 40;

export function useStickToBottom(getLength: () => number) {
  let scrollHost = ref<HTMLElement>();

  // Consider the user "at the bottom" within a small slop so new rows still
  // snap into view even if the scroll position is off by a pixel or two.
  function isNearBottom(): boolean {
    let el = scrollHost.value;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLOP;
  }

  watch(getLength, () => {
    let shouldStick = isNearBottom();
    nextTick(() => {
      if (shouldStick && scrollHost.value)
        scrollHost.value.scrollTop = scrollHost.value.scrollHeight;
    });
  });

  function pin() {
    if (scrollHost.value)
      scrollHost.value.scrollTop = scrollHost.value.scrollHeight;
  }

  // Pin to bottom as soon as the feed's scroll host mounts, so a panel opened
  // with a backlog already scrolled starts at the newest row instead of the
  // top. Without this the length watch never fires for the initial rows and
  // isNearBottom() reads false (overflowing content at scrollTop 0), so new
  // runs only began sticking after the user scrolled down once.
  //
  // A ResizeObserver additionally re-pins on the hidden -> visible transition:
  // dockview collapses an inactive tab's panel to zero size, so switching to a
  // background feed (Chat, Events, Thoughts...) needs to snap to the newest row
  // on the way back in, not leave it wherever it sat when last hidden.
  let observer: ResizeObserver | null = null;
  watch(scrollHost, (el) => {
    observer?.disconnect();
    observer = null;
    if (!el) return;
    nextTick(pin);
    let wasVisible = el.clientHeight > 0;
    observer = new ResizeObserver(() => {
      let visible = (scrollHost.value?.clientHeight ?? 0) > 0;
      if (visible && !wasVisible) nextTick(pin);
      wasVisible = visible;
    });
    observer.observe(el);
  });

  onBeforeUnmount(() => observer?.disconnect());

  return { scrollHost };
}
