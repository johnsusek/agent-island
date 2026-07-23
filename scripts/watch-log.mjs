#!/usr/bin/env node
// Watch one seat's play log as it happens. The crew writes a fresh
// play-<stamp>-worker-N.jsonl under <home>/{characters,directors}/<Name>/logs/<engine>/
// every time a seat is (re)launched, in whichever engine's wire format that
// seat is running - claude and codex log completely different shapes. This
// script finds the seat, picks the newest log, renders it in either dialect,
// and keeps following: when the seat dies and reincarnates into a new log file
// it switches over on its own.
//
// Usage:
//   scripts/watch-log.mjs Linden                 Newest log for that seat
//   scripts/watch-log.mjs character Linden       Same, role made explicit
//   scripts/watch-log.mjs director Oracle
//   scripts/watch-log.mjs                        The most recently written seat
//   scripts/watch-log.mjs --list                 Seats and their latest logs
//
// Options:
//   --engine claude|codex   Restrict to one engine's logs (default: newest of any)
//   -n N                    Replay only the last N lines before following
//   --tail                  Skip the backlog entirely; only new lines
//   --no-follow             Print what is there and exit
//   --width N               Clip payloads at N chars (default 500, 0 disables)
//   --raw                   Emit the raw JSONL lines instead of rendering

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Mirrored from src/paths.ts - this runs under plain node, not tsx.
function agentIslandHome() {
  let raw = process.env.AGENT_ISLAND_HOME?.trim();
  if (raw) {
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
    return path.resolve(raw);
  }
  return path.join(os.homedir(), ".agent-island");
}

const ROLES = {
  character: process.env.AGENT_ISLAND_CHARACTERS_DIR ??
    path.join(agentIslandHome(), "characters"),
  director: process.env.AGENT_ISLAND_DIRECTORS_DIR ??
    path.join(agentIslandHome(), "directors"),
};

const POLL_MS = 300;

// --- argument parsing ---------------------------------------------------

function parseArgs(argv) {
  let opts = {
    role: null,
    name: null,
    engine: null,
    lines: Infinity,
    follow: true,
    width: 500,
    raw: false,
    list: false,
  };
  let positional = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === "--list") opts.list = true;
    else if (arg === "--raw") opts.raw = true;
    else if (arg === "--tail") opts.lines = 0;
    else if (arg === "--no-follow") opts.follow = false;
    else if (arg === "-n") opts.lines = Number(argv[++i]);
    else if (arg === "--engine") opts.engine = argv[++i];
    else if (arg === "--width") opts.width = Number(argv[++i]);
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg.startsWith("-")) fail(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  // Leading positional may be the role; anything else is the seat name.
  if (positional.length && positional[0] in ROLES) opts.role = positional.shift();
  else if (positional.length && positional[0] === "characters") {
    opts.role = "character";
    positional.shift();
  } else if (positional.length && positional[0] === "directors") {
    opts.role = "director";
    positional.shift();
  }
  if (positional.length) opts.name = positional.shift();
  if (positional.length) fail(`Unexpected argument ${positional[0]}`);
  return opts;
}

function fail(message) {
  process.stderr.write(`watch-log: ${message}\n`);
  process.exit(1);
}

// --- seat and log discovery ---------------------------------------------

// Every seat that has ever written a log, newest activity first.
function findSeats() {
  let seats = [];
  for (let [role, dir] of Object.entries(ROLES)) {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (let name of names) {
      let logs = findLogs(path.join(dir, name, "logs"));
      if (logs.length) seats.push({ role, name, dir: path.join(dir, name), logs });
    }
  }
  seats.sort((a, b) => b.logs[0].mtime - a.logs[0].mtime);
  return seats;
}

