// Dry-run linting for GM-authored rules: simulate the candidate rule set on a
// disposable clone of the live world and report what the rule under test did -
// or failed to do - before real characters meet it.
//
// This leans on two properties the substrate already guarantees. The kernel
// world is fully serializable, so a structuredClone is a complete sandbox; and
// noise is stateless (addressed by seed/tick/entity, never drawn from mutable
// RNG state), so two simulations from the same start see identical random
// streams and any divergence between them is attributable to the one rule that
// differs. That is what lets "did this rule do anything?" be answered by
// diffing a with-rule run against a without-rule run.
//
// Findings are advisory, split by weight:
//   warnings - rule_errors the rule threw in simulation (a missing stock, a
//              malformed expression). Real problems, but not always: a rule
//              may read a stock the GM is about to seed with set_stock_default,
//              so the caller adds the rule regardless and reports these back.
//   notes    - softer observations: the rule matched no entity, or ran to no
//              observable effect (fine for a rule waiting on a season).

import {
  beginTick,
  checkAction,
  hasTag,
  runRulesForTick,
  type KernelEvent,
  type KernelWorld,
  type Rule,
} from "./kernel.js";
import type { StockDisplay } from "./scenario.js";

export interface DryRunReport {
  // Simulated ticks actually run: 0 for an action rule, whose body only runs
  // when a character commits it (see the availability sweep below).
  ticks: number;
  warnings: string[];
  notes: string[];
}

export interface DryRunOptions {
  // The live grid's terrain kinds, tiles[y][x]. Cloned per simulation so a
  // setTerrain effect lands in the sandbox, never on the real map.
  terrain: string[][];
  // Living character ids, for the action-rule availability sweep.
  agents: string[];
  // The scenario's display hints, so the body lint can tell a gauge that falls
  // as a benefit (thirst) from a resource that falls as a cost (wood).
  display?: Record<string, StockDisplay>;
  // Every stock name this ruleset has legitimately declared (see engine.ts
  // knownStockNames), for the unknown-stock-write lint below. Omitted, that
  // lint is skipped rather than flagging everything as unknown.
  knownStocks?: string[];
  ticks?: number;
}

const DEFAULT_TICKS = 50;

// Run `ticks` kernel ticks on clones of the world and terrain, mirroring the
// engine's tick composition (per-tick event arrays, so rule_error dedupe keeps
// its production per-tick semantics) minus the host concerns a sandbox has no
// use for: movement, token sync, orders, history.
function simulate(
  start: KernelWorld,
  rules: Rule[],
  terrainRows: string[][],
  ticks: number,
): { world: KernelWorld; events: KernelEvent[] } {
  let world = structuredClone(start);
  let terrain = terrainRows.map((row) => [...row]);
  let lookup = (x: number, y: number) => terrain[y]?.[x];
  let write = (x: number, y: number, kind: string) => {
    if (terrain[y]?.[x] !== undefined) terrain[y][x] = kind;
  };
  // Fog is host state with no sandbox counterpart; a no-op revealer lets a
  // reveal-bearing rule simulate cleanly instead of erroring on the hook.
  let reveal = () => {};
  let all: KernelEvent[] = [];
  for (let i = 0; i < ticks; i += 1) {
    let before = beginTick(world);
    let events: KernelEvent[] = [];
    runRulesForTick(world, rules, before, events, lookup, write, reveal);
    all.push(...events);
  }
  return { world, events: all };
}

