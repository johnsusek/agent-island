import assert from "node:assert/strict";
import test from "node:test";

import { step, type KernelWorld, type Rule } from "../src/kernel.js";

// A watch fires when its condition newly holds, judged against the world as it
// stood before the tick. The clock has to be part of that "before", or a watch
// on the tick itself never sees a crossing and silently never fires.
test("a watch on the clock fires once, on the tick it crosses", () => {
  let world: KernelWorld = {
    tick: 0,
    entities: { world: { id: "world", tags: ["world"], stocks: {} } },
  };
  let rules: Rule[] = [
    {
      id: "season-ends",
      phase: "watch",
      each: { tag: "world" },
      when: { cmp: "gte", left: { tick: true }, right: 3 },
      emit: { type: "season_over", global: true },
    },
  ];

  let fired: number[] = [];
  for (let i = 0; i < 6; i += 1)
    if (step(world, rules).some((e) => e.type === "season_over"))
      fired.push(world.tick);

  assert.deepEqual(fired, [3]);
});
