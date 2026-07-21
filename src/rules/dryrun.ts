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
import type { DisplayHint } from "./scenario.js";

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
  display?: Record<string, DisplayHint>;
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
// with nothing given back? Judged from shape only, never from the stock's name:
// a negative adjust on a "down is good" gauge (a thirst that falls when you
// drink) is the relief the verb exists to deliver, so it is a payoff and not a
// price. Anything whose size is an expression rather than a literal number, or
// whose target is a dynamic reference, is left alone - the sign is not knowable
// from the shape, and a false alarm on a working rule costs more than a miss.
function isPrice(eff: unknown, display: Record<string, DisplayHint>): boolean {
  let adjust = (eff as { adjust?: Record<string, unknown> })?.adjust;
  if (!adjust || adjust.of !== undefined) return false;
  if (typeof adjust.by !== "number" || adjust.by >= 0) return false;
  if (typeof adjust.target !== "string") return false;
  return display[adjust.target]?.tone !== "down";
}

// Everything that is not a price is a payoff: a spawn, a transfer, a tag, a
// move, a relief. forEach is transparent - it pays off if any of its branches
// does.
function isPayoff(eff: unknown, display: Record<string, DisplayHint>): boolean {
  let each = (eff as { forEach?: { do?: unknown[] } })?.forEach;
  if (each) return (each.do ?? []).some((e) => isPayoff(e, display));
  return !isPrice(eff, display);
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
function lintActionBody(
  rule: { id: string; do?: unknown },
  display: Record<string, DisplayHint>,
  warnings: string[],
) {
  let body = Array.isArray(rule.do) ? rule.do : [];
  if (body.length === 0) {
    warnings.push(
      `action "${rule.id}" has an empty body - committing it will cost time and change nothing, and characters will believe it worked.`,
    );
    return;
  }
  if (!body.some((eff) => isPayoff(eff, display)))
    warnings.push(
      `action "${rule.id}" only spends - every effect in its body subtracts from the actor and nothing is produced, moved, or placed. Characters will pay the cost, be told the action completed, and find the world unchanged. If this verb makes a thing, spawn that thing here; if it relieves something, adjust the gauge it relieves.`,
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
    lintActionBody(rule, opts.display ?? {}, warnings);
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
