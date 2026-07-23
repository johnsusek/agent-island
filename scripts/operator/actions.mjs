import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

let execFileAsync = promisify(execFile);

export function buildCrewArgs(form) {
  let role = form.role === "director" ? "director" : "characters";
  let args = [role];
  pushOption(args, "--max-ticks", form.maxTicks);
  pushOption(args, "--engine", form.engine);
  pushOption(args, "--model", form.model);
  pushOption(args, "--effort", form.effort);
  pushOption(args, "--persona", form.persona);
  if (role === "director")
    pushOption(args, "--cadence-ticks", form.cadenceTicks);
  pushOption(args, "--instructions", form.instructions);
  pushOption(args, "--url", form.url);

  if (role === "director") pushOption(args, "--name", form.names);
  else if (form.names?.trim()) pushOption(args, "--names", form.names);
  else pushOption(args, "--count", form.count);
  if (role === "characters" && form.ocean === false) args.push("--no-ocean");
  return args;
}

export async function launchCrew(form, context) {
  await fs.promises.mkdir(context.paths.operatorLogsDir, { recursive: true });
  let stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let role = form.role === "director" ? "director" : "characters";
  let file = path.join(context.paths.operatorLogsDir, `${role}-${stamp}.log`);
  let output = await fs.promises.open(file, "a");
  let args = [
    context.paths.crewScript,
    ...buildCrewArgs({ ...form, url: context.options.url }),
  ];
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: context.paths.repoRoot,
      detached: true,
      stdio: ["ignore", output.fd, output.fd],
      env: {
        ...process.env,
        AGENT_ISLAND_HOME: context.options.home,
        AGENT_ISLAND_URL: context.options.url,
      },
    });
    await waitForSpawn(child);
    child.unref();
  } finally {
    await output.close();
  }
  return { pid: child.pid, file, role };
}

export async function stopCrew(target, name, context) {
  let args = [context.paths.crewScript, "stop"];
  if (target) args.push(target);
  if (name) args.push(name);
  let result = await execFileAsync(process.execPath, args, {
    cwd: context.paths.repoRoot,
    env: {
      ...process.env,
      AGENT_ISLAND_HOME: context.options.home,
      AGENT_ISLAND_URL: context.options.url,
    },
  });
  return `${result.stdout}${result.stderr}`.trim();
}

export async function pauseWorld(paused, context) {
  return api("POST", "/api/pause", { paused }, context);
}

export async function setClock(realTimeMs, context) {
  return api("POST", "/api/clock", { realTimeMs }, context);
}

export async function activateScenario(name, context) {
  return api(
    "POST",
    `/api/scenarios/${encodeURIComponent(name)}/active`,
    { active: true },
    context,
  );
}

export async function restoreRun(runId, context) {
  return api("POST", "/api/restore", { runId }, context);
}

export async function resetWorld(dimensions, context) {
  let body = {};
  if (numberOrNull(dimensions?.width))
    body.width = numberOrNull(dimensions.width);
  if (numberOrNull(dimensions?.height))
    body.height = numberOrNull(dimensions.height);
  return api("POST", "/api/reset", body, context);
}

export function personaNames(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          entry.name !== "OCEAN.md",
      )
      .map((entry) => path.basename(entry.name, ".md"))
      .sort();
  } catch {
    return [];
  }
}

async function api(method, endpoint, body, context) {
  let response = await fetch(`${context.options.url}${endpoint}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  let text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (response.ok) return payload;
  throw new Error(payload.error ?? `${response.status} ${response.statusText}`);
}

function pushOption(args, option, value) {
  if (value === undefined || value === null || String(value).trim() === "")
    return;
  args.push(option, String(value).trim());
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function numberOrNull(value) {
  let parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
