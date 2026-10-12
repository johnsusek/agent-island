# @agent-island/core

The rules kernel behind [`@agent-island/mcp`](../mcp): a small, fully
serializable simulation engine with no I/O.

- **Entities** hold named numeric **stocks** (`{ value, min, max }`), tags,
  and optionally a position on a grid.
- **Rules** are plain JSON: flows, thresholds, watches, transitions, event
  reactions, derived values, actions, and modifiers. A tick runs them in
  fixed phases, so the result never depends on the order they were added.
- **`rule-schema`** validates a rule before it runs, and **`dryrun`**
  simulates a rule on a copy of the world and reports what it would break.
- **`space`** is the grid: terrain, passability, sight, and movement.

```ts
import { step, type KernelWorld, type Rule } from "@agent-island/core";

let world: KernelWorld = {
  tick: 0,
  entities: {
    world: {
      id: "world",
      tags: ["world"],
      stocks: { fish: { value: 30, min: 0, max: 40 } },
    },
  },
};
let rules: Rule[] = [
  {
    id: "regrow",
    phase: "flow",
    each: { tag: "world" },
    target: "fish",
    rate: 0.5,
  },
];
step(world, rules);
```

Most users want the [engine](../engine) or the [MCP host](../mcp), which
build worlds from scenario files. The full rule grammar is the `Rule` type in
[`src/kernel.ts`](src/kernel.ts).

> Not published yet; the `@agent-island/*` names are placeholders.
