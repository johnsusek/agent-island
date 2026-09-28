#!/usr/bin/env node
// The crew supervisor: launches and babysits the LLM CLI processes that play
// Agent Island. This is the AI-native replacement for the old in-server
// launcher - the server knows nothing about LLMs; this script owns the child
// processes, their workdirs and memory files, death-aware reincarnation, the
// restart-storm guard, and the token report on drain.
//
// Usage:
//   node scripts/crew.mjs director   [--cadence-ticks N] [--min-wake-ms N] [--max-ticks N] [seat options]
//   node scripts/crew.mjs characters [--count N] [--max-ticks N] [seat options]
//   node scripts/crew.mjs stop [director|characters [name]]   SIGTERM crew(s)
//   node scripts/crew.mjs status                              Show running crews
//
// Directors and characters are launched as separate, additive crews, so seat
// options never bleed across roles and each director can keep its own cadence.
// World setup (scenario, reset, clock, pause/resume) lives in scripts/world.mjs.
//
// A director runs one pass per LLM process and exits. The lightweight crew
// supervisor waits for that director's next launch tick, then starts a fresh
// process. A cadence of 0 is event-woken: the process parks once in
// wait_for_world, exits after acting, and is relaunched after a short gap - or
// after that seat's wake throttle, when its persona sets one.
// Continuity lives only in the director's memory file.
//
// Each director persona (agents/directors/<NAME>.md) opens with a frontmatter
// block declaring its model, effort, and wake policy - the single source of
// orchestration truth; CLI flags below override it per launch. A persona
// without a wake block is not a seat and refuses to launch as a director.
//
// Seat options:
//   --engine codex|claude      (default persona frontmatter, else claude)
//   --model NAME               (default persona frontmatter, else haiku)
//   --effort low|medium|high|xhigh|max   (default persona frontmatter;
//                              characters low, directors medium)
//   --persona NAME             agents/characters|directors/<NAME>.md
//   --name NAME                Explicit seat name (single character)
//   --names A,B,C              Explicit seat names (multiple characters)
//   --cadence-ticks N          Override the persona's wake cadence
//                              (0 = event-woken)
//   --min-wake-ms N            Floor between an event-woken director's passes
//                              (default persona wake.min_interval_ms)
//   --no-ocean                 Skip the OCEAN personality roll (on by default)
//   --instructions TEXT        Extra operator text appended to the prompt
//   --url http://host:port     Server base (env AGENT_ISLAND_URL, default :3000)
//
// The crew process stays in the foreground supervising its children; SIGTERM
// or Ctrl-C drains them (SIGTERM, grace window, SIGKILL) and prints per-seat
// token usage. Run it in the background from a skill or shell.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  directorWake,
  disallowedTools,
  parseDirectorCadenceTicks,
  parseMaxTicks,
  parseMinWakeMs,
  parsePassTicks,
  parsePersona,
  targetTick,
  wakeDelayMs,
} from "./crew-policy.mjs";
import { api, baseUrl } from "./world.mjs";

// Runtime home, mirrored from src/paths.ts (this script runs under plain node,
// not tsx, so it cannot import the TS helper). Character/director workdirs and
// crew pidfiles live here, out of the repo. Override with AGENT_ISLAND_HOME.
function agentIslandHome() {
  let raw = process.env.AGENT_ISLAND_HOME?.trim();
  if (raw) {
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
    return path.resolve(raw);
  }
  return path.join(os.homedir(), ".agent-island");
}

function homePath(...segments) {
  return path.join(agentIslandHome(), ...segments);
}

const execFileP = promisify(execFile);

// --- configuration ------------------------------------------------------