// An action rule's body never runs in a world simulation (nothing commits it),
// so the useful submit-time check is the availability sweep: can anyone use it,
// and if not, what does its own gate say? Checked with empty args, so an action
// whose `requires` reads an arg reports that instead of throwing.
function sweepAction(
  world: KernelWorld,
  rules: Rule[],
  ruleId: string,
  opts: DryRunOptions,
  notes: string[],
) {
  if (opts.agents.length === 0) {
    notes.push(
      `no living agents to check "${ruleId}" against - its availability was not exercised.`,
    );
    return;
  }
  let sandbox = structuredClone(world);
  let lookup = (x: number, y: number) => opts.terrain[y]?.[x];
  let usable = 0;
  let reasons = new Set<string>();
  for (let id of opts.agents) {
    try {
      let check = checkAction(sandbox, rules, id, ruleId, {}, lookup);
      if (check.applicable) usable += 1;
      else reasons.add(check.unavailableReason ?? "unavailable");
    } catch (err) {
      reasons.add(err instanceof Error ? err.message : String(err));
    }
  }
  let sample = reasons.size ? ` (e.g. "${[...reasons][0]}")` : "";
  notes.push(
    `action "${ruleId}": ${usable} of ${opts.agents.length} agents could commit it right now${usable === opts.agents.length ? "" : sample}; its effects only run on commit, so the body was not exercised.`,
  );
}

// Is this effect a price the actor pays - a subtraction from its own stocks
// with nothing given back? Judged from shape only, never from the stock's
// name: every gauge in this world reads up as good, so a negative adjust is
// always a cost - the relief a verb delivers (easing hunger, slaking thirst)
// is authored as a rise, never a fall (see StockSpec). Anything whose size is
// an expression rather than a literal number, or whose target is a dynamic
// reference, is left alone - the sign is not knowable from the shape, and a
// false alarm on a working rule costs more than a miss.
function isPrice(eff: unknown): boolean {
  let adjust = (eff as { adjust?: Record<string, unknown> })?.adjust;
  if (!adjust || adjust.of !== undefined) return false;
  if (typeof adjust.by !== "number" || adjust.by >= 0) return false;
  return typeof adjust.target === "string";
}

// Everything that is not a price is a payoff: a spawn, a transfer, a tag, a
// move, a relief. forEach is transparent - it pays off if any of its branches
// does.
function isPayoff(eff: unknown): boolean {
  let each = (eff as { forEach?: { do?: unknown[] } })?.forEach;
  if (each) return (each.do ?? []).some((e) => isPayoff(e));
  return !isPrice(eff);
}

// Every stock name a literal adjust/set/transfer effect writes, collected
// recursively through forEach - the shape a rule author typo's ("self" meant
// "of":"self") independent of whether simulation ever exercises that branch,
// which matters most for an action rule (whose body never runs in
// simulation at all) or a rule gated behind a condition simulation might not
// trip within its tick budget. `{arg}` targets are skipped: the name isn't
// knowable from the shape alone, the same doctrine as isPrice.
function literalWriteTargets(effects: unknown[]): string[] {
  let names: string[] = [];
  for (let eff of effects) {
    if (!eff || typeof eff !== "object") continue;
    let e = eff as Record<string, any>;
    if (e.adjust && typeof e.adjust.target === "string")
      names.push(e.adjust.target);
    if (e.set && typeof e.set.target === "string") names.push(e.set.target);
    if (e.transfer) {
      if (typeof e.transfer.from?.stock === "string")
        names.push(e.transfer.from.stock);
      if (typeof e.transfer.to?.stock === "string")
        names.push(e.transfer.to.stock);
    }
    if (e.forEach?.do) names.push(...literalWriteTargets(e.forEach.do));
  }
  return names;
}

// A stock this same rule declares for itself, via a spawn in its own body -
// so a rule that mints a crate and then tops it up later in the same body
// isn't flagged for a name only its own authoring just introduced (the live
// registry only catches up once the rule is actually added; see engine.ts
// addRule's syncKnownStocks).
function selfDeclaredStocks(effects: unknown[]): string[] {
  let names: string[] = [];
  for (let eff of effects) {
    if (!eff || typeof eff !== "object") continue;
    let e = eff as Record<string, any>;
    if (e.spawn?.stocks) names.push(...Object.keys(e.spawn.stocks));
    if (e.forEach?.do) names.push(...selfDeclaredStocks(e.forEach.do));
  }
  return names;
}

