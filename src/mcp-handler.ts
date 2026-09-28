import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Request, Response } from "express";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as schema from "zod/v4";

import { characterBriefing, gmBriefing } from "./briefing.js";
import type { Colony } from "./coordinator.js";
import { MAX_INSCRIPTION } from "./rules/kernel.js";
import { orderInputSchema } from "./mcp-order-schema.js";
import {
  describeSense,
  isWakeResult,
  renderCharacterResult,
  renderWake,
} from "./sense-prose.js";

// Tool descriptions live one-per-file in mcp-tool-descriptions/, not scattered
// across every registerTool call, so editing what a tool tells the model is
// just editing its .md file - no digging through the schema/handler wiring.
let toolDescriptionsDir = fileURLToPath(
  new URL("./mcp-tool-descriptions/", import.meta.url),
);
let toolDescriptions: Record<string, string> = Object.fromEntries(
  readdirSync(toolDescriptionsDir)
    .filter((fileName) => fileName.endsWith(".md"))
    .map((fileName) => [
      fileName.slice(0, -".md".length),
      readFileSync(toolDescriptionsDir + fileName, "utf8").trim(),
    ]),
);

function describe(toolName: string): string {
  let description = toolDescriptions[toolName];
  if (!description)
    throw new Error(
      `No mcp-tool-descriptions/${toolName}.md file for tool "${toolName}"`,
    );
  return description;
}

// Shared instructions for finding a game-icons.net slug, reused across every
// icon field below. Each tool still writes its own requirement clause (when a
// resource/entity needs one is genuinely different per tool - see spawn_entity's
// entity-kind icon, which requires color, versus everything else's resource
// icon, which doesn't).
const ICON_SLUG_HOWTO =
  "browse https://game-icons.net, open an icon, and copy the slug from its URL - the last path segment, e.g. 'wheat' or 'meat'";

