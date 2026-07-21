// Stable, auto-assigned *colors* for map icons. The icon a resource is drawn
// with comes from the GM/scenario-chosen kindVisuals registry, but an icon
// without a hand-authored color still needs a fill, so a resource whose tag has
// no catalog color falls back to a tint deterministically derived from its
// name. Pills and cards take their color from tone, not from here.
const TINTS = [
  0x9fb8d0, 0xc8a45a, 0x9ec97a, 0xcf9090, 0xb6a0d2, 0x6fc2b0, 0xd2b45c,
];

// FNV-1a over the name — tiny, dependency-free, and deterministic: the same name
// always lands on the same tint, independent of what else exists, so a resource's
// color never shuffles when another is introduced.
function hash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function autoTintNum(name: string): number {
  return TINTS[hash(name) % TINTS.length];
}

// Per-character name colors for the activity feed. Same deterministic hash, but a
// CSS-string palette tuned for body text on the dark HUD: distinct enough to tell
// characters apart at a glance, and kept clear of the danger/accent/warn hues
// (reds and ambers, roughly 0-54 degrees) so alert rows still stand out. Hues are
// spread ~18 degrees apart with alternating lightness for extra separation
// between neighbors, so even a full colony rarely sees two names land on
// visually adjacent colors. Each name lands on a stable hue regardless of who
// else exists.
const NAME_TINTS = [
  "#cfc87d", // chartreuse
  "#c6d68f", // lime
  "#a4cf7d", // moss
  "#9cd68f", // green
  "#7dcf88", // emerald
  "#8fd6ae", // mint
  "#7dcfb9", // jade
  "#8fd3d6", // teal
  "#7db3cf", // sky
  "#8fa9d6", // azure
  "#7d82cf", // indigo
  "#a08fd6", // violet
  "#aa7dcf", // purple
  "#cb8fd6", // orchid
  "#cf7dc2", // magenta
  "#d68fb6", // pink
];

export function nameTint(name: string): string {
  return NAME_TINTS[hash(name) % NAME_TINTS.length];
}