// Flags a rule effect writing to a stock nothing has declared - the closed
// namespace's static counterpart to the simulation's rule_error warnings,
// catching an action rule (never simulated) or a rarely-gated rule the
// simulation's tick budget doesn't happen to trip. Skipped entirely when the
// caller didn't thread a registry (opts.knownStocks), rather than treating
// "no registry given" as "everything is unknown".
function lintUnknownStockWrites(
  rule: { id: string; do?: unknown; phase?: string; target?: unknown },
  known: string[] | undefined,
  warnings: string[],
) {
  if (!known) return;
  let body = Array.isArray(rule.do) ? rule.do : [];
  let targets = literalWriteTargets(body);
  // A flow rule's write target lives at the top level (target/rate), not in
  // a `do` array.
  if (rule.phase === "flow" && typeof rule.target === "string")
    targets.push(rule.target);
  let allowed = new Set([...known, ...selfDeclaredStocks(body)]);
  for (let name of [...new Set(targets)].filter((n) => !allowed.has(n)))
    warnings.push(
      `"${rule.id}" writes to "${name}", which nothing has declared - it will error the moment the rule fires. If "${name}" is meant to name an entity (e.g. "self"), it belongs in "of", not "target"; otherwise declare the resource first (set_stock_default, a spawn's stocks).`,
    );
}

// An action's body never runs in simulation, so its shape is all we can check.
// Two failures are visible from the shape alone, without the engine guessing at
// what a verb's name means:
//
//   - a `do` that does nothing at all;
//   - a `do` that only spends. Genesis run 7a04489e minted build_shelter as the
//     single effect `adjust wood by -3`. The character paid, the order reported
//     completed, and no hearth was ever placed - so they told each other about a
//     camp that did not exist, which is the empty-body failure wearing a cost.
//
// Both are structural, which is what keeps them here. Everything else about a
// rule's intent - whether a verb that promises a noun delivers that noun,
// whether a built thing reserves its tile - is the director's judgment, and
// belongs in the director's prompt rather than in a list of English words the
// kernel pretends to understand.
function lintActionBody(rule: { id: string; do?: unknown }, warnings: string[]) {
  let body = Array.isArray(rule.do) ? rule.do : [];
  if (body.length === 0) {
    warnings.push(
      `action "${rule.id}" has an empty body - committing it will cost time and change nothing, and characters will believe it worked.`,
    );
    return;
  }
  if (!body.some((eff) => isPayoff(eff)))
    warnings.push(
      `action "${rule.id}" only spends - every effect in its body subtracts from the actor and nothing is produced, moved, or placed. Characters will pay the cost, be told the action completed, and find the world unchanged. If this verb makes a thing, spawn that thing here; if it relieves something, adjust the gauge it relieves.`,
    );
}

// Literal stock names a Cond compares against - walks all/any/not, only
// collecting a name where `{stock: "X"}` appears as a literal string. An
// `{arg}`/`{nameOf}` reference isn't knowable from shape alone and is
// skipped, the same doctrine as isPrice.
// Every spawn effect in a rule body, walking forEach fan-outs the way the other
// body lints do.
function spawnSpecs(effects: unknown[]): Record<string, unknown>[] {
  let out: Record<string, unknown>[] = [];
  for (let eff of (effects ?? []) as any[]) {
    if (!eff || typeof eff !== "object") continue;
    if (eff.spawn && typeof eff.spawn === "object") out.push(eff.spawn);
    if (eff.forEach?.do) out.push(...spawnSpecs(eff.forEach.do));
  }
  return out;
}