function numEnv(name, fallback) {
  let raw = process.env[name];
  if (!raw) return fallback;
  let value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const CONFIG = {
  charactersDir: path.resolve(
    process.env.AGENT_ISLAND_CHARACTERS_DIR ?? homePath("characters"),
  ),
  directorsDir: path.resolve(
    process.env.AGENT_ISLAND_DIRECTORS_DIR ?? homePath("directors"),
  ),
  characterPromptsDir: path.resolve(
    process.env.AGENT_ISLAND_CHARACTER_PROMPTS_DIR ?? "agents/characters",
  ),
  personasDir: path.resolve(
    process.env.AGENT_ISLAND_PERSONAS_DIR ?? "agents/directors",
  ),
  defaultCharacterPrompt: path.resolve(
    process.env.AGENT_ISLAND_CHARACTER_PROMPT ??
      "agents/characters/character-minimal.md",
  ),
  defaultDirectorPersona: path.resolve(
    process.env.AGENT_ISLAND_DIRECTOR_PROMPT ?? "agents/directors/oracle.md",
  ),
  namesFile: path.resolve(
    process.env.AGENT_ISLAND_NAMES_FILE ?? "agents/characters/names.txt",
  ),
  oceanFile: path.resolve(
    process.env.AGENT_ISLAND_OCEAN_FILE ?? "agents/characters/OCEAN.md",
  ),
  batchDirs: {
    characters: homePath(".crew-characters"),
    director: homePath(".crew-directors"),
  },
  // World time one character pass covers before it wraps up and exits; see
  // parsePassTicks in crew-policy.mjs for why 150. 0 = unbounded.
  characterPassTicks: numEnv("AGENT_ISLAND_CHARACTER_PASS_TICKS", 150),
  relaunchDelayMs: numEnv("AGENT_ISLAND_CREW_RELAUNCH_MS", 3000),
  directorPollMs: numEnv("AGENT_ISLAND_DIRECTOR_POLL_MS", 1000),
  launchStaggerMs: numEnv("AGENT_ISLAND_CREW_STAGGER_MS", 3000),
  stopGraceMs: numEnv("AGENT_ISLAND_CREW_STOP_GRACE_MS", 10000),
  livenessPollMs: numEnv("AGENT_ISLAND_CREW_LIVENESS_MS", 5000),
  storm: {
    maxRestarts: numEnv("AGENT_ISLAND_CREW_STORM_MAX", 3),
    windowMs: numEnv("AGENT_ISLAND_CREW_STORM_WINDOW_MS", 20000),
    // A director exits on purpose after every pass, and it has no body for
    // liveness to find, so "did it ever join" can't tell a healthy pass
    // from a CLI that won't start. Run length can: a pass does a whole orient
    // and reading before exit, while a broken CLI dies in under a second.
    healthyRunMs: numEnv("AGENT_ISLAND_CREW_HEALTHY_RUN_MS", 10000),
  },
  defaults: {
    character: { engine: "claude", model: "haiku", effort: "low" },
    director: { engine: "claude", model: "haiku", effort: "medium" },
    claude: {
      model: process.env.CLAUDE_PLAY_MODEL ?? "haiku",
      permissionMode: process.env.CLAUDE_PLAY_PERMISSION_MODE ?? "acceptEdits",
    },
    // Model fallbacks when --engine codex is requested without --model.
    codex: { character: "gpt-5.4-mini", director: "gpt-5.6-luna" },
  },
};

async function readWorldState(opts) {
  let response = await fetch(`${baseUrl(opts)}/api/state`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error(`GET /api/state failed (${response.status}).`);
  return response.json();
}

async function readWorldTick(opts) {
  let payload = await readWorldState(opts);
  let tick = payload.state?.tick;
  if (!Number.isFinite(tick)) throw new Error("World state has no valid tick.");
  return tick;
}

// --- spawn plans (parity with the retired in-server launcher) -----------

function planSpawn(engine, options) {
  if (engine === "claude") return planClaude(options);
  return planCodex(options);
}

function planClaude(options) {
  let mcpConfig = JSON.stringify({
    mcpServers: { "agent-island": { type: "http", url: options.mcpUrl } },
  });
  return {
    command: "claude",
    logSubdir: "claude",
    gitInit: true,
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      // Ephemeral seat: load no user/project/local settings so nothing from
      // the operator's own claude config bleeds into a character's context.
      // --bare would go further (skips hooks, auto-memory, CLAUDE.md
      // discovery) but it refuses OAuth/keychain auth, so only use it when
      // an API key is available.
      ...(process.env.ANTHROPIC_API_KEY ? ["--bare"] : []),
      "--setting-sources",
      "",
      "--model",
      options.model,
      "--effort",
      options.effort,
      "--permission-mode",
      CONFIG.defaults.claude.permissionMode,
      // Pre-approve every Agent Island tool; hard-block the shell, sub-agents,
      // scheduling and the dead harness surface (see crew-policy.mjs) so the
      // prohibitions in the persona are load-bearing.
      "--allowedTools",
      "mcp__agent-island",
      "--disallowedTools",
      disallowedTools(["Bash"]),
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      options.prompt,
    ],
  };
}

function planCodex(options) {
  return {
    command: "codex",
    logSubdir: "codex",
    gitInit: false,
    args: [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--json",
      "--model",
      options.model,
      "-c",
      `model_reasoning_effort=${options.effort}`,
      "-c",
      `mcp_servers.agent-island.url="${options.mcpUrl}"`,
      "-c",
      'mcp_servers.agent-island.default_tools_approval_mode="approve"',
      "--sandbox",
      "workspace-write",
      options.prompt,
    ],
  };
}

// --- name pool ----------------------------------------------------------

function parseNames(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").replace(/\s+/g, ""))
    .filter((name) => name.length > 0);
}

function shuffle(items) {
  let out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Names that have already played (evidence on disk) come first so a launch
// resumes an unattended character before spawning a brand-new body.
function buildNamePool() {
  let played = [];
  for (let entry of safeReaddir(CONFIG.charactersDir)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    let dir = path.join(CONFIG.charactersDir, entry.name);
    let hasMemory = safeReaddir(dir).some(
      (f) => f.isFile() && f.name.endsWith(".md"),
    );
    let hasLogs = ["codex", "claude"].some((engine) =>
      safeReaddir(path.join(dir, "logs", engine)).some(
        (f) =>
          f.isFile() && f.name.startsWith("play-") && f.name.endsWith(".jsonl"),
      ),
    );
    if (hasMemory || hasLogs) played.push(entry.name);
  }
  let seeds = parseNames(safeReadFile(CONFIG.namesFile));
  let seen = new Set();
  let pool = [];
  for (let name of [...shuffle(played), ...shuffle(seeds)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    pool.push(name);
  }
  return pool;
}

// The world's agent id is a normalized form of the display name (lowercased,
// spaces collapsed to hyphens - see normalizeId in src/rules/engine.ts, which
// this plain-node script can't import directly). Character names are always
// single words, so this is the whole normalization that matters here.
function toAgentId(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

// What the live world actually looks like right now, so a (re)launch can
// reclaim real idle colonists instead of a local, world-blind guess. Keyed by
// agent id (toAgentId), with `idleNames` carrying each idle agent's original
// display name (state.agents[id].name) so a relaunch passes back exactly the
// name that will reclaim it. Best-effort: a fetch failure just yields empty
// sets, degrading to the old filesystem-only pool rather than failing the
// launch outright.
async function fetchRoster(opts) {
  let idleNames = [];
  let deadIds = new Set();
  let activeIds = new Set();
  try {
    let state = await api("GET", "/api/state", opts);
    let agents = state.state?.agents ?? {};
    let controllers = state.controllers ?? {};
    for (let [id, agent] of Object.entries(agents)) {
      if (!agent.alive) {
        deadIds.add(id);
      } else if (controllers[id]?.connected) {
        activeIds.add(id);
      } else {
        idleNames.push(agent.name ?? id);
      }
    }
  } catch {
    // transient - treat the world as unknown rather than blocking the launch
  }
  return { idleNames, deadIds, activeIds };
}

// Tell the world to drop this character's controller right now, best-effort.
// Called when a seat is stopped (Ctrl-C, `stop characters`, a dying child) so
// the seat reads as idle immediately instead of lingering "connected" until
// the server's own idle sweep catches up - which is slow enough that an
// immediate relaunch would otherwise see the body as taken and spawn a fresh
// one instead of reclaiming it. Never throws or exits; a failure here just
// means the next launch falls back to the idle-sweep timing.
async function releaseAgentNow(name, opts) {
  try {
    await fetch(`${baseUrl(opts)}/api/release-agent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
  } catch {
    // best-effort
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeReadFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// --- memory + OCEAN -----------------------------------------------------

function ensureCharacterMemory(baseDir, name) {
  let dir = path.join(baseDir, name);
  let memoryPath = path.join(dir, "memory.md");
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(
      memoryPath,
      `# ${name}\n\n## Durable knowledge\n\n## Current intent\n`,
    );
  }
  return memoryPath;
}

const OCEAN_HEADING = "## Who you are (fixed - do not edit or prune)";
const OCEAN_NOTE =
  "This is your temperament, the same across every launch. Play in character. " +
  "Keep this section exactly as written - do not rewrite or prune it.";

function parseOceanTraits(markdown) {
  let traits = [];
  let current = null;
  for (let raw of markdown.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) {
      current = { name: line.slice(2).trim(), levels: [] };
      traits.push(current);
    } else if (current) {
      current.levels.push(line);
    }
  }
  return traits.filter((trait) => trait.levels.length > 0);
}

// Center-biased pick: averaging two uniform draws leans "normal society"
// while still reaching the extremes often.
function pickLevel(count) {
  if (count <= 1) return 0;
  let t = (Math.random() + Math.random()) / 2;
  return Math.min(count - 1, Math.floor(t * count));
}

function ensureOceanPersonality(memoryPath) {
  let memory;
  try {
    memory = fs.readFileSync(memoryPath, "utf8");
  } catch {
    return false;
  }
  if (memory.includes(OCEAN_HEADING)) return false;
  let traits = parseOceanTraits(safeReadFile(CONFIG.oceanFile));
  if (!traits.length) return false;
  let lines = traits.map(
    (trait) => `- ${trait.levels[pickLevel(trait.levels.length)]}`,
  );
  let block = `${OCEAN_HEADING}\n\n${OCEAN_NOTE}\n\n${lines.join("\n")}\n`;
  let split = memory.split(/\r?\n/);
  let woven = split[0]?.startsWith("# ")
    ? `${split[0]}\n\n${block}\n${split.slice(1).join("\n")}`
    : `${block}\n${memory}`;
  fs.writeFileSync(memoryPath, woven);
  return true;
}

// --- token usage (read back off the run logs) ---------------------------

function zeroUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
  };
}

function addUsage(into, from) {
  into.inputTokens += from.inputTokens;
  into.cachedInputTokens += from.cachedInputTokens;
  into.uncachedInputTokens += from.uncachedInputTokens;
  into.outputTokens += from.outputTokens;
}

function tryParse(line) {
  let trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromCodexLog(lines) {
  let total = zeroUsage();
  for (let line of lines) {
    let event = tryParse(line);
    if (!event || event.type !== "turn.completed" || !event.usage) continue;
    let input = num(event.usage.input_tokens);
    let cached = num(event.usage.cached_input_tokens);
    addUsage(total, {
      inputTokens: input,
      cachedInputTokens: cached,
      uncachedInputTokens: Math.max(0, input - cached),
      outputTokens: num(event.usage.output_tokens),
    });
  }
  return total;
}

function usageFromClaudeLog(lines) {
  let fromResult = null;
  let fromMessages = zeroUsage();
  let sawMessage = false;
  for (let line of lines) {
    let event = tryParse(line);
    if (!event) continue;
    if (event.type === "result" && event.usage) {
      fromResult = usageBlockClaude(event.usage);
    } else if (event.type === "assistant" && event.message?.usage) {
      sawMessage = true;
      addUsage(fromMessages, usageBlockClaude(event.message.usage));
    }
  }
  return fromResult ?? (sawMessage ? fromMessages : zeroUsage());
}

function usageBlockClaude(u) {
  let fresh = num(u.input_tokens);
  let cacheWrite = num(u.cache_creation_input_tokens);
  let cacheRead = num(u.cache_read_input_tokens);
  return {
    inputTokens: fresh + cacheWrite + cacheRead,
    cachedInputTokens: cacheRead,
    uncachedInputTokens: fresh + cacheWrite,
    outputTokens: num(u.output_tokens),
  };
}

// Seat log dirs persist across crew invocations, so the report reads only the
// logs this process wrote (recorded at spawn) - otherwise every run reports the
// seat's whole history.
function readRunUsage(logs) {
  let total = zeroUsage();
  for (let { path: file, engine } of logs) {
    let lines = safeReadFile(file).split("\n");
    addUsage(
      total,
      engine === "claude"
        ? usageFromClaudeLog(lines)
        : usageFromCodexLog(lines),
    );
  }
  return total;
}

function formatUsage(usage) {
  if (!usage) return null;
  let k = (n) =>
    n >= 1e6
      ? `${(n / 1e6).toFixed(2)}M`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}K`
        : String(n);
  return `in ${k(usage.inputTokens)} (${k(usage.uncachedInputTokens)} uncached) / out ${k(usage.outputTokens)}`;
}

// --- the supervisor -----------------------------------------------------

class Crew {
  constructor(opts) {
    this.opts = opts;
    this.seats = new Map();
    // seat name -> [{ path, engine }] for every pass this process spawned.
    // Keyed off the map so a retired seat's usage still lands in the report.
    this.runLogs = new Map();
    this.livenessTimer = null;
    this.draining = false;
  }

  async launch(request) {
    let role = request.role === "director" ? "director" : "character";
    let roleDefaults = CONFIG.defaults[role];
    let count = Math.max(1, Math.floor(request.count ?? 1));
    let persona = request.persona?.trim() || null;
    if (persona && !/^[A-Za-z0-9_-]+$/.test(persona))
      throw new Error(`Invalid persona name: ${persona}`);

    // A director persona's frontmatter is the single orchestration source:
    // model, effort, and its wake policy all live in the .md file, so resolve
    // and parse it before computing engine defaults. A persona without a wake
    // block is not a seat and cannot be launched as a director.
    let personaMeta = {};
    let wake = null;
    if (role === "director") {
      let file = persona
        ? path.join(CONFIG.personasDir, `${persona}.md`)
        : CONFIG.defaultDirectorPersona;
      if (!fs.existsSync(file))
        throw new Error(`persona file not found: ${file}`);
      personaMeta = parsePersona(fs.readFileSync(file, "utf8")).meta;
      wake = directorWake(personaMeta);
      if (!wake)
        throw new Error(
          `${path.basename(file)} has no wake frontmatter - it is not a director seat. Add a wake block (events and/or every_ticks) to seat it.`,
        );
    }

    let engine = ["claude", "codex"].includes(request.engine ?? "")
      ? request.engine
      : ["claude", "codex"].includes(personaMeta.engine ?? "")
        ? personaMeta.engine
        : roleDefaults.engine;
    // Frontmatter model names are written for the persona's own engine
    // (claude unless it says otherwise), so an --engine override past it
    // falls back to that engine's stock model instead.
    let personaEngine = personaMeta.engine ?? "claude";
    let model =
      request.model?.trim() ||
      (engine === personaEngine && typeof personaMeta.model === "string"
        ? personaMeta.model
        : null) ||
      (engine === roleDefaults.engine
        ? roleDefaults.model
        : engine === "claude"
          ? CONFIG.defaults.claude.model
          : CONFIG.defaults.codex[role]);
    let effortLevels = ["low", "medium", "high", "xhigh", "max"];
    let effort = effortLevels.includes(request.effort ?? "")
      ? request.effort
      : effortLevels.includes(personaMeta.effort ?? "")
        ? personaMeta.effort
        : roleDefaults.effort;
    let cadenceTicks =
      role === "director"
        ? parseDirectorCadenceTicks(request.cadenceTicks, wake)
        : 0;
    // Only an event-woken director throttles; a scheduled seat's rate is its
    // tick cadence already.
    let minWakeMs =
      role === "director" && cadenceTicks === 0
        ? parseMinWakeMs(request.minWakeMs, wake)
        : 0;
    let passTicks =
      role === "character"
        ? parsePassTicks(request.passTicks, CONFIG.characterPassTicks)
        : 0;

    let personaFile;
    let names;
    if (role === "director") {
      personaFile = persona
        ? path.join(CONFIG.personasDir, `${persona}.md`)
        : CONFIG.defaultDirectorPersona;
      let stem = persona ?? path.basename(personaFile, ".md");
      let name =
        request.name?.trim() || stem.charAt(0).toUpperCase() + stem.slice(1);
      let siblingIds = new Set(
        [...(request.excludeNames ?? [])].map(toAgentId),
      );
      if (siblingIds.has(toAgentId(name)))
        throw new Error(`${name} already has a running director crew.`);
      names = this.seats.has(name) ? [] : [name];
    } else {
      personaFile = persona
        ? path.join(CONFIG.characterPromptsDir, `${persona}.md`)
        : CONFIG.defaultCharacterPrompt;
      let roster = await fetchRoster(this.opts);
      // Names already claimed by a sibling characters batch (a different
      // launch/process, running concurrently against the same world) - kept
      // id-normalized since a sibling's casing may differ from ours.
      let siblingIds = new Set(
        [...(request.excludeNames ?? [])].map(toAgentId),
      );
      let explicit = [
        ...(request.name?.trim() ? [request.name.trim()] : []),
        ...(request.names ?? []),
      ];
      if (explicit.length) {
        // Fail fast on a name the world will refuse outright, instead of
        // spawning a child that just burns a restart-storm retry on it.
        for (let name of explicit) {
          if (roster.deadIds.has(toAgentId(name)))
            throw new Error(
              `${name} died and cannot rejoin - pick a different name.`,
            );
          if (siblingIds.has(toAgentId(name)))
            throw new Error(
              `${name} is already seated by another running characters batch.`,
            );
        }
        for (let name of explicit) {
          if (roster.activeIds.has(toAgentId(name)))
            console.log(
              `[crew] ${name} is already controlled by a live session - this will reclaim it.`,
            );
        }
        let taken = new Set(this.seats.keys());
        names = explicit.filter((name) => !taken.has(name));
      } else {
        let taken = new Set(this.seats.keys());
        let claimedIds = new Set([
          ...roster.deadIds,
          ...roster.activeIds,
          ...siblingIds,
        ]);
        // Idle colonists already in the world - the actual "empty seats" -
        // come first, deterministically (sorted, not shuffled), so a restart
        // reliably reclaims the same bodies instead of a shuffle lottery.
        let idle = [...new Set(roster.idleNames)]
          .filter(
            (name) => !taken.has(name) && !siblingIds.has(toAgentId(name)),
          )
          .sort();
        let rest = buildNamePool().filter(
          (name) => !idle.includes(name) && !claimedIds.has(toAgentId(name)),
        );
        let ordered = [...idle, ...rest];
        names = [];
        for (let i = 0; i < count; i++) {
          let name = ordered.find(
            (candidate) => !taken.has(candidate) && !names.includes(candidate),
          );
          if (!name) break;
          taken.add(name);
          names.push(name);
        }
      }
    }
    if (!fs.existsSync(personaFile))
      throw new Error(`persona file not found: ${personaFile}`);

    for (let [index, name] of names.entries()) {
      let seat = {
        name,
        role,
        engine,
        model,
        effort,
        personaFile,
        persona: persona ?? path.basename(personaFile, ".md"),
        wake,
        cadenceTicks,
        minWakeMs,
        passTicks,
        instructions: request.instructions?.trim() ?? "",
        ocean: role === "character" && request.ocean !== false,
        child: null,
        state: "starting",
        spawnedAt: 0,
        childPid: null,
        lastLaunchTick: null,
        nextLaunchTick: null,
        nextLaunchAt: null,
        everJoined: false,
        stopping: false,
        restartTimes: [],
        relaunchTimer: null,
        stopTimer: null,
        onRetire: [],
      };
      this.seats.set(name, seat);
      this.notifySeat(seat);
      let delay = index * CONFIG.launchStaggerMs;
      if (delay > 0)
        seat.relaunchTimer = setTimeout(() => this.spawnSeat(seat), delay);
      else void this.spawnSeat(seat);
      console.log(
        `[crew] seat ${name} [${role}] ${engine}/${model} effort ${effort}`,
      );
    }
    this.ensureLivenessTimer();
    return names;
  }

  notifySeat(seat) {
    this.opts.onSeatChange?.(seat);
  }

  seatBaseDir(seat) {
    return seat.role === "director"
      ? CONFIG.directorsDir
      : CONFIG.charactersDir;
  }

  seatDir(seat) {
    return path.join(this.seatBaseDir(seat), seat.name);
  }

  async buildPrompt(seat) {
    // Frontmatter is launcher configuration, not persona prose - strip it.
    // The body is re-read every spawn so persona edits land on the next pass;
    // scheduling stays as parsed at launch.
    let prompt = parsePersona(fs.readFileSync(seat.personaFile, "utf8")).body;
    let wakeSpec = seat.wake ?? { events: [], everyTicks: null };
    let armWith = [
      wakeSpec.events.length ? `events ${JSON.stringify(wakeSpec.events)}` : "",
      wakeSpec.everyTicks ? `everyTicks ${wakeSpec.everyTicks}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    let directorCycle = seat.cadenceTicks
      ? `Run ONE scheduled pass immediately. Do not call wait_for_world: orient, act if warranted, write ./memory.md, and end your turn. Your supervisor will launch a fresh process every ${seat.cadenceTicks} world ticks.`
      : `Run ONE wake cycle: park in wait_for_world once${armWith ? ` with ${armWith}` : ""}, act on what it returns, write ./memory.md, and end your turn. Do not re-arm wait_for_world; your supervisor relaunches you for the next wake.`;
    // A character pass is bounded in world time, not turns: every observation
    // it gets opens with the current tick, so a tick target is something it can
    // actually check against rather than bookkeeping it has to carry.
    let characterCycle = seat.passTicks
      ? `Play a stretch of about ${seat.passTicks} ticks, then wrap up. Note the tick in your first observation; once the tick has climbed roughly ${seat.passTicks} past it, finish what you are in the middle of, consolidate ./memory.md, call leave_game, and end your turn. A fresh process picks you up under the same name and carries on from your memory, so this is a breath between stretches of one life, not the end of it. Landing near the mark is the point - do not cut a stretch short, and do not run far past it.`
      : `Keep running continuously.`;
    let lead =
      seat.role === "director"
        ? `Your launcher seats you as the resident director named ${seat.name}.\nConnect and join_as_gm. ${directorCycle} ./memory.md is the only thing that survives between processes.`
        : `Your launcher gives you this character name: ${seat.name}\n${characterCycle} Keep your memory current when durable knowledge or your intent changes.`;
    let base = `${lead}\n\n${prompt}`;
    // Characters always learn the world's ongoing dynamics (the flow rules'
    // descriptions) - passive mechanics like hunger are physics a resident
    // would know, not secrets to rediscover every launch.
    if (seat.role === "character") {
      let flows = await this.flowDescriptions();
      if (flows.length)
        base += `\n\n## Ongoing world dynamics\n\n${flows.join("\n")}`;
    }
    if (seat.instructions)
      base += `\n\n## Additional instructions from your operator\n\n${seat.instructions}`;
    return base;
  }

  async flowDescriptions() {
    try {
      let state = await readWorldState(this.opts);
      return (state.rules ?? [])
        .filter((rule) => rule.phase === "flow" && rule.description?.trim())
        .map((rule) => rule.description.trim());
    } catch {
      return [];
    }
  }

  async spawnSeat(seat) {
    seat.relaunchTimer = null;
    if (this.draining || seat.stopping || !this.seats.has(seat.name)) return;
    seat.state = "starting";
    seat.nextLaunchTick = null;
    seat.nextLaunchAt = null;
    seat.childPid = null;
    this.notifySeat(seat);

    let settled = false;
    let settle = (error) => {
      if (settled) return;
      settled = true;
      this.onExit(seat, error);
    };

    try {
      let base = baseUrl(this.opts);
      let mcpUrl = seat.role === "director" ? `${base}/gm` : `${base}/mcp`;
      let plan = planSpawn(seat.engine, {
        role: seat.role,
        model: seat.model,
        effort: seat.effort,
        prompt: await this.buildPrompt(seat),
        mcpUrl,
      });

      let seatDir = this.seatDir(seat);
      let memoryPath = ensureCharacterMemory(this.seatBaseDir(seat), seat.name);
      if (seat.ocean) ensureOceanPersonality(memoryPath);

      let logDir = path.join(seatDir, "logs", plan.logSubdir);
      fs.mkdirSync(logDir, { recursive: true });

      if (plan.gitInit && !fs.existsSync(path.join(seatDir, ".git"))) {
        // Isolates this seat's claude project memory. Non-fatal without git.
        try {
          await execFileP("git", ["init", "-q", seatDir]);
        } catch {
          // ignore
        }
      }

      if (this.draining || seat.stopping || !this.seats.has(seat.name)) return;

      let stamp = new Date().toISOString().replace(/[-:.]/g, "");
      let worker = 1;
      let runStamp = `${stamp}-worker-${worker}`;
      while (fs.existsSync(path.join(logDir, `play-${runStamp}.jsonl`))) {
        worker += 1;
        runStamp = `${stamp}-worker-${worker}`;
      }
      let eventsPath = path.join(logDir, `play-${runStamp}.jsonl`);
      let seatLogs = this.runLogs.get(seat.name);
      if (!seatLogs) this.runLogs.set(seat.name, (seatLogs = []));
      seatLogs.push({ path: eventsPath, engine: plan.logSubdir });
      try {
        fs.writeFileSync(
          `${eventsPath}.meta`,
          JSON.stringify({
            runStamp,
            name: seat.name,
            role: seat.role,
            engine: seat.engine,
            model: seat.model,
            effort: seat.effort,
            startedAt: new Date().toISOString(),
          }),
        );
      } catch {
        // ignore
      }

      let out = fs.createWriteStream(eventsPath, { flags: "w" });
      let err = fs.createWriteStream(
        eventsPath.replace(/\.jsonl$/, ".stderr.log"),
        { flags: "w" },
      );
      out.on("error", () => {});
      err.on("error", () => {});

      if (seat.role === "director" && seat.cadenceTicks > 0)
        seat.lastLaunchTick = await readWorldTick(this.opts);

      let child = spawn(plan.command, plan.args, {
        cwd: seatDir,
        stdio: ["ignore", "pipe", "pipe"],
        // Preload tool schemas. Once the dead harness tools are cut (see
        // DEAD_HARNESS_TOOLS in crew-policy.mjs) a seat's whole surface is
        // small enough that preloading and deferring produce the same prefix -
        // measured at ~11.17K either way - so deferring buys no prefix back
        // and still costs the ToolSearch turns a fresh process would spend
        // rediscovering its own tools before it can act.
        env: { ...process.env, ENABLE_TOOL_SEARCH: "false" },
      });
      child.stdout?.pipe(out);
      child.stderr?.pipe(err);
      seat.child = child;
      seat.childPid = child.pid ?? null;
      seat.state = "running";
      seat.spawnedAt = Date.now();
      this.notifySeat(seat);

      child.on("error", (error) => {
        seat.error = error instanceof Error ? error.message : String(error);
        if (child.pid == null) settle(error);
      });
      child.once("exit", () => settle());
    } catch (error) {
      settle(error);
    }
  }

  async liveness(name) {
    try {
      let state = await readWorldState(this.opts);
      let agents = Object.values(state.state?.agents ?? {});
      let joined = false;
      let alive = false;
      for (let agent of agents) {
        if (agent.name !== name) continue;
        joined = true;
        if (agent.alive) alive = true;
      }
      return { joined, alive };
    } catch {
      return { joined: false, alive: false };
    }
  }

  onExit(seat, spawnError) {
    if (seat.stopTimer) {
      clearTimeout(seat.stopTimer);
      seat.stopTimer = null;
    }
    seat.child = null;
    seat.childPid = null;
    if (spawnError)
      seat.error =
        spawnError instanceof Error ? spawnError.message : String(spawnError);

    if (this.draining || seat.stopping) {
      this.retire(seat);
      return;
    }

    // A healthy director exit completes one pass. Scheduled directors remain
    // process-free until their next launch tick; event-woken directors start a
    // fresh process after the ordinary relaunch gap. Fast failures retry on the
    // short gap so a broken CLI reaches the storm guard promptly.
    if (seat.role === "director") {
      let now = Date.now();
      let ranMs = seat.spawnedAt ? now - seat.spawnedAt : 0;
      let healthy = !spawnError && ranMs >= CONFIG.storm.healthyRunMs;
      if (healthy) seat.restartTimes = [];
      else {
        seat.restartTimes.push(now);
        seat.restartTimes = seat.restartTimes.filter(
          (at) => now - at <= CONFIG.storm.windowMs,
        );
        if (seat.restartTimes.length >= CONFIG.storm.maxRestarts) {
          seat.state = "errored";
          this.notifySeat(seat);
          console.error(
            `[crew] ${seat.name} exited ${seat.restartTimes.length} times in under ${Math.round(CONFIG.storm.healthyRunMs / 1000)}s - giving up${seat.error ? ` (${seat.error})` : ""}`,
          );
          return;
        }
      }
      if (healthy && seat.cadenceTicks > 0) {
        seat.nextLaunchTick = Number.isFinite(seat.lastLaunchTick)
          ? seat.lastLaunchTick + seat.cadenceTicks
          : null;
        seat.state = "scheduled";
        this.notifySeat(seat);
        seat.relaunchTimer = setTimeout(
          () => void this.checkDirectorCadence(seat),
          CONFIG.relaunchDelayMs,
        );
      } else {
        // An unhealthy exit keeps the short gap so a broken CLI reaches the
        // storm guard promptly; only a completed pass pays the wake throttle.
        let delay = healthy
          ? wakeDelayMs(seat.minWakeMs, ranMs, CONFIG.relaunchDelayMs)
          : CONFIG.relaunchDelayMs;
        seat.state = "relaunching";
        seat.nextLaunchTick = null;
        seat.nextLaunchAt = now + delay;
        this.notifySeat(seat);
        seat.relaunchTimer = setTimeout(() => this.spawnSeat(seat), delay);
      }
      return;
    }

    void this.liveness(seat.name).then((liveness) => {
      if (!this.seats.has(seat.name)) return;
      if (liveness.joined) seat.everJoined = true;
      // Joined and then died: the engine refuses to reclaim a dead name, so a
      // relaunch would only spin failed join_game calls. Retire the seat.
      if (liveness.joined && !liveness.alive) {
        console.log(`[crew] ${seat.name} has died - retiring the seat`);
        this.retire(seat);
        return;
      }
      let now = Date.now();
      seat.restartTimes.push(now);
      seat.restartTimes = seat.restartTimes.filter(
        (at) => now - at <= CONFIG.storm.windowMs,
      );
      // Restart-storm guard: repeated exits before the seat ever joined means
      // the CLI is failing to start (bad auth, missing binary). Stop
      // relaunching and surface it.
      if (
        !seat.everJoined &&
        seat.restartTimes.length >= CONFIG.storm.maxRestarts
      ) {
        seat.state = "errored";
        console.error(
          `[crew] ${seat.name} exited ${seat.restartTimes.length} times without joining - giving up${seat.error ? ` (${seat.error})` : ""}`,
        );
        return;
      }
      seat.state = "relaunching";
      this.notifySeat(seat);
      seat.relaunchTimer = setTimeout(
        () => this.spawnSeat(seat),
        CONFIG.relaunchDelayMs,
      );
    });
  }

  async checkDirectorCadence(seat) {
    seat.relaunchTimer = null;
    if (this.draining || seat.stopping || !this.seats.has(seat.name)) return;
    try {
      let tick = await readWorldTick(this.opts);
      if (!Number.isFinite(seat.nextLaunchTick))
        seat.nextLaunchTick = tick + seat.cadenceTicks;
      if (tick >= seat.nextLaunchTick) {
        void this.spawnSeat(seat);
        return;
      }
      this.notifySeat(seat);
    } catch (error) {
      seat.error = error instanceof Error ? error.message : String(error);
      this.notifySeat(seat);
    }
    seat.relaunchTimer = setTimeout(
      () => void this.checkDirectorCadence(seat),
      CONFIG.directorPollMs,
    );
  }

  retire(seat) {
    if (seat.relaunchTimer) clearTimeout(seat.relaunchTimer);
    if (seat.stopTimer) clearTimeout(seat.stopTimer);
    seat.relaunchTimer = null;
    seat.stopTimer = null;
    this.seats.delete(seat.name);
    if (!this.seats.size && this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
    let waiters = seat.onRetire;
    seat.onRetire = [];
    for (let resolve of waiters) resolve();
  }

  stopSeat(seat) {
    return new Promise((resolve) => {
      if (!this.seats.has(seat.name)) {
        resolve();
        return;
      }
      seat.stopping = true;
      if (seat.relaunchTimer) {
        clearTimeout(seat.relaunchTimer);
        seat.relaunchTimer = null;
      }
      seat.onRetire.push(resolve);
      // The child's own SIGTERM handling can't be relied on to disconnect
      // its MCP session cleanly, so tell the world directly - a relaunch
      // right after this seat stops should see the body as idle, not wait
      // out the idle sweep.
      if (seat.role === "character") void releaseAgentNow(seat.name, this.opts);
      if (seat.child) {
        seat.state = "stopping";
        this.notifySeat(seat);
        // SIGTERM first so the seat can call leave_game and vacate cleanly;
        // SIGKILL only if it ignores the grace window.
        seat.child.kill("SIGTERM");
        seat.stopTimer = setTimeout(() => {
          seat.child?.kill("SIGKILL");
        }, CONFIG.stopGraceMs);
      } else {
        this.retire(seat);
      }
    });
  }

  async drain() {
    this.draining = true;
    await Promise.all(
      [...this.seats.values()].map((seat) => this.stopSeat(seat)),
    );
    let names = [...this.runLogs.keys()];
    let totals = zeroUsage();
    for (let name of names) {
      let usage = readRunUsage(this.runLogs.get(name) ?? []);
      addUsage(totals, usage);
      let line = formatUsage(usage);
      if (line) console.log(`[crew] ${name}: ${line}`);
    }
    if (names.length > 1) {
      let line = formatUsage(totals);
      if (line) console.log(`[crew] total: ${line}`);
    }
  }

  // One timer catches characters that die mid-run: their body is gone from the
  // world while the CLI still spins. SIGTERM the child; its exit handler sees
  // joined && !alive and retires the seat.
  ensureLivenessTimer() {
    if (this.livenessTimer || !this.seats.size) return;
    this.livenessTimer = setInterval(async () => {
      for (let seat of this.seats.values()) {
        if (!seat.child || seat.stopping || seat.role === "director") continue;
        let liveness = await this.liveness(seat.name);
        if (liveness.joined) seat.everJoined = true;
        if (liveness.joined && !liveness.alive) seat.child.kill("SIGTERM");
      }
    }, CONFIG.livenessPollMs);
  }
}

// --- crew batch files ---------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function batchFile(role, pid = process.pid) {
  return path.join(CONFIG.batchDirs[role], `${pid}.json`);
}

