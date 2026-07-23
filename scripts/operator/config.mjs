import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function defaultHome() {
  let configured = process.env.AGENT_ISLAND_HOME?.trim();
  if (configured) return path.resolve(expandHome(configured));
  return path.join(os.homedir(), ".agent-island");
}

export function parseOperatorArgs(argv) {
  let options = {
    url: process.env.AGENT_ISLAND_URL ?? "http://localhost:3000",
    home: defaultHome(),
    refreshMs: 1000,
    monochrome: false,
    selectedName: null,
    snapshot: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    let argument = argv[index];
    if (argument === "--url")
      options.url = requiredValue(argv, ++index, argument);
    else if (argument === "--home")
      options.home = path.resolve(
        expandHome(requiredValue(argv, ++index, argument)),
      );
    else if (argument === "--refresh")
      options.refreshMs = positiveNumber(
        requiredValue(argv, ++index, argument),
        argument,
      );
    else if (argument === "--agent")
      options.selectedName = requiredValue(argv, ++index, argument);
    else if (argument === "--monochrome" || argument === "--no-color")
      options.monochrome = true;
    else if (argument === "--snapshot") options.snapshot = true;
    else if (argument === "-h" || argument === "--help") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }

  options.url = options.url.replace(/\/$/, "");
  return options;
}

function requiredValue(argv, index, option) {
  let value = argv[index];
  if (value && !value.startsWith("--")) return value;
  throw new Error(`${option} requires a value.`);
}

function positiveNumber(value, option) {
  let parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 200) return parsed;
  throw new Error(`${option} must be a number of at least 200.`);
}

export function operatorPaths(options) {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  let scriptsDir = path.resolve(directory, "..");
  let repoRoot = path.resolve(scriptsDir, "..");
  let home = options.home;
  return {
    home,
    repoRoot,
    scriptsDir,
    crewScript: path.join(scriptsDir, "crew.mjs"),
    worldScript: path.join(scriptsDir, "world.mjs"),
    charactersDir: path.resolve(
      process.env.AGENT_ISLAND_CHARACTERS_DIR ?? path.join(home, "characters"),
    ),
    directorsDir: path.resolve(
      process.env.AGENT_ISLAND_DIRECTORS_DIR ?? path.join(home, "directors"),
    ),
    batchesDir: path.join(home, ".crew-characters"),
    directorBatchesDir: path.join(home, ".crew-directors"),
    runsDir: path.resolve(
      process.env.AGENT_ISLAND_RUNS_DIR ?? path.join(home, "runs"),
    ),
    stateFile: path.resolve(
      process.env.AGENT_ISLAND_STATE ?? path.join(home, "state.json"),
    ),
    operatorLogsDir: path.join(home, "operator", "logs"),
    characterPersonasDir: path.join(repoRoot, "agents", "characters"),
    directorPersonasDir: path.join(repoRoot, "agents", "directors"),
    scenariosDir: path.join(repoRoot, "config", "scenarios"),
  };
}

export function operatorHelp() {
  return `Agent Island operator console

USAGE
  npm run operator
  node scripts/operator.mjs [options]

OPTIONS
  --url <url>       Server URL (default http://localhost:3000)
  --home <path>     Runtime home (default ~/.agent-island)
  --agent <name>    Select an agent on startup
  --refresh <ms>    Runtime refresh interval (default 1000)
  --monochrome      Disable color
  --snapshot        Print one plain-text status snapshot and exit
  -h, --help        Show this help

KEYS
  ↑/↓ or j/k        Select agent        PgUp/PgDn  Scroll transcript
  l                 Launch agents      x / X       Stop selected / all
  f                 Cycle roster       /           Search roster and logs
  Space             Follow log tail    v           Raw/rendered transcript
  w                 World operations   r           Refresh now
  ?                 Help
  q                 Quit console (crews keep running)`;
}
