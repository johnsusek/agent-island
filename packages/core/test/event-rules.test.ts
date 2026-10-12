import assert from "node:assert/strict";
import test from "node:test";

import { step, stock, type KernelWorld, type Rule } from "../src/kernel.js";

test("event rules handle events emitted by transitions in the same tick", () => {
  let world: KernelWorld = {
    tick: 0,
    entities: {
      world: {
        id: "world",
        tags: ["world"],
        stocks: { signal: stock(0) },
      },
    },
  };
  let rules: Rule[] = [
    {
      id: "signal-started",
      phase: "transition",
      when: { cmp: "eq", left: { stock: "signal" }, right: 0 },
      do: [],
      emit: { type: "signal_started" },
    },
    {
      id: "signal-reacted",
      phase: "event",
      on: "signal_started",
      do: [{ adjust: { target: "signal", by: 1 } }],
    },
  ];

  let events = step(world, rules);

  assert.equal(world.entities.world.stocks.signal.value, 1);
  assert.ok(events.some((event) => event.type === "signal_started"));
});
