#!/usr/bin/env node
// The crew supervisor: launches and babysits the LLM CLI processes that play
// Agent Island. This is the AI-native replacement for the old in-server
// launcher - the server knows nothing about LLMs; this script owns the child
// processes, their workdirs and memory files, death-aware reincarnation, the
// restart-storm guard, and the token report on drain.
//
// Usage:
//   node scripts/crew.mjs director   [--max-ticks N] [seat options]
//   node scripts/crew.mjs characters [--count N] [--max-ticks N] [seat options]
//   node scripts/crew.mjs stop [director|characters]   SIGTERM crew(s)
//   node scripts/crew.mjs status                       Show running crews
//
// The director and characters are always launched as SEPARATE crews with
// separate pidfiles, so seat options never bleed across roles. World setup
// (scenario, reset, clock, pause/resume) lives in scripts/world.mjs.
//
// Seat options:
//   --engine codex|claude      (default claude)
//   --model NAME               (default haiku for characters and director)
//   --effort low|medium|high|xhigh|max   (characters low; director medium)
//   --persona NAME             agents/characters|directors/<NAME>.md
//   --name NAME                Explicit seat name (single character)
//   --no-ocean                 Skip the OCEAN personality roll (on by default)
//   --instructions TEXT        Extra operator text appended to the prompt
//   --url http://host:port     Server base (env AGENT_ISLAND_URL, default :3000)
//
// The crew process stays in the foreground supervising its children; SIGTERM
// or Ctrl-C drains them (SIGTERM, grace window, SIGKILL) and prints per-seat
// token usage. Run it in the background from a skill or shell.

