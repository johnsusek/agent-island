import { readFileSync } from "node:fs";
import path from "node:path";

import type { Scenario, WorldFile } from "./scenario.js";
import { pickSpawn } from "@agent-island/core/space";

// Presentation config only: sprites live inline in the scenario's visuals (the
// sprite DSL), so graphics carries no asset-pack URLs - just the default zoom.
export interface GraphicsConfig {
  scale: number;
}

// The world file is selected directly: pass `--ruleset path/to/config.json`,
// set AGENT_ISLAND_RULESET, or fall back to the repo's bundled config. The file
// is a flat WorldGen (width/height/seed) - just the shared canvas; terrain, its
// placement, rules, and all authoring arrive later as scenario overlays.
export function loadRuleset(filePath = selectedRulesetPath()): Scenario {
  let rulesetPath = path.resolve(filePath);
  let raw = readJson(rulesetPath) as Record<string, unknown>;
  // Rules live in scenarios (config/scenarios/), never in the world file -
  // reject them here so a stray "rules" key fails loudly at boot instead of
  // silently authoring a second, un-toggleable rule source. A nested
  // "worldgen" object is the pre-flattening shape; reject it too so an old
  // file fails with a pointer instead of quietly generating a bare 21x21 grid.
  if ("rules" in raw)
    throw new Error(
      `${rulesetPath} must not contain "rules" - author them as a scenario in config/scenarios/ instead.`,
    );
  if ("worldgen" in raw)
    throw new Error(
      `${rulesetPath} has a nested "worldgen" object - the world file is flat now, put its keys at the root.`,
    );
  // The world file is just the canvas now; a "name" is optional and only used
  // as the bare-world identity when no scenario is active - bootScenario restamps
  // it from the active scenario otherwise. Defaults to "world" when the file omits it.
  let {
    name,
    graphics: _graphics,
    ...worldgen
  } = raw as unknown as {
    name?: unknown;
    graphics?: unknown;
  } & WorldFile;
  // Both this name and this spawn are provisional: the coordinator restamps the
  // name from the active scenario and rerolls spawn once the scenario's terrain specs and
  // placement are merged in (see bootScenario).
  let scenario: Scenario = {
    name: typeof name === "string" && name ? name : "world",
    rules: [],
    worldgen,
    spawn: pickSpawn(worldgen),
  };
  return scenario;
}

export function loadGraphicsConfig(
  filePath = selectedRulesetPath(),
): GraphicsConfig {
  let rulesetPath = path.resolve(filePath);
  let raw = readJson(rulesetPath) as Record<string, unknown>;
  let value = raw.graphics;
  if (value === undefined) return { scale: 3 };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${rulesetPath} graphics must be an object.`);

  let graphics = value as Record<string, unknown>;
  for (let key of Object.keys(graphics))
    if (key !== "scale")
      throw new Error(`${rulesetPath} graphics has unknown key "${key}".`);

  let scale = graphics.scale;
  if (typeof scale !== "number" || !Number.isInteger(scale) || scale < 1)
    throw new Error(
      `${rulesetPath} graphics.scale must be a positive integer.`,
    );

  return { scale };
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load ${filePath}: ${message}`);
  }
}

function selectedRulesetPath(): string {
  let fromArg = rulesetArg(process.argv.slice(2));
  return fromArg ?? process.env.AGENT_ISLAND_RULESET ?? "config/config.json";
}

function rulesetArg(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    let arg = args[index];
    if (arg === "--ruleset") return args[index + 1];
    if (arg.startsWith("--ruleset=")) return arg.slice("--ruleset=".length);
  }
  return undefined;
}

export const scenario = loadRuleset();
export let graphics = loadGraphicsConfig();
