import type { Scenario, WorldFile } from "@agent-island/engine/scenario";
import { pickSpawn } from "@agent-island/core/space";

// Presentation config only: sprites live inline in the scenario's visuals (the
// sprite DSL), so graphics carries no asset-pack URLs - just the default zoom.
export interface GraphicsConfig {
  scale: number;
}

export const DEFAULT_GRAPHICS: GraphicsConfig = { scale: 3 };

// A parsed world file as the base Scenario a colony boots from. The file is a
// flat WorldGen (width/height/seed) - just the shared canvas; terrain, its
// placement, rules, and all authoring arrive later as scenario overlays.
// `source` names the file in errors.
export function scenarioFromWorldFile(raw: unknown, source: string): Scenario {
  let file = asObject(raw, source);
  // Rules live in scenarios, never in the world file - reject them here so a
  // stray "rules" key fails loudly at boot instead of silently authoring a
  // second, un-toggleable rule source. A nested "worldgen" object is the
  // pre-flattening shape; reject it too so an old file fails with a pointer
  // instead of quietly generating a bare 21x21 grid.
  if ("rules" in file)
    throw new Error(
      `${source} must not contain "rules" - author them as a scenario instead.`,
    );
  if ("worldgen" in file)
    throw new Error(
      `${source} has a nested "worldgen" object - the world file is flat now, put its keys at the root.`,
    );
  // The world file is just the canvas now; a "name" is optional and only used
  // as the bare-world identity when no scenario is active - bootScenario restamps
  // it from the active scenario otherwise. Defaults to "world" when the file omits it.
  let {
    name,
    graphics: _graphics,
    ...worldgen
  } = file as unknown as {
    name?: unknown;
    graphics?: unknown;
  } & WorldFile;
  // Both this name and this spawn are provisional: the coordinator restamps the
  // name from the active scenario and rerolls spawn once the scenario's terrain specs and
  // placement are merged in (see bootScenario).
  return {
    name: typeof name === "string" && name ? name : "world",
    rules: [],
    worldgen,
    spawn: pickSpawn(worldgen),
  };
}

// The world file's optional `graphics` block, validated.
export function graphicsFromWorldFile(
  raw: unknown,
  source: string,
): GraphicsConfig {
  let value = asObject(raw, source).graphics;
  if (value === undefined) return { ...DEFAULT_GRAPHICS };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${source} graphics must be an object.`);

  let graphics = value as Record<string, unknown>;
  for (let key of Object.keys(graphics))
    if (key !== "scale")
      throw new Error(`${source} graphics has unknown key "${key}".`);

  let scale = graphics.scale;
  if (typeof scale !== "number" || !Number.isInteger(scale) || scale < 1)
    throw new Error(`${source} graphics.scale must be a positive integer.`);

  return { scale };
}

function asObject(raw: unknown, source: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(`${source} must be a JSON object.`);
  return raw as Record<string, unknown>;
}
