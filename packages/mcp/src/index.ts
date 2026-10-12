// The MCP host: createColony runs a world engine for any number of agents
// (sessions, the lockstep turn barrier or a real-time clock, victory, an event
// journal, optional file persistence), and createMcpHandler serves it over
// Streamable HTTP as two surfaces - characters at one endpoint, game masters
// who inspect the world and edit its rules at another. Each module is also
// importable on its own subpath.

export * from "./briefing.js";
export * from "./coordinator.js";
export * from "./coordinator-admin.js";
export * from "./coordinator-gm.js";
export * from "./coordinator-inspection.js";
export * from "./coordinator-scenarios.js";
export * from "./journal.js";
export * from "./mcp-handler.js";
export * from "./mcp-order-schema.js";
export * from "./scenarios.js";
export * from "./sense-prose.js";
export * from "./world-file.js";
