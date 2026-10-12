import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createColony,
  parseWorldDimensions,
  type Colony,
} from "@agent-island/mcp/coordinator";
import { graphics, scenario } from "./config.js";
import { createMcpHandler } from "@agent-island/mcp/mcp-handler";
import { homePath } from "./paths.js";

let host = process.env.AGENT_ISLAND_HOST ?? "127.0.0.1";
let port = process.env.AGENT_ISLAND_PORT
  ? Number(process.env.AGENT_ISLAND_PORT)
  : 3000;
let minTurnMs = process.env.AGENT_ISLAND_MIN_TURN_MS
  ? Number(process.env.AGENT_ISLAND_MIN_TURN_MS)
  : 10;
// The real-time clock, on by default at 2s/tick (0 = the lockstep barrier).
// When > 0, the world advances one tick every this many ms regardless of who
// has parked, so time keeps moving while agents think. Set the env var to 0 to
// ship the lockstep barrier instead; also adjustable through the admin API.
let realTimeMs = process.env.AGENT_ISLAND_REAL_TIME_MS
  ? Number(process.env.AGENT_ISLAND_REAL_TIME_MS)
  : 2000;
let waitTimeoutMs = process.env.AGENT_ISLAND_WAIT_TIMEOUT_MS
  ? Number(process.env.AGENT_ISLAND_WAIT_TIMEOUT_MS)
  : undefined;
let sessionTtlMs = process.env.AGENT_ISLAND_SESSION_TTL_MS
  ? Number(process.env.AGENT_ISLAND_SESSION_TTL_MS)
  : undefined;
let idleMs = process.env.AGENT_ISLAND_IDLE_MS
  ? Number(process.env.AGENT_ISLAND_IDLE_MS)
  : undefined;
// Source lives in src/; the built observatory sits at the repo root one level up.
let directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ServerOptions {
  coordinator?: Colony;
  host?: string;
  port?: number;
}

export function configuredScenarios(value: string | undefined): string[] {
  if (value === undefined) return ["genesis"];
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

// The crew script owns these workdirs (it launches the CLIs and seeds their
// memory.md); the server only reads them at archive time and clears them on
// reset. Keeping the paths here, not in the crew, means a reset still wipes
// stale beliefs even when no crew is running.
export function characterDirs() {
  return {
    charactersDir: path.resolve(
      process.env.AGENT_ISLAND_CHARACTERS_DIR ?? homePath("characters"),
    ),
    directorsDir: path.resolve(
      process.env.AGENT_ISLAND_DIRECTORS_DIR ?? homePath("directors"),
    ),
  };
}

// Copy every mind's memory.md into <runDir>/memory/ before reset wipes them:
// characters/<name>.md and directors/<name>.md from the two workspace roots.
// These files are the run's design history and beliefs - exactly what a retro
// wants and exactly what the wipe deletes. Best-effort per file; a hiccup must
// never block the archive or the reset.
export function collectMemoryArtifacts(runDir: string) {
  let { charactersDir, directorsDir } = characterDirs();
  let memoryRoot = path.join(runDir, "memory");
  for (let [label, root] of [
    ["characters", charactersDir],
    ["directors", directorsDir],
  ] as const) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      let memoryFile = path.join(root, entry.name, "memory.md");
      try {
        if (!fs.existsSync(memoryFile)) continue;
        fs.mkdirSync(path.join(memoryRoot, label), { recursive: true });
        fs.copyFileSync(
          memoryFile,
          path.join(memoryRoot, label, `${entry.name}.md`),
        );
      } catch {
        // skip this mind, keep banking the rest
      }
    }
  }
}

// The restore-time mirror of collectMemoryArtifacts: copy a run archive's
// banked memory.md files back onto the live character/director workdirs
// before the restored world boots, so a relaunched seat picks up the memory
// it had when that run was archived instead of starting blank. Creates the
// seat's workdir if a relaunch hasn't recreated it yet. Best-effort per file,
// same as the collector this reverses.
export function restoreMemoryArtifacts(runDir: string) {
  let { charactersDir, directorsDir } = characterDirs();
  let memoryRoot = path.join(runDir, "memory");
  for (let [label, root] of [
    ["characters", charactersDir],
    ["directors", directorsDir],
  ] as const) {
    let labelDir = path.join(memoryRoot, label);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(labelDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      let name = entry.name.slice(0, -".md".length);
      try {
        let seatDir = path.join(root, name);
        fs.mkdirSync(seatDir, { recursive: true });
        fs.copyFileSync(
          path.join(labelDir, entry.name),
          path.join(seatDir, "memory.md"),
        );
      } catch {
        // skip this mind, keep restoring the rest
      }
    }
  }
}

