import type { RuleOverlay } from "./engine.js";
import type { Rule } from "./kernel.js";

export function emptyOverlay(): RuleOverlay {
  return { dynamicRules: [], removedBaseIds: [] };
}

export function cloneOverlay(overlay: RuleOverlay | undefined): RuleOverlay {
  return structuredClone(overlay ?? emptyOverlay());
}

export function overlayRuleIds(overlay: RuleOverlay | undefined): string[] {
  if (!overlay) return [];
  let ids = new Set<string>();
  for (let rule of overlay.dynamicRules) ids.add(rule.id);
  for (let id of overlay.removedBaseIds) ids.add(id);
  return [...ids];
}

export function overlayCounts(overlay: RuleOverlay | undefined) {
  let value = overlay ?? emptyOverlay();
  return {
    rules: value.dynamicRules.length,
    removedBaseRules: value.removedBaseIds.length,
    stockDefaults: Object.keys(value.stockDefaults ?? {}).length,
    worldStocks: Object.keys(value.worldStocks ?? {}).length,
    fixtures: value.fixtures?.length ?? 0,
    setup: value.setup?.length ?? 0,
    terrainSpecs: Object.keys(value.terrainSpecs ?? {}).length,
    blobs: value.blobs?.length ?? 0,
    terrainLayers: value.terrainLayers?.length ?? 0,
    describeEvent: Object.keys(value.describeEvent ?? {}).length,
    display: Object.keys(value.display ?? {}).length,
  };
}

export function mergeOverlays(
  baselineIds: Iterable<string>,
  overlays: (RuleOverlay | undefined)[],
): RuleOverlay {
  let baseline = new Set(baselineIds);
  let removedBaseIds = new Set<string>();
  let dynamicRules = new Map<string, Rule>();
  let dynamicOrder: string[] = [];
  let stockDefaults: RuleOverlay["stockDefaults"] = {};
  let worldStocks: RuleOverlay["worldStocks"] = {};
  let fixtures = new Map<
    string,
    NonNullable<RuleOverlay["fixtures"]>[number]
  >();
  let setup: NonNullable<RuleOverlay["setup"]> = [];
  let terrainSpecs: RuleOverlay["terrainSpecs"] = {};
  let defaultTerrain: RuleOverlay["defaultTerrain"];
  let blobs: RuleOverlay["blobs"];
  let terrainLayers: RuleOverlay["terrainLayers"];
  let connect: RuleOverlay["connect"];
  let kindVisuals: RuleOverlay["kindVisuals"] = {};
  let describeEvent: RuleOverlay["describeEvent"] = {};
  let display: RuleOverlay["display"] = {};

  for (let overlay of overlays) {
    if (!overlay) continue;

    for (let id of overlay.removedBaseIds) {
      if (!baseline.has(id)) continue;
      removedBaseIds.add(id);
      dynamicRules.delete(id);
    }

    for (let rule of overlay.dynamicRules) {
      if (!dynamicRules.has(rule.id)) dynamicOrder.push(rule.id);
      dynamicRules.set(rule.id, structuredClone(rule));
      removedBaseIds.delete(rule.id);
    }

    Object.assign(stockDefaults, structuredClone(overlay.stockDefaults ?? {}));
    Object.assign(worldStocks, structuredClone(overlay.worldStocks ?? {}));
    Object.assign(terrainSpecs, structuredClone(overlay.terrainSpecs ?? {}));
    // Placement is a whole-recipe field, not a keyed record: the last overlay to
    // declare one wins outright (a scenario's map, then any GM override on top).
    if (overlay.defaultTerrain !== undefined)
      defaultTerrain = overlay.defaultTerrain;
    if (overlay.blobs !== undefined) blobs = structuredClone(overlay.blobs);
    if (overlay.terrainLayers !== undefined)
      terrainLayers = structuredClone(overlay.terrainLayers);
    if (overlay.connect !== undefined) connect = overlay.connect;
    Object.assign(kindVisuals, structuredClone(overlay.kindVisuals ?? {}));
    Object.assign(describeEvent, structuredClone(overlay.describeEvent ?? {}));
    Object.assign(display, structuredClone(overlay.display ?? {}));
    for (let fixture of overlay.fixtures ?? [])
      fixtures.set(fixture.id, structuredClone(fixture));
    setup.push(...structuredClone(overlay.setup ?? []));
  }

  return compactOverlay({
    dynamicRules: dynamicOrder
      .filter((id) => dynamicRules.has(id))
      .map((id) => dynamicRules.get(id)!),
    removedBaseIds: [...removedBaseIds],
    stockDefaults,
    worldStocks,
    fixtures: [...fixtures.values()],
    setup,
    terrainSpecs,
    defaultTerrain,
    blobs,
    terrainLayers,
    connect,
    kindVisuals,
    describeEvent,
    display,
  });
}

export function pickOverlay(
  overlay: RuleOverlay | undefined,
  ids?: string[],
): RuleOverlay {
  let value = cloneOverlay(overlay);
  if (!ids?.length) return value;

  let wanted = new Set(ids);
  return compactOverlay({
    ...value,
    dynamicRules: value.dynamicRules.filter((rule) => wanted.has(rule.id)),
    removedBaseIds: value.removedBaseIds.filter((id) => wanted.has(id)),
  });
}

