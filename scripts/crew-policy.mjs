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
//   ---
//
// `wake.events` present means event-woken: the process parks once in
// wait_for_world (with these events and the optional every_ticks heartbeat)
// and is relaunched after it acts. `every_ticks` alone means scheduled: the
// supervisor relaunches the seat every N world ticks and it never parks.
// A persona with no `wake` at all is not a seat - the Illuminator is a
// commissioned helper other seats invoke, and dropping a new .md into
// agents/directors/ without `wake` keeps it launchable-by-hand only.

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
  if (
    everyTicks !== null &&
    (!Number.isInteger(everyTicks) || everyTicks <= 0)
  )
    throw new Error("wake.every_ticks must be a positive integer.");
  if (events.length === 0 && everyTicks === null)
    throw new Error("wake needs events, every_ticks, or both.");
  return { events, everyTicks };
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

export function parseMaxTicks(value) {
  if (value === "off") return 0;
  let ticks = Number(value ?? 2000);
  if (Number.isInteger(ticks) && ticks > 0) return ticks;
  throw new Error("--max-ticks must be a positive integer or off.");
}

export function targetTick(startTick, maxTicks) {
  if (maxTicks <= 0) return null;
  return startTick + maxTicks;
}