// Delete every character's and director's memory.md so a relaunch starts fresh
// in the new world instead of acting on the wiped world's beliefs. Logs are
// kept - they are the run's evidence trail and the archive already banked the
// memory files.
export function wipeCharacterMemories() {
  let { charactersDir, directorsDir } = characterDirs();
  for (let root of [charactersDir, directorsDir]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      try {
        fs.rmSync(path.join(root, entry.name, "memory.md"), { force: true });
      } catch {
        // best-effort
      }
    }
  }
}

export function createAgentIslandServer(options: ServerOptions = {}) {
  let coordinator =
    options.coordinator ??
    createColony({
      // The world file's canvas (see config.ts for how it is selected) and
      // its presentation config.
      baseScenario: scenario,
      graphics,
      // Runtime state lives under AGENT_ISLAND_HOME (default ~/.agent-island),
      // never in the repo, so a clean checkout carries no world. Each slot below
      // keeps its own AGENT_ISLAND_* override for one-off relocation.
      statePath: process.env.AGENT_ISLAND_STATE ?? homePath("state.json"),
      // GM rule edits persist to their own file so they can be reused across
      // world resets, separate from the disposable world snapshot.
      rulesPath: process.env.AGENT_ISLAND_RULES ?? homePath("rules.json"),
      // The bundled starter scenarios (blank/genesis) are tracked repo
      // content, so they are READ from config/scenarios; GM-saved scenarios are
      // runtime data and land in scenariosSaveDir below, out of the repo.
      scenariosDir:
        process.env.AGENT_ISLAND_SCENARIOS_DIR ??
        path.resolve("config/scenarios"),
      scenariosSaveDir:
        process.env.AGENT_ISLAND_SCENARIOS_SAVE_DIR ?? homePath("scenarios"),
      activeScenariosPath:
        process.env.AGENT_ISLAND_ACTIVE_SCENARIOS ??
        homePath("active-scenarios.json"),
      // Durable event history for cursor/range diffs, apart from state.json's
      // bounded in-memory ring.
      journalDir: process.env.AGENT_ISLAND_JOURNAL_DIR ?? homePath("journal"),
      // A reset banks the outgoing world's files here instead of only
      // deleting them.
      runsDir: process.env.AGENT_ISLAND_RUNS_DIR ?? homePath("runs"),
      wipeCharacterMemory: () => wipeCharacterMemories(),
      // Bank every mind's memory.md (characters and directors) into the run
      // archive before the wipe above deletes them - the retro reads these.
      // Copies only; the wipe owns deletion.
      collectRunArtifacts: (runDir) => collectMemoryArtifacts(runDir),
      // The restore half: bring a banked run's memory files back before the
      // restored world boots.
      restoreRunArtifacts: (runDir) => restoreMemoryArtifacts(runDir),
      scenarios: configuredScenarios(process.env.AGENT_ISLAND_SCENARIOS),
      minTurnMs,
      realTimeMs,
      waitTimeoutMs,
      sessionTtlMs,
      idleMs,
    });
  let app = express();
  let mcpHandler = createMcpHandler(coordinator);

  app.use(express.json());
  app.use(express.static(path.join(directory, "dist", "web")));

  app.get("/api/state", (_request, response) =>
    response.json(coordinator.getAdminPayload()),
  );

  app.get("/api/map", (_request, response) =>
    response.json(coordinator.getMapPayload()),
  );

  app.get("/api/fog", (_request, response) =>
    response.json(coordinator.getFogPayload()),
  );

  app.post("/api/reset", async (request, response) => {
    let dimensions;
    try {
      dimensions = parseWorldDimensions(request.body);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
      return;
    }
    try {
      let payload = await coordinator.reset(dimensions);
      response.json(payload);
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  // Force a live agent's controller loose right now, bypassing the idle
  // grace window. For an operator (crew.mjs, say) that just killed a
  // character's process by signal - the process never sends the MCP
  // session's own disconnect, so without this the seat reads as "connected"
  // until the idle sweep catches up, which is long enough that an immediate
  // relaunch sees the body as taken and spawns a fresh one instead of
  // reclaiming it. Body: { name: string }.
  app.post("/api/release-agent", (request, response) => {
    let name = request.body?.name;
    if (typeof name !== "string" || !name.trim()) {
      response.status(400).json({ error: "name is required." });
      return;
    }
    response.json({ released: coordinator.releaseAgent(name) });
  });

  app.get("/api/runs", (_request, response) => {
    response.json(coordinator.listRuns());
  });

  app.post("/api/restore", async (request, response) => {
    let runId = request.body?.runId;
    if (typeof runId !== "string" || !runId.trim()) {
      response.status(400).json({ error: "runId is required." });
      return;
    }
    try {
      let payload = await coordinator.restoreRun(runId);
      response.json(payload);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  // Toggle the real-time clock at runtime. Body: { realTimeMs: number } - 0
  // restores the lockstep barrier, while a positive value runs time on that ms
  // cadence. Returns the fresh admin payload.
  app.post("/api/clock", (request, response) => {
    let ms = (request.body ?? {}).realTimeMs;
    if (ms !== undefined && (typeof ms !== "number" || !Number.isFinite(ms))) {
      response.status(400).json({ error: "realTimeMs must be a number." });
      return;
    }
    try {
      response.json(coordinator.setRealTime(ms ?? 0));
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  // Pause or resume the world's ticking (the HUD pause button). Body:
  // { paused: boolean } - true freezes every clock driver in place, false lets
  // time run again. Returns the fresh admin payload so the UI reflects the new
  // state.
  app.post("/api/pause", (request, response) => {
    let paused = (request.body ?? {}).paused;
    if (typeof paused !== "boolean") {
      response.status(400).json({ error: "paused must be a boolean." });
      return;
    }
    try {
      response.json(coordinator.setPaused(paused));
    } catch (error) {
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/scenarios", (_request, response) =>
    response.json(coordinator.listScenarios()),
  );

  app.post("/api/scenarios/:name/active", async (request, response) => {
    try {
      let result = await coordinator.setScenarioActive(
        request.params.name,
        Boolean(request.body?.active),
      );
      response.json(result);
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/scenarios", (request, response) => {
    try {
      response.json(
        coordinator.saveScenario(request.body?.name, request.body?.ids),
      );
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/rules/clear-gm", (_request, response) => {
    try {
      response.json(coordinator.clearGmRules());
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
    }
  });

  // Characters connect to /mcp (lean tool surface); GM clients (the operator
  // console and the resident Clerk) connect to /gm, which hands the full GM
  // surface at connect so no client needs to react to a tools/list_changed
  // refresh.
  app.post("/mcp", mcpHandler.character.post);
  app.get("/mcp", mcpHandler.character.get);
  app.delete("/mcp", mcpHandler.character.delete);

  app.post("/gm", mcpHandler.gm.post);
  app.get("/gm", mcpHandler.gm.get);
  app.delete("/gm", mcpHandler.gm.delete);

  coordinator.start();

  return {
    app,
    coordinator,
    closeMcp: mcpHandler.close,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function startAgentIslandServer(options: ServerOptions = {}) {
  let serverParts = createAgentIslandServer(options);
  let listenPort = options.port ?? port;
  let listenHost = options.host ?? host;
  let httpServer = await new Promise<ReturnType<typeof serverParts.app.listen>>(
    (resolve, reject) => {
      let listener = serverParts.app.listen(listenPort, listenHost);
      listener.once("listening", () => resolve(listener));
      listener.once("error", reject);
    },
  );

  return {
    ...serverParts,
    httpServer,
    close: async () => {
      serverParts.coordinator.stop();
      await serverParts.closeMcp();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    let server = await startAgentIslandServer();
    let shutdown: Promise<void> | null = null;
    let stop = (signal: NodeJS.Signals) => {
      if (shutdown) return;
      shutdown = server.close().then(
        () => process.exit(0),
        (error) => {
          console.error(`Failed to stop after ${signal}:`, error);
          process.exit(1);
        },
      );
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
    let address = server.httpServer.address();
    let resolvedPort =
      address && typeof address === "object" ? address.port : port;
    console.log(`http://${host}:${resolvedPort}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use — the Agent Island server is probably already running. Open http://${host}:${port}, or stop the other process first.`,
      );
      process.exit(1);
    }
    throw error;
  }
}
