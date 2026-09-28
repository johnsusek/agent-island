#!/usr/bin/env node
// The Illuminator commissioner: the Oracle asks for a sprite, this spawns a
// ONE-SHOT drawing session (claude -p / codex exec) in a throwaway workspace,
// hands it agents/directors/illuminator.md plus the specific brief, waits for it
// to write ./sprite.json, and attaches the result to the world itself over the
// GM MCP surface.
//
// This is the AI-native shape of the old in-server commissioner: the server
// knows nothing about LLMs, so the child process, its workspace, and the
// registration all live out here beside scripts/crew.mjs.
//
// Usage:
//   node scripts/illuminate.mjs "<brief>" --kind NAME     [options]
//   node scripts/illuminate.mjs "<brief>" --terrain NAME  [options]
//   node scripts/illuminate.mjs list                Recent commissions and status
//   node scripts/illuminate.mjs show <commission>   One commission's record
//
// Commissioning does NOT block: it stages the workspace, detaches the drawing
// session, prints a commission id, and returns in well under a second. Drawing
// takes minutes; when it lands, the sprite registers itself and shows up in the
// GM audit stream as a normal register_kind_visual / register_terrain edit. The
// caller goes straight back to work and never polls.
//
// Options:
//   --kind NAME        Attach to an entity kind (register_kind_visual, merging)
//   --terrain NAME     Attach to a terrain kind (register_terrain, REPLACING)
//   --passable false   Terrain policy, restated (see the warning below)
//   --move-cost N      Terrain policy, restated
//   --color '#rrggbb'  Terrain map fill, restated
//   --icon SLUG        Terrain map icon, restated
//   --cells WxH        Size in 16px cells, 1-4 each (default 1x1 = 16x16)
//   --anchor X,Y       Anchor override as fractions (default bottom-center)
//   --engine claude|codex   (default codex)
//   --model NAME       (default opus for claude, gpt-5.6-terra for codex)
//   --effort low|medium|high|xhigh|max   (default medium)
//   --timeout-ms N     Drawing-session wall clock (default 600000)
//   --url http://host:port   Server base (env AGENT_ISLAND_URL, default :3000)
//   --foreground       Draw in THIS process instead of detaching (operator debugging)
//
// Neither --kind nor --terrain leaves the sprite unattached: the spec lands in
// the commission record for `show` to print, and nothing touches the world.
//
// WARNING on --terrain: register_terrain DECLARES a terrain wholesale - every
// field you omit reverts to its default, by design (see the engine's
// registerTerrain and test/terrain-registry.test.ts). Attaching a sprite to
// ground that already exists therefore means restating its policy, exactly as
// you would calling the tool directly: commissioning art for water WITHOUT
// `--passable false` makes the lake walkable. This script passes the flags
// straight through and cannot check them for you - nothing on the GM or HTTP
// surface reads a terrain's current passable/moveCost back. --kind has no such
// hazard: register_kind_visual merges.

import { spawn } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { disallowedTools } from "./crew-policy.mjs";
import { baseUrl } from "./world.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), "..");

// Runtime home, mirrored from src/paths.ts (this script runs under plain node,
// not tsx, so it cannot import the TS helper). Commission workspaces live here,
// out of the repo, like every other thing the world generates as it runs.
function agentIslandHome() {
  let raw = process.env.AGENT_ISLAND_HOME?.trim();
  if (raw) {
    if (raw === "~") return os.homedir();
    if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
    return path.resolve(raw);
  }
  return path.join(os.homedir(), ".agent-island");
}