// Two ways a build action's spawn goes wrong that are visible from shape alone,
// both learned from genesis run cc3d1956.
//
// A constant id makes the structure a global singleton: the first build takes
// the name and every later one throws "already exists" *after* the requires
// have passed and the materials are spent, so the second builder pays and gets
// an error. `{{self}}`/`{{tick}}` render now (see kernel `spawnId`), and
// omitting `id` auto-numbers - either is fine, a bare constant is not.
//
// The occupancy note is the other half of that run's shelter story: a structure
// spawned at `self` takes the builder's tile, and one tile holds one token, so
// a *second* structure can never be raised on the same square. The director kept
// authoring toward "a fire inside the shelter" (Tobias asked for exactly that)
// without anything telling it that the world cannot hold both. A note rather
// than a warning - building on open ground is the normal case and works fine.
function lintSpawnIds(
  rule: { id: string; do?: unknown },
  warnings: string[],
  notes: string[],
) {
  let specs = spawnSpecs(Array.isArray(rule.do) ? rule.do : []);
  for (let spec of specs) {
    let id = spec.id;
    if (typeof id === "string" && !id.includes("{{"))
      warnings.push(
        `action "${rule.id}" spawns with the fixed id "${id}", so only one can ever exist - the next build passes its requires, spends the materials, then throws "already exists". Use "${id}-{{self}}-{{tick}}" for one per builder per tick, or drop \`id\` for an auto-numbered one.`,
      );
    if (
      spec.occupancy !== undefined &&
      (spec.at === undefined || spec.at === "self")
    )
      notes.push(
        `"${rule.id}" puts something that holds ground on the builder's own tile. A tile carries one token, so nothing else can be built there afterwards - if this is meant to be combined with another structure (a fire inside a shelter), the two need adjacent tiles, not one.`,
      );
  }
}

function literalCondStocks(cond: unknown): string[] {
  if (!cond || typeof cond !== "object") return [];
  let c = cond as Record<string, unknown>;
  if ("cmp" in c) {
    let names: string[] = [];
    for (let side of [c.left, c.right])
      if (
        side &&
        typeof side === "object" &&
        typeof (side as { stock?: unknown }).stock === "string"
      )
        names.push((side as { stock: string }).stock);
    return names;
  }
  if ("all" in c && Array.isArray(c.all))
    return c.all.flatMap(literalCondStocks);
  if ("any" in c && Array.isArray(c.any))
    return c.any.flatMap(literalCondStocks);
  if ("not" in c) return literalCondStocks(c.not);
  return [];
}

// Whether a literal adjust effect moves a vital stock in the harmful
// direction, judged from shape - never from its name. Every vital reads up as
// good, so the harmful direction is always a fall. Ambiguous shapes (a
// dynamic by/target) are left alone: a false alarm on a working rule costs
// more than a miss, the same doctrine as isPrice/isPayoff.
function harmsVital(
  eff: unknown,
  display: Record<string, StockDisplay>,
): string | null {
  let adjust = (eff as { adjust?: Record<string, unknown> })?.adjust;
  if (!adjust || adjust.of !== undefined) return null;
  if (typeof adjust.by !== "number" || typeof adjust.target !== "string")
    return null;
  if (display[adjust.target]?.role !== "vital") return null;
  return adjust.by < 0 ? adjust.target : null;
}

// The name of a vital this rule harms, if any - its own `do` body (including
// one level of forEach), or a flow's desugared target/rate.
function ruleHarmsVital(
  rule: {
    do?: unknown;
    phase?: string;
    target?: unknown;
    rate?: unknown;
  },
  display: Record<string, StockDisplay>,
): string | null {
  for (let eff of Array.isArray(rule.do) ? rule.do : []) {
    let hit = harmsVital(eff, display);
    if (hit) return hit;
    let each = (eff as { forEach?: { do?: unknown[] } })?.forEach;
    for (let inner of each?.do ?? []) {
      let innerHit = harmsVital(inner, display);
      if (innerHit) return innerHit;
    }
  }
  if (
    rule.phase === "flow" &&
    typeof rule.target === "string" &&
    typeof rule.rate === "number" &&
    display[rule.target]?.role === "vital" &&
    rule.rate < 0
  )
    return rule.target;
  return null;
}

