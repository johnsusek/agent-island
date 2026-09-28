// Pure policy helpers for the crew supervisor: persona frontmatter parsing,
// director wake policy, and run-length math. Kept free of process/spawn code
// so tests can exercise the rules directly.
//
// A director persona file opens with a tiny frontmatter block that is the
// single source of orchestration truth for that seat - model, effort, and how
// it wakes:
//
//   ---
//   model: haiku
//   effort: medium
//   wake:
//     events: [speculative_attempt, noun_attempt]
//     every_ticks: 50
//     min_interval_ms: 30000
//   ---
//
// `wake.events` present means event-woken: the process parks once in
// wait_for_world (with these events and the optional every_ticks heartbeat)
// and is relaunched after it acts. `every_ticks` alone means scheduled: the
// supervisor relaunches the seat every N world ticks and it never parks.
// `min_interval_ms` throttles an event-woken seat to at most one pass per that
// many wall-clock milliseconds - a busy event feed then batches into fewer,
// fuller passes instead of one process per attempt. It is ignored by a
// scheduled seat, whose rate is already its tick cadence.
// A persona with no `wake` at all is not a seat - the Illuminator is a
// commissioned helper other seats invoke, and dropping a new .md into
// agents/directors/ without `wake` keeps it launchable-by-hand only.

// Harness tools that sub-agents, scheduling and delegation ride in on. These
// stay blocked everywhere so the prohibitions written into each persona are
// load-bearing rather than advisory.
export const BLOCKED_TOOLS = [
  "Agent",
  "Task",
  "TaskCreate",
  "Workflow",
  "ScheduleWakeup",
];

// Harness tools no seat here can use. A character's whole surface is its MCP
// tools plus Read/Write/Edit for ./memory.md; a director adds one narrowly
// scoped Bash rule for the Illuminator commissioner; the Illuminator and the
// Worldsmith get files and a shell. Nothing in this list serves any of them,
// and every entry is weight either way - a full schema in the process prefix
// when schemas are preloaded, a name to search past when they are deferred.
export const DEAD_HARNESS_TOOLS = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "DesignSync",
  "EnterWorktree",
  "ExitWorktree",
  "Monitor",
  "NotebookEdit",
  "PushNotification",
  "RemoteTrigger",
  "ReportFindings",
  "SendMessage",
  "Skill",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "WebFetch",
  "WebSearch",
];

// The --disallowedTools value for a seat. `extra` carries whatever else this
// role must not reach - a character gets no shell at all, while a director's
// Bash has to stay allowed for the one Illuminator rule to mean anything.
export function disallowedTools(extra = []) {
  return [...BLOCKED_TOOLS, ...DEAD_HARNESS_TOOLS, ...extra].join(",");
}

// Parse the optional frontmatter block at the top of a persona file into
// { meta, body }. The format is deliberately tiny - flat `key: value` pairs
// plus one level of nesting for block keys like `wake:` - so plain node can
// read it without a YAML dependency.
export function parsePersona(source) {
  let text = String(source ?? "");
  let lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return { meta: {}, body: text };
  let close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (close === -1) return { meta: {}, body: text };
  let meta = {};
  let block = null;
  for (let i = 1; i < close; i++) {
    let line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    let match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match)
      throw new Error(`Unparseable persona frontmatter line: ${line.trim()}`);
    let [, indent, key, rawValue] = match;
    if (indent.length === 0) {
      if (rawValue.trim() === "") {
        meta[key] = {};
        block = key;
      } else {
        meta[key] = parseScalar(rawValue);
        block = null;
      }
    } else {
      if (!block)
        throw new Error(
          `Indented persona frontmatter line outside a block: ${line.trim()}`,
        );
      meta[block][key] = parseScalar(rawValue);
    }
  }
  let body = lines
    .slice(close + 1)
    .join("\n")
    .replace(/^\s*\n/, "");
  return { meta, body };
}

