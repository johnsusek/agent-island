import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import express from "express";

import { createColony, type Colony } from "./coordinator.js";
import { createMcpHandler } from "./mcp-handler.js";
import { createScenarioStore } from "./scenarios.js";
import { graphicsFromWorldFile, scenarioFromWorldFile } from "./world-file.js";

// Everything `serve` needs to run a world from files: a world file (the
// canvas), a folder of scenarios, and where to listen. With no data
// directory the world lives in memory and is gone when the process exits.
export interface ServeOptions {
  world: string;
  scenariosDir?: string;
  // The scenario to run. Omitted, a folder holding exactly one scenario runs
  // that one; otherwise the bare world runs until a GM activates one.
  scenario?: string;
  dataDir?: string;
  port?: number;
  host?: string;
  name?: string;
  briefing?: string;
  gmBriefing?: string;
  // Advance the world on a wall clock, one tick every N ms. Omitted, the
  // world advances in lockstep once every connected character has acted.
  tickMs?: number;
}

export const SERVE_USAGE = `Usage: serve --world <file> [options]

  --world <file>         World file: {"width", "height", "seed"} (required)
  --scenarios <dir>      Folder of scenario JSON files
  --scenario <name>      Scenario to run (default: the only one in the folder)
  --data <dir>           Persist the world here (default: in memory)
  --port <n>             Port to listen on (default: 3000)
  --host <addr>          Address to bind (default: 127.0.0.1)
  --name <name>          MCP server name reported to clients
  --briefing <file>      Replace the character briefing
  --gm-briefing <file>   Replace the GM briefing
  --tick-ms <n>          Advance on a wall clock instead of in lockstep

Characters connect to /mcp, game masters to /gm, and GET /api/state
returns the world as JSON.`;

export function parseServeArgs(argv: string[]): ServeOptions {
  let values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    let arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}".`);
    let [flag, inline] = arg.slice(2).split("=", 2);
    let value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`--${flag} needs a value.`);
    values.set(flag, value);
  }
  let known = [
    "world",
    "scenarios",
    "scenario",
    "data",
    "port",
    "host",
    "name",
    "briefing",
    "gm-briefing",
    "tick-ms",
  ];
  for (let flag of values.keys())
    if (!known.includes(flag)) throw new Error(`Unknown option --${flag}.`);
  let world = values.get("world");
  if (!world) throw new Error("--world is required.");
  return {
    world,
    scenariosDir: values.get("scenarios"),
    scenario: values.get("scenario"),
    dataDir: values.get("data"),
    port: optionalInteger(values, "port"),
    host: values.get("host"),
    name: values.get("name"),
    briefing: values.get("briefing"),
    gmBriefing: values.get("gm-briefing"),
    tickMs: optionalInteger(values, "tick-ms"),
  };
}

function optionalInteger(
  values: Map<string, string>,
  flag: string,
): number | undefined {
  let raw = values.get(flag);
  if (raw === undefined) return undefined;
  let value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`--${flag} must be a whole number.`);
  return value;
}

// The colony and the HTTP app that serves it, not yet listening.
export function createServeApp(options: ServeOptions): {
  app: express.Express;
  colony: Colony;
  close(): Promise<void>;
} {
  let worldPath = resolve(options.world);
  let worldFile = JSON.parse(readFileSync(worldPath, "utf8"));
  let scenariosDir = options.scenariosDir
    ? resolve(options.scenariosDir)
    : undefined;
  let scenario = options.scenario ?? onlyScenarioIn(scenariosDir);
  let data = options.dataDir ? resolve(options.dataDir) : undefined;

  let colony = createColony({
    baseScenario: scenarioFromWorldFile(worldFile, worldPath),
    graphics: graphicsFromWorldFile(worldFile, worldPath),
    scenariosDir,
    scenarios: scenario ? [scenario] : [],
    briefings: {
      character: options.briefing && readFileSync(options.briefing, "utf8"),
      gm: options.gmBriefing && readFileSync(options.gmBriefing, "utf8"),
    },
    realTimeMs: options.tickMs,
    ...(data
      ? {
          statePath: join(data, "state.json"),
          rulesPath: join(data, "rules.json"),
          journalDir: join(data, "journal"),
          runsDir: join(data, "runs"),
          scenariosSaveDir: join(data, "scenarios"),
          activeScenariosPath: join(data, "active-scenarios.json"),
        }
      : {}),
  });
  let handler = createMcpHandler(colony, { serverName: options.name });

  let app = express();
  app.use(express.json());
  app.get("/api/state", (_request, response) =>
    response.json(colony.getAdminPayload()),
  );
  app.post("/mcp", handler.character.post);
  app.get("/mcp", handler.character.get);
  app.delete("/mcp", handler.character.delete);
  app.post("/gm", handler.gm.post);
  app.get("/gm", handler.gm.get);
  app.delete("/gm", handler.gm.delete);

  colony.start();
  return {
    app,
    colony,
    close: async () => {
      colony.stop();
      await handler.close();
    },
  };
}

// The scenario a folder runs by default: its only one, if it has exactly one.
function onlyScenarioIn(scenariosDir: string | undefined): string | undefined {
  if (!scenariosDir) return undefined;
  let names = createScenarioStore(scenariosDir, scenariosDir)
    .list([])
    .map((summary) => summary.name);
  return names.length === 1 ? names[0] : undefined;
}

// Start serving and resolve once listening. close() stops the world and the
// HTTP server.
export async function serve(options: ServeOptions) {
  let parts = createServeApp(options);
  let host = options.host ?? "127.0.0.1";
  let httpServer = await new Promise<ReturnType<typeof parts.app.listen>>(
    (resolveListen, reject) => {
      let listener = parts.app.listen(options.port ?? 3000, host);
      listener.once("listening", () => resolveListen(listener));
      listener.once("error", reject);
    },
  );
  let address = httpServer.address();
  let port = address && typeof address === "object" ? address.port : 0;
  return {
    ...parts,
    url: `http://${host}:${port}`,
    close: async () => {
      await parts.close();
      await new Promise<void>((resolveClose, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}