export function removeOverlayRules(
  overlay: RuleOverlay | undefined,
  ids: string[],
): RuleOverlay {
  let value = cloneOverlay(overlay);
  let removed = new Set(ids);
  return compactOverlay({
    ...value,
    dynamicRules: value.dynamicRules.filter((rule) => !removed.has(rule.id)),
    removedBaseIds: value.removedBaseIds.filter((id) => !removed.has(id)),
  });
}

export function subtractOverlay(
  overlay: RuleOverlay | undefined,
  base: RuleOverlay | undefined,
): RuleOverlay {
  let value = cloneOverlay(overlay);
  let baseline = cloneOverlay(base);
  let baseRules = new Map(baseline.dynamicRules.map((rule) => [rule.id, rule]));
  let baseRemoved = new Set(baseline.removedBaseIds);

  return compactOverlay({
    dynamicRules: value.dynamicRules.filter((rule) => {
      let baseRule = baseRules.get(rule.id);
      return !baseRule || !sameJson(baseRule, rule);
    }),
    removedBaseIds: value.removedBaseIds.filter((id) => !baseRemoved.has(id)),
    stockDefaults: subtractRecord(value.stockDefaults, baseline.stockDefaults),
    worldStocks: subtractRecord(value.worldStocks, baseline.worldStocks),
    fixtures: subtractFixtures(value.fixtures, baseline.fixtures),
    setup: subtractSetup(value.setup, baseline.setup),
    terrainSpecs: subtractRecord(value.terrainSpecs, baseline.terrainSpecs),
    defaultTerrain: sameJson(value.defaultTerrain, baseline.defaultTerrain)
      ? undefined
      : value.defaultTerrain,
    blobs: sameJson(value.blobs, baseline.blobs)
      ? undefined
      : structuredClone(value.blobs),
    terrainLayers: sameJson(value.terrainLayers, baseline.terrainLayers)
      ? undefined
      : structuredClone(value.terrainLayers),
    connect: sameJson(value.connect, baseline.connect)
      ? undefined
      : value.connect,
    kindVisuals: subtractRecord(value.kindVisuals, baseline.kindVisuals),
    describeEvent: subtractRecord(value.describeEvent, baseline.describeEvent),
    display: subtractRecord(value.display, baseline.display),
  });
}

export function compactOverlay(overlay: RuleOverlay): RuleOverlay {
  let compact = {
    dynamicRules: overlay.dynamicRules ?? [],
    removedBaseIds: overlay.removedBaseIds ?? [],
  } as RuleOverlay;

  if (Object.keys(overlay.stockDefaults ?? {}).length)
    compact.stockDefaults = overlay.stockDefaults;
  if (Object.keys(overlay.worldStocks ?? {}).length)
    compact.worldStocks = overlay.worldStocks;
  if (overlay.fixtures?.length) compact.fixtures = overlay.fixtures;
  if (overlay.setup?.length) compact.setup = overlay.setup;
  if (Object.keys(overlay.terrainSpecs ?? {}).length)
    compact.terrainSpecs = overlay.terrainSpecs;
  if (overlay.defaultTerrain !== undefined)
    compact.defaultTerrain = overlay.defaultTerrain;
  if (overlay.blobs?.length) compact.blobs = overlay.blobs;
  if (overlay.terrainLayers?.length)
    compact.terrainLayers = overlay.terrainLayers;
  if (overlay.connect !== undefined && overlay.connect !== false)
    compact.connect = overlay.connect;
  if (Object.keys(overlay.kindVisuals ?? {}).length)
    compact.kindVisuals = overlay.kindVisuals;
  if (Object.keys(overlay.describeEvent ?? {}).length)
    compact.describeEvent = overlay.describeEvent;
  if (Object.keys(overlay.display ?? {}).length)
    compact.display = overlay.display;

  return compact;
}

function subtractRecord<Value>(
  value: Record<string, Value> | undefined,
  base: Record<string, Value> | undefined,
): Record<string, Value> | undefined {
  let out: Record<string, Value> = {};
  for (let [key, item] of Object.entries(value ?? {})) {
    if (sameJson(base?.[key], item)) continue;
    out[key] = structuredClone(item);
  }
  return Object.keys(out).length ? out : undefined;
}

function subtractFixtures(
  value: RuleOverlay["fixtures"],
  base: RuleOverlay["fixtures"],
): RuleOverlay["fixtures"] {
  let baseFixtures = new Map(
    (base ?? []).map((fixture) => [fixture.id, fixture]),
  );
  let out = (value ?? []).filter((fixture) => {
    let baseFixture = baseFixtures.get(fixture.id);
    return !baseFixture || !sameJson(baseFixture, fixture);
  });
  return out.length ? structuredClone(out) : undefined;
}

function subtractSetup(
  value: RuleOverlay["setup"],
  base: RuleOverlay["setup"],
): RuleOverlay["setup"] {
  let baseItems = new Set((base ?? []).map((item) => JSON.stringify(item)));
  let out = (value ?? []).filter(
    (item) => !baseItems.has(JSON.stringify(item)),
  );
  return out.length ? structuredClone(out) : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
