// How a stock reads to a character. The host builds these from its stock specs
// (see the engine's stockDisplay); the dry-run lints read them to tell a gauge
// that falls as a benefit from a resource that falls as a cost.

// What a stock IS to a character, independent of its name: a pressure that
// can hurt or kill (`vital`, band-alarmed prose, never a figure), a personal
// dimension worth a mention only when it's notable (`stat`, adjectival prose,
// silent otherwise), or a fungible quantity that gets carried and handed over
// (`pack`, the "Carrying:" figures, the only role give/stockpile ever touch),
// or the rules' own bookkeeping that the character must not perceive at all
// (`hidden`: never in prose, never givable - a fever nobody can feel yet).
// An unclassified stock is `pack`: the plain reading of a bare number nobody
// has said anything else about.
export type StockRole = "vital" | "stat" | "pack" | "hidden";

// The reader-facing view of one stock: what it is and how to say it. Built
// fresh on every read (see engine.ts stockDisplay) from the registry that
// declares the stock - stockDefaults for a per-character stock, worldStocks
// for a global one - which is where `scope` comes from. Prose, alarms, the
// dry-run lints, and the dashboard all read this one shape; nothing authors
// it directly.
export interface StockDisplay {
  role: StockRole;
  scope: "agent" | "world";
  label?: string;
  bands?: Partial<Record<"pressing" | "serious" | "critical", string>>;
}
