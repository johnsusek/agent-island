import assert from "node:assert/strict";
import test from "node:test";

import { createColony } from "../src/coordinator.js";

// The real-time clock is the one place the world advances on wall-clock rather
// than on the turn barrier, so these tests use real timers and short waits. They
// prove the whole point: time keeps moving while an agent never parks (never
// calls wait_for_change), which under the default lockstep barrier would freeze
// the world for everyone.

let sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the real-time clock advances the world while an agent never parks", async () => {
  let colony = createColony({ realTimeMs: 40, scenarios: ["survival"] });
  colony.start();
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    let before = colony.getAdminPayload().state.tick;
    // Ara is "thinking" - she never parks. Under lockstep the world would be
    // frozen; the real-time clock ticks on regardless.
    await sleep(250);
    let after = colony.getAdminPayload().state.tick;
    assert.ok(
      after > before,
      `world advanced without the agent parking (${before} -> ${after})`,
    );
  } finally {
    colony.stop();
  }
});

test("setPaused freezes the real-time clock and resuming lets it run again", async () => {
  let colony = createColony({ realTimeMs: 40, scenarios: ["survival"] });
  colony.start();
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    assert.equal(
      colony.getAdminPayload().liveness.paused,
      false,
      "starts un-paused",
    );

    // Pause: the returned payload reflects it, and ticking stops even though the
    // real-time clock's cadence is unchanged and Ara never parks.
    let payload = colony.setPaused(true);
    assert.equal(payload.liveness.paused, true);
    let frozen = colony.getAdminPayload().state.tick;
    await sleep(200);
    assert.equal(
      colony.getAdminPayload().state.tick,
      frozen,
      "a paused world holds still under the real-time clock",
    );

    // Resume: the clock keeps its cadence and time moves again.
    colony.setPaused(false);
    await sleep(250);
    assert.ok(
      colony.getAdminPayload().state.tick > frozen,
      "resuming lets the real-time clock advance the world again",
    );
  } finally {
    colony.stop();
  }
});

test("setRealTime toggles between lockstep and real-time at runtime", async () => {
  let colony = createColony({ scenarios: ["survival"] }); // default off
  colony.start();
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    assert.equal(
      colony.getAdminPayload().liveness.realTimeMs,
      0,
      "starts on the lockstep barrier",
    );

    // Lockstep: an un-parked (thinking) agent freezes the world.
    let frozen = colony.getAdminPayload().state.tick;
    await sleep(150);
    assert.equal(
      colony.getAdminPayload().state.tick,
      frozen,
      "lockstep freezes the world while the agent thinks",
    );

    // Flip the clock on - the returned payload reflects it, and time starts to
    // move even though Ara still never parks.
    let payload = colony.setRealTime(40);
    assert.equal(payload.liveness.realTimeMs, 40);
    await sleep(250);
    assert.ok(
      colony.getAdminPayload().state.tick > frozen,
      "real-time clock advances the frozen world",
    );

    // Flip it back off - the barrier resumes and the world re-freezes for the
    // still-thinking agent (the 30s backstop won't fire inside this window).
    colony.setRealTime(0);
    let settled = colony.getAdminPayload().state.tick;
    await sleep(150);
    assert.equal(
      colony.getAdminPayload().state.tick,
      settled,
      "the world re-freezes once the barrier is back",
    );
  } finally {
    colony.stop();
  }
});