function parseScalar(raw) {
  let value = raw.trim();
  if (value === "" || value === "null" || value === "~") return null;
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`Unterminated list: ${value}`);
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter((item) => item.length > 0);
  }
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value.replace(/^["']|["']$/g, "");
}

// Normalize a persona's wake policy, or return null when the persona is not a
// seat (no `wake` frontmatter). Throws on a wake block that declares neither
// events nor a cadence.
export function directorWake(meta) {
  let wake = meta?.wake;
  if (wake == null || typeof wake !== "object") return null;
  let events =
    wake.events == null
      ? []
      : Array.isArray(wake.events)
        ? wake.events.map(String)
        : [String(wake.events)];
  let everyTicks = wake.every_ticks ?? null;
  if (everyTicks !== null && (!Number.isInteger(everyTicks) || everyTicks <= 0))
    throw new Error("wake.every_ticks must be a positive integer.");
  let minIntervalMs = wake.min_interval_ms ?? null;
  if (
    minIntervalMs !== null &&
    (!Number.isInteger(minIntervalMs) || minIntervalMs <= 0)
  )
    throw new Error("wake.min_interval_ms must be a positive integer.");
  if (events.length === 0 && everyTicks === null)
    throw new Error("wake needs events, every_ticks, or both.");
  return { events, everyTicks, minIntervalMs };
}

// The supervisor-side cadence a wake policy implies: 0 (event-woken, relaunch
// as soon as the previous pass exits) when the seat subscribes to events,
// otherwise the scheduled tick interval.
export function wakeCadenceTicks(wake) {
  return wake.events.length > 0 ? 0 : wake.everyTicks;
}

export function parseDirectorCadenceTicks(value, wake) {
  if (value === undefined || value === null || value === "")
    return wakeCadenceTicks(wake);
  let ticks = Number(value);
  if (Number.isInteger(ticks) && ticks >= 0) return ticks;
  throw new Error("--cadence-ticks must be a non-negative integer.");
}

// The floor an event-woken seat puts under its own wake rate, in wall-clock ms.
// 0 (or null) means unthrottled: relaunch as soon as the previous pass exits.
export function parseMinWakeMs(value, wake) {
  if (value === undefined || value === null || value === "")
    return wake?.minIntervalMs ?? 0;
  if (value === "off") return 0;
  let ms = Number(value);
  if (Number.isInteger(ms) && ms >= 0) return ms;
  throw new Error("--min-wake-ms must be a non-negative integer or off.");
}

// How long to hold an event-woken seat before its next pass. The floor is
// measured from when the previous pass STARTED, not when it exited, so the
// throttle is a rate limit rather than an added delay: a pass that already
// took longer than the interval relaunches on the ordinary gap and pays
// nothing. Events are never lost to the wait - the world keeps queuing
// speculative attempts while nobody is parked, so a throttled seat reads the
// whole backlog on its next pass instead of one attempt per process.
export function wakeDelayMs(minWakeMs, ranMs, gapMs) {
  if (!minWakeMs) return gapMs;
  return Math.max(gapMs, minWakeMs - Math.max(0, ranMs));
}

export function parseMaxTicks(value) {
  if (value === "off") return 0;
  let ticks = Number(value ?? 500);
  if (Number.isInteger(ticks) && ticks > 0) return ticks;
  throw new Error("--max-ticks must be a positive integer or off.");
}

export function targetTick(startTick, maxTicks) {
  if (maxTicks <= 0) return null;
  return startTick + maxTicks;
}

// How much world time one character pass covers before the seat wraps up and
// lets its supervisor start a fresh process. `off` (or 0) restores the old
// unbounded pass. A pass costs input tokens quadratically in its own turn
// count - every turn re-reads the whole transcript - so splitting the same
// work across several passes is dramatically cheaper than one long one.
// Measured over 167 runs (0.43 turns/tick, ~216 tokens of context growth per
// turn, ~15 turns spent re-orienting at the start of each pass), ~150 ticks
// sits near the optimum and the curve is flat from 125 to 250. The penalty is
// asymmetric: too small is much worse than too large, because below ~100 the
// fixed re-orientation cost starts to dominate the pass.
export function parsePassTicks(value, fallback = 150) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "off") return 0;
  let ticks = Number(value);
  if (Number.isInteger(ticks) && ticks >= 0) return ticks;
  throw new Error("--pass-ticks must be a non-negative integer or off.");
}