// The inline sprite DSL (see src/rules/sprite.ts). Kept loose here - the
// engine's shared validator does the real checking (grid/size/palette/corners)
// so its errors reach the caller as specific prose instead of a zod mismatch.
const spriteSpecSchema = schema
  .object({
    size: schema
      .tuple([schema.number().int(), schema.number().int()])
      .describe("[width, height] in pixels; multiples of 16, at most 64"),
    kind: schema
      .enum(["token", "terrain"])
      .optional()
      .describe(
        '"token" (default) stands over a transparent field; "terrain" fills the cell',
      ),
    palette: schema
      .record(schema.string(), schema.string())
      .describe(
        'Single-character glyph -> "#rrggbb" or "none"; "." is transparent by default',
      ),
    grid: schema
      .array(schema.string())
      .min(1)
      .describe("Rows of glyphs, top first, one character per pixel"),
    mirror: schema
      .enum(["horizontal", "vertical", "none"])
      .optional()
      .describe(
        'Author one half and let the renderer mirror it exactly ("horizontal": left half)',
      ),
    anchor: schema
      .object({
        x: schema.number().min(0).max(1),
        y: schema.number().min(0).max(1),
      })
      .optional()
      .describe(
        "Anchor as fractions; defaults to bottom-center {x:0.5, y:1}, the standing-token convention",
      ),
  })
  .describe(
    "An inline sprite: palette + character grid, baked to pixels by the viewport",
  );

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export function createMcpHandler(coordinator: Colony) {
  let sessions = new Map<string, McpSession>();

  // Let the coordinator's idle reaper tear down a transport whose client is gone
  // for good. Closing fires the transport's onclose, which deletes the session
  // here and calls coordinator.disconnect, so cleanup stays in one place.
  function closeSession(sessionId: string) {
    let session = sessions.get(sessionId);
    if (!session) return;
    void session.transport.close().catch((error) => {
      console.error("Failed to close idle MCP session:", error);
    });
  }
  coordinator.setTransportCloser(closeSession);

  // One POST handler per endpoint. Both share the session map and teardown;
  // they differ only in which tool surface a fresh connection gets.
  // The character endpoint (/mcp) stays lean; the GM endpoint (/gm) hands
  // the full GM surface at connect, so a GM client sees every tool at init and
  // never depends on a tools/list_changed refresh many MCP clients ignore.
  function makePost(
    buildServer: (sessionId: string, includeRawJson: boolean) => McpServer,
  ) {
    return async function post(request: Request, response: Response) {
      let sessionId = request.headers["mcp-session-id"];
      let session =
        typeof sessionId === "string" ? sessions.get(sessionId) : null;
      let newSessionId: string | null = null;

      try {
        if (session) {
          await session.transport.handleRequest(
            request,
            response,
            request.body,
          );
          return;
        }

        // A stale session id gets 404, the spec's "session terminated" signal,
        // so a client whose session was reaped re-initializes instead of
        // treating the server as broken.
        if (sessionId) {
          sendProtocolError(response, 404, "MCP session not found.");
          return;
        }

        if (!isInitializeRequest(request.body)) {
          sendProtocolError(
            response,
            400,
            "No valid MCP session was provided.",
          );
          return;
        }

        let id = randomUUID();
        newSessionId = id;
        coordinator.connect(id);
        let transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => id,
          onsessioninitialized: (initializedSessionId) => {
            sessions.set(initializedSessionId, {
              transport,
              server: mcpServer,
            });
          },
        });
        // GM only: its results are data, carried in structuredContent, and a
        // client whose runtime only surfaces content[].text (some local-LLM
        // setups) can opt into the JSON duplicate with ?rawJson=1. The
        // character surface ignores the flag - it has no JSON to duplicate.
        let includeRawJson = isTruthyQueryFlag(request.query.rawJson);
        let mcpServer = buildServer(id, includeRawJson);

        transport.onclose = () => {
          sessions.delete(id);
          coordinator.disconnect(id);
        };

        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        console.error("MCP request failed:", error);
        if (newSessionId && !sessions.has(newSessionId))
          coordinator.disconnect(newSessionId);
        if (!response.headersSent)
          sendProtocolError(response, 500, "Internal MCP server error.");
      }
    };
  }

  async function get(request: Request, response: Response) {
    let session = findSession(request);
    if (!session) return response.status(404).send("MCP session not found.");
    await session.transport.handleRequest(request, response);
  }

  async function remove(request: Request, response: Response) {
    let session = findSession(request);
    if (!session) return response.status(404).send("MCP session not found.");
    await session.transport.handleRequest(request, response);
  }

  async function close() {
    await Promise.all(
      [...sessions.values()].map(async (session) => session.server.close()),
    );
    sessions.clear();
  }

  function findSession(request: Request): McpSession | null {
    let sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId !== "string") return null;
    return sessions.get(sessionId) ?? null;
  }

  // get/remove operate on the shared session map by id, so one pair serves both
  // endpoints; only the initializing POST differs by role.
  // ?rawJson=1 is a GM-only escape hatch now: the character surface has no
  // structured payload to duplicate.
  let characterPost = makePost((id) =>
    createCharacterMcpServer(id, coordinator),
  );
  let gmPost = makePost((id, includeRawJson) =>
    createGmMcpServer(id, coordinator, includeRawJson),
  );

  return {
    character: { post: characterPost, get, delete: remove },
    gm: { post: gmPost, get, delete: remove },
    close,
  };
}