const CONFIG = {
  promptFile: path.resolve(
    process.env.AGENT_ISLAND_ILLUMINATOR_PROMPT ??
      path.join(REPO, "agents/directors/illuminator.md"),
  ),
  // The sole sanctioned renderer, staged into each workspace so the session runs
  // `node ./render-sprite.mjs` on the DSL it wrote instead of hand-rolling its
  // own drawing code.
  rendererFile: path.resolve(
    process.env.AGENT_ISLAND_ILLUMINATOR_RENDERER ??
      path.join(REPO, "scripts/render-sprite.mjs"),
  ),
  workRoot: path.resolve(
    process.env.AGENT_ISLAND_COMMISSIONS_DIR ??
      path.join(agentIslandHome(), "commissions"),
  ),
  // Defaults to CODEX at gpt-5.6-terra, effort medium. Every knob overrides
  // with AGENT_ISLAND_ILLUMINATOR_* or a flag.
  engine: process.env.AGENT_ISLAND_ILLUMINATOR_ENGINE ?? "codex",
  model: process.env.AGENT_ISLAND_ILLUMINATOR_MODEL ?? null,
  effort: process.env.AGENT_ISLAND_ILLUMINATOR_EFFORT ?? "medium",
  timeoutMs: Number(process.env.AGENT_ISLAND_ILLUMINATOR_TIMEOUT_MS ?? 600_000),
  defaultModel: { claude: "opus", codex: "gpt-5.6-terra" },
};

// --- argument parsing ---------------------------------------------------

function parseArgs(argv) {
  let opts = {};
  let positional = [];
  const BOOLEANS = new Set(["foreground"]);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg.startsWith("--")) {
      let key = arg.slice(2);
      if (BOOLEANS.has(key)) opts[key] = true;
      else opts[key] = argv[++i];
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

function fail(message) {
  console.error(`illuminate: ${message}`);
  process.exit(1);
}

function parseCells(raw) {
  if (raw === undefined) return { width: 1, height: 1 };
  let match = /^(\d+)\s*[x*]\s*(\d+)$/i.exec(String(raw).trim());
  if (!match) fail(`--cells wants WxH, e.g. 1x2 (got ${JSON.stringify(raw)})`);
  return { width: clampCells(match[1]), height: clampCells(match[2]) };
}

function clampCells(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(4, Math.round(n)));
}

function parseAnchor(raw) {
  if (raw === undefined) return null;
  let parts = String(raw).split(",");
  let x = Number(parts[0]);
  let y = Number(parts[1]);
  if (parts.length !== 2 || !inUnit(x) || !inUnit(y))
    fail(`--anchor wants X,Y with both in 0..1 (got ${JSON.stringify(raw)})`);
  return { x, y };
}