function writeBatchFile(role, details) {
  let directory = CONFIG.batchDirs[role];
  let file = batchFile(role);
  let temporary = `${file}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    temporary,
    JSON.stringify({ pid: process.pid, role, ...details }),
  );
  fs.renameSync(temporary, file);
}

function clearBatchFile(role) {
  try {
    fs.rmSync(batchFile(role), { force: true });
  } catch {
    // ignore
  }
}

// Every live batch for a role, pruning files left by supervisors that exited
// without draining.
function readCrewBatches(role) {
  let batches = [];
  let directory = CONFIG.batchDirs[role];
  for (let entry of safeReaddir(directory)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let file = path.join(directory, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(safeReadFile(file));
    } catch {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!pidAlive(parsed.pid)) {
      fs.rmSync(file, { force: true });
      continue;
    }
    batches.push({ ...parsed, names: parsed.names ?? [], file });
  }
  return batches;
}

// --- commands -----------------------------------------------------------

function parseArgs(argv) {
  let command = argv[0];
  let opts = {};
  for (let i = 1; i < argv.length; i++) {
    let arg = argv[i];
    if (!arg.startsWith("--")) continue;
    let key = arg.slice(2);
    let booleans = ["no-ocean"];
    if (booleans.includes(key)) opts[key] = true;
    else opts[key] = argv[++i];
  }
  return { command, opts };
}

function seatRequest(opts, role) {
  return {
    role,
    count: opts.count ? Number(opts.count) : 1,
    engine: opts.engine,
    model: opts.model,
    effort: opts.effort,
    persona: opts.persona,
    cadenceTicks: opts["cadence-ticks"],
    minWakeMs: opts["min-wake-ms"],
    passTicks: opts["pass-ticks"],
    name: opts.name,
    names: opts.names
      ? opts.names
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
      : undefined,
    instructions: opts.instructions,
    ocean: !opts["no-ocean"],
    excludeNames: opts.excludeNames,
  };
}

async function runLimit(opts) {
  let maxTicks = parseMaxTicks(opts["max-ticks"]);
  if (maxTicks === 0) return { maxTicks, startTick: null, stopTick: null };
  let startTick = await readWorldTick(opts);
  return { maxTicks, startTick, stopTick: targetTick(startTick, maxTicks) };
}

// Supervise this crew until every seat retires, a signal arrives, or the tick
// budget has elapsed from this crew's launch tick. Reaching the cap pauses the
// world before draining; a plain stop leaves the clock alone.
async function supervise(crew, opts, role, limit, names) {
  if (role === "characters") writeBatchFile(role, { names, ...limit });
  let drained = false;
  let finish = async (code, pause) => {
    if (drained) return;
    drained = true;
    if (pause)
      await api("POST", "/api/pause", opts, { paused: true }).catch(() => {});
    console.log(`[crew] draining ${role}...`);
    await crew.drain();
    clearBatchFile(role);
    process.exit(code);
  };
  process.once("SIGINT", () => void finish(0, false));
  process.once("SIGTERM", () => void finish(0, false));

  let pollMs = opts["poll-ms"] ? Number(opts["poll-ms"]) : 5000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (!crew.seats.size) {
      console.log(`[crew] every ${role} seat has retired.`);
      await finish(0, false);
    }
    if (limit.stopTick !== null) {
      try {
        let state = await readWorldState(opts);
        let tick = state.state?.tick ?? 0;
        if (state.liveness?.ended || tick >= limit.stopTick) {
          console.log(
            `[crew] ran ${Math.max(0, tick - limit.startTick)} ticks (world tick ${tick}) - pausing and draining.`,
          );
          await finish(0, true);
        }
      } catch {
        // transient; keep watching
      }
    }
  }
}

async function cmdDirector(opts) {
  let limit = await runLimit(opts);
  let excludeNames = readCrewBatches("director").flatMap(
    (batch) => batch.names,
  );
  let crew = new Crew({
    ...opts,
    onSeatChange: (seat) =>
      writeBatchFile("director", {
        names: [seat.name],
        persona: seat.persona,
        cadenceTicks: seat.cadenceTicks,
        minWakeMs: seat.minWakeMs,
        state: seat.state,
        childPid: seat.childPid,
        lastLaunchTick: seat.lastLaunchTick,
        nextLaunchTick: seat.nextLaunchTick,
        nextLaunchAt: seat.nextLaunchAt,
        ...limit,
      }),
  });
  let launched = await crew.launch(
    seatRequest({ ...opts, count: 1, excludeNames }, "director"),
  );
  let seat = crew.seats.get(launched[0]);
  console.log(
    limit.maxTicks > 0
      ? `[crew] ${seat.name} seated - ${limit.maxTicks} run ticks, stopping at world tick ${limit.stopTick}.`
      : `[crew] ${seat.name} seated - unbounded.`,
  );
  console.log(
    seat.cadenceTicks > 0
      ? `[crew] ${seat.name} launches every ${seat.cadenceTicks} world ticks.`
      : seat.minWakeMs > 0
        ? `[crew] ${seat.name} is event-woken, at most once every ${(seat.minWakeMs / 1000).toFixed(seat.minWakeMs % 1000 ? 1 : 0)}s.`
        : `[crew] ${seat.name} is event-woken.`,
  );
  await supervise(crew, opts, "director", limit, launched);
}

// Every characters launch is its own additive batch, so adding more seats or
// filling an empty one never needs to stop whatever is already running.
async function cmdCharacters(opts) {
  let limit = await runLimit(opts);
  let crew = new Crew(opts);
  let excludeNames = readCrewBatches("characters").flatMap(
    (batch) => batch.names,
  );
  let launched = await crew.launch(
    seatRequest({ ...opts, excludeNames }, "character"),
  );
  if (!launched.length) {
    console.error(
      "error: no seats launched (name pool exhausted or name taken)",
    );
    process.exit(1);
  }
  console.log(
    limit.maxTicks > 0
      ? `[crew] ${launched.length} character(s) seated - ${limit.maxTicks} run ticks, stopping at world tick ${limit.stopTick}.`
      : `[crew] ${launched.length} character(s) seated - unbounded.`,
  );
  await supervise(crew, opts, "characters", limit, launched);
}

let ROLES = ["director", "characters"];

async function cmdStop(target, name) {
  let roles = target ? [target] : ROLES;
  if (target && !ROLES.includes(target)) {
    console.error(`unknown crew: ${target} (director|characters)`);
    process.exit(1);
  }
  for (let role of roles) {
    let batches = readCrewBatches(role);
    if (name) batches = batches.filter((batch) => batch.names.includes(name));
    if (!batches.length) {
      console.log(
        name
          ? `no ${role} crew has a seat named ${name}`
          : `no ${role} crew is running`,
      );
      continue;
    }
    for (let batch of batches) {
      process.kill(batch.pid, "SIGTERM");
      console.log(
        `sent SIGTERM to ${role} crew pid ${batch.pid} (${batch.names.join(", ")}); it drains and reports usage.`,
      );
    }
  }
}

async function cmdStatus() {
  for (let role of ROLES) {
    let batches = readCrewBatches(role);
    if (!batches.length) {
      console.log(`no ${role} crew is running`);
      continue;
    }
    for (let batch of batches)
      console.log(
        `${role} crew running (pid ${batch.pid}): ${batch.names.join(", ")}${batch.state ? ` · ${batch.state}` : ""}`,
      );
  }
}

function printHelp() {
  console.log(`Agent Island crew supervisor - launches and babysits the LLM CLIs.

Every launch is an independent crew. Directors run one pass per LLM process,
exit, and relaunch on their own cadence. World setup (scenario, reset, clock,
pause/resume) lives in scripts/world.mjs.

USAGE
  node scripts/crew.mjs director   [--cadence-ticks N] [--max-ticks N] [seat options]
  node scripts/crew.mjs characters [--count N] [--max-ticks N] [seat options]
  node scripts/crew.mjs stop [director|characters [name]]
  node scripts/crew.mjs status

Crews are additive: run the command again to add another character batch or a
different director. \`stop <role> <name>\` stops only that seat's crew.

SEAT OPTIONS
  --engine codex|claude   --model NAME   --effort low|medium|high|xhigh|max
  --persona NAME          --name NAME    --names A,B,C   --no-ocean
  --cadence-ticks N       Override the persona's wake cadence; 0 = event-woken
  --min-wake-ms N         Floor between an event-woken director's passes, in
                          wall-clock ms (default: the persona's
                          wake.min_interval_ms, else unthrottled; off = none).
                          Measured from the last pass's start, so a slow pass
                          pays nothing. Events queue during the wait, so a
                          throttled seat batches the backlog into one pass.
  --pass-ticks N          World time one character pass covers before it wraps
                          up and relaunches (default 150, off = unbounded).
                          Context cost grows with the square of a pass's turns,
                          so long passes are far more expensive than short ones.
  --instructions TEXT     --url http://host:port

Without --name/--names, characters auto-pick names: idle colonists already
alive in the world come first (reliably reclaimed on a restart), then
previously-played names with local evidence, then fresh ones.

DEFAULTS
  characters: claude / haiku / low, OCEAN on, 150-tick passes
  directors:  model, effort, and wake policy come from the persona's
              frontmatter in agents/directors/<NAME>.md; a persona without a
              wake block is not a seat
  both run for 500 ticks after launch (--max-ticks off = unbounded)`);
}

async function main() {
  let { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "director":
      return cmdDirector(opts);
    case "characters":
      return cmdCharacters(opts);
    case "stop":
      return cmdStop(process.argv[3], process.argv[4]);
    case "status":
      return cmdStatus();
    case "help":
    case undefined:
      printHelp();
      return;
    default:
      console.error(`unknown command: ${command} (try help)`);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
