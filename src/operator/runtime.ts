import fs from "node:fs";
import path from "node:path";

import { addUsage, createLogStore, zeroUsage } from "./logs.js";
import type {
  LogView,
  OperatorOptions,
  OperatorPaths,
  OperatorRuntime,
  OperatorSnapshot,
  RunSummary,
  ScenarioSummary,
  Seat,
} from "./types.js";

type DataRecord = Record<string, any>;
type LogStore = ReturnType<typeof createLogStore>;

interface RemoteData {
  error: string | null;
  runs: RunSummary[] | null;
  scenarios: ScenarioSummary | null;
  state: DataRecord | null;
}

interface StoredState {
  payload: DataRecord;
  scenario: string;
  tick: number;
  worldId: string;
}

interface BatchRecord extends DataRecord {
  alive: boolean;
  names: string[];
  pid: number;
}

export function createRuntime(
  options: OperatorOptions,
  paths: OperatorPaths,
): OperatorRuntime {
  let logStore = createLogStore();

  async function refresh(): Promise<OperatorSnapshot> {
    let remote = await readRemote(options.url);
    let stored = remote.state ? null : readStoredState(paths.stateFile);
    let payload = remote.state ?? stored?.payload ?? emptyPayload();
    let runs = remote.runs ?? readRuns(paths.runsDir);
    let scenarios =
      remote.scenarios ?? readScenarios(paths.scenariosDir, stored?.scenario);
    let runStartedAt = inferRunStart(runs, paths.stateFile);
    let characterBatches = readBatches(paths.batchesDir);
    let directorBatches = readBatches(paths.directorBatchesDir);
    let liveAgents = normalizeLiveAgents(payload);
    let seats = buildSeats(
      paths,
      liveAgents,
      characterBatches,
      directorBatches,
      payload,
      logStore,
      runStartedAt,
    );
    let runUsage = zeroUsage();
    for (let seat of seats) addUsage(runUsage, seat.usage.run);

    let characters = seats.filter((seat) => seat.role === "character");
    let alive = characters.filter((seat) => seat.alive === true).length;
    let dead = characters.filter((seat) => seat.alive === false).length;
    let active = characters.filter((seat) => seat.controllerConnected).length;
    let openAttempts = (payload.speculative ?? []).filter(
      (attempt: DataRecord) => !attempt.redeemed,
    ).length;
    let elapsedMs = Math.max(0, Date.now() - runStartedAt);
    let tokenTotal = runUsage.inputTokens + runUsage.outputTokens;

    return {
      refreshedAt: Date.now(),
      online: Boolean(remote.state),
      error: remote.error,
      seats,
      runs,
      scenarios,
      world: {
        worldId: payload.worldId ?? stored?.worldId ?? "unknown",
        scenario: scenarios.active?.[0] ?? stored?.scenario ?? "none",
        tick: payload.state?.tick ?? stored?.tick ?? 0,
        running: Boolean(payload.liveness?.running),
        paused: Boolean(payload.liveness?.paused),
        ended: Boolean(payload.liveness?.ended),
        realTimeMs: number(payload.liveness?.realTimeMs),
        lastTickAt: payload.liveness?.lastTickAt ?? null,
        lastTickError: payload.liveness?.lastTickError ?? null,
        gmConnected: Boolean(payload.liveness?.gmConnected),
        activeCount: active,
        parkedCount: number(payload.liveness?.parkedCount),
        alive,
        idle: Math.max(0, alive - active),
        dead,
        openAttempts,
        attemptCount: (payload.speculative ?? []).length,
        nounAttempts: (payload.speculativeNouns ?? []).length,
        mintedRules: payload.ruleMeta?.customIds?.length ?? 0,
        unsavedRules: payload.ruleMeta?.dirtyIds?.length ?? 0,
        ruleCount: payload.rules?.length ?? 0,
        runStartedAt,
        elapsedMs,
        usage: runUsage,
        tokensPerMinute: elapsedMs > 0 ? tokenTotal / (elapsedMs / 60_000) : 0,
      },
      raw: payload as Record<string, unknown>,
    };
  }

  function logView(seatDir: string): LogView | null {
    return logStore.inspectView(seatDir);
  }

  return { refresh, logView };
}

