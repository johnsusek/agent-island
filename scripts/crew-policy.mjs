let directorCadences = Object.freeze({
  auditor: 500,
  oracle: 0,
  seeder: 500,
  tuner: 300,
});

export function defaultDirectorCadenceTicks(persona) {
  let key = String(persona ?? "oracle")
    .trim()
    .toLowerCase();
  return directorCadences[key] ?? 0;
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