import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { api, baseUrl } from "./world.mjs";

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
    process.env.AGENT_ISLAND_CHARACTERS_DIR ?? "data/characters",
  ),
  directorsDir: path.resolve(
    process.env.AGENT_ISLAND_DIRECTORS_DIR ?? "data/directors",
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
  pidFiles: {
    director: path.resolve("data/.crew-director.pid"),
    characters: path.resolve("data/.crew-characters.pid"),
  },
  relaunchDelayMs: numEnv("AGENT_ISLAND_CREW_RELAUNCH_MS", 3000),
  launchStaggerMs: numEnv("AGENT_ISLAND_CREW_STAGGER_MS", 3000),
  stopGraceMs: numEnv("AGENT_ISLAND_CREW_STOP_GRACE_MS", 10000),
  livenessPollMs: numEnv("AGENT_ISLAND_CREW_LIVENESS_MS", 5000),
  storm: {
    maxRestarts: numEnv("AGENT_ISLAND_CREW_STORM_MAX", 3),
    windowMs: numEnv("AGENT_ISLAND_CREW_STORM_WINDOW_MS", 20000),
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
      "--model",
      options.model,
      "--effort",
      options.effort,
      "--permission-mode",
      CONFIG.defaults.claude.permissionMode,
      // Pre-approve every Agent Island tool; hard-block shell/sub-agent/
      // scheduling so the prohibitions in the persona are load-bearing.
      "--allowedTools",
      "mcp__agent-island",
      "--disallowedTools",
      "Bash,Agent,Task,TaskCreate,Workflow,ScheduleWakeup",
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

function readSeatUsage(seatDir) {
  let total = zeroUsage();
  for (let engine of ["codex", "claude"]) {
    let dir = path.join(seatDir, "logs", engine);
    for (let entry of safeReaddir(dir)) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith("play-") ||
        !entry.name.endsWith(".jsonl")
      )
        continue;
      let lines = safeReadFile(path.join(dir, entry.name)).split("\n");
      addUsage(
        total,
        engine === "claude"
          ? usageFromClaudeLog(lines)
          : usageFromCodexLog(lines),
      );
    }
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
    this.livenessTimer = null;
    this.draining = false;
  }

  async launch(request) {
    let role = request.role === "director" ? "director" : "character";
    let roleDefaults = CONFIG.defaults[role];
    let engine = ["claude", "codex"].includes(request.engine ?? "")
      ? request.engine
      : roleDefaults.engine;
    let model =
      request.model?.trim() ||
      (engine === roleDefaults.engine
        ? roleDefaults.model
        : engine === "claude"
          ? CONFIG.defaults.claude.model
          : CONFIG.defaults.codex[role]);
    let effort = ["low", "medium", "high", "xhigh", "max"].includes(
      request.effort ?? "",
    )
      ? request.effort
      : roleDefaults.effort;
    let count = Math.max(1, Math.floor(request.count ?? 1));
    let persona = request.persona?.trim() || null;
    if (persona && !/^[A-Za-z0-9_-]+$/.test(persona))
      throw new Error(`Invalid persona name: ${persona}`);

    let personaFile;
    let names;
    if (role === "director") {
      personaFile = persona
        ? path.join(CONFIG.personasDir, `${persona}.md`)
        : CONFIG.defaultDirectorPersona;
      let stem = persona ?? path.basename(personaFile, ".md");
      let name =
        request.name?.trim() || stem.charAt(0).toUpperCase() + stem.slice(1);
      names = this.seats.has(name) ? [] : [name];
    } else {
      personaFile = persona
        ? path.join(CONFIG.characterPromptsDir, `${persona}.md`)
        : CONFIG.defaultCharacterPrompt;
      if (request.name?.trim()) {
        names = this.seats.has(request.name.trim())
          ? []
          : [request.name.trim()];
      } else {
        let pool = buildNamePool();
        let taken = new Set(this.seats.keys());
        names = [];
        for (let i = 0; i < count; i++) {
          let name = pool.find((candidate) => !taken.has(candidate));
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
        instructions: request.instructions?.trim() ?? "",
        ocean: role === "character" && request.ocean !== false,
        child: null,
        state: "starting",
        everJoined: false,
        stopping: false,
        restartTimes: [],
        relaunchTimer: null,
        stopTimer: null,
        onRetire: [],
      };
      this.seats.set(name, seat);
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

  seatBaseDir(seat) {
    return seat.role === "director"
      ? CONFIG.directorsDir
      : CONFIG.charactersDir;
  }

  seatDir(seat) {
    return path.join(this.seatBaseDir(seat), seat.name);
  }

  async buildPrompt(seat) {
    let prompt = fs.readFileSync(seat.personaFile, "utf8");
    let lead =
      seat.role === "director"
        ? `Your launcher seats you as the resident director named ${seat.name}.\nConnect, join_as_gm, and stay in your wake loop. Keep ./memory.md current when durable knowledge or your intent changes.`
        : `Your launcher gives you this character name: ${seat.name}\nKeep running continuously. Keep your memory current when durable knowledge or your intent changes.`;
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
      let state = await api("GET", "/api/state", this.opts);
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
      out.on("error", () => { });
      err.on("error", () => { });

      let child = spawn(plan.command, plan.args, {
        cwd: seatDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      child.stdout?.pipe(out);
      child.stderr?.pipe(err);
      seat.child = child;
      seat.state = "running";

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
      let state = await api("GET", "/api/state", this.opts);
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
    if (spawnError)
      seat.error =
        spawnError instanceof Error ? spawnError.message : String(spawnError);

    if (this.draining || seat.stopping) {
      this.retire(seat);
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
      seat.relaunchTimer = setTimeout(
        () => this.spawnSeat(seat),
        CONFIG.relaunchDelayMs,
      );
    });
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
      if (seat.child) {
        seat.state = "stopping";
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
    let names = [...this.seats.keys()];
    let dirs = new Map(
      [...this.seats.values()].map((seat) => [seat.name, this.seatDir(seat)]),
    );
    await Promise.all(
      [...this.seats.values()].map((seat) => this.stopSeat(seat)),
    );
    let totals = zeroUsage();
    for (let name of names) {
      let usage = readSeatUsage(dirs.get(name));
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

// --- pidfile ------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(role) {
  let raw = safeReadFile(CONFIG.pidFiles[role]).trim();
  let pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function writePidFile(role) {
  fs.mkdirSync(path.dirname(CONFIG.pidFiles[role]), { recursive: true });
  fs.writeFileSync(CONFIG.pidFiles[role], String(process.pid));
}

function clearPidFile(role) {
  try {
    fs.rmSync(CONFIG.pidFiles[role], { force: true });
  } catch {
    // ignore
  }
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
    name: opts.name,
    instructions: opts.instructions,
    ocean: !opts["no-ocean"],
  };
}

function guardSingleCrew(role) {
  let pid = readPidFile(role);
  if (pid && pidAlive(pid) && pid !== process.pid) {
    console.error(
      `error: a ${role} crew is already running (pid ${pid}). Stop it first: node scripts/crew.mjs stop ${role}`,
    );
    process.exit(1);
  }
}

// Supervise this crew until every seat retires, a signal arrives, or the tick
// cap is reached (max-ticks > 0). Reaching the cap pauses the world before
// draining; a plain stop leaves the clock alone.
async function supervise(crew, opts, role, maxTicks) {
  writePidFile(role);
  let drained = false;
  let finish = async (code, pause) => {
    if (drained) return;
    drained = true;
    if (pause)
      await api("POST", "/api/pause", opts, { paused: true }).catch(() => { });
    console.log(`[crew] draining ${role}...`);
    await crew.drain();
    clearPidFile(role);
    process.exit(code);
  };
  process.once("SIGINT", () => void finish(0, false));
  process.once("SIGTERM", () => void finish(0, false));

  let pollMs = opts["poll-ms"] ? Number(opts["poll-ms"]) : 5000;
  for (; ;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    if (!crew.seats.size) {
      console.log(`[crew] every ${role} seat has retired.`);
      await finish(0, false);
    }
    if (maxTicks > 0) {
      try {
        let state = await api("GET", "/api/state", opts);
        let tick = state.state?.tick ?? 0;
        if (state.liveness?.ended || tick >= maxTicks) {
          console.log(`[crew] reached tick ${tick} - pausing and draining.`);
          await finish(0, true);
        }
      } catch {
        // transient; keep watching
      }
    }
  }
}

function parseMaxTicks(opts) {
  return opts["max-ticks"] === "off" ? 0 : Number(opts["max-ticks"] ?? 2000);
}

async function cmdDirector(opts) {
  guardSingleCrew("director");
  let crew = new Crew(opts);
  await crew.launch(seatRequest({ ...opts, count: 1 }, "director"));
  let maxTicks = parseMaxTicks(opts);
  console.log(
    maxTicks > 0
      ? `[crew] director seated - watching for tick ${maxTicks}.`
      : "[crew] director seated - unbounded.",
  );
  await supervise(crew, opts, "director", maxTicks);
}

async function cmdCharacters(opts) {
  guardSingleCrew("characters");
  let crew = new Crew(opts);
  let launched = await crew.launch(seatRequest(opts, "character"));
  if (!launched.length) {
    console.error(
      "error: no seats launched (name pool exhausted or name taken)",
    );
    process.exit(1);
  }
  let maxTicks = parseMaxTicks(opts);
  console.log(
    maxTicks > 0
      ? `[crew] ${launched.length} character(s) seated - watching for tick ${maxTicks}.`
      : `[crew] ${launched.length} character(s) seated - unbounded.`,
  );
  await supervise(crew, opts, "characters", maxTicks);
}

const ROLES = ["director", "characters"];

async function cmdStop(target) {
  let roles = target ? [target] : ROLES;
  if (target && !ROLES.includes(target)) {
    console.error(`unknown crew: ${target} (director|characters)`);
    process.exit(1);
  }
  for (let role of roles) {
    let pid = readPidFile(role);
    if (!pid || !pidAlive(pid)) {
      console.log(`no ${role} crew is running`);
      clearPidFile(role);
      continue;
    }
    process.kill(pid, "SIGTERM");
    console.log(
      `sent SIGTERM to ${role} crew pid ${pid}; it drains and reports usage.`,
    );
  }
}

async function cmdStatus() {
  for (let role of ROLES) {
    let pid = readPidFile(role);
    if (pid && pidAlive(pid)) console.log(`${role} crew running (pid ${pid})`);
    else console.log(`no ${role} crew is running`);
  }
}

function printHelp() {
  console.log(`Agent Island crew supervisor - launches and babysits the LLM CLIs.

The director and characters are separate crews, launched separately; seat
options apply only to the crew being launched. World setup (scenario, reset,
clock, pause/resume) lives in scripts/world.mjs.

USAGE
  node scripts/crew.mjs director   [--max-ticks N] [seat options]
  node scripts/crew.mjs characters [--count N] [--max-ticks N] [seat options]
  node scripts/crew.mjs stop [director|characters]
  node scripts/crew.mjs status

SEAT OPTIONS
  --engine codex|claude   --model NAME   --effort low|medium|high|xhigh|max
  --persona NAME          --name NAME    --no-ocean
  --instructions TEXT     --url http://host:port

DEFAULTS
  characters: codex / gpt-5.4-mini / low, OCEAN on
  director:   codex / gpt-5.6-luna / medium, persona oracle
  both drain at tick 2000 (--max-ticks off = unbounded)`);
}

async function main() {
  let { command, opts } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "director":
      return cmdDirector(opts);
    case "characters":
      return cmdCharacters(opts);
    case "stop":
      return cmdStop(process.argv[3]);
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

main();