async function readRemote(url: string): Promise<RemoteData> {
  let result: RemoteData = {
    error: null,
    runs: null,
    scenarios: null,
    state: null,
  };
  let requests = await Promise.allSettled([
    fetchJson(`${url}/api/state`),
    fetchJson(`${url}/api/scenarios`),
    fetchJson(`${url}/api/runs`),
  ]);
  if (requests[0].status === "fulfilled") result.state = requests[0].value;
  else result.error = errorMessage(requests[0].reason);
  if (requests[1].status === "fulfilled")
    result.scenarios = requests[1].value as ScenarioSummary;
  if (requests[2].status === "fulfilled")
    result.runs = requests[2].value as unknown as RunSummary[];
  return result;
}

async function fetchJson(url: string): Promise<DataRecord> {
  let response = await fetch(url, { signal: AbortSignal.timeout(900) });
  let text = await response.text();
  let payload: DataRecord;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (response.ok) return payload;
  throw new Error(payload.error ?? `${response.status} ${response.statusText}`);
}

function readStoredState(file: string): StoredState | null {
  let stored = readJson(file);
  if (!stored?.engine?.world) return null;
  let entities = stored.engine.world.entities ?? {};
  let agents: DataRecord = {};
  for (let [id, entity] of Object.entries(entities) as [string, DataRecord][]) {
    if (!entity.tags?.includes("agent")) continue;
    agents[id] = {
      ...entity,
      name: displayName(id),
      alive: number(entity.stocks?.health?.value) > 0,
      position: entity.pos,
    };
  }
  return {
    worldId: stored.worldId,
    scenario: stored.engine.scenario,
    tick: stored.engine.world.tick,
    payload: {
      worldId: stored.worldId,
      state: { tick: stored.engine.world.tick, agents },
      controllers: {},
      speculative: [],
      speculativeNouns: [],
      rules: [],
      ruleMeta: { customIds: [], dirtyIds: [] },
      liveness: {
        running: false,
        paused: false,
        ended: stored.endedAt !== null,
      },
    },
  };
}

function normalizeLiveAgents(payload: DataRecord): Map<string, DataRecord> {
  let agents = new Map<string, DataRecord>();
  for (let [id, agent] of Object.entries(payload.state?.agents ?? {}) as [
    string,
    DataRecord,
  ][]) {
    agents.set(id, {
      id,
      ...agent,
      name: agent.name ?? displayName(id),
      controllerConnected: Boolean(payload.controllers?.[id]?.connected),
    });
  }
  return agents;
}

function buildSeats(
  paths: OperatorPaths,
  liveAgents: Map<string, DataRecord>,
  characterBatches: BatchRecord[],
  directorBatches: BatchRecord[],
  payload: DataRecord,
  logStore: LogStore,
  runStartedAt: number,
): Seat[] {
  let characterNames = new Set<string>();
  let directorNames = new Set<string>();
  let directorPersonas = new Map(
    markdownNames(paths.directorPersonasDir)
      .filter((persona) =>
        personaIsSeat(path.join(paths.directorPersonasDir, `${persona}.md`)),
      )
      .map((persona) => [normalizeId(directorName(persona)), persona]),
  );
  for (let persona of directorPersonas.values())
    directorNames.add(directorName(persona));
  for (let agent of liveAgents.values()) characterNames.add(agent.name);
  for (let batch of characterBatches)
    for (let name of batch.names) characterNames.add(name);
  for (let batch of directorBatches)
    for (let name of batch.names) directorNames.add(name);

  let characterBatchByName = new Map<string, BatchRecord>();
  for (let batch of characterBatches)
    for (let name of batch.names)
      characterBatchByName.set(normalizeId(name), batch);
  let directorBatchByName = new Map<string, BatchRecord>();
  for (let batch of directorBatches)
    for (let name of batch.names)
      directorBatchByName.set(normalizeId(name), batch);
  let seats: Seat[] = [];
  let directorInputs = [...directorNames].map((name) => {
    let seatDir = path.join(paths.directorsDir, name);
    return {
      name,
      persona: directorPersonas.get(normalizeId(name)) ?? null,
      batch: directorBatchByName.get(normalizeId(name)) ?? null,
      seatDir,
      logs: logStore.inspectSeat(seatDir, runStartedAt),
    };
  });
  for (let input of directorInputs) {
    let processRunning = Boolean(input.batch?.alive);
    seats.push(
      makeSeat({
        name: input.name,
        persona: input.batch?.persona ?? input.persona,
        role: "director",
        pid: processRunning ? input.batch?.pid : null,
        processRunning,
        controllerConnected:
          input.batch?.state === "running" &&
          Boolean(payload.liveness?.gmConnected),
        supervisorState: input.batch?.state ?? null,
        cadenceTicks: input.batch?.cadenceTicks ?? null,
        nextLaunchTick: input.batch?.nextLaunchTick ?? null,
        startTick: input.batch?.startTick ?? null,
        stopTick: input.batch?.stopTick ?? null,
        live: null,
        seatDir: input.seatDir,
        logs: input.logs,
      }),
    );
  }
  for (let name of characterNames) {
    let id = normalizeId(name);
    let live =
      liveAgents.get(id) ??
      [...liveAgents.values()].find(
        (agent) => normalizeId(agent.name) === id,
      ) ??
      null;
    let batch = characterBatchByName.get(id);
    let processRunning = Boolean(batch?.alive);
    let seatDir = path.join(paths.charactersDir, name);
    let logs = logStore.inspectSeat(seatDir, runStartedAt);
    seats.push(
      makeSeat({
        name: live?.name ?? name,
        role: "character",
        pid: processRunning ? batch?.pid : null,
        processRunning,
        controllerConnected: Boolean(live?.controllerConnected),
        live,
        seatDir,
        logs,
      }),
    );
  }

  return seats.sort(compareSeats);
}