// All play-*.jsonl under a seat's logs/<engine>/ dirs, newest first.
function findLogs(logsDir, engine = null) {
  let engines = [];
  try {
    engines = fs.readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  if (engine) engines = engines.filter((name) => name === engine);
  let logs = [];
  for (let name of engines) {
    let dir = path.join(logsDir, name);
    for (let file of fs.readdirSync(dir)) {
      if (!file.startsWith("play-") || !file.endsWith(".jsonl")) continue;
      let full = path.join(dir, file);
      let stat = statOr(full);
      if (stat) logs.push({ path: full, engine: name, mtime: stat.mtimeMs });
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  return logs;
}

function statOr(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function resolveSeat(opts) {
  let seats = findSeats();
  if (!seats.length) {
    fail(`No seat logs under ${agentIslandHome()} - has the crew run yet?`);
  }
  let matches = seats;
  if (opts.role) matches = matches.filter((seat) => seat.role === opts.role);
  if (opts.name) {
    let wanted = opts.name.toLowerCase();
    let exact = matches.filter((seat) => seat.name.toLowerCase() === wanted);
    let prefix = matches.filter((seat) => seat.name.toLowerCase().startsWith(wanted));
    matches = exact.length ? exact : prefix;
  }
  if (!matches.length) {
    let known = seats.map((seat) => `${seat.role} ${seat.name}`).join(", ");
    fail(`No seat matching ${[opts.role, opts.name].filter(Boolean).join(" ")}. Known: ${known}`);
  }
  return matches[0];
}

function listSeats(opts) {
  for (let seat of findSeats()) {
    let log = seat.logs.find((entry) => !opts.engine || entry.engine === opts.engine);
    if (!log) continue;
    let when = new Date(log.mtime).toISOString().replace("T", " ").slice(0, 19);
    process.stdout.write(
      `${seat.role.padEnd(9)} ${seat.name.padEnd(12)} ${log.engine.padEnd(6)} ${when}  ${path.basename(log.path)}\n`,
    );
  }
}

// --- rendering ----------------------------------------------------------
// One renderer per engine dialect, ported from the old scripts/watch-log-*.jq.

const COLORS = {
  think: "35",
  text: "36",
  tool: "33",
  rslt: "32",
  file: "34",
  meta: "90",
};

function color(name, text) {
  if (!process.stdout.isTTY) return text;
  return `\x1b[${COLORS[name] ?? "0"}m${text}\x1b[0m`;
}

function makeClip(width) {
  return (value) => {
    let text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    text = text ?? "";
    if (!width || text.length <= width) return text;
    return `${text.slice(0, width)} ...`;
  };
}

function line(kind, body) {
  return `${color(kind, kind.padEnd(5))} ${body}`;
}

function renderClaude(event, clip) {
  if (event.type !== "assistant" && event.type !== "user") return [];
  let out = [];
  for (let block of event.message?.content ?? []) {
    if (block.type === "thinking") out.push(line("think", clip(block.thinking)));
    else if (block.type === "text") out.push(line("text", clip(block.text)));
    else if (block.type === "tool_use") {
      out.push(line("tool", `${block.name} ${clip(JSON.stringify(block.input))}`));
    } else if (block.type === "tool_result") {
      let content = Array.isArray(block.content)
        ? block.content.map((part) => part.text ?? "").join(" ")
        : String(block.content ?? "");
      out.push(line("rslt", clip(content)));
    }
  }
  return out;
}

function renderCodex(event, clip) {
  if (event.type !== "item.completed") return [];
  let item = event.item ?? {};
  if (item.type === "agent_message") return [line("text", clip(item.text ?? ""))];
  if (item.type === "reasoning") return [line("think", clip(item.text ?? ""))];
  if (item.type === "command_execution") {
    return [
      line("tool", item.command ?? ""),
      line("rslt", clip(item.aggregated_output ?? "")),
    ];
  }
  if (item.type === "mcp_tool_call") {
    let name = `${item.server ?? ""}.${item.tool ?? ""}`;
    return [line("tool", `${name} ${clip(JSON.stringify(item.arguments ?? item.input ?? {}))}`)];
  }
  if (item.type === "file_change") return [line("file", clip(JSON.stringify(item)))];
  if (item.type === "web_search") return [line("file", clip(item.query ?? ""))];
  return [];
}

// The engine is known from the log's parent directory, but fall back to
// sniffing the payload so an unfamiliar dir name still renders.
function rendererFor(engine, event) {
  if (engine === "claude") return renderClaude;
  if (engine === "codex") return renderCodex;
  if (event?.type?.startsWith("item.") || event?.type?.startsWith("thread.")) {
    return renderCodex;
  }
  return renderClaude;
}

function emit(rawLine, log, opts, clip) {
  if (opts.raw) {
    process.stdout.write(`${rawLine}\n`);
    return;
  }
  let event;
  try {
    event = JSON.parse(rawLine);
  } catch {
    return;
  }
  for (let out of rendererFor(log.engine, event)(event, clip)) {
    process.stdout.write(`${out}\n`);
  }
}

// --- following ----------------------------------------------------------

// Follow one file, then hand back when a newer log for the same seat shows up.
// Reading is offset-based rather than fs.watch-based: the writer appends from
// another process and partial lines are normal, so we keep a remainder buffer.
async function followSeat(seat, opts) {
  let clip = makeClip(opts.width);
  let logs = seat.logs;
  let current = pickLog(seat, opts);
  if (!current) fail(`No ${opts.engine} logs for ${seat.name}`);
  let offset = 0;
  let remainder = "";
  let first = true;

  for (;;) {
    if (first) {
      banner(seat, current);
      let start = backlogStart(current.path, opts.lines);
      offset = start;
      first = false;
    }
    let stat = statOr(current.path);
    if (stat && stat.size > offset) {
      let handle = fs.openSync(current.path, "r");
      let length = stat.size - offset;
      let buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, offset);
      fs.closeSync(handle);
      offset = stat.size;
      let chunk = remainder + buffer.toString("utf8");
      let parts = chunk.split("\n");
      remainder = parts.pop() ?? "";
      for (let part of parts) {
        if (part.trim()) emit(part, current, opts, clip);
      }
    } else if (stat && stat.size < offset) {
      // Truncated or replaced under us; restart from the top.
      offset = 0;
      remainder = "";
      continue;
    }
    if (!opts.follow) return;

    // A reincarnated seat writes a brand new file; roll onto it once it exists.
    let latest = pickLog(seat, opts, true);
    if (latest && latest.path !== current.path && latest.mtime > current.mtime) {
      current = latest;
      offset = 0;
      remainder = "";
      first = true;
      continue;
    }
    await sleep(POLL_MS);
  }
}

function pickLog(seat, opts, refresh = false) {
  let logs = refresh ? findLogs(path.join(seat.dir, "logs"), opts.engine) : seat.logs;
  if (!refresh && opts.engine) logs = logs.filter((log) => log.engine === opts.engine);
  return logs[0] ?? null;
}

// Byte offset to start reading from so only the last N lines replay.
function backlogStart(file, lines) {
  if (lines === Infinity) return 0;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  if (lines <= 0) return Buffer.byteLength(text, "utf8");
  let all = text.split("\n").filter((entry) => entry.trim());
  let kept = all.slice(-lines).join("\n");
  return Math.max(0, Buffer.byteLength(text, "utf8") - Buffer.byteLength(kept, "utf8"));
}

function banner(seat, log) {
  let label = `${seat.role} ${seat.name} [${log.engine}] ${path.basename(log.path)}`;
  process.stdout.write(`${color("meta", `--- ${label}`)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- entry point --------------------------------------------------------

const HELP = `Usage: scripts/watch-log.mjs [character|director] [Name] [options]

  --list            Show every seat with a log and its newest file
  --engine E        Restrict to claude or codex logs
  -n N              Replay only the last N lines before following
  --tail            Skip the backlog; show only new lines
  --no-follow       Print and exit
  --width N         Clip payloads at N chars (default 500, 0 disables)
  --raw             Emit raw JSONL instead of rendering
`;

let opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (opts.list) {
  listSeats(opts);
  process.exit(0);
}
process.stdout.on("error", () => process.exit(0)); // piping into head etc.
await followSeat(resolveSeat(opts), opts);