function inUnit(n) {
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

// Everything register_terrain takes besides the sprite. Omitted flags stay
// omitted, which is what makes the wholesale-declaration warning matter: the
// caller is restating the terrain's policy, not patching it.
function parseTerrainSpec(opts) {
  let spec = {};
  if (opts.passable !== undefined) {
    if (!["true", "false"].includes(String(opts.passable)))
      fail(
        `--passable wants true or false (got ${JSON.stringify(opts.passable)})`,
      );
    spec.passable = String(opts.passable) === "true";
  }
  if (opts["move-cost"] !== undefined) {
    let cost = Number(opts["move-cost"]);
    if (!Number.isInteger(cost) || cost < 1)
      fail(
        `--move-cost wants a whole number of ticks, 1 or more (got ${JSON.stringify(opts["move-cost"])})`,
      );
    spec.moveCost = cost;
  }
  if (opts.color !== undefined) spec.color = String(opts.color).trim();
  if (opts.icon !== undefined) spec.icon = String(opts.icon).trim();
  return spec;
}

function sanitize(text) {
  return (
    text
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "asset"
  );
}

// --- commissioning (the parent) -----------------------------------------

async function commission(brief, opts) {
  if (!brief?.trim()) fail("a brief is required.");
  if (opts.kind && opts.terrain) fail("pass --kind or --terrain, not both.");
  if (!fs.existsSync(CONFIG.promptFile))
    fail(`the Illuminator briefing is missing: ${CONFIG.promptFile}`);

  let engine = ["claude", "codex"].includes(opts.engine ?? CONFIG.engine)
    ? (opts.engine ?? CONFIG.engine)
    : fail(`unknown --engine ${opts.engine}; use claude or codex`);
  let effort = opts.effort ?? CONFIG.effort;
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
    fail(`unknown --effort ${effort}`);

  let cells = parseCells(opts.cells);
  let record = {
    brief: brief.trim(),
    kind: opts.kind?.trim() || null,
    terrain: opts.terrain?.trim() || null,
    // Restated terrain policy, passed straight through to register_terrain -
    // see the wholesale-declaration warning at the top of this file.
    terrainSpec: opts.terrain ? parseTerrainSpec(opts) : null,
    cells,
    size: [cells.width * 16, cells.height * 16],
    anchor: parseAnchor(opts.anchor),
    engine,
    model: opts.model?.trim() || CONFIG.model || CONFIG.defaultModel[engine],
    effort,
    timeoutMs: Number(opts["timeout-ms"] ?? CONFIG.timeoutMs),
    url: baseUrl(opts),
    status: "drawing",
    startedAt: new Date().toISOString(),
  };

  let id = `${sanitize(record.brief.slice(0, 32))}-${Date.now().toString(36)}`;
  let dir = path.join(CONFIG.workRoot, id);
  await fsp.mkdir(dir, { recursive: true });
  record.commission = id;
  record.workspace = dir;
  await writeRecord(dir, record);

  if (opts.foreground) {
    await draw(dir);
    return;
  }

  // Detach so the caller (usually the Oracle, mid-wake) is never blocked on a
  // drawing session that runs for minutes. The child re-enters this script in
  // foreground mode; everything it learns lands in the workspace's result.json.
  let log = fs.openSync(path.join(dir, "commission.log"), "a");
  let child = spawn(process.execPath, [SELF, "draw", "--commission", dir], {
    cwd: REPO,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();

  console.log(
    JSON.stringify({
      ok: true,
      status: "drawing",
      commission: id,
      target: record.kind
        ? { kind: record.kind }
        : record.terrain
          ? { terrain: record.terrain }
          : null,
      size: record.size,
      engine: record.engine,
      model: record.model,
      note:
        record.kind || record.terrain
          ? "The sprite attaches itself when it lands; do not poll for it."
          : "Unattached: collect the spec later with `illuminate show`.",
    }),
  );
}

// --- drawing (the detached worker) --------------------------------------

async function draw(dir) {
  let record = JSON.parse(
    await fsp.readFile(path.join(dir, "commission.json"), "utf8"),
  );
  try {
    let sprite = await runSession(dir, record);
    let attached = await attach(record, sprite);
    await writeRecord(dir, {
      ...record,
      status: "done",
      finishedAt: new Date().toISOString(),
      sprite,
      attached,
    });
    console.log(
      `illuminate: ${record.commission} done${attached ? ` -> ${attached}` : " (unattached)"}`,
    );
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    await writeRecord(dir, {
      ...record,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: message,
    });
    console.error(`illuminate: ${record.commission} failed - ${message}`);
    process.exitCode = 1;
  }
}

async function runSession(dir, record) {
  // Stage the renderer beside the work so the session invokes it as
  // ./render-sprite.mjs; if it cannot be staged, point the prompt at the repo
  // copy rather than fail the whole commission.
  let renderer = "./render-sprite.mjs";
  try {
    await fsp.copyFile(
      CONFIG.rendererFile,
      path.join(dir, "render-sprite.mjs"),
    );
  } catch {
    renderer = CONFIG.rendererFile;
  }

  let briefing = await fsp.readFile(CONFIG.promptFile, "utf8");
  let prompt = `${briefing}\n\n${commissionBlock(record, renderer)}`;
  await runCommand(planSpawn(record, prompt), dir, record.timeoutMs);

  let raw;
  try {
    raw = await fsp.readFile(path.join(dir, "sprite.json"), "utf8");
  } catch {
    throw new Error("the drawing session finished without writing sprite.json");
  }

  let sprite;
  try {
    sprite = JSON.parse(raw);
  } catch {
    throw new Error(
      "the drawing session wrote a sprite.json that is not valid JSON",
    );
  }

  // The session lints its own work, but re-run the renderer here as an
  // independent gate: a session that skipped the check, or edited the grid after
  // it passed, is caught before anything reaches the world.
  await assertRenders(dir, renderer);

  let [width, height] = record.size;
  if (sprite?.size?.[0] !== width || sprite?.size?.[1] !== height)
    throw new Error(
      `the Illuminator drew a ${sprite?.size?.[0]}x${sprite?.size?.[1]} sprite; the commission asked for ${width}x${height}`,
    );

  let anchor = (await readMetaAnchor(dir)) ?? record.anchor;
  return anchor ? { ...sprite, anchor } : sprite;
}

function commissionBlock(record, renderer) {
  let [width, height] = record.size;
  let anchor = record.anchor
    ? `Anchor: {x:${record.anchor.x}, y:${record.anchor.y}}.`
    : "Anchor: the default bottom-center {x:0.5, y:1} unless this is a terrain tile.";
  return [
    "---",
    "COMMISSION",
    "",
    `Subject: ${record.brief}`,
    `Canvas: exactly ${width}x${height} pixels (${record.cells.width}x${record.cells.height} cells of 16px).`,
    record.terrain
      ? 'This is a TERRAIN tile: set "kind":"terrain" and fill the cell edge to edge.'
      : 'This is a standing TOKEN: set "kind":"token", transparent field, feet at the bottom edge.',
    anchor,
    "",
    "Author your sprite as ./sprite.json (size, kind, palette, grid - see the briefing)",
    `and check it with:  node ${renderer} ./sprite.json`,
    `Set "size" to [${width}, ${height}]. ./sprite.json itself is the deliverable - the`,
    "game stores and renders the grid directly. The renderer enforces every check",
    "(writing preview PNGs as a side effect); once it succeeds you are done - do not open",
    "the PNGs or redraw a sprite that rendered cleanly. Do NOT write your own drawing",
    "code; the renderer is the only sanctioned check.",
    "You may write ./meta.json with an anchor override. Nothing you draw touches the game;",
    "you only produce files in this workspace.",
  ].join("\n");
}

// The Illuminator MUST have Bash/Write (authoring the DSL and running the
// renderer is the whole job) and must NOT get an MCP config - it has no game
// access at all. codex's workspace-write sandbox already grants shell and writes
// with no game reach.
function planSpawn(record, prompt) {
  if (record.engine === "claude") {
    // Tool lists are comma-separated single tokens and permission-mode is the
    // LAST option before the prompt: --allowedTools/--disallowedTools are
    // variadic, so a space-separated list or a trailing prompt gets slurped in
    // as tool names.
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        ...(process.env.ANTHROPIC_API_KEY ? ["--bare"] : []),
        "--setting-sources",
        "",
        "--model",
        record.model,
        "--effort",
        record.effort,
        "--allowedTools",
        "Bash,Read,Write,Edit",
        "--disallowedTools",
        disallowedTools(),
        "--permission-mode",
        "acceptEdits",
        prompt,
      ],
    };
  }
  return {
    command: "codex",
    args: [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--json",
      "--model",
      record.model,
      "-c",
      `model_reasoning_effort=${record.effort}`,
      "--sandbox",
      "workspace-write",
      prompt,
    ],
  };
}

function runCommand(plan, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let out = fs.createWriteStream(path.join(cwd, "run.jsonl"), { flags: "w" });
    let err = fs.createWriteStream(path.join(cwd, "run.stderr.log"), {
      flags: "w",
    });
    out.on("error", () => {});
    err.on("error", () => {});

    let done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out.end();
      err.end();
      error ? reject(error) : resolve();
    };

    let child = spawn(plan.command, plan.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Preload tool schemas, as the seats do: a drawing session is one short
      // pass and the surface is small once the dead harness tools are cut, so
      // spending turns on ToolSearch discovery is pure latency.
      env: { ...process.env, ENABLE_TOOL_SEARCH: "false" },
    });
    let timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    }, timeoutMs);

    child.stdout?.pipe(out);
    child.stderr?.pipe(err);
    // ENOENT when the CLI is not installed: no pid, and no 'exit' follows.
    child.on("error", (error) => {
      if (child.pid == null) done(error);
    });
    child.once("exit", () =>
      done(
        timedOut
          ? new Error(`the drawing session timed out after ${timeoutMs}ms`)
          : undefined,
      ),
    );
  });
}