function makeSeat(input: DataRecord): Seat {
  let latest = input.logs.latest;
  let state = seatState(input);
  let pending = latest?.pending?.[0]?.label ?? null;
  let action =
    input.live?.action?.type ??
    input.live?.order?.steps?.[input.live?.order?.index ?? 0]?.type ??
    null;
  return {
    id: `${input.role}:${normalizeId(input.name)}`,
    name: input.name,
    persona: input.persona ?? null,
    role: input.role,
    state,
    alive:
      input.role === "director"
        ? null
        : input.live
          ? input.live.alive !== false
          : null,
    action,
    pending,
    pid: input.pid,
    processRunning: input.processRunning,
    controllerConnected: input.controllerConnected,
    cadenceTicks: input.cadenceTicks ?? null,
    nextLaunchTick: input.nextLaunchTick ?? null,
    startTick: input.startTick ?? null,
    stopTick: input.stopTick ?? null,
    engine: latest?.engine ?? input.logs.runs[0]?.engine ?? null,
    model: latest?.model ?? input.logs.runs[0]?.model ?? null,
    effort: latest?.effort ?? input.logs.runs[0]?.effort ?? null,
    startedAt: latest?.startedAt ?? null,
    updatedAt: latest?.mtime ?? null,
    seatDir: input.seatDir,
    memory: readText(path.join(input.seatDir, "memory.md")),
    log: latest,
    logCount: input.logs.logs.length,
    usage: { total: input.logs.totalUsage, run: input.logs.runUsage },
    live: input.live,
  };
}

function seatState(input: DataRecord): string {
  if (input.role === "director") {
    if (input.processRunning && input.supervisorState === "scheduled")
      return "scheduled";
    if (input.processRunning && input.supervisorState === "relaunching")
      return "relaunching";
    if (input.processRunning && input.supervisorState === "errored")
      return "errored";
    if (input.processRunning && input.supervisorState === "running")
      return "running";
    if (input.processRunning) return "connecting";
    if (input.controllerConnected) return "connected";
    return "stopped";
  }
  if (input.live?.alive === false) return "dead";
  if (input.processRunning && input.controllerConnected)
    return input.live?.action ? "working" : "waiting";
  if (input.processRunning) return input.live ? "relaunching" : "connecting";
  if (input.controllerConnected) return "connected";
  if (input.live?.alive) return "idle";
  return "stopped";
}

function compareSeats(left: Seat, right: Seat): number {
  if (left.role !== right.role) return left.role === "director" ? -1 : 1;
  let rank: Record<string, number> = {
    running: 0,
    working: 0,
    waiting: 1,
    connected: 1,
    connecting: 2,
    relaunching: 2,
    scheduled: 3,
    idle: 3,
    errored: 4,
    dead: 4,
    stopped: 5,
  };
  let difference = (rank[left.state] ?? 9) - (rank[right.state] ?? 9);
  if (difference) return difference;
  return left.name.localeCompare(right.name);
}

