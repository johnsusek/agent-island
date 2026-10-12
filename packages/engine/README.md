# @agent-island/engine

A world host on [`@agent-island/core`](../core), with no I/O: give
`createWorld` a scenario and it runs a world agents can live in.

- Agents join on the grid, see what is in sight, and talk within earshot.
- Actions defined by the rules, plus standing orders ("repeat this until
  my basket is full").
- Events reach whoever could perceive them.
- Rules can be added, changed, removed, and dry-run while the world runs.
- Scenarios layer on as overlays, and the whole world snapshots and
  restores.

```ts
import { createWorld } from "@agent-island/engine";

let world = createWorld(scenario, { requireStockIcons: false });
world.applyOverlay(overlay);
world.addAgent("Ara");
world.commitIntent("ara", { type: "fish" });
world.tick();
```

To put a world on MCP for agents to play, use
[`@agent-island/mcp`](../mcp), whose README covers scenarios and rules.

> Not published yet; the `@agent-island/*` names are placeholders.