function assertRenders(dir, renderer) {
  return new Promise((resolve, reject) => {
    let child = spawn(process.execPath, [renderer, "./sprite.json"], {
      cwd: dir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `sprite.json does not render: ${stderr.trim() || `render-sprite exited ${code}`}`,
            ),
          ),
    );
  });
}

async function readMetaAnchor(dir) {
  try {
    let raw = JSON.parse(
      await fsp.readFile(path.join(dir, "meta.json"), "utf8"),
    );
    let a = raw?.anchor;
    if (a && inUnit(a.x) && inUnit(a.y)) return { x: a.x, y: a.y };
  } catch {
    // no meta.json or unreadable: fall back to the commission's anchor
  }
  return null;
}

// --- attaching (the GM MCP client) --------------------------------------

// The commissioner holds its own short-lived GM session, separate from the
// Oracle's - the server allows more than one, and each other's edits show up in
// the GM audit stream, which is exactly how the Oracle learns the sprite landed.
async function attach(record, sprite) {
  if (!record.kind && !record.terrain) return null;

  let client = new Client(
    { name: "illuminator", version: "0.1.0" },
    { capabilities: {} },
  );
  let transport = new StreamableHTTPClientTransport(
    new URL(`${record.url}/gm`),
  );
  try {
    await client.connect(transport);
    await call(client, "join_as_gm", {});
    if (record.kind) {
      await call(client, "register_kind_visual", { kind: record.kind, sprite });
      return `kind ${record.kind}`;
    }
    // register_terrain declares the terrain wholesale: whatever policy the
    // commission restated rides along, and anything it omitted goes back to
    // default. The warning at the top of this file is the whole story.
    await call(client, "register_terrain", {
      name: record.terrain,
      sprite,
      ...(record.terrainSpec ?? {}),
    });
    return `terrain ${record.terrain}`;
  } finally {
    await client.close().catch(() => {});
  }
}