function readBatches(directory: string): BatchRecord[] {
  let batches: BatchRecord[] = [];
  for (let entry of safeEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let parsed = readJson(path.join(directory, entry.name));
    if (!parsed) continue;
    let pid = number(parsed?.pid);
    if (!pid) continue;
    batches.push({
      ...parsed,
      pid,
      names: Array.isArray(parsed.names) ? parsed.names : [],
      alive: processAlive(pid),
    });
  }
  return batches;
}

function readRuns(directory: string): RunSummary[] {
  let runs: RunSummary[] = [];
  for (let name of directoryNames(directory)) {
    let meta = readJson(path.join(directory, name, "meta.json"));
    if (meta) runs.push({ ...meta, runId: meta.runId ?? name });
  }
  return runs.sort(
    (left, right) => number(right.archivedAt) - number(left.archivedAt),
  );
}

function readScenarios(
  directory: string,
  activeName: string | undefined,
): ScenarioSummary {
  let scenarios: NonNullable<ScenarioSummary["scenarios"]> = [];
  for (let entry of safeEntries(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let data = readJson(path.join(directory, entry.name));
    if (!data?.name) continue;
    scenarios.push({
      name: data.name,
      description: data.description ?? "",
      active: data.name === activeName,
    });
  }
  return { active: activeName ? [activeName] : [], scenarios, gm: {} };
}

function inferRunStart(runs: RunSummary[], stateFile: string): number {
  let newestArchive = Math.max(0, ...runs.map((run) => number(run.archivedAt)));
  if (newestArchive) return newestArchive;
  try {
    return fs.statSync(stateFile).birthtimeMs;
  } catch {
    return Date.now();
  }
}

function processAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readJson(file: string): DataRecord | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function safeEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function directoryNames(directory: string): string[] {
  return safeEntries(directory)
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

function markdownNames(directory: string): string[] {
  return safeEntries(directory)
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.basename(entry.name, ".md"))
    .sort();
}

// A director persona is a seat only when its frontmatter declares a wake
// policy; wake-less personas (the Illuminator) are commissioned helpers.
// Mirrors parsePersona in scripts/crew-policy.mjs, which plain-node scripts
// use and this TS module cannot import.
function personaIsSeat(file: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return false;
  let close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close === -1) return false;
  return lines.slice(1, close).some((line) => /^wake\s*:/.test(line));
}

function directorName(persona: string): string {
  return `${persona.charAt(0).toUpperCase()}${persona.slice(1)}`;
}

function normalizeId(name: string): string {
  return String(name).trim().toLowerCase().replace(/\s+/g, "-");
}

function displayName(id: string): string {
  return String(id)
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyPayload(): DataRecord {
  return {
    state: { tick: 0, agents: {} },
    controllers: {},
    speculative: [],
    speculativeNouns: [],
    rules: [],
    ruleMeta: {},
    liveness: {},
  };
}

export function snapshotText(snapshot: OperatorSnapshot): string {
  let world = snapshot.world;
  let state = world.ended
    ? "ENDED"
    : world.paused
      ? "PAUSED"
      : snapshot.online
        ? "RUNNING"
        : "OFFLINE";
  let lines = [
    `Agent Island · ${world.scenario} · tick ${world.tick} · ${state}`,
    `World ${world.worldId}`,
    `Characters ${world.alive} alive · ${world.activeCount} active · ${world.idle} idle · ${world.dead} dead`,
    `Usage ${world.usage.inputTokens} input · ${world.usage.cachedInputTokens} cached · ${world.usage.outputTokens} output`,
    "",
  ];
  for (let seat of snapshot.seats) {
    let model = [seat.engine, seat.model, seat.effort]
      .filter(Boolean)
      .join("/");
    lines.push(
      `${seat.role.padEnd(9)} ${seat.name.padEnd(14)} ${seat.state.padEnd(12)} ${model}`.trimEnd(),
    );
  }
  if (snapshot.error) lines.push("", `Server: ${snapshot.error}`);
  return lines.join("\n");
}
