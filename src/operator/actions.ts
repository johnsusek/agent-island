import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import type { ActionContext, AgentRole, LaunchForm } from "./types.js";

let execFileAsync = promisify(execFile);

export function buildCrewArgs(form: LaunchForm): string[] {
  let role = form.role === "director" ? "director" : "characters";
  let arguments_ = [role];
  pushOption(arguments_, "--max-ticks", form.maxTicks);
  pushOption(arguments_, "--engine", form.engine);
  pushOption(arguments_, "--model", form.model);
  pushOption(arguments_, "--effort", form.effort);
  pushOption(arguments_, "--persona", form.persona);
  if (role === "director")
    pushOption(arguments_, "--cadence-ticks", form.cadenceTicks);
  pushOption(arguments_, "--instructions", form.instructions);
  pushOption(arguments_, "--url", form.url);

  if (role === "director") return arguments_;
  if (form.names?.trim()) pushOption(arguments_, "--names", form.names);
  else pushOption(arguments_, "--count", form.count);
  if (form.ocean === false) arguments_.push("--no-ocean");
  return arguments_;
}

export async function launchCrew(
  form: LaunchForm,
  context: ActionContext,
): Promise<{ file: string; pid: number | undefined; role: string }> {
  await fs.promises.mkdir(context.paths.operatorLogsDir, { recursive: true });
  let stamp = new Date().toISOString().replace(/[-:.]/g, "");
  let role = form.role === "director" ? "director" : "characters";
  let file = path.join(context.paths.operatorLogsDir, `${role}-${stamp}.log`);
  let output = await fs.promises.open(file, "a");
  let arguments_ = [
    context.paths.crewScript,
    ...buildCrewArgs({ ...form, url: context.options.url }),
  ];
  let child;
  try {
    child = spawn(process.execPath, arguments_, {
      cwd: context.paths.repoRoot,
      detached: true,
      env: {
        ...process.env,
        AGENT_ISLAND_HOME: context.options.home,
        AGENT_ISLAND_URL: context.options.url,
      },
      stdio: ["ignore", output.fd, output.fd],
    });
    await waitForSpawn(child);
    child.unref();
  } finally {
    await output.close();
  }
  return { file, pid: child.pid, role };
}

export async function stopCrew(
  target: AgentRole | "all" | null,
  name: string | null,
  context: ActionContext,
): Promise<string> {
  let arguments_ = [context.paths.crewScript, "stop"];
  if (target) arguments_.push(target);
  if (name) arguments_.push(name);
  let result = await execFileAsync(process.execPath, arguments_, {
    cwd: context.paths.repoRoot,
    env: {
      ...process.env,
      AGENT_ISLAND_HOME: context.options.home,
      AGENT_ISLAND_URL: context.options.url,
    },
  });
  return `${result.stdout}${result.stderr}`.trim();
}

export async function pauseWorld(
  paused: boolean,
  context: ActionContext,
): Promise<Record<string, unknown>> {
  return api("POST", "/api/pause", { paused }, context);
}

export async function setClock(
  realTimeMs: number,
  context: ActionContext,
): Promise<Record<string, unknown>> {
  return api("POST", "/api/clock", { realTimeMs }, context);
}

export async function activateScenario(
  name: string,
  context: ActionContext,
): Promise<Record<string, unknown>> {
  return api(
    "POST",
    `/api/scenarios/${encodeURIComponent(name)}/active`,
    { active: true },
    context,
  );
}

export async function restoreRun(
  runId: string,
  context: ActionContext,
): Promise<Record<string, unknown>> {
  return api("POST", "/api/restore", { runId }, context);
}

export async function resetWorld(
  dimensions: { height?: number; width?: number },
  context: ActionContext,
): Promise<Record<string, unknown>> {
  return api("POST", "/api/reset", dimensions, context);
}

export function parseResetDimensions(dimensions: {
  height?: string;
  width?: string;
}): { height?: number; width?: number } {
  let width = dimensions.width?.trim() ?? "";
  let height = dimensions.height?.trim() ?? "";
  if (!width && !height) return {};
  if (!width || !height)
    throw new Error("Enter both dimensions, or leave both blank.");
  return {
    height: worldDimension("height", height),
    width: worldDimension("width", width),
  };
}

export function personaNames(directory: string): string[] {
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

async function api(
  method: string,
  endpoint: string,
  body: Record<string, unknown>,
  context: ActionContext,
): Promise<Record<string, unknown>> {
  let response = await fetch(`${context.options.url}${endpoint}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method,
    signal: AbortSignal.timeout(5000),
  });
  let text = await response.text();
  let payload = parsePayload(text);
  if (response.ok) return payload;
  throw new Error(
    typeof payload.error === "string"
      ? payload.error
      : `${response.status} ${response.statusText}`,
  );
}

function parsePayload(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    let parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object")
      return parsed as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
  return {};
}

function pushOption(
  arguments_: string[],
  option: string,
  value: boolean | number | string | null | undefined,
): void {
  if (value === undefined || String(value).trim() === "") return;
  arguments_.push(option, String(value).trim());
}

function waitForSpawn(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function worldDimension(label: string, value: string): number {
  let parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 200) return parsed;
  throw new Error(`World ${label} must be a whole number from 1 to 200.`);
}
