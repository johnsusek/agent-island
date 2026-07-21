// The director's wake loop: wait_for_world parks a GM session until an event
// matching its filter lands (in either the character or GM audit stream) or its
// tick cadence comes due, and every delivery carries the pulse digest. These
// tests drive ticks the same way victory.test.ts does - a sole parked character
// fast-forwards the world - while a parked GM watches.

import assert from "node:assert/strict";
import test from "node:test";

import { createColony } from "../src/coordinator.js";
import { createWorld } from "../src/rules/engine.js";
import type { Scenario } from "../src/rules/scenario.js";

// A tiny scenario with a director tripwire: a world `progress` stock ticks up
// by one, and a watch rule emits a global `omen` once it reaches `at` - the
// exact shape the briefing tells a director to author for threshold wakes.
function omenScenario(at: number): Scenario {
  return {
    name: "omen-demo",
    spawn: { x: 1, y: 1 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    rules: [
      { id: "progress", phase: "flow", target: "progress", rate: 1 },
      {
        id: "omen-at-progress",
        phase: "watch",
        when: {
          cmp: "gte",
          left: { stock: "progress", of: "world" },
          right: at,
        },
        emit: { type: "omen", text: "The sky darkens.", global: true },
      },
    ],
  };
}

test("wait_for_world rejects before join_as_gm and without any trigger", () => {
  let colony = createColony({ engine: createWorld(omenScenario(3)) });
  colony.start();
  colony.connect("s1");
  colony.connect("gm");
  try {
    assert.throws(
      () => colony.waitForWorld("s1", { events: ["omen"] }),
      /join_as_gm/,
    );
    colony.joinAsGm("gm");
    assert.throws(() => colony.waitForWorld("gm", {}), /events.*everyTicks/s);
  } finally {
    colony.stop();
  }
});

test("a watch-rule tripwire wakes a parked director with the event and a pulse", async () => {
  let colony = createColony({
    engine: createWorld(omenScenario(3)),
    waitTimeoutMs: 5000,
  });
  colony.start();
  colony.connect("gm");
  colony.connect("s1");
  try {
    colony.joinAsGm("gm");
    colony.join("s1", "Ara");

    let wake = colony.waitForWorld("gm", { events: ["omen"] });
    // The sole character parks, which completes the barrier and fast-forwards
    // the world to the omen tick.
    void colony.waitForChange("s1");

    let result = await wake;
    assert.equal(result.status, "changed");
    assert.ok(
      result.events.some((event: any) => event.type === "omen"),
      "the matched tripwire event is delivered",
    );
    assert.equal(typeof result.pulse.population, "number");
    assert.equal(typeof result.pulse.ticksSinceLastDecisionEvent, "number");
    assert.ok(result.tick >= 3, "delivered at or after the omen tick");
  } finally {
    colony.stop();
  }
});

test("a GM edit in another session wakes a director parked on the audit stream", async () => {
  let colony = createColony({
    engine: createWorld(omenScenario(50)),
    waitTimeoutMs: 5000,
  });
  colony.start();
  colony.connect("director");
  colony.connect("console");
  try {
    colony.joinAsGm("director");
    colony.joinAsGm("console");

    let wake = colony.waitForWorld("director", {
      events: ["entity_spawned"],
    });
    colony.gmSpawnEntity("console", {
      id: "obelisk",
      tags: [],
      occupancy: "tile",
    });

    let result = await wake;
    assert.equal(result.status, "changed");
    assert.ok(
      result.gmEvents.some((event: any) => event.kind === "entity_spawned"),
      "the audit-stream event is delivered",
    );
  } finally {
    colony.stop();
  }
});

test("everyTicks wakes on cadence and re-arming does not re-deliver", async () => {
  let colony = createColony({
    engine: createWorld(omenScenario(1000)),
    waitTimeoutMs: 5000,
  });
  colony.start();
  colony.connect("gm");
  colony.connect("s1");
  try {
    colony.joinAsGm("gm");
    colony.join("s1", "Ara");

    let wake = colony.waitForWorld("gm", { everyTicks: 3 });
    void colony.waitForChange("s1");
    let first = await wake;
    assert.equal(first.status, "changed");
    assert.ok(first.tick >= 3, "cadence came due");

    // Re-arm immediately: the delivered tick advanced, so the cadence must
    // count from the delivery, not fast-path on the same ticks again.
    let again = colony.waitForWorld("gm", { everyTicks: 1000 });
    let raced = await Promise.race([
      again,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    assert.equal(raced, "pending", "no immediate second delivery");
  } finally {
    colony.stop();
  }
});

test("consecutive waits deliver disjoint event sets", async () => {
  let colony = createColony({
    engine: createWorld(omenScenario(1000)),
    waitTimeoutMs: 5000,
  });
  colony.start();
  colony.connect("director");
  colony.connect("console");
  try {
    colony.joinAsGm("director");
    colony.joinAsGm("console");

    // Announcements land in both streams, so this also proves both cursors
    // advance on delivery.
    let wake = colony.waitForWorld("director", { events: ["announced"] });
    colony.gmAnnounce("console", "the first omen");
    let first = await wake;
    assert.equal(first.status, "changed");
    assert.ok(
      first.events.some((event: any) =>
        String(event.message ?? event.text).includes("first"),
      ),
    );

    let second = colony.waitForWorld("director", { events: ["announced"] });
    colony.gmAnnounce("console", "the second omen");
    let result = await second;
    assert.equal(result.status, "changed");
    assert.ok(
      result.events.every(
        (event: any) => !String(event.message ?? event.text).includes("first"),
      ),
      "the first announcement is not re-delivered",
    );
    assert.ok(
      result.events.some((event: any) =>
        String(event.message ?? event.text).includes("second"),
      ),
    );
  } finally {
    colony.stop();
  }
});

test("a timed-out wait returns idle and still carries the pulse", async () => {
  let colony = createColony({
    engine: createWorld(omenScenario(1000)),
    waitTimeoutMs: 100,
  });
  colony.start();
  colony.connect("gm");
  // The waiter's timeout timer is unref'd; hold the event loop open past it.
  let hold = setTimeout(() => {}, 2000);
  try {
    colony.joinAsGm("gm");
    let result = await colony.waitForWorld("gm", { events: ["omen"] });
    assert.equal(result.status, "idle");
    assert.equal(typeof result.pulse.population, "number");
  } finally {
    clearTimeout(hold);
    colony.stop();
  }
});

test("a parked director alone never advances the clock", async () => {
  let colony = createColony({
    engine: createWorld(omenScenario(1000)),
    waitTimeoutMs: 100,
  });
  colony.start();
  colony.connect("gm");
  let hold = setTimeout(() => {}, 2000);
  try {
    colony.joinAsGm("gm");
    let result = await colony.waitForWorld("gm", { everyTicks: 1 });
    // With no characters there is nothing to gate the barrier open: the wait
    // idles out with the world still on tick 0.
    assert.equal(result.status, "idle");
    assert.equal(colony.getAdminPayload().state.tick, 0);
  } finally {
    clearTimeout(hold);
    colony.stop();
  }
});

test("victory conclusion resolves a parked director with status ended", async () => {
  let colony = createColony({
    engine: createWorld({
      ...omenScenario(1000),
      rules: [
        { id: "progress", phase: "flow", target: "progress", rate: 1 },
        {
          id: "win",
          phase: "watch",
          when: {
            cmp: "gte",
            left: { stock: "progress", of: "world" },
            right: 3,
          },
          emit: { type: "victory", text: "Done.", global: true },
        },
      ],
    }),
    victoryGraceTicks: 0,
    waitTimeoutMs: 5000,
  });
  colony.start();
  colony.connect("gm");
  colony.connect("s1");
  try {
    colony.joinAsGm("gm");
    colony.join("s1", "Ara");

    // Park the director on something that never fires, so only the conclusion
    // can resolve it.
    let wake = colony.waitForWorld("gm", { events: ["never"] });
    void colony.waitForChange("s1");

    let result = await wake;
    assert.equal(result.status, "ended");
    assert.equal(typeof result.pulse.population, "number");
  } finally {
    colony.stop();
  }
});