// Flags a rule that harms a vital gauge while gating on a stock nothing has
// marked vital - the gate is exactly what a character would need alarmed to
// see the harm coming, and a harm nobody can see coming reads as a bug.
// Literal-only, like every other dry-run shape check: a `{arg}` gate or a
// computed `by` is left alone rather than risk a false alarm on a working
// rule.
function lintLethalUnmarkedGate(
  rule: {
    id: string;
    when?: unknown;
    do?: unknown;
    phase?: string;
    target?: unknown;
    rate?: unknown;
  },
  display: Record<string, StockDisplay>,
  warnings: string[],
) {
  let harmedVital = ruleHarmsVital(rule, display);
  if (!harmedVital) return;
  let gateNames = new Set(
    literalCondStocks(rule.when).filter((n) => n !== harmedVital),
  );
  for (let name of gateNames) {
    if (display[name]?.role === "vital") continue;
    warnings.push(
      `"${rule.id}" harms "${harmedVital}" gated on "${name}", which is not marked vital - characters get no alarm as "${name}" slides toward triggering this. set_stock_default "${name}" with role:"vital" and bands if it should warn them.`,
    );
  }
}

// Whether this rule signals danger to a character - a threshold that harms
// another stock, or a watch whose emit interrupts the subject's hands. The
// two shapes an alarm actually takes in this DSL (see add_rule.md).
function ruleSignalsDanger(rule: unknown): boolean {
  let r = rule as { do?: unknown; phase?: string; emit?: { interrupt?: unknown } };
  if (r.phase === "watch") return typeof r.emit?.interrupt === "string";
  return (Array.isArray(r.do) ? r.do : []).some((eff) => {
    let adjust = (eff as { adjust?: Record<string, unknown> })?.adjust;
    return (
      !!adjust &&
      adjust.of === undefined &&
      typeof adjust.by === "number" &&
      adjust.by < 0
    );
  });
}

// Genesis run 3a89cfab: exposure was declared role:"vital" and wired to rise
// toward harm (a threshold at "gte 100"), but every vital in this world reads
// up as good - low is always the emergency. The band prose read the stock
// backwards: it screamed at exposure 0.8 and went silent at 100, the one tick
// health actually started draining. Solving the problem escalated the alarm.
//
// The fix isn't a per-stock switch (that's the field this refactor removed -
// it's what let the mismatch exist undetected). It's catchable from shape: a
// single, literal `{cmp:"gte"|"gt", left:{stock}, right:number}` gating a
// rule that harms is the exact shape of "this stock's crisis is high", which
// can never be correct once every vital's crisis is defined as low. Compound
// conditions (all/any/not) are left alone - a co-gate inside an "all" isn't
// necessarily the rule's own trigger, and a false alarm here costs more than
// a miss, the same doctrine as every other check in this file.
function lintBackwardsVitalGate(
  rule: unknown,
  display: Record<string, StockDisplay>,
  warnings: string[],
) {
  let r = rule as { id: string; when?: unknown; phase?: string };
  if (r.phase !== "threshold" && r.phase !== "watch") return;
  let when = r.when as
    | { cmp?: unknown; left?: { stock?: unknown }; right?: unknown }
    | undefined;
  if (!when || typeof when.cmp !== "string") return;
  if (when.cmp !== "gte" && when.cmp !== "gt") return;
  let name = when.left?.stock;
  if (typeof name !== "string" || typeof when.right !== "number") return;
  if (display[name]?.role !== "vital") return;
  if (!ruleSignalsDanger(rule)) return;
  warnings.push(
    `"${r.id}" signals danger when "${name}" is HIGH, but every vital in this world treats low as the emergency (up is good) - this alarm reads backwards: quiet while "${name}" climbs toward real trouble, loud the moment it's actually fine. Either flip the comparison to "lte"/"lt", or "${name}" is really named for its problem rather than its relief - name it for the relief instead (warmth, not cold) so a low value is naturally the danger.`,
  );
}

