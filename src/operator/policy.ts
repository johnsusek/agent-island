import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface CadenceConfig {
  default: number;
  directors: Record<string, number>;
}

let moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
let configFile = path.resolve(
  moduleDirectory,
  "../../config/director-cadences.json",
);
let cadenceConfig = readCadenceConfig();

export function defaultDirectorCadenceTicks(persona: string): number {
  return (
    cadenceConfig.directors[persona.toLowerCase()] ?? cadenceConfig.default
  );
}

export function parseDirectorCadenceTicks(
  value: string,
  persona: string,
): number {
  if (!value) return defaultDirectorCadenceTicks(persona);
  let ticks = Number(value);
  if (Number.isInteger(ticks) && ticks >= 0) return ticks;
  throw new Error("Cadence must be a non-negative integer.");
}

export function parseMaxTicks(value: string): number {
  if (value === "off") return 0;
  let ticks = Number(value || 2000);
  if (Number.isInteger(ticks) && ticks > 0) return ticks;
  throw new Error("Max ticks must be a positive integer or off.");
}

function readCadenceConfig(): CadenceConfig {
  let parsed = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<
    Record<"default" | "directors", unknown>
  >;
  let fallback = cadenceValue(parsed.default, "default");
  let directors: Record<string, number> = {};
  if (parsed.directors && typeof parsed.directors === "object") {
    for (let [persona, value] of Object.entries(parsed.directors))
      directors[persona.toLowerCase()] = cadenceValue(value, persona);
  }
  return { default: fallback, directors };
}

function cadenceValue(value: unknown, label: string): number {
  let ticks = Number(value);
  if (Number.isInteger(ticks) && ticks >= 0) return ticks;
  throw new Error(`Invalid Director cadence for ${label} in ${configFile}.`);
}
