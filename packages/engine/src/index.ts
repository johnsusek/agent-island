// The world host: createWorld turns a Scenario into a running engine that
// places agents on the grid, runs their actions and standing orders, carries
// speech and events to whoever can perceive them, takes rule edits at runtime
// (each one dry-run first), and snapshots and restores itself. Scenarios layer
// on as RuleOverlays. Visuals and sprites are presentation metadata the engine
// stores and persists for whatever UI watches it; it never draws them. Each
// module is also importable on its own subpath.

export * from "./engine.js";
export * from "./engine-actions.js";
export * from "./engine-orders.js";
export * from "./orders.js";
export * from "./overlays.js";
export * from "./scenario.js";
export * from "./sprite.js";
export * from "./vitals.js";