// Lint one rule by simulation. `rules` is the full candidate set and must
// already contain the rule under test - which is how one code path serves both
// add_rule (candidate = live set, now including the newcomer) and tweak_rule
// (candidate = live set with the patch applied).
export function dryRunRule(
  world: KernelWorld,
  rules: Rule[],
  ruleId: string,
  opts: DryRunOptions,
): DryRunReport {
  let rule = rules.find((r) => r.id === ruleId);
  if (!rule)
    throw new Error(
      `dry run: no rule with id "${ruleId}" in the candidate set`,
    );
  let ticks = opts.ticks ?? DEFAULT_TICKS;
  let warnings: string[] = [];
  let notes: string[] = [];

  lintUnknownStockWrites(rule, opts.knownStocks, warnings);
  lintLethalUnmarkedGate(rule, opts.display ?? {}, warnings);
  lintBackwardsVitalGate(rule, opts.display ?? {}, warnings);

  // A selector that matches nothing is almost always a typo'd tag/kind - but
  // it is also the legitimate shape of a rule awaiting entities the GM spawns
  // next, so it stays a note rather than a warning.
  let each = (rule as { each?: { tag?: string; kind?: string } }).each;
  if (each?.tag !== undefined || each?.kind !== undefined) {
    let tag = each.tag;
    let kind = each.kind;
    let matched = Object.values(world.entities).some(
      (e) =>
        (tag === undefined || hasTag(e, tag)) &&
        (kind === undefined || e.kind === kind),
    );
    if (!matched) {
      let wanted = [
        ...(tag !== undefined ? [`tag "${tag}"`] : []),
        ...(kind !== undefined ? [`kind "${kind}"`] : []),
      ].join(" + ");
      notes.push(
        `"${ruleId}" binds to ${wanted}, but nothing matches right now - it will sit idle until something does.`,
      );
    }
  }

  if ("kind" in rule && rule.kind === "action") {
    lintActionBody(rule, warnings);
    lintSpawnIds(rule, warnings, notes);
    sweepAction(world, rules, ruleId, opts, notes);
    return { ticks: 0, warnings, notes };
  }

  let candidate = simulate(world, rules, opts.terrain, ticks);
  let baseline = simulate(
    world,
    rules.filter((r) => r.id !== ruleId),
    opts.terrain,
    ticks,
  );

  // Collapse the rule's errors to one warning per distinct message: the tick it
  // first fired and how often it recurred is what tells a GM "typo, fires every
  // tick" apart from "edge case, fired once on tick 37".
  let seen = new Map<string, { first: number; count: number }>();
  for (let e of candidate.events) {
    if (e.type !== "rule_error" || e.args?.rule !== ruleId) continue;
    let msg = e.text ?? "unknown error";
    let entry = seen.get(msg);
    if (entry) entry.count += 1;
    else seen.set(msg, { first: e.tick, count: 1 });
  }
  for (let [msg, { first, count }] of seen)
    warnings.push(
      `simulated tick ${first}: ${msg}` +
        (count > 1 ? ` (recurred on ${count} of ${ticks} ticks)` : ""),
    );

  // "Did nothing": final world and (non-error) event stream identical with and
  // without the rule. Skipped when the rule threw - a throwing rule certainly
  // fired, and the warnings already cover it.
  if (warnings.length === 0) {
    let strip = (events: KernelEvent[]) =>
      JSON.stringify(events.filter((e) => e.type !== "rule_error"));
    let inert =
      JSON.stringify(candidate.world) === JSON.stringify(baseline.world) &&
      strip(candidate.events) === strip(baseline.events);
    if (inert)
      notes.push(
        `"${ruleId}" had no observable effect over ${ticks} simulated ticks - expected for a rule waiting on a season or a threshold, otherwise check its conditions.`,
      );
  }

  return { ticks, warnings, notes };
}
