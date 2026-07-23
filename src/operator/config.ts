import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OperatorOptions, OperatorPaths } from "./types.js";

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export function defaultHome(): string {
  return expandHome(
    process.env.AGENT_ISLAND_HOME ?? path.join("~", ".agent-island"),
  );
}

export function parseOperatorArgs(arguments_: string[]): OperatorOptions {
  let options: OperatorOptions = {
    help: false,
    home: defaultHome(),
    monochrome: false,
    refreshMs: 1000,
    selectedName: null,
    snapshot: false,
    url: process.env.AGENT_ISLAND_URL ?? "http://127.0.0.1:3000",
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    let argument = arguments_[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--snapshot") options.snapshot = true;
    else if (argument === "--monochrome") options.monochrome = true;
    else if (argument === "--url")
      options.url = requiredValue(arguments_, ++index, argument);
    else if (argument === "--home")
      options.home = expandHome(requiredValue(arguments_, ++index, argument));
    else if (argument === "--refresh")
      options.refreshMs = positiveNumber(
        requiredValue(arguments_, ++index, argument),
        argument,
      );
    else if (argument === "--agent")
      options.selectedName = requiredValue(arguments_, ++index, argument);
    else throw new Error(`Unknown option: ${argument}`);
  }

  options.url = options.url.replace(/\/+$/, "");
  return options;
}

export function operatorPaths(options: OperatorOptions): OperatorPaths {
  let moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  let repoRoot = path.resolve(moduleDirectory, "../..");
  return {
    batchesDir: path.join(options.home, ".crew"),
    characterPersonasDir: path.join(repoRoot, "agents", "characters"),
    charactersDir: path.join(options.home, "characters"),
    crewScript: path.join(repoRoot, "scripts", "crew.mjs"),
    directorBatchesDir: path.join(options.home, ".crew-directors"),
    directorPersonasDir: path.join(repoRoot, "agents", "directors"),
    directorsDir: path.join(options.home, "directors"),
    operatorLogsDir: path.join(options.home, "operator-logs"),
    repoRoot,
    runsDir: path.join(options.home, "runs"),
    scenariosDir: path.join(repoRoot, "config", "scenarios"),
    stateFile: path.join(options.home, "state.json"),
  };
}

export function operatorHelp(): string {
  return `Usage: npm run operator -- [options]

Options:
  --snapshot          Print status and exit
  --url URL           Server URL
  --home PATH         Agent Island data directory
  --refresh MS        Refresh interval
  --agent NAME        Initially selected agent
  --monochrome        Disable color
  -h, --help          Show help

Keys:
  ↑/↓                 Select agent       Tab          Move focus
  l                   Launch             x / X        Stop selected / all
  /                   Find               m            Activity / memory
  w                   World operations   r            Refresh
  ?                   Help               q            Quit`;
}

function requiredValue(
  arguments_: string[],
  index: number,
  option: string,
): string {
  let value = arguments_[index];
  if (value) return value;
  throw new Error(`${option} requires a value.`);
}

function positiveNumber(value: string, option: string): number {
  let parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  throw new Error(`${option} must be a positive number.`);
}
