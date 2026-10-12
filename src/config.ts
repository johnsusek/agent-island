import { readFileSync } from "node:fs";
import path from "node:path";

import type { Scenario } from "@agent-island/engine/scenario";
import {
  graphicsFromWorldFile,
  scenarioFromWorldFile,
  type GraphicsConfig,
} from "@agent-island/mcp/world-file";

// The world file is selected directly: pass `--ruleset path/to/config.json`,
// set AGENT_ISLAND_RULESET, or fall back to the repo's bundled config. Parsing
// lives in world-file.ts; this module only finds and reads the file.
export function loadRuleset(filePath = selectedRulesetPath()): Scenario {
  let rulesetPath = path.resolve(filePath);
  return scenarioFromWorldFile(readJson(rulesetPath), rulesetPath);
}

export function loadGraphicsConfig(
  filePath = selectedRulesetPath(),
): GraphicsConfig {
  let rulesetPath = path.resolve(filePath);
  return graphicsFromWorldFile(readJson(rulesetPath), rulesetPath);
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
