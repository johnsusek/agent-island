import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { RuleOverlay } from "./rules/engine.js";
import {
  compactOverlay,
  emptyOverlay,
  mergeOverlays,
  overlayCounts,
} from "./rules/overlays.js";
import { validateRule } from "./rules/kernel.js";
import { assertValidRule } from "./rules/rule-schema.js";
import { assertValidTerrainSpec } from "./rules/scenario.js";
import { assertValidConnect, assertValidTerrainLayers } from "./rules/space.js";

// Advisory player-count guidance shown in the scenario picker - not enforced by
// the engine, which will happily boot any number of agents into any scenario.
export interface RecommendedPlayers {
  min: number;
  max?: number; // omit for "no practical upper bound"
}

export interface ScenarioFile {
  name: string;
  description?: string;
  recommendedPlayers?: RecommendedPlayers;
  // Names of rulesets (config/rulesets/*.json) to pull in before this file's own
  // overlay. A shared bundle of related rules (the hunger loop, woodcutting, ...)
  // lives in one ruleset and is `include`d by every scenario that wants it, so we
  // stop copy-pasting the same rules into each scenario. Resolved and merged away
  // at load time - the returned overlay is already the composed result, and
  // `include` never rides the live overlay. Rulesets may themselves `include`
  // other rulesets; a cycle is a load error.
  include?: string[];
  overlay: RuleOverlay;
  ruleSources?: Record<string, string>;
}

// A reusable bundle of related rules (plus the stocks, prose, and visuals they
// need) that scenarios pull in via `include`. Structurally a scenario file
// without the player-count metadata: an overlay, optionally composed from its own
// `include`d rulesets. Lives in config/rulesets/*.json. A ruleset is a fragment,
// not a playable game on its own, so it is never activated directly.
export interface RulesetFile {
  name?: string;
  description?: string;
  include?: string[];
  overlay: RuleOverlay;
}

export interface ScenarioSummary {
  name: string;
  description?: string;
  recommendedPlayers?: RecommendedPlayers;
  active: boolean;
  counts: ReturnType<typeof overlayCounts>;
  // The resource names this scenario introduces — the keys of its worldStocks and
  // stockDefaults, deduped and sorted. Lets the dashboard show, per active scenario,
  // which stocks (warmth, morale, wood...) checking it brings into play.
  stocks: string[];
  // The goal(s) this scenario is played toward, one per rule that emits `victory`.
  victoryConditions: string[];
}

function assertValidRecommendedPlayers(
  name: string,
  value: unknown,
): asserts value is RecommendedPlayers | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      `scenario "${name}": recommendedPlayers must be an object.`,
    );
  let { min, max } = value as { min?: unknown; max?: unknown };
  if (typeof min !== "number" || !Number.isInteger(min) || min < 1)
    throw new Error(
      `scenario "${name}": recommendedPlayers.min must be a positive integer.`,
    );
  if (max !== undefined) {
    if (typeof max !== "number" || !Number.isInteger(max) || max < min)
      throw new Error(
        `scenario "${name}": recommendedPlayers.max must be an integer >= min.`,
      );
  }
}

export interface ScenarioStore {
  list(activeNames: Iterable<string>): ScenarioSummary[];
  load(name: string): ScenarioFile;
  save(name: string, overlay: RuleOverlay): ScenarioFile;
}

// The resources a scenario introduces: the union of its worldStocks and
// stockDefaults keys, deduped and sorted for a stable display order.
function scenarioStocks(overlay: RuleOverlay): string[] {
  let names = new Set([
    ...Object.keys(overlay.worldStocks ?? {}),
    ...Object.keys(overlay.stockDefaults ?? {}),
  ]);
  return [...names].sort();
}

// The human-readable goal(s) this scenario is played toward: the description of
// every rule that emits the reserved `victory` event. Read from the scenario's
// own overlay so the picker can show each scenario's win condition, active or not.
function scenarioVictoryConditions(overlay: RuleOverlay): string[] {
  return overlay.dynamicRules
    .filter(
      (rule) =>
        "emit" in rule &&
        rule.emit?.type === "victory" &&
        Boolean(rule.description?.trim()),
    )
    .map((rule) => rule.description!.trim());
}

let namePattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function normalizeScenarioName(input: unknown): string {
  if (typeof input !== "string") throw new Error("Scenario name must be text.");
  let name = input.trim().toLowerCase().replace(/\s+/g, "-");
  if (!namePattern.test(name))
    throw new Error(
      "Scenario name must be 1 to 40 characters: letters, digits, or hyphens.",
    );
  return name;
}

// The two load-time gates the live GM surface runs on every rule (assertValidRule
// for structure, validateRule for value bounds and phase semantics) plus the
// terrain checks, applied to one file's OWN overlay. Scenario and ruleset JSON
// never passes through tsc, so a malformed rule would otherwise surface only as a
// cryptic error mid-tick; catch it at load with the file (`label`) and rule id
// attached. Runs on each file's own overlay - a scenario and each ruleset it
// pulls in are validated once, at their own source, so errors point at the file
// that owns the mistake rather than the merged blur.
export function validateOwnOverlay(overlay: RuleOverlay, label: string): void {
  for (let rule of overlay.dynamicRules) {
    try {
      validateRule(rule);
      assertValidRule(rule);
    } catch (err) {
      throw new Error(
        `${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  for (let [terrain, spec] of Object.entries(overlay.terrainSpecs ?? {})) {
    try {
      assertValidTerrainSpec(terrain, spec);
    } catch (error) {
      throw new Error(
        `${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // Terrain placement gets the same load-time gate as rules: a malformed layer
  // stack or connect flag fails here with the file named, not as a blank map
  // after the world reset that activating the scenario triggers.
  try {
    if (overlay.terrainLayers !== undefined) {
      assertValidTerrainLayers(overlay.terrainLayers);
      if (overlay.blobs?.length)
        throw new Error(
          'declare either "terrainLayers" or "blobs", not both - the layer stack replaces the blob recipe.',
        );
    }
    if (overlay.connect !== undefined) assertValidConnect(overlay.connect);
  } catch (error) {
    throw new Error(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Where reusable rulesets live: a sibling `rulesets/` dir next to the scenarios
// dir (config/scenarios -> config/rulesets). `include` names resolve here.
export function rulesetsDirFor(scenariosDir: string): string {
  return path.join(path.dirname(scenariosDir), "rulesets");
}

// Load one ruleset by name and return its fully composed overlay (its own
// overlay with any rulesets IT includes merged in first). `stack` carries the
// include chain so a cycle (A includes B includes A) is a clear load error
// rather than a stack overflow. Each ruleset is validated at its own source.
interface ComposedOverlay {
  overlay: RuleOverlay;
  ruleSources: Record<string, string>;
}

function loadRulesetOverlay(
  name: string,
  rulesetsDir: string,
  stack: string[],
  seen: Set<string>,
): ComposedOverlay {
  let norm = normalizeScenarioName(name);
  if (stack.includes(norm))
    throw new Error(`ruleset include cycle: ${[...stack, norm].join(" -> ")}`);
  seen.add(norm);
  let file = path.join(rulesetsDir, `${norm}.json`);
  let parsed: RulesetFile;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as RulesetFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`unknown ruleset "${norm}" (looked in ${rulesetsDir})`);
    throw new Error(
      `ruleset "${norm}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let own = compactOverlay(parsed.overlay ?? emptyOverlay());
  validateOwnOverlay(own, `ruleset "${norm}"`);
  return composeIncludes(
    own,
    parsed.include,
    rulesetsDir,
    [...stack, norm],
    norm,
    seen,
  );
}

// Compose a file's own (already-validated) overlay on top of its `include`d
// rulesets. Includes merge in listed order, then the file's own overlay applies
// last - so a scenario (or a ruleset higher in the chain) overrides any included
// rule by redefining its id, or drops one with removedBaseIds. The included rule
// ids seed the merge baseline precisely so that removedBaseIds can reach them.
// `seen` guards diamond includes: a ruleset already merged anywhere in this
// composition is skipped on later references, so nothing it carries (rules,
// stocks, and especially additive `setup` entries) is ever merged twice.
function composeIncludes(
  own: RuleOverlay,
  include: string[] | undefined,
  rulesetsDir: string,
  stack: string[],
  source: string,
  seen: Set<string> = new Set(),
): ComposedOverlay {
  let ownSources = Object.fromEntries(
    own.dynamicRules.map((rule) => [rule.id, source]),
  );
  if (!include?.length) return { overlay: own, ruleSources: ownSources };
  let included = include
    .map((name) => normalizeScenarioName(name))
    .flatMap((norm) =>
      // A repeat that is NOT an ancestor is a diamond - skip it. A repeat that
      // IS an ancestor is a cycle - load anyway so the stack check reports it.
      seen.has(norm) && !stack.includes(norm)
        ? []
        : [loadRulesetOverlay(norm, rulesetsDir, stack, seen)],
    );
  let includedIds = included.flatMap(({ overlay }) =>
    overlay.dynamicRules.map((rule) => rule.id),
  );
  let overlay = mergeOverlays(includedIds, [
    ...included.map((item) => item.overlay),
    own,
  ]);
  let ruleSources: Record<string, string> = Object.assign(
    {},
    ...included.map((item) => item.ruleSources),
    ownSources,
  );
  let liveIds = new Set(overlay.dynamicRules.map((rule) => rule.id));
  return {
    overlay,
    ruleSources: Object.fromEntries(
      Object.entries(ruleSources).filter(([id]) => liveIds.has(id)),
    ),
  };
}

// Resolve a scenario (or ruleset) file's `include` list against a rulesets dir
// and return the composed overlay. The file's own overlay is validated here; the
// pulled-in rulesets validate themselves as they load. Exported so the offline
// validator resolves includes exactly as the live loader does.
export function resolveIncludes(
  file: { overlay?: RuleOverlay; include?: string[] },
  rulesetsDir: string,
): RuleOverlay {
  let own = compactOverlay(file.overlay ?? emptyOverlay());
  validateOwnOverlay(own, "scenario");
  return composeIncludes(own, file.include, rulesetsDir, [], "scenario")
    .overlay;
}

export function createScenarioStore(
  directory: string,
  rulesetsDir: string = rulesetsDirFor(directory),
): ScenarioStore {
  function filePath(name: string) {
    return path.join(directory, `${normalizeScenarioName(name)}.json`);
  }

  function readScenario(name: string): ScenarioFile {
    let raw = readFileSync(filePath(name), "utf8");
    let parsed = JSON.parse(raw) as ScenarioFile;
    let own = compactOverlay(parsed.overlay ?? emptyOverlay());
    validateOwnOverlay(own, `scenario "${name}"`);
    // Pull in any `include`d rulesets and merge them under this scenario's own
    // overlay (scenario wins on id clashes). The returned overlay is the fully
    // composed game - `include` has been resolved away and never rides it.
    let composed = composeIncludes(own, parsed.include, rulesetsDir, [], name);
    assertValidRecommendedPlayers(name, parsed.recommendedPlayers);
    return {
      name: normalizeScenarioName(parsed.name ?? name),
      description: parsed.description,
      recommendedPlayers: parsed.recommendedPlayers,
      overlay: composed.overlay,
      ruleSources: composed.ruleSources,
    };
  }

  return {
    list(activeNames) {
      mkdirSync(directory, { recursive: true });
      let active = new Set([...activeNames].map(normalizeScenarioName));
      return readdirSync(directory)
        .filter((fileName) => fileName.endsWith(".json"))
        .map((fileName) => readScenario(fileName.slice(0, -5)))
        .map((scenario) => ({
          name: scenario.name,
          description: scenario.description,
          recommendedPlayers: scenario.recommendedPlayers,
          active: active.has(scenario.name),
          counts: overlayCounts(scenario.overlay),
          stocks: scenarioStocks(scenario.overlay),
          victoryConditions: scenarioVictoryConditions(scenario.overlay),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    load(name) {
      return readScenario(name);
    },

    save(name, overlay) {
      mkdirSync(directory, { recursive: true });
      let scenario = {
        name: normalizeScenarioName(name),
        overlay: compactOverlay(overlay),
      };
      let payload = JSON.stringify(scenario, null, 2);
      let destination = filePath(scenario.name);
      let tmp = `${destination}.tmp`;
      writeFileSync(tmp, payload);
      renameSync(tmp, destination);
      return scenario;
    },
  };
}
