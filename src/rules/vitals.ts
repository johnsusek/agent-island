// Vitals as bands, not numbers. A gauge reading 33.4/100 makes the reader do
// the comparison the scenario already knows how to make, and an agent that has
// to infer its own thresholds infers them badly - the starving character in
// every run read `hunger 33.4/100` and did nothing. So the world says which
// band a gauge is in, in words, and says nothing at all while it is fine.
//
// Which way is bad comes from the scenario's display tone, never from the
// stock's name: this module can price a world whose vitality is called
// `integrity` and whose clock is called `decay` without knowing either word.

import type { DisplayHint } from "./scenario.js";

export type VitalBand = "pressing" | "serious" | "critical";

// Worst first - the order alarms should be read in.
export const VITAL_BANDS: VitalBand[] = ["critical", "serious", "pressing"];

// How well a gauge is doing, 1 = fine and 0 = dire. Everything below is
// expressed in this one number, so no caller needs the tone again.
const BAND_CUTOFFS: [VitalBand, number][] = [
  ["critical", 0.15],
  ["serious", 0.3],
  ["pressing", 0.5],
];

interface StockValue {
  value?: number;
  min?: number;
  max?: number;
}

// null for anything unbounded or non-numeric: a counter with no ceiling has no
// "how well", and guessing one would invent alarms out of bookkeeping.
export function wellOf(
  stock: StockValue | undefined,
  hint?: DisplayHint,
): number | null {
  if (!stock || typeof stock.value !== "number") return null;
  let min = stock.min ?? 0;
  let max = stock.max;
  if (typeof max !== "number" || max <= min) return null;
  let fraction = (stock.value - min) / (max - min);
  // "down" means harm lies toward the ceiling (a hunger that climbs), so a full
  // gauge is a dire one.
  return hint?.tone === "down" ? 1 - fraction : fraction;
}

// The epsilon is not fussiness: a gauge sitting exactly on a cutoff lands on
// either side of it depending on how it got there (1 - 70/100 is 0.30000000000000004,
// while the engine's own running value is a hair under). Without it the alarm
// and the envelope in the SAME wake report disagree - one says parched, the
// other says thirsty - which is worse than either answer alone.
const BAND_EPSILON = 1e-9;

export function bandOf(well: number | null): VitalBand | null {
  if (well === null) return null;
  for (let [band, cutoff] of BAND_CUTOFFS)
    if (well <= cutoff + BAND_EPSILON) return band;
  return null;
}

// Every VITAL currently in a band, worst first. A stock that is fine simply
// isn't here - silence is the healthy state - and a stock the scenario never
// marked vital is never here at all.
export function bandedStocks(
  stocks: Record<string, StockValue> | undefined,
  display?: Record<string, DisplayHint>,
): { name: string; band: VitalBand }[] {
  if (!stocks) return [];
  return Object.entries(stocks)
    .filter(([name]) => display?.[name]?.vital)
    .map(([name, stock]) => ({
      name,
      band: bandOf(wellOf(stock, display?.[name])),
    }))
    .filter((entry): entry is { name: string; band: VitalBand } => !!entry.band)
    .sort((a, b) => VITAL_BANDS.indexOf(a.band) - VITAL_BANDS.indexOf(b.band));
}

// What the world says about a gauge in trouble. A scenario may author the
// sentence for any band ("You are starving."); anything it doesn't write gets a
// serviceable default built from the stock's own label, so a GM can mint a new
// resource without also having to write its alarms.
export function bandSentence(
  name: string,
  band: VitalBand,
  hint?: DisplayHint,
): string {
  let authored = hint?.bands?.[band];
  if (authored) return authored;
  // Labels are written for HUD pills ("Hunger"), so they arrive capitalized;
  // mid-sentence they read wrong. Only a plainly title-cased word is lowered -
  // an initialism like "HP" is left exactly as its scenario wrote it.
  let label = hint?.label ?? name;
  if (/^[A-Z][a-z]+$/.test(label)) label = label.toLowerCase();
  if (band === "critical") return `Your ${label} is critical.`;
  if (band === "serious") return `Your ${label} is serious.`;
  return `Your ${label} is becoming a problem.`;
}

// What a character is carrying: every non-vital gauge it actually holds some of.
// Figures survive here, unlike vitals - "how much food is in my pack" is a
// magnitude question ("enough to skip the detour?"), not a threshold one, and
// an empty line is simply omitted.
export function carriedStocks(
  stocks: Record<string, StockValue> | undefined,
  display?: Record<string, DisplayHint>,
): { name: string; value: number; max?: number }[] {
  if (!stocks) return [];
  return Object.entries(stocks)
    .filter(([name, stock]) => {
      let hint = display?.[name];
      if (hint?.vital || hint?.scope === "world") return false;
      return typeof stock.value === "number" && stock.value > 0;
    })
    .map(([name, stock]) => ({
      name,
      value: Math.round((stock.value as number) * 10) / 10,
      ...(typeof stock.max === "number" ? { max: stock.max } : {}),
    }));
}