async function call(client, name, args) {
  let result = await client.callTool({ name, arguments: args });
  if (result?.isError) {
    let text = (result.content ?? [])
      .map((part) => part?.text ?? "")
      .join(" ")
      .trim();
    throw new Error(`${name} was refused: ${text || "no detail"}`);
  }
  return result;
}

// --- records ------------------------------------------------------------

async function writeRecord(dir, record) {
  await fsp.writeFile(
    path.join(dir, "commission.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function readRecord(dir) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dir, "commission.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

function listCommissions() {
  let entries;
  try {
    entries = fs.readdirSync(CONFIG.workRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRecord(path.join(CONFIG.workRoot, entry.name)))
    .filter(Boolean)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function show(id) {
  if (!id) fail("show wants a commission id (see `illuminate list`).");
  let record = readRecord(path.join(CONFIG.workRoot, id));
  if (!record) fail(`no commission "${id}" in ${CONFIG.workRoot}`);
  console.log(JSON.stringify(record, null, 2));
}

function list() {
  let rows = listCommissions();
  if (!rows.length) {
    console.log(`No commissions in ${CONFIG.workRoot}`);
    return;
  }
  for (let row of rows) {
    let target = row.kind
      ? `kind ${row.kind}`
      : row.terrain
        ? `terrain ${row.terrain}`
        : "unattached";
    console.log(
      `${row.status.padEnd(8)} ${row.commission}  ${target}  ${row.size?.join("x")}  ${row.engine}/${row.model}${row.error ? `  - ${row.error}` : ""}`,
    );
  }
}

// --- entry --------------------------------------------------------------

async function main() {
  let argv = process.argv.slice(2);
  let { opts, positional } = parseArgs(argv);
  let command = positional[0];

  if (command === "draw") {
    // Internal: the detached worker re-entering with a staged workspace.
    if (!opts.commission) fail("draw wants --commission <workspace>");
    await draw(path.resolve(opts.commission));
    return;
  }
  if (command === "list") return list();
  if (command === "show") return show(positional[1]);
  if (!command)
    fail(
      'a brief is required, e.g. illuminate "a mossy standing stone" --kind waystone',
    );

  await commission(positional.join(" "), opts);
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : String(error)),
);
