import assert from "node:assert/strict";
import test from "node:test";

import { normalizeOrderInput } from "@agent-island/engine/orders";
import { makeSurvivalEngine } from "./helpers.js";

function survival() {
  return makeSurvivalEngine();
}

function tickUntilOrderStops(
  engine: ReturnType<typeof survival>,
  agentId: string,
) {
  for (let tickCount = 0; tickCount < 40; tickCount += 1) {
    let order = engine.getObservation(agentId).you.order;
    if (order?.status !== "running") return order;
    engine.tick();
  }
  throw new Error("order did not stop");
}

test("an order passed as a JSON string is parsed", () => {
  let order = normalizeOrderInput(
    '{"kind":"sequence","steps":[{"type":"travel","location":"meadow-1"},{"type":"eat"}]}',
  );
  assert.equal(order.kind, "sequence");
  assert.deepEqual(order, {
    kind: "sequence",
    steps: [{ type: "travel", location: "meadow-1" }, { type: "eat" }],
    interrupts: [],
    label: undefined,
  });
});

test("a non-JSON string order still errors clearly", () => {
  assert.throws(
    () => normalizeOrderInput("explore east"),
    /Order must be one object/,
  );
});

test("a repeat order runs primitive actions until its stop condition", () => {
  let engine = survival();
  engine.addAgent("ara");

  let started = engine.setOrder("ara", {
    kind: "repeat",
    action: { type: "rest" },
    maxRepeats: 2,
  });

  assert.equal(started.order?.status, "running");
  assert.equal(engine.getObservation("ara").you.action?.type, "rest");

  let stopped = tickUntilOrderStops(engine, "ara");
  assert.equal(stopped?.status, "completed");
  assert.equal(stopped?.repeats, 2);
  assert.equal(stopped?.reason, "max repeats reached");

  let events = engine.recentEvents();
  assert.ok(
    events.some((event) => event.type === "rested" && event.wake === "routine"),
    "routine action events do not demand a new decision",
  );
  assert.ok(
    events.some(
      (event) => event.type === "order_completed" && event.wake === "decision",
    ),
    "order lifecycle events wake the controller",
  );
});

test("manual actions cancel a running order", () => {
  let engine = survival();
  engine.addAgent("ara");

  engine.setOrder("ara", {
    kind: "repeat",
    action: { type: "rest" },
    maxRepeats: 3,
  });
  engine.commitIntent("ara", { type: "rest" });

  let order = engine.getObservation("ara").you.order;
  assert.equal(order?.status, "cancelled");
  assert.equal(order?.reason, "manual action");
  let eventTypes = engine
    .recentEvents()
    .slice(-3)
    .map((event) => event.type);
  assert.deepEqual(eventTypes, [
    "order_cancelled",
    "action_abandoned",
    "action_started",
  ]);
});

test("an invalid replacement leaves the current order running", () => {
  let engine = survival();
  engine.addAgent("ara");
  engine.setOrder("ara", {
    kind: "repeat",
    action: { type: "rest" },
    maxRepeats: 3,
  });
  let before = engine.getOrder("ara").order;

  assert.throws(
    () => engine.setOrder("ara", { kind: "sequence", steps: [] }),
    /needs one or more steps/,
  );
  assert.deepEqual(engine.getOrder("ara").order, before);
});

test("an unrecognized manual action throws and leaves the current order running", () => {
  let engine = survival();
  engine.addAgent("ara");
  engine.setOrder("ara", {
    kind: "repeat",
    action: { type: "rest" },
    maxRepeats: 3,
  });
  let before = engine.getOrder("ara").order;

  assert.throws(
    () => engine.commitIntent("ara", { type: "typo" }),
    /Unknown action "typo"/,
  );
  assert.deepEqual(engine.getOrder("ara").order, before);
});
