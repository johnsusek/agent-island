import type { DisplayHint, Stock } from "./types";

// Groups agent-scoped stocks into three families so the roster stays a fixed
// width no matter how many stocks a scenario (or a live GM) piles on:
//   vitals    - bounded 0..100 needs, worth checking every tick
//   skills    - slow-moving proficiencies, worth checking when staffing
//   inventory - everything else, mostly unbounded material counts
// Classification is name-based and entirely client-side: a GM-invented stock
// with no display hint still lands in "inventory" instead of breaking layout.
export type StatFamily = "vitals" | "skills" | "inventory";

export const FAMILY_LABEL: Record<StatFamily, string> = {
  vitals: "Needs",
  skills: "Skills",
  inventory: "Inventory",
};

const VITAL_NAMES = new Set([
  "health",
  "hunger",
  "thirst",
  "mood",
  "fatigue",
  "warmth",
]);

export function familyOf(name: string): StatFamily {
  if (VITAL_NAMES.has(name)) return "vitals";
  if (name.startsWith("skill_")) return "skills";
  return "inventory";
}

// 0..1, always "1 = best" regardless of whether the stock counts up (health)
// or counts down (hunger) toward trouble - so bar fills and heatmap colors
// can share one scale.
export function goodness(stock: Stock, tone: DisplayHint["tone"]): number {
  let span = stock.max - stock.min || 1;
  let frac = (stock.value - stock.min) / span;
  return tone === "down" ? 1 - frac : frac;
}

export function isBad(stock: Stock, tone: DisplayHint["tone"]): boolean {
  return goodness(stock, tone) < 0.3;
}

// Short, human alert words for the vitals the game ships with; anything else
// falls back to a generic "low X" / "high X" built from the tone direction.
const ALERT_WORDS: Record<string, string> = {
  health: "injured",
  hunger: "hungry",
  thirst: "thirsty",
  mood: "unhappy",
  fatigue: "exhausted",
  warmth: "freezing",
};

export function alertLabel(
  name: string,
  label: string,
  tone: DisplayHint["tone"],
): string {
  let known = ALERT_WORDS[name];
  if (known) return known;
  return tone === "down"
    ? `high ${label.toLowerCase()}`
    : `low ${label.toLowerCase()}`;
}
