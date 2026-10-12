// serve, end to end: the commons example over real HTTP, driven by the MCP
// SDK's own client the way any agent harness would connect.

import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { parseServeArgs, serve } from "../src/serve.js";

let example = new URL("../examples/commons/", import.meta.url).pathname;

function text(result: any): string {
  return result.content.map((part: any) => part.text ?? "").join("\n");
}

async function connect(url: string, name: string) {
  let client = new Client({ name, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

test("serve runs the commons example for MCP clients", async () => {
  let server = await serve({
    world: `${example}world.json`,
    scenariosDir: `${example}scenarios`,
    port: 0,
    name: "commons-test",
  });
  let character: Client | undefined;
  let gm: Client | undefined;
  try {
    character = await connect(`${server.url}/mcp`, "ara");
    assert.equal(character.getServerVersion()?.name, "commons-test");
    assert.match(character.getInstructions() ?? "", /^# Agent briefing/);

    let joined = await character.callTool({
      name: "join_game",
      arguments: { name: "Ara" },
    });
    assert.match(text(joined), /fish in the bay 30\/40/);
    assert.match(text(joined), /You can: .*fish/);

    let acted = await character.callTool({
      name: "set_order",
      arguments: { order: { kind: "sequence", steps: [{ type: "fish" }] } },
    });
    assert.equal(acted.isError ?? false, false, text(acted));

    gm = await connect(`${server.url}/gm`, "gm");
    assert.equal(gm.getServerVersion()?.name, "commons-test-gm");
    let tools = (await gm.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes("dry_run_rule"));

    // The folder's only scenario is running: its rules are live.
    let state = (await (await fetch(`${server.url}/api/state`)).json()) as {
      rules: { id: string }[];
    };
    assert.ok(state.rules.some((rule) => rule.id === "season-ends"));
  } finally {
    await character?.close();
    await gm?.close();
    await server.close();
  }
});

test("serve's arguments parse, and mistakes are named", () => {
  assert.deepEqual(
    parseServeArgs(["--world", "w.json", "--port=4000", "--tick-ms", "500"]),
    {
      world: "w.json",
      scenariosDir: undefined,
      scenario: undefined,
      dataDir: undefined,
      port: 4000,
      host: undefined,
      name: undefined,
      briefing: undefined,
      gmBriefing: undefined,
      tickMs: 500,
    },
  );
  assert.throws(() => parseServeArgs([]), /--world is required/);
  assert.throws(
    () => parseServeArgs(["--world", "w.json", "--colour", "red"]),
    /Unknown option --colour/,
  );
  assert.throws(
    () => parseServeArgs(["--world", "w.json", "--port", "abc"]),
    /--port must be a whole number/,
  );
});