function createCharacterMcpServer(
  sessionId: string,
  coordinator: Colony,
): McpServer {
  // The server carries the game briefing so clients only need a tiny local
  // prompt (name, personality, how to connect). Clients that surface MCP
  // instructions get it here at connect; join_game also returns it to a fresh
  // spawn as a fallback for clients that don't.
  let server = new McpServer(
    { name: "agent-island", version: "0.4.0" },
    { instructions: characterBriefing },
  );
  let registerTool = bindRegisterTool({ prose: true });

  registerTool(
    server,
    "join_game",
    {
      description: describe("join_game"),
      inputSchema: {
        name: schema.string().describe("Your agent's name"),
      },
    },
    async ({ name }) =>
      coordinator.join(sessionId, proseText(name, "name", 20)),
  );

  registerTool(
    server,
    "leave_game",
    {
      description: describe("leave_game"),
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => coordinator.leave(sessionId),
  );

  registerTool(
    server,
    "sense",
    {
      description: describe("sense"),
      inputSchema: {
        mode: schema.string().describe("situation"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ mode }) => coordinator.sense(sessionId, mode),
  );

  registerTool(
    server,
    "wait_for_change",
    {
      description: describe("wait_for_change"),
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => coordinator.waitForChange(sessionId),
  );

  registerTool(
    server,
    "set_order",
    {
      description: describe("set_order"),
      inputSchema: { order: ORDER_INPUT },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ order }) => coordinator.setOrder(sessionId, parseOrder(order)),
  );

  registerTool(
    server,
    "set_order_and_wait",
    {
      description: describe("set_order_and_wait"),
      inputSchema: { order: ORDER_INPUT },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ order }) =>
      coordinator.setOrderAndWait(sessionId, parseOrder(order)),
  );

  registerTool(
    server,
    "cancel_order",
    {
      description: describe("cancel_order"),
      inputSchema: {},
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => coordinator.cancelOrder(sessionId),
  );

  registerTool(
    server,
    "get_order",
    {
      description: describe("get_order"),
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => coordinator.getOrder(sessionId),
  );

  registerTool(
    server,
    "speak",
    {
      description: describe("speak"),
      inputSchema: { message: schema.string() },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ message }) => coordinator.speak(sessionId, message),
  );

  registerTool(
    server,
    "whisper",
    {
      description: describe("whisper"),
      inputSchema: {
        target: schema.string().describe("Recipient's name"),
        message: schema.string(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ target, message }) =>
      coordinator.whisper(sessionId, target, message),
  );

  registerTool(
    server,
    "inscribe",
    {
      description: describe("inscribe"),
      inputSchema: {
        message: schema.string(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ message }) => coordinator.inscribe(sessionId, message),
  );

  return server;
}

// The GM endpoint (/gm) gets its own MCP server so the full GM surface is
// present at connect. GM tools used to live on the character server and only
// appear after join_as_gm fired a tools/list_changed - but many MCP clients
// (codex, and others) snapshot their tool list at init and never re-list on that
// notification, so the tools stayed invisible. A dedicated endpoint sidesteps
// the refresh entirely: a client that connects here sees every tool at init.
// The character server (/mcp) stays lean, which was the point of not registering
// these unconditionally there - a character never pays for the GM schema.
//
// join_as_gm still claims the role in the coordinator, and every other GM tool
// rejects via requireGm until it succeeds.
function createGmMcpServer(
  sessionId: string,
  coordinator: Colony,
  includeRawJson: boolean,
): McpServer {
  // Like the character server, the endpoint carries the seat's mechanics
  // briefing so a bring-your-own-director client only ships its personality.
  let server = new McpServer(
    { name: "agent-island-gm", version: "0.4.0" },
    { instructions: gmBriefing },
  );
  let registerTool = bindRegisterTool({ prose: false, includeRawJson });

  registerTool(
    server,
    "join_as_gm",
    {
      description: describe("join_as_gm"),
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => coordinator.joinAsGm(sessionId),
  );

  registerGmTools(server, sessionId, coordinator, includeRawJson);
  return server;
}

function registerGmTools(
  server: McpServer,
  sessionId: string,
  coordinator: Colony,
  includeRawJson: boolean,
) {
  let registerTool = bindRegisterTool({ prose: false, includeRawJson });

  registerTool(
    server,
    "inspect_world",
    {
      description: describe("inspect_world"),
      inputSchema: {
        agent: schema
          .string()
          .optional()
          .describe(
            "An agent name: return its full state plus its observation",
          ),
        entity: schema
          .string()
          .optional()
          .describe(
            'An entity id (token, spawned entity, or "world"): return its full record',
          ),
        rule: schema
          .string()
          .optional()
          .describe("A rule id: return that rule's full body"),
        area: schema
          .object({
            around: schema
              .string()
              .optional()
              .describe("Center on this token or agent's position"),
            x: schema.number().optional().describe("Center x (if no `around`)"),
            y: schema.number().optional().describe("Center y (if no `around`)"),
            radius: schema
              .number()
              .optional()
              .describe("Chebyshev radius, default 4, capped at 10"),
          })
          .optional()
          .describe(
            "A map sub-region: its tiles plus the agents and entities standing in it",
          ),
        include: schema
          .array(schema.string())
          .optional()
          .describe(
            'Full sections to add/upgrade: agents, entities, rules, ruleMeta, map, observations, history, controllers, pulse — or "all".',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ agent, entity, rule, area, include }) =>
      coordinator.gmInspect(sessionId, {
        agent,
        entity,
        rule,
        area,
        include,
      }),
  );

  registerTool(
    server,
    "wait_for_world",
    {
      description: describe("wait_for_world"),
      inputSchema: {
        events: schema
          .array(schema.string().trim().min(1))
          .optional()
          .describe(
            'Event types to wake on. Matches both the in-world event stream (e.g. "victory", "said", "rule_error", or any type your own watch rules emit) and the GM audit stream ("world_grew", "world_regenerated", "entity_spawned", "announced", ...).',
          ),
        everyTicks: schema
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Also wake every N world ticks — the pacing heartbeat. Ticks only pass while characters are active.",
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ events, everyTicks }) =>
      coordinator.waitForWorld(sessionId, { events, everyTicks }),
  );

  registerTool(
    server,
    "list_rules",
    {
      description: describe("list_rules"),
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => coordinator.gmRules(sessionId),
  );

  registerTool(
    server,
    "add_rule",
    {
      description: describe("add_rule"),
      inputSchema: {
        rule: schema
          .record(schema.string(), schema.unknown())
          .describe("A complete rule object (see list_rules for templates)"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ rule }) => coordinator.gmAddRule(sessionId, rule),
  );

  registerTool(
    server,
    "remove_rule",
    {
      description: describe("remove_rule"),
      inputSchema: {
        id: schema
          .string()
          .trim()
          .min(1)
          .describe("The id of the rule to remove"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => coordinator.gmRemoveRule(sessionId, id),
  );

  registerTool(
    server,
    "save_scenario",
    {
      description: describe("save_scenario"),
      inputSchema: {
        name: schema
          .string()
          .trim()
          .min(1)
          .describe("Name for the new standalone scenario"),
        ids: schema
          .array(schema.string().trim().min(1))
          .min(1)
          .optional()
          .describe(
            "GM-edited rule ids to save; omit to save every current GM rule edit",
          ),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, ids }) => coordinator.gmSaveScenario(sessionId, name, ids),
  );

  registerTool(
    server,
    "clear_gm_edits",
    {
      description: describe("clear_gm_edits"),
      inputSchema: {},
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => coordinator.gmClearEdits(sessionId),
  );

  registerTool(
    server,
    "tweak_rule",
    {
      description: describe("tweak_rule"),
      inputSchema: {
        id: schema
          .string()
          .trim()
          .min(1)
          .describe("The id of the rule to tweak"),
        fields: schema
          .record(schema.string(), schema.unknown())
          .describe("Fields to merge into the rule, e.g. { rate: -4 }"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, fields }) => coordinator.gmPatchRule(sessionId, id, fields),
  );

  registerTool(
    server,
    "set_stock",
    {
      description: describe("set_stock"),
      inputSchema: {
        entity: schema
          .string()
          .trim()
          .min(1)
          .describe('Entity id: "world", an agent\'s name, or a token'),
        stock: schema.string().trim().min(1).describe("Stock name"),
        value: schema.number().describe("New value (clamped to bounds)"),
        min: schema
          .number()
          .optional()
          .describe(
            "Lower bound. Applied whether the stock is new or already exists (it overrides the current bound and re-clamps the value); omit to keep the existing/default bound",
          ),
        max: schema
          .number()
          .optional()
          .describe(
            "Upper bound. Applied whether the stock is new or already exists (it overrides the current bound and re-clamps the value); omit to keep the existing/default bound",
          ),
        icon: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            `A game-icons.net slug representing this resource on the dashboard (${ICON_SLUG_HOWTO}). REQUIRED when introducing a resource for the first time; optional for an already-known one (pass it to change the icon)`,
          ),
        color: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Optional CSS hex tint for the resource's icon, e.g. '#e6b84a'; omit for a neutral auto tint",
          ),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ entity, stock, value, min, max, icon, color }) => {
      let bounds =
        min === undefined && max === undefined ? undefined : { min, max };
      let visual =
        icon === undefined && color === undefined ? undefined : { icon, color };
      return coordinator.gmSetStock(
        sessionId,
        entity,
        stock,
        value,
        bounds,
        visual,
      );
    },
  );

  registerTool(
    server,
    "set_stock_default",
    {
      description: describe("set_stock_default"),
      inputSchema: {
        stock: schema.string().trim().min(1).describe("Stock name"),
        value: schema
          .number()
          .describe("Starting value every agent spawns with (clamped)"),
        min: schema.number().optional().describe("Lower bound (default 0)"),
        max: schema.number().optional().describe("Upper bound (default 100)"),
        icon: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            `A game-icons.net slug for this resource (${ICON_SLUG_HOWTO}). REQUIRED when the resource is new; optional once it's known. Used on the map, header pills, and agent stat rows`,
          ),
        color: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Optional CSS hex tint for the resource's icon, e.g. '#e6b84a'; omit for a neutral auto tint",
          ),
        role: schema
          .enum(["vital", "stat", "pack"])
          .optional()
          .describe(
            'What this stock IS to a character: "vital" (a pressure that can hurt or kill - band-alarmed prose, never a figure, never givable), "stat" (a personal dimension worth a mention only when notable - never givable), or "pack" (a fungible carried quantity - "Carrying:" figures, the only role give/stockpile touch). Omit to default to "pack".',
          ),
        stockpilable: schema
          .boolean()
          .optional()
          .describe(
            'Whether characters can haul this into a stockpile via deposit/withdraw. Only valid on a "pack"-role resource (explicit or defaulted) - rejected on a vital or stat.',
          ),
        label: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Friendly label for prose and the dashboard (e.g. 'warmth'); defaults to the stock name",
          ),
        bands: schema
          .object({
            pressing: schema.string().trim().min(1).optional(),
            serious: schema.string().trim().min(1).optional(),
            critical: schema.string().trim().min(1).optional(),
          })
          .optional()
          .describe(
            'What the world tells a character at each band of trouble (vital) or notability (stat) - e.g. {critical:"You are starving."}. Any band left unwritten gets a serviceable default built from the label.',
          ),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ stock, value, min, max, icon, color, role, stockpilable, label, bands }) =>
      coordinator.gmSetStockDefault(sessionId, stock, {
        value,
        min,
        max,
        icon,
        color,
        role,
        stockpilable,
        label,
        bands,
      }),
  );

  registerTool(
    server,
    "announce",
    {
      description: describe("announce"),
      inputSchema: {
        text: schema
          .string()
          .trim()
          .min(1)
          .max(160)
          .describe("The message to broadcast, delivered verbatim"),
        audience: schema
          .array(schema.string())
          .optional()
          .describe("Names of agents to address; omit to reach everyone"),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ text, audience }) =>
      coordinator.gmAnnounce(sessionId, text, audience),
  );

  registerTool(
    server,
    "spawn_entity",
    {
      description: describe("spawn_entity"),
      inputSchema: {
        id: schema.string().trim().min(1).describe("Unique entity id"),
        kind: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            'What the entity IS - the one identity name its sprite, label, and icon key off, e.g. "wolf" or "hearth". Rules can match it like a tag.',
          ),
        tags: schema
          .array(schema.string())
          .optional()
          .describe(
            'Behavior tags rules bind to (unordered), e.g. "water-source"; identity goes in `kind`, and how it sits on its tile goes in `occupancy`',
          ),
        stocks: schema
          .record(schema.string(), schema.unknown())
          .optional()
          .describe(
            'Stocks, e.g. { health: { value: 20, min: 0, max: 20 } }. A stock for a resource the world hasn\'t seen should carry an `icon` (a game-icons.net slug) and optionally a `color`, e.g. { ore: { value: 30, icon: "war-pick", color: "#9fb8d0" } }; a known resource (health, food) needs none',
          ),
        pos: schema
          .object({ x: schema.number(), y: schema.number() })
          .optional()
          .describe("Grid position for colocation"),
        occupancy: schema
          .enum(["tile", "blocking"])
          .optional()
          .describe(
            'How it takes ground. "tile" carves it onto the grid as a token agents can see, travel to, and cannot build over; "blocking" does the same and also makes routes go around it (a wall). Omit for something that only lies where it was put - invisible on the map, matchable by colocation. Needs pos.',
          ),
        reveal: schema
          .boolean()
          .optional()
          .describe(
            "Reveal the token to every agent immediately instead of waiting for one to wander within sight. Needs a token on the map.",
          ),
        icon: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            `Optional map icon for this entity's kind: a game-icons.net slug (${ICON_SLUG_HOWTO}). Registered under \`kind\` (required with an icon), so every entity of that kind draws with it, not just this one. If set, color is required.`,
          ),
        color: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "CSS hex tint for the icon, required when icon is set, e.g. '#e6b84a'",
          ),
        text: schema
          .string()
          .trim()
          .min(1)
          .max(MAX_INSCRIPTION)
          .optional()
          .describe(
            "An inscription the entity carries (a sign's face, carved lore). Agents read it verbatim when standing beside the token; opaque to rules.",
          ),
        allowImpassable: schema
          .boolean()
          .optional()
          .describe(
            "Permit a position on ground nobody can walk onto (water, lava). Off by default: such a token can only be reached from an adjacent tile and never stood or built on, so it is normally a mistake. Set true only for something that genuinely belongs there.",
          ),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      id,
      kind,
      tags,
      stocks,
      pos,
      occupancy,
      reveal,
      icon,
      color,
      text,
      allowImpassable,
    }) =>
      coordinator.gmSpawnEntity(sessionId, {
        id,
        kind,
        tags,
        stocks: stocks as any,
        pos,
        occupancy,
        reveal,
        icon,
        color,
        text,
        allowImpassable,
      }),
  );

  registerTool(
    server,
    "register_terrain",
    {
      description: describe("register_terrain"),
      inputSchema: {
        name: schema
          .string()
          .trim()
          .min(1)
          .describe("The terrain kind's name, e.g. 'lava' or 'swamp'"),
        passable: schema
          .boolean()
          .optional()
          .describe(
            "Can agents walk onto it? Default true. false makes it a wall/hazard they route around (harvest it from an adjacent tile with harvest:'near')",
          ),
        moveCost: schema
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Ticks to step onto a tile of it (default 1); higher = slower ground",
          ),
        sprite: spriteSpecSchema
          .optional()
          .describe(
            "Optional ground sprite as an inline sprite DSL (kind:'terrain', filling the cell). Without one the tile renders as the missing-sprite checker",
          ),
        color: schema
          .string()
          .trim()
          .optional()
          .describe("Map fill as a CSS hex, e.g. '#ff6a00'"),
        icon: schema
          .string()
          .trim()
          .optional()
          .describe(
            `Optional map icon: a game-icons.net slug (${ICON_SLUG_HOWTO})`,
          ),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, passable, moveCost, sprite, color, icon }) =>
      coordinator.gmRegisterTerrain(sessionId, name, {
        passable,
        moveCost,
        visual: sprite || color || icon ? { sprite, color, icon } : undefined,
      }),
  );

  registerTool(
    server,
    "register_kind_visual",
    {
      description: describe("register_kind_visual"),
      inputSchema: {
        kind: schema
          .string()
          .trim()
          .min(1)
          .describe('The entity kind, e.g. "hearth" or "workbench"'),
        sprite: spriteSpecSchema
          .optional()
          .describe(
            "Optional map sprite as an inline sprite DSL (palette + 16px grid rows)",
          ),
        icon: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(`Optional game-icons.net slug (${ICON_SLUG_HOWTO})`),
        color: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional CSS hex tint"),
        label: schema
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Optional human-readable map label"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ kind, sprite, icon, color, label }) =>
      coordinator.gmRegisterKindVisual(sessionId, kind, {
        sprite,
        icon,
        color,
        label,
      }),
  );

  registerTool(
    server,
    "set_terrain",
    {
      description: describe("set_terrain"),
      inputSchema: {
        at: schema
          .array(schema.object({ x: schema.number(), y: schema.number() }))
          .min(1)
          .describe("The tiles to repaint"),
        to: schema
          .string()
          .trim()
          .min(1)
          .describe(
            "The terrain kind to paint them (register_terrain it first if new)",
          ),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ at, to }) => coordinator.gmSetTerrain(sessionId, at, to),
  );
}

// The character surface takes its structured input loose and validates it in
// the handler. zod rejects a bad argument INSIDE the SDK, before any tool
// handler runs, and its message is a JSON dump of issue objects - the one
// channel a prose-only server can't reach. Taking the value as-is and checking
// it here puts every failure back through the normal error path, where it
// comes out as a sentence. The strict shape still exists: orderInputSchema
// runs below, it just no longer owns the wording.
const ORDER_INPUT = schema
  .unknown()
  .describe(
    'An order: {"kind":"repeat","action":{...},"maxRepeats":n} or {"kind":"sequence","steps":[{...}]} - see the description above',
  );

function parseOrder(order: unknown) {
  // Some models send the order as a JSON-encoded string; accept that too.
  if (typeof order === "string") {
    try {
      order = JSON.parse(order);
    } catch {
      throw new Error(
        "That order is malformed: it arrived as a string that is not valid JSON. Pass the order as a JSON object.",
      );
    }
  }
  let parsed = orderInputSchema.safeParse(order);
  if (parsed.success) return parsed.data;
  let issues = parsed.error.issues
    .map((issue) => {
      let path = issue.path.join(".");
      return path ? `${path} - ${issue.message}` : issue.message;
    })
    .join("; ");
  throw new Error(`That order is malformed: ${issues}`);
}

// Text the engine has no guard of its own for.
function proseText(value: string, field: string, max: number): string {
  let text = value.trim();
  if (!text || text.length > max)
    throw new Error(`Your ${field} must be 1 to ${max} characters.`);
  return text;
}

type ToolHandler = (input: any) => unknown | Promise<unknown>;

// How a server renders results. The character surface is prose-only: text is
// the whole message, with no structuredContent twin to fall back on, so every
// fact a player needs must survive the renderer. The GM surface keeps the
// structured payload - a director reads rules, pulses and dry-run reports as
// data, and has no fog to preserve.
type ResultMode = { prose: true } | { prose: false; includeRawJson: boolean };

// Bound once per MCP server (character/GM), so every registerTool call at every
// call site doesn't need to thread the mode itself.
function bindRegisterTool(mode: ResultMode) {
  return function registerTool(
    server: McpServer,
    name: string,
    configuration: any,
    handler: ToolHandler,
  ) {
    server.registerTool(name, configuration, async (input: any) => {
      try {
        return toolResult(await handler(input), false, mode);
      } catch (error) {
        return toolResult({ error: (error as Error).message }, true, mode);
      }
    });
  };
}

function toolResult(result: unknown, isError: boolean, mode: ResultMode) {
  if (mode.prose)
    return {
      content: [{ type: "text" as const, text: renderCharacterResult(result) }],
      isError,
    };
  return {
    content: [
      {
        type: "text" as const,
        text: summarizeToolResult(result, mode.includeRawJson),
      },
    ],
    structuredContent: structuredToolResult(result),
    isError,
  };
}

function summarizeToolResult(result: unknown, includeRawJson: boolean): string {
  if (!isRecord(result)) return String(result ?? "");

  if (typeof result.error === "string") return `error: ${result.error}`;
  // Sense results and wake reports share one renderer family, so a character
  // learns a single format and can re-orient from any message.
  if (typeof result.sense === "string") return describeSense(result);
  if (isWakeResult(result)) return renderWake(result);
  if (typeof result.status === "string") return result.status;
  if (typeof result.message === "string") return result.message;

  // A bare acknowledgement carries no data worth serializing.
  if (result.ok === true && Object.keys(result).length === 1) return "ok";

  // Everything else is data-bearing. structuredContent already carries it in
  // full; most MCP clients read that and a terse pointer here is enough. Only
  // a client that connected with ?rawJson=1 (because it only reads
  // content[].text and ignores structuredContent) gets the full duplicate.
  if (!includeRawJson) {
    let keys = Object.keys(result);
    return keys.length
      ? `Result has fields: ${keys.join(", ")} (see structuredContent for values).`
      : "ok";
  }

  return JSON.stringify(result, null, 2);
}

function structuredToolResult(result: unknown): Record<string, unknown> {
  if (isRecord(result)) return result;
  return { result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTruthyQueryFlag(value: unknown): boolean {
  let flag = Array.isArray(value) ? value[0] : value;
  return flag === "1" || flag === "true";
}

function sendProtocolError(
  response: Response,
  status: number,
  message: string,
) {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}
