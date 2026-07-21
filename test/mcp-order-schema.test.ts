import assert from "node:assert/strict";
import test from "node:test";

import { orderInputSchema } from "../src/mcp-order-schema.js";

test("order MCP schema accepts repeat and sequence orders", () => {
  assert.equal(
    orderInputSchema.safeParse({
      kind: "sequence",
      steps: [{ type: "travel", location: "town-2" }, { type: "buy_grain" }],
    }).success,
    true,
  );
  assert.equal(
    orderInputSchema.safeParse({
      kind: "repeat",
      action: { type: "explore", direction: "north" },
      until: [{ kind: "agent_stock_at_least", stock: "coin", value: 150 }],
      interrupts: [{ kind: "visible_event", type: "said" }],
      maxRepeats: 10,
    }).success,
    true,
  );
});

test("order MCP schema rejects nested sequence actions and wrong condition fields", () => {
  assert.equal(
    orderInputSchema.safeParse({
      kind: "sequence",
      steps: [{ action: { type: "buy_grain" } }],
    }).success,
    false,
  );
  assert.equal(
    orderInputSchema.safeParse({
      kind: "repeat",
      action: { type: "buy_grain" },
      until: [{ kind: "agent_stock_at_least", stock: "coin", amount: 150 }],
    }).success,
    false,
  );
});
