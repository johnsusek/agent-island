import {
  existsSync,
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
import { validateRule } from "@agent-island/core/kernel";
import { assertValidRule } from "@agent-island/core/rule-schema";
import { assertValidTerrainSpec } from "./rules/scenario.js";
import {
  assertValidConnect,
  assertValidTerrainLayers,
} from "@agent-island/core/space";

// Advisory player-count guidance shown in the scenario picker - not enforced by
// the engine, which will happily boot any number of agents into any scenario.
export interface RecommendedPlayers {
  min: number;
  max?: number; // omit for "no practical upper bound"
}

export interface ScenarioFile {
  name: string;
  description?: string;
  // One or two character-facing sentences in the fiction's own register,
  // delivered in-band to a fresh character at join (never to a reclaim, which
  // already has its history). `description` stays operator-facing prose.
  intro?: string;
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
  for (let [key, value] of [
    ["worldWidth", overlay.worldWidth],
    ["worldHeight", overlay.worldHeight],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
      throw new Error(`${label}: ${key} must be a positive integer.`);
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

// A scenario store reads from up to two directories and writes to one. The read
// source is the repo's bundled starters (`directory`); `saveDir` is where the GM
// save_scenario tool writes, kept out of the repo. Both are read on load/list,
// with saveDir winning on a name clash so a saved scenario shadows a bundled one.
// When saveDir === directory (the default, and every test) it collapses back to
// single-dir behavior. Rulesets always resolve against `directory`'s sibling
// config/rulesets - a saved scenario is stored pre-composed with no `include`.
export function createScenarioStore(
  directory: string,
  saveDir: string = directory,
  rulesetsDir: string = rulesetsDirFor(directory),
): ScenarioStore {
  // saveDir first so a home-saved scenario shadows a bundled one of the same name.
  let readDirs = saveDir === directory ? [directory] : [saveDir, directory];

  // Resolve a name to the file that should back it. Falls through to the repo
  // path when nothing exists, so a genuine miss reports ENOENT against the
  // canonical location rather than the home overlay.
  function resolveReadPath(name: string): string {
    let fileName = `${normalizeScenarioName(name)}.json`;
    for (let dir of readDirs) {
      let candidate = path.join(dir, fileName);
      if (existsSync(candidate)) return candidate;
    }
    return path.join(directory, fileName);
  }

  function readScenarioAt(file: string, name: string): ScenarioFile {
    let raw = readFileSync(file, "utf8");
    let parsed = JSON.parse(raw) as ScenarioFile;
    let own = compactOverlay(parsed.overlay ?? emptyOverlay());
    validateOwnOverlay(own, `scenario "${name}"`);
    // Pull in any `include`d rulesets and merge them under this scenario's own
    // overlay (scenario wins on id clashes). The returned overlay is the fully
    // composed game - `include` has been resolved away and never rides it.
    let composed = composeIncludes(own, parsed.include, rulesetsDir, [], name);
    assertValidRecommendedPlayers(name, parsed.recommendedPlayers);
    if (parsed.intro !== undefined && typeof parsed.intro !== "string")
      throw new Error(`scenario "${name}": intro must be a string.`);
    return {
      name: normalizeScenarioName(parsed.name ?? name),
      description: parsed.description,
      intro: parsed.intro,
      recommendedPlayers: parsed.recommendedPlayers,
      overlay: composed.overlay,
      ruleSources: composed.ruleSources,
    };
  }

  function readScenario(name: string): ScenarioFile {
    return readScenarioAt(resolveReadPath(name), name);
  }

  return {
    list(activeNames) {
      let active = new Set([...activeNames].map(normalizeScenarioName));
      // Merge both dirs into one map keyed by scenario name. Iterate repo first,
      // saveDir last, so a home-saved scenario overrides a bundled one of the
      // same name in the picker - matching resolveReadPath's precedence.
      let byName = new Map<string, ScenarioFile>();
      let mergeOrder =
        saveDir === directory ? [directory] : [directory, saveDir];
      for (let dir of mergeOrder) {
        let entries: string[];
        try {
          mkdirSync(dir, { recursive: true });
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (let fileName of entries) {
          if (!fileName.endsWith(".json")) continue;
          // A pregenerated map (<name>.map.json, see scripts/generate-map.ts) is a
          // plain sibling of its scenario file, not a scenario in its own right -
          // skip it here the same way loadPregeneratedMap reads it directly rather
          // than through the store.
          if (fileName.endsWith(".map.json")) continue;
          let scenario = readScenarioAt(
            path.join(dir, fileName),
            fileName.slice(0, -5),
          );
          byName.set(scenario.name, scenario);
        }
      }
      return [...byName.values()]
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
      mkdirSync(saveDir, { recursive: true });
      let scenario = {
        name: normalizeScenarioName(name),
        overlay: compactOverlay(overlay),
      };
      let payload = JSON.stringify(scenario, null, 2);
      let destination = path.join(saveDir, `${scenario.name}.json`);
      let tmp = `${destination}.tmp`;
      writeFileSync(tmp, payload);
      renameSync(tmp, destination);
      return scenario;
    },
  };
}
