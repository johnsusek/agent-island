import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
let cadenceConfigFile = path.resolve(
  scriptDirectory,
  "../config/director-cadences.json",
);
let cadenceConfig = readCadenceConfig(cadenceConfigFile);

export function defaultDirectorCadenceTicks(persona) {
  let key = String(persona ?? "oracle")
    .trim()
    .toLowerCase();
  return cadenceConfig.directors[key] ?? cadenceConfig.default;
}

export function parseDirectorCadenceTicks(value, persona) {
  if (value === undefined || value === null || value === "")
    return defaultDirectorCadenceTicks(persona);
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

function readCadenceConfig(file) {
  let parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  let fallback = parseCadence(parsed.default, "default");
  let directors = {};
  for (let [persona, value] of Object.entries(parsed.directors ?? {})) {
    directors[persona.toLowerCase()] = parseCadence(value, persona);
  }
  return Object.freeze({
    default: fallback,
    directors: Object.freeze(directors),
  });
}

function parseCadence(value, label) {
  let ticks = Number(value);
  if (Number.isInteger(ticks) && ticks >= 0) return ticks;
  throw new Error(
    `Invalid director cadence for ${label} in ${cadenceConfigFile}.`,
  );
}
