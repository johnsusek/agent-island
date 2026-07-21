#!/usr/bin/env node
// World-ops CLI for the Agent Island server: status, reset, pause, clock,
// scenario. Talks to an ALREADY-RUNNING server over its admin HTTP API and
// never launches or stops LLM processes - that is scripts/crew.mjs's job.
//
// Usage:
//   node scripts/world.mjs <command> [options]
//   npm run world -- <command> [options]
//
// Commands:
//   status                     Show world tick/state
//   reset [--width N --height N]   Wipe and regenerate the world
//   scenario <name> [--off]    Activate (or --off deactivate) a scenario pack
//   pause | resume             Freeze / unfreeze the world clock
//   clock [--ms N]             Real-time clock cadence (0/omit = lockstep)
//
// Options:
//   --url http://host:port     Server base (env AGENT_ISLAND_URL, default :3000)

function parseArgs(argv) {
  let command = argv[0];
  let opts = {};
  let positional = [];
  for (let i = 1; i < argv.length; i++) {
    let arg = argv[i];
    if (arg.startsWith("--")) {
      let key = arg.slice(2);
      let booleans = ["off"];
      if (booleans.includes(key)) {
        opts[key] = true;
      } else {
        opts[key] = argv[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, opts, positional };
}

export function baseUrl(opts = {}) {
  let url = opts.url ?? process.env.AGENT_ISLAND_URL ?? "http://localhost:3000";
  return url.replace(/\/$/, "");
}

export async function api(method, path, opts, body) {
  let response;
  try {
    response = await fetch(baseUrl(opts) + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    fail(
      `Could not reach ${baseUrl(opts)} - is the server running? (${error.message})`,
    );
  }
  let text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    fail(
      `${method} ${path} failed (${response.status}): ${payload.error ?? text}`,
    );
  }
  return payload;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

export async function cmdStatus(opts) {
  let state = await api("GET", "/api/state", opts);
  let live = state.liveness ?? {};
  let clock =
    live.realTimeMs > 0 ? `realtime ${live.realTimeMs}ms` : "lockstep";
  let status = live.ended ? "ENDED" : live.paused ? "PAUSED" : "running";
  console.log(
    `world ${state.worldId}  tick ${state.state?.tick ?? "?"}  ${status}  ${clock}  (${live.activeCount ?? 0} active)`,
  );
}

export async function cmdReset(opts) {
  let body = {};
  if (opts.width) body.width = Number(opts.width);
  if (opts.height) body.height = Number(opts.height);
  let payload = await api("POST", "/api/reset", opts, body);
  console.log(`reset ok - new world ${payload.worldId}`);
}

export async function cmdScenario(opts, positional) {
  let name = positional[0];
  if (!name) fail("scenario requires a name, e.g. `scenario genesis`");
  await api("POST", `/api/scenarios/${encodeURIComponent(name)}/active`, opts, {
    active: !opts.off,
  });
  console.log(`scenario ${name} ${opts.off ? "deactivated" : "activated"}`);
}

export async function cmdPause(opts, paused) {
  await api("POST", "/api/pause", opts, { paused });
  console.log(paused ? "paused" : "resumed");
}

export async function cmdClock(opts) {
  let ms = opts.ms ? Number(opts.ms) : 0;
  await api("POST", "/api/clock", opts, { realTimeMs: ms });
  console.log(ms > 0 ? `clock: realtime ${ms}ms` : "clock: lockstep");
}

function printHelp() {
  console.log(`Agent Island world CLI - world ops only (crew.mjs launches agents).

USAGE
  node scripts/world.mjs <command> [options]

COMMANDS
  status                         Show world tick/state.
  reset [--width N] [--height N] Wipe and regenerate the world.
  scenario <name> [--off]        Activate (or --off deactivate) a scenario.
  pause | resume                 Freeze / unfreeze the world clock.
  clock [--ms N]                 Real-time cadence in ms (0/omit = lockstep).

OPTIONS
  --url <http://host:port>       Server base URL (env AGENT_ISLAND_URL, default http://localhost:3000)`);
}

async function main() {
  let { command, opts, positional } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "status":
      return cmdStatus(opts);
    case "reset":
      return cmdReset(opts);
    case "scenario":
      return cmdScenario(opts, positional);
    case "pause":
      return cmdPause(opts, true);
    case "resume":
      return cmdPause(opts, false);
    case "clock":
      return cmdClock(opts);
    case "help":
    case undefined:
      printHelp();
      return;
    default:
      fail(`unknown command: ${command} (try \`help\`)`);
  }
}

// Only run as a CLI when invoked directly; crew.mjs imports the api helpers.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
