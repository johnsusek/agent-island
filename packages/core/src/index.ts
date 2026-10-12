// The rules core: the kernel (entities, stocks, rules, phased ticks), the
// spatial grid it can run on, the rule schema, and dry runs. Nothing here knows
// about any particular world; a host supplies the scenario, the agents, and the
// MCP surface. Each module is also importable on its own subpath.

export * from "./kernel.js";
export * from "./space.js";
export * from "./rule-schema.js";
export * from "./dryrun.js";
export * from "./stock-display.js";
