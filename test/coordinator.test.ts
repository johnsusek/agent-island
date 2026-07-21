import assert from "node:assert/strict";
import { hasTag } from "../src/rules/kernel.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createColony } from "../src/coordinator.js";
import { wipeCharacterMemories } from "../src/server.js";
import { scenario } from "../src/rules/config.js";
import { makeSurvivalEngine } from "./helpers.js";

// Production no longer hands a fresh character a known food source — it must
// explore to find one. A blind sweep would starve the character first, so the
// scaffold beelines: it reads the nearest food tile off the (omniscient) map
// payload and explores straight at it until the token enters the agent's fog,
// returning the nearest one it then knows. Bounded, so a stuck search fails loudly
// instead of hanging.
async function discoverFood(
  colony: any,
  sid: string,
  joined: any,
): Promise<string> {
  // Skip food within sight of spawn (SIGHT 12): callers rely on the destination
  // being far enough that a newcomer at spawn can't see it, so reaching it
  // genuinely reveals fresh fog.
  let start = joined.observation.you.position;
  let foodTiles = colony
    .getAdminPayload()
    .tokens.filter(
      (t: any) =>
        !!t.token &&
        hasTag(t.token, "food") &&
        Math.max(Math.abs(t.x - start.x), Math.abs(t.y - start.y)) > 12,
    );
  let farFood = new Set(foodTiles.map((t: any) => t.token.name));
  let nearestKnown = (obs: any) =>
    obs.known.locations
      .filter((l: any) => farFood.has(l.name))
      .sort((a: any, b: any) => a.distance - b.distance)[0];
  // Eight compass steps, so a blocked beeline (water across the straight line)
  // can detour around instead of dead-ending.
  let steps: [string, number, number][] = [
    ["north", 0, -1],
    ["south", 0, 1],
    ["east", 1, 0],
    ["west", -1, 0],
    ["northeast", 1, -1],
    ["northwest", -1, -1],
    ["southeast", 1, 1],
    ["southwest", -1, 1],
  ];
  let obs = joined.observation;
  for (let i = 0; i < 15; i += 1) {
    let found = nearestKnown(obs);
    if (found) return found.name;
    let me = obs.you.position;
    let target = foodTiles
      .map((t: any) => ({
        t,
        d: Math.max(Math.abs(t.x - me.x), Math.abs(t.y - me.y)),
      }))
      .sort((a: any, b: any) => a.d - b.d)[0];
    if (!target) break;
    // Try the directions that land us closest to the target first, skipping any
    // the engine rejects (impassable water or the map edge).
    let ranked = steps
      .map(([dir, dx, dy]) => ({
        dir,
        d: Math.max(
          Math.abs(me.x + dx - target.t.x),
          Math.abs(me.y + dy - target.t.y),
        ),
      }))
      .sort((a, b) => a.d - b.d);
    let stepped = false;
    for (let { dir } of ranked) {
      let acting;
      try {
        acting = colony.act(sid, { type: "explore", direction: dir });
      } catch {
        continue; // blocked - try the next-best direction
      }
      if (acting.status === "acting") {
        let change = await colony.waitForChange(sid);
        obs = change.observation;
        stepped = true;
        break;
      }
    }
    if (!stepped) break;
  }
  throw new Error("character never discovered a food source");
}

async function waitUntil(condition: () => boolean, timeoutMs = 500) {
  let deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(condition(), true);
}

// The world is turn-based on a logical clock: it advances only when every active
// player is parked in wait_for_change. These tests drive that barrier directly.
// A small maxWaitMs is used where a deliberately-idle player must not freeze the
// world — it stands in for the backstop that bounds how long a turn may stall.

test("a session joins by name, acts, and wait_for_change wakes on completion", async () => {
  let colony = createColony({ waitTimeoutMs: 2000, scenarios: ["survival"] });
  colony.start();
  colony.connect("s1");
  try {
    let joined = colony.join("s1", "Ara");
    assert.equal(joined.status, "joined");
    assert.equal(joined.observation.you.id, "ara");
    let dest = await discoverFood(colony, "s1", joined);

    let acting = colony.act("s1", { type: "travel", location: dest });
    assert.equal(acting.status, "acting");
    assert.ok(acting.accepted);
    assert.ok(acting.duration > 0);

    // Sole active player: parking completes the barrier and the world advances
    // straight to arrival.
    let change = await colony.waitForChange("s1");
    assert.equal(change.status, "changed");
    assert.equal(change.observation.you.at, dest);
    assert.ok(change.events.some((event: any) => event.type === "arrived"));
  } finally {
    colony.stop();
  }
});

test("concurrent wait_for_change calls share one pending result", async () => {
  let colony = createColony({ waitTimeoutMs: 2000 });
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    let first = colony.waitForChange("a");
    let second = colony.waitForChange("a");
    assert.equal(second, first);

    colony.connect("b");
    colony.join("b", "Bren");
    colony.speak("b", "hello");
    let [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, "changed");
    assert.deepEqual(secondResult, firstResult);
  } finally {
    colony.stop();
  }
});

test("durable orders run routine actions before waking for a decision", async () => {
  let colony = createColony({ waitTimeoutMs: 2000, scenarios: ["survival"] });
  colony.start();
  colony.connect("session-one");
  try {
    colony.join("session-one", "Ara");
    let ordered = colony.setOrder("session-one", {
      kind: "repeat",
      action: { type: "rest" },
      maxRepeats: 2,
    });
    assert.equal(ordered.status, "ordered");
    assert.ok(ordered.order);
    assert.equal(ordered.order.status, "running");
    assert.equal((ordered as any).observation, undefined);

    let change = await colony.waitForChange("session-one");
    assert.equal(change.status, "changed");
    assert.equal(change.observation.you.order.status, "completed");
    assert.equal(change.observation.you.order.repeats, 2);
    assert.ok(change.observation.tick >= 12);
    assert.ok(change.events.some((event: any) => event.type === "rested"));
    assert.ok(
      change.events.some((event: any) => event.type === "order_completed"),
    );
  } finally {
    colony.stop();
  }
});

test("set_order_and_wait returns the completion observation", async () => {
  let colony = createColony({ waitTimeoutMs: 2000 });
  colony.start();
  colony.connect("session-one");
  try {
    let joined = colony.join("session-one", "Ara");
    let explore = joined.observation.availableActions.find(
      (action: any) => action.name === "explore" && action.options?.length,
    );
    assert.ok(explore);
    let direction = explore.options?.[0];
    assert.equal(typeof direction, "string");
    let change = await colony.setOrderAndWait("session-one", {
      kind: "sequence",
      steps: [{ type: "explore", direction }],
    });
    assert.equal(change.status, "changed");
    assert.equal(change.observation.you.order.status, "completed");
    assert.ok(change.observation.tick > joined.observation.tick);
  } finally {
    colony.stop();
  }
});

test("another character is not woken by routine order progress", async () => {
  let colony = createColony({ waitTimeoutMs: 30, scenarios: ["survival"] });
  colony.start();
  colony.connect("session-one");
  colony.connect("session-two");
  try {
    colony.join("session-one", "Ara");
    colony.join("session-two", "Bren");
    colony.setOrder("session-one", {
      kind: "repeat",
      action: { type: "rest" },
      maxRepeats: 1,
    });

    let araWait = colony.waitForChange("session-one");
    let brenWait = colony.waitForChange("session-two");
    let araChange = await araWait;

    assert.equal(araChange.status, "changed");
    assert.equal(araChange.observation.you.order.status, "completed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    let brenChange = await brenWait;
    assert.equal(brenChange.status, "idle");
    assert.ok(
      !brenChange.events.some((event: any) => event.type === "order_completed"),
    );
  } finally {
    colony.stop();
  }
});

test("the world holds until every active player is waiting", async () => {
  let colony = createColony({ waitTimeoutMs: 500, scenarios: ["survival"] });
  colony.start();
  colony.connect("a");
  colony.connect("b");
  try {
    colony.join("a", "Ara");
    colony.join("b", "Bren");

    // Ara commits and parks, but Bren has not submitted a turn yet — so time
    // must not pass.
    colony.act("a", { type: "rest" });
    let araWait = colony.waitForChange("a");
    assert.equal(colony.sense("a", "changes").observation.tick, 0);

    // Bren parking completes the barrier; now the world advances and Ara's rest
    // resolves.
    colony.waitForChange("b");
    let araChange = await araWait;
    assert.ok(araChange.events.some((event: any) => event.type === "rested"));
    assert.ok(colony.sense("a", "changes").observation.tick >= 6);
  } finally {
    colony.stop();
  }
});

test("minimum turn length paces all-parked turns", async () => {
  let colony = createColony({
    minTurnMs: 40,
    waitTimeoutMs: 500,
    scenarios: ["survival"],
  });
  colony.start();
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    colony.act("a", { type: "rest" });
    let araWait = colony.waitForChange("a");

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(colony.sense("a", "changes").observation.tick, 0);

    await new Promise((resolve) => setTimeout(resolve, 280));
    let araChange = await araWait;
    assert.ok(araChange.events.some((event: any) => event.type === "rested"));
    assert.ok(colony.sense("a", "changes").observation.tick >= 6);
  } finally {
    colony.stop();
  }
});

test("speak wakes a parked listener anywhere in the colony, in real time", async () => {
  let colony = createColony({ waitTimeoutMs: 2000 });
  colony.start();
  colony.connect("a");
  colony.connect("b");
  try {
    colony.join("a", "Ara");
    colony.join("b", "Bren");
    colony.sense("a", "changes");
    colony.sense("b", "changes");

    // Bren parks; Ara speaks (free, instant) and that wakes Bren immediately —
    // no tick required, so a conversation can happen before anyone acts.
    let brenWait = colony.waitForChange("b");
    let said = colony.speak("a", "fire's low!");
    assert.equal(said.status, "spoke");

    let change = await brenWait;
    assert.equal(change.status, "changed");
    assert.ok(
      change.events.some(
        (event: any) =>
          event.type === "said" && event.message === "fire's low!",
      ),
    );
    assert.equal(colony.sense("a", "changes").observation.tick, 0); // talking spent no game time
  } finally {
    colony.stop();
  }
});

test("a GM-added action is flagged isNew until the character looks past it", async () => {
  let colony = createColony({ waitTimeoutMs: 2000 });
  colony.start();
  colony.connect("c1");
  colony.connect("gm");
  try {
    let joined = colony.join("c1", "Ara");
    let initialDetailedAction = joined.observation.availableActions.find(
      (action: any) =>
        typeof action.description === "string" && Array.isArray(action.params),
    );
    assert.ok(initialDetailedAction);
    assert.ok(Array.isArray(initialDetailedAction.params));

    colony.joinAsGm("gm");

    // Baseline: with no runtime-added action, nothing carries the capability
    // stamp - the standing set is not "new" to a character already playing.
    let before = colony.sense("c1", "changes").observation.availableActions;
    let repeatedAction = before.find(
      (action: any) => action.name === initialDetailedAction.name,
    );
    assert.ok(repeatedAction);
    assert.equal(repeatedAction.description, undefined);
    assert.equal(repeatedAction.params, undefined);
    assert.ok(
      before.every(
        (a: any) => a.addedTick === undefined && a.isNew === undefined,
      ),
    );
    assert.ok(!before.some((a: any) => a.name === "carve"));

    colony.gmAddRule("gm", {
      id: "carve",
      kind: "action",
      duration: 1,
      description: "carve a marker post",
      do: [],
    });

    // The character's next look flags the freshly conjured capability.
    let after = colony.sense("c1", "changes").observation.availableActions;
    let carve = after.find((a: any) => a.name === "carve");
    assert.ok(carve, "carve should appear in availableActions");
    assert.equal(carve.isNew, true);
    assert.equal(typeof carve.addedTick, "number");
    assert.equal(carve.description, "carve a marker post");
    assert.ok(Array.isArray(carve.params));

    // Once time moves on and the character has looked past it, it is no longer
    // flagged new - but still carries addedTick so its recency stays legible.
    colony.act("c1", { type: "explore", direction: "north" });
    await colony.waitForChange("c1");
    let later = colony
      .sense("c1", "changes")
      .observation.availableActions.find((a: any) => a.name === "carve");
    assert.ok(later, "carve should still be listed");
    assert.equal(later.isNew, false);
    assert.equal(typeof later.addedTick, "number");
    assert.equal(later.description, undefined);
    assert.equal(later.params, undefined);
  } finally {
    colony.stop();
  }
});

test("players can join at any time and see each other at the spawn clearing", () => {
  let colony = createColony();
  colony.connect("a");
  colony.connect("b");
  try {
    colony.join("a", "Ara");
    colony.join("b", "Bren");
    // No shared roster in a bare world - but they stand on the same clearing,
    // so each is in the other's sight.
    let seen = colony.sense("b", "situation");
    assert.ok(seen.others.some((other: any) => other.name === "Ara"));
  } finally {
    colony.stop();
  }
});

test("a live character can always be reclaimed, even while another session holds it", () => {
  let colony = createColony();
  colony.connect("a");
  colony.connect("b");
  try {
    colony.join("a", "Ara");
    let reclaimed = colony.join("b", "Ara");
    assert.equal(reclaimed.observation.you.id, "ara");
  } finally {
    colony.stop();
  }
});

test("a reincarnating character reclaims its body and is backfilled recent history", async () => {
  let colony = createColony({ waitTimeoutMs: 2000, scenarios: ["survival"] });
  colony.start();
  colony.connect("a");
  try {
    let fresh = colony.join("a", "Ara");
    assert.equal(fresh.reclaimed, false); // a brand-new character has no past
    // A fresh spawn is handed the game briefing in-band, for clients that
    // don't surface the MCP server's instructions.
    assert.ok(fresh.briefing?.includes("You are playing an agent"));

    // Ara rests; as the sole active player the world advances and her rest
    // resolves, producing a `rested` event she sees and consumes.
    colony.act("a", { type: "rest" });
    let change = await colony.waitForChange("a");
    assert.ok(change.events.some((event: any) => event.type === "rested"));

    // Her session drops — the body persists, mid-life. A new session relaunches
    // the same name: it reclaims the body and is replayed what changed while it
    // was away (here, the rest it had already consumed), so it never restarts
    // blind.
    colony.disconnect("a");
    colony.connect("a2");
    let reborn = colony.join("a2", "Ara");
    assert.equal(reborn.reclaimed, true);
    assert.equal(reborn.observation.you.id, "ara");
    assert.equal(reborn.briefing, undefined);
    assert.ok(reborn.events.some((event: any) => event.type === "rested"));
  } finally {
    colony.stop();
  }
});

test("a reclaimed character receives only the last 10 ticks of history", async () => {
  let colony = createColony({ waitTimeoutMs: 2000, scenarios: ["survival"] });
  colony.start();
  colony.connect("ara-session");
  colony.connect("bren-session");
  try {
    colony.join("ara-session", "Ara");
    colony.join("bren-session", "Bren");
    colony.speak("bren-session", "old news");
    colony.disconnect("ara-session");

    for (let restCount = 0; restCount < 5; restCount += 1) {
      colony.act("bren-session", { type: "rest" });
      await colony.waitForChange("bren-session");
    }
    colony.speak("bren-session", "recent news");

    colony.connect("ara-reborn");
    let reborn = colony.join("ara-reborn", "Ara");
    let messages = reborn.events
      .filter((event: any) => event.type === "said")
      .map((event: any) => event.message);
    assert.equal(messages.includes("old news"), false);
    assert.equal(messages.includes("recent news"), true);
  } finally {
    colony.stop();
  }
});

test("witnessed activity is sight-scoped: a distant character does not see it", async () => {
  let colony = createColony({ waitTimeoutMs: 2000, scenarios: ["survival"] });
  colony.start();
  colony.connect("a");
  try {
    let ara = colony.join("a", "Ara");
    let foodSpot = await discoverFood(colony, "a", ara);

    // Ara walks out to a food source as the sole active player, so the world
    // advances freely until she's standing on it.
    colony.act("a", { type: "travel", location: foodSpot });
    let arrived = await colony.waitForChange("a");
    assert.equal(
      arrived.observation.you.at,
      foodSpot,
      "Ara reached the source",
    );

    // Now Bren joins back at the spawn clearing and rests there. One synchronized
    // round: Ara gathers at the far source while Bren rests at the clearing.
    // Both parking completes the barrier; Ara's 2-tick gather lands mid-round.
    // Bren's own park never has to wake - the far gather is out of his sight, so
    // his waiter stays pending and we read the recorded deed directly instead.
    colony.connect("b");
    colony.join("b", "Bren");
    colony.act("b", { type: "rest" });
    colony.act("a", { type: "gather" });
    let brenWait = colony.waitForChange("b");
    let araChange = await colony.waitForChange("a");
    assert.ok(araChange.events.some((event: any) => event.type === "gathered"));

    // Witnessed activity is scoped to the actor's SIGHT: the gather's audience,
    // stamped when it happened, lists only characters who stood within sight of
    // Ara. Bren, resting far off at the clearing, is not among them - the deed
    // never enters his stream, exactly as speech out of earshot wouldn't.
    let gathered = colony
      .getAdminPayload()
      .eventLog.find(
        (event: any) => event.type === "gathered" && event.agentId === "ara",
      );
    assert.ok(gathered, "the gather was recorded");
    assert.ok(
      !(gathered.audience ?? []).includes("bren"),
      "Bren, out of sight, is not in the gather's audience",
    );

    // Release Bren's still-parked waiter so none lingers past the test.
    colony.disconnect("b");
    await brenWait;
    colony.disconnect("a");
  } finally {
    colony.stop();
  }
});

test("leave_game releases control but leaves the character reclaimable", async () => {
  let colony = createColony({ waitTimeoutMs: 2000 });
  colony.start();
  colony.connect("a");
  try {
    let joined = colony.join("a", "Ara");
    let position = joined.observation.you.position;

    let left = colony.leave("a");
    assert.equal(left.status, "left");
    assert.equal(left.agentId, "ara");

    // The controller is gone, but the character body stays where it was.
    let payload = colony.getAdminPayload();
    assert.deepEqual(payload.state.agents.ara.position, position);

    // Tools that need a character now refuse until the session joins again.
    assert.throws(() => colony.sense("a", "changes"), /join_game/);

    // The session stays open and can reclaim the same in-world body by name.
    let rejoined = colony.join("a", "Ara");
    assert.equal(rejoined.observation.you.id, "ara");
    assert.equal(rejoined.reclaimed, true);
    assert.deepEqual(rejoined.observation.you.position, position);
  } finally {
    colony.stop();
  }
});

test("leave_game is controller bookkeeping, not an in-world departure", async () => {
  let colony = createColony({ waitTimeoutMs: 2000 });
  colony.start();
  colony.connect("a");
  colony.connect("b");
  try {
    colony.join("a", "Ara");
    colony.join("b", "Bren");
    colony.sense("a", "changes");
    colony.sense("b", "changes"); // advance Bren's cursor to now

    colony.leave("a");

    // Releasing a controller is not a world event for either GM or characters.
    assert.ok(
      !colony
        .getAdminPayload()
        .eventLog.some((event: any) => event.type === "left"),
      "controller release should not create a departure event",
    );
    let brenView = colony.sense("b", "changes");
    assert.ok(
      !brenView.events.some((event: any) => event.type === "left"),
      "no character sees a controller release as a departure",
    );
  } finally {
    colony.stop();
  }
});

test("a join is hidden from characters; presence is learned at the camp ledger", async () => {
  let colony = createColony({ waitTimeoutMs: 2000, scenarios: ["survival"] });
  colony.start();
  colony.connect("a");
  colony.connect("b");
  try {
    // Ara travels to the nearest food (deterministically beyond SIGHT of spawn)
    // and arrives; she is now out of sight of where newcomers appear.
    let ara = colony.join("a", "Ara");
    let dest = await discoverFood(colony, "a", ara);
    colony.act("a", { type: "travel", location: dest });
    let arrival = await colony.waitForChange("a");
    assert.equal(arrival.observation.you.at, dest);
    colony.sense("a", "changes"); // advance Ara's cursor past her own arrival

    // Bren appears at spawn, out of Ara's SIGHT.
    colony.join("b", "Bren");
    let araView = colony.sense("a", "changes");
    // The arrival is not announced to characters (no join/leave churn in the feed)...
    assert.ok(
      !araView.events.some((event: any) => event.type === "joined"),
      "the join is not announced to characters",
    );
    // ...and presence is no longer broadcast either: away from camp, the
    // coordination ledger is out of reach, so Ara simply doesn't know yet.
    assert.equal(
      araView.observation.colony.atLedger,
      false,
      "away from camp the board is out of reach",
    );
    // Bren stands at the spawn camp, where the survival scenario's ledger lists
    // the whole colony - including far-off Ara.
    let brenView = colony.sense("b", "changes");
    assert.equal(brenView.observation.colony.atLedger, true);
    assert.ok(
      brenView.observation.colony.roster.some((c: any) => c.name === "Ara"),
      "the camp ledger lists every character",
    );
  } finally {
    colony.stop();
  }
});

test("a join does not wake a parked character, and rides only the GM log", async () => {
  let colony = createColony({ waitTimeoutMs: 60 });
  colony.start();
  colony.connect("a");
  colony.connect("b");
  colony.connect("c");
  // wait_for_change parks on an unref'd timer; since the join no longer wakes
  // Bren, his wait now falls to that timeout - a ref'd handle keeps the test's
  // event loop alive so the runner doesn't exit before it fires.
  let keepAlive = setInterval(() => {}, 5);
  try {
    colony.join("a", "Ara");
    colony.join("b", "Bren");
    colony.sense("a", "changes");
    colony.sense("b", "changes");

    // Bren parks (Ara stays un-parked, so the clock holds). Cleo joining is
    // session bookkeeping now: it does not reach Bren, so his wait simply times
    // out with no arrival event rather than waking him.
    let brenWait = colony.waitForChange("b");
    colony.join("c", "Cleo");
    let change = await brenWait;
    assert.ok(
      !change.events.some((event: any) => event.type === "joined"),
      "the join does not reach a character",
    );
    // The GM dashboard log still records it.
    assert.ok(
      colony
        .getAdminPayload()
        .eventLog.some(
          (event: any) =>
            event.type === "joined" &&
            /Cleo joins the colony\./.test(event.text),
        ),
      "but it is on the GM log",
    );
  } finally {
    clearInterval(keepAlive);
    colony.stop();
  }
});

test("a character idle past idleMs releases the controller and keeps the body", async () => {
  // Ara joins and then never commits an act of play. Once idleMs of wall-clock
  // time passes the reaper releases her controller and tears down the transport.
  // The character remains in the world for a later same-name reclaim.
  let colony = createColony({ idleMs: 30, sessionTtlMs: 200 });
  let closed: string[] = [];
  colony.setTransportCloser((sessionId) => closed.push(sessionId));
  colony.start();
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    await waitUntil(() => closed.length === 1);
    assert.deepEqual(closed, ["a"]);
    assert.ok(colony.getAdminPayload().state.agents.ara);
  } finally {
    colony.stop();
  }
});

test("an abandoned body whose session dropped remains reclaimable", async () => {
  // The common case: a client joins then vanishes without leave_game - its
  // process exits, onclose fires disconnect(), the session is gone but the body
  // stays behind for reclaim instead of being swept out of the world.
  let colony = createColony({ idleMs: 30, sessionTtlMs: 200 });
  colony.start();
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    colony.disconnect("a"); // client vanishes without leaving; body remains
    assert.equal(
      Object.keys(colony.getAdminPayload().state.agents).length,
      1,
      "the body should linger at first, available for reclaim",
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(colony.getAdminPayload().state.agents.ara);

    colony.connect("b");
    let rejoined = colony.join("b", "Ara");
    assert.equal(rejoined.reclaimed, true);
  } finally {
    colony.stop();
  }
});

test("reclaiming an abandoned body works after the idle grace", async () => {
  // If a client comes back and rejoins by name after the idle grace, the same
  // body is reclaimed because session cleanup no longer removes characters.
  let colony = createColony({ idleMs: 60, sessionTtlMs: 200 });
  colony.start();
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    colony.disconnect("a"); // dropped, body remains reclaimable
    await new Promise((resolve) => setTimeout(resolve, 150));
    colony.connect("b");
    let rejoined = colony.join("b", "Ara");
    assert.equal(rejoined.reclaimed, true);
    assert.equal(
      Object.keys(colony.getAdminPayload().state.agents).length,
      1,
      "a reclaimed body must still be standing",
    );
  } finally {
    colony.stop();
  }
});

test("a character that only polls wait_for_change is detached as idle", async () => {
  // The bug this guards against: idleness used to be measured from the last
  // tool call, but wait_for_change is a tool call. A client looping it forever
  // kept its session looking active while its character did nothing. Idleness is
  // wall-clock time since the last act of play, so a pure poller is detached
  // once it's more than idleMs stale, however hot its transport looks.
  // sessionTtlMs doubles as the reaper's sweep interval, so keep it small so
  // sweeps land inside the test; no transport closer is wired here, so the
  // small TTL can't close anything. minTurnMs paces the lone parked
  // character's ticks - without it the clock fast-forwards unbounded and Ara
  // can starve to death before the reaper can catch her idling.
  let colony = createColony({
    idleMs: 30,
    waitTimeoutMs: 15,
    sessionTtlMs: 20,
    minTurnMs: 20,
  });
  colony.start();
  colony.connect("a");
  // wait_for_change parks on an unref'd timer; a ref'd handle keeps the test's
  // event loop alive so the runner doesn't cancel us mid-park.
  let keepAlive = setInterval(() => {}, 5);
  try {
    colony.join("a", "Ara");
    let detached = false;
    for (let i = 0; i < 40 && !detached; i++) {
      // Keep the transport hot - this refreshes lastSeen every iteration - but
      // never commit an action, so lastActedAt goes stale.
      try {
        await colony.waitForChange("a");
      } catch {
        // requireJoined throws once the reaper has released Ara's controller.
      }
      try {
        colony.sense("a", "changes");
      } catch {
        detached = true;
      }
    }
    assert.ok(
      detached,
      "an idle poller should be detached despite a hot transport",
    );
    assert.ok(colony.getAdminPayload().state.agents.ara);
    let rejoined = colony.join("a", "Ara");
    assert.equal(rejoined.reclaimed, true);
  } finally {
    clearInterval(keepAlive);
    colony.stop();
  }
});

test("a character that stalls one turn stops gating the clock", async () => {
  // Ara joins and never parks. She holds the world for exactly one backstop
  // turn (maxWaitMs), gets marked stalled, and from then on Bren's parking
  // alone drives the clock at full speed. Her body stays in the world - going
  // absent costs the game one turn, not idleMs of crawling clock. 20 ticks by
  // backstop alone would need 2s of wall time, far past waitUntil's deadline,
  // so the assertion only passes if the stall exemption kicked in.
  let colony = createColony({
    maxWaitMs: 100,
    waitTimeoutMs: 30,
    idleMs: 5000,
    sessionTtlMs: 5000,
  });
  colony.start();
  colony.connect("a");
  colony.connect("b");
  let keepAlive = setInterval(() => {}, 5);
  let done = false;
  let pump: Promise<void> | null = null;
  try {
    colony.join("a", "Ara");
    colony.join("b", "Bren");
    let t0 = colony.sense("b", "changes").observation.tick;
    // Keep Bren parked so he is always ready for time to pass.
    pump = (async () => {
      while (!done) {
        try {
          await colony.waitForChange("b");
        } catch {
          return;
        }
      }
    })();
    await waitUntil(
      () => colony.sense("b", "changes").observation.tick - t0 >= 20,
    );
    assert.ok(
      colony.getAdminPayload().state.agents.ara,
      "the stalled character's body is spared while idleMs runs",
    );
  } finally {
    done = true;
    // Settle the pump's pending park (its timer is unref'd, so it would never
    // resolve once the test's event loop drains) before stopping the colony.
    colony.disconnect("b");
    await pump;
    clearInterval(keepAlive);
    colony.stop();
  }
});

test("a character driven by a standing order is spared while it runs", async () => {
  // A running order means the engine is acting for the character, so it is not
  // idle even though it only parks in wait_for_change between routine steps.
  // sessionTtlMs keeps the reaper's sweep interval small so the sparing logic
  // is actually exercised within the test (the polling keeps the transport
  // hot, so the stage-2 TTL never fires); minTurnMs paces the ticks so Ara is
  // still alive - not a lingering corpse - when the final assertion looks.
  let colony = createColony({
    idleMs: 30,
    waitTimeoutMs: 15,
    sessionTtlMs: 20,
    minTurnMs: 20,
    scenarios: ["survival"],
  });
  colony.start();
  colony.connect("a");
  let keepAlive = setInterval(() => {}, 5);
  try {
    colony.join("a", "Ara");
    // Unbounded repeat: no `until`, no maxRepeats, so the order never completes.
    let ordered = colony.setOrder("a", {
      kind: "repeat",
      action: { type: "rest" },
    });
    assert.equal(ordered.order?.status, "running");
    for (let i = 0; i < 20; i++) {
      try {
        await colony.waitForChange("a");
      } catch {
        break;
      }
    }
    assert.ok(
      colony.getAdminPayload().state.agents.ara,
      "a character with a running order should keep its controller",
    );
  } finally {
    clearInterval(keepAlive);
    colony.stop();
  }
});

test("a connected session that never joins is reaped once silent past sessionTtlMs", async () => {
  let colony = createColony({ sessionTtlMs: 60 });
  let closed: string[] = [];
  colony.setTransportCloser((sessionId) => closed.push(sessionId));
  colony.start();
  colony.connect("a");
  try {
    await waitUntil(() => closed.length === 1);
    assert.deepEqual(closed, ["a"]);
  } finally {
    colony.stop();
  }
});

test("a GM session is never reaped for idleness", async () => {
  let colony = createColony({ idleMs: 20, sessionTtlMs: 60 });
  let closed: string[] = [];
  colony.setTransportCloser((id) => closed.push(id));
  colony.start();
  colony.connect("gm");
  try {
    colony.joinAsGm("gm");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(closed, []);
  } finally {
    colony.stop();
  }
});

test("world state persists across a restart and a character is reclaimed", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-state-"));
  let statePath = join(dir, "world.json");
  try {
    // First run: join and walk somewhere, then stop so the final state flushes
    // to disk.
    let first = createColony({
      statePath,
      waitTimeoutMs: 2000,
      scenarios: ["survival"],
    });
    first.start();
    first.connect("s1");
    let joined = first.join("s1", "Ara");
    let dest = await discoverFood(first, "s1", joined);
    first.act("s1", { type: "travel", location: dest });
    await first.waitForChange("s1");
    let beforeTick = first.sense("s1", "changes").observation.tick;
    first.stop();

    // Second run against the same file: the world, the character, and its
    // position all come back, under the same worldId.
    let second = createColony({
      statePath,
      waitTimeoutMs: 2000,
      scenarios: ["survival"],
    });
    second.start();
    let payload = second.getAdminPayload();
    assert.ok(payload.state.agents.ara, "ara survived the restart");
    assert.equal(payload.state.agents.ara.at, dest);
    assert.equal(payload.state.tick, beforeTick);

    // The session is gone (connections aren't persisted), so a returning client
    // rejoins by name and reclaims the still-living character.
    second.connect("s1");
    let rejoined = second.join("s1", "Ara");
    assert.equal(rejoined.observation.you.id, "ara");
    second.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active orders persist across a restart", () => {
  let directory = mkdtempSync(join(tmpdir(), "agent-island-order-state-"));
  let statePath = join(directory, "world.json");
  try {
    let first = createColony({
      statePath,
      waitTimeoutMs: 2000,
      scenarios: ["survival"],
    });
    first.start();
    first.connect("session-one");
    first.join("session-one", "Ara");
    first.setOrder("session-one", {
      kind: "repeat",
      action: { type: "rest" },
      maxRepeats: 2,
    });
    first.stop();

    let second = createColony({
      statePath,
      waitTimeoutMs: 2000,
      scenarios: ["survival"],
    });
    second.start();
    let payload = second.getAdminPayload();
    let order = payload.state.agents.ara.order;
    assert.ok(order);
    assert.equal(order.status, "running");
    assert.equal(order.repeats, 1);
    second.stop();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reset empties the world and closes every session", async () => {
  let colony = createColony();
  colony.connect("a");
  try {
    colony.join("a", "Ara");
    let payload = await colony.reset();
    assert.deepEqual(Object.keys(payload.state.agents), []);
    // Sessions are state: the old session is gone entirely (the client
    // re-initializes from scratch), not merely detached from its character.
    assert.throws(() => colony.sense("a", "changes"), /Unknown MCP session/);
    // A fresh connection joins the same name into the fresh world.
    colony.connect("b");
    assert.doesNotThrow(() => colony.join("b", "Ara"));
  } finally {
    colony.stop();
  }
});

test("reset uses the requested world dimensions", async () => {
  let colony = createColony();
  try {
    await colony.reset({ width: 13, height: 9 });
    let map = colony.getMapPayload().map;
    assert.equal(map.width, 13);
    assert.equal(map.height, 9);
    assert.ok(map.spawn.x >= 0 && map.spawn.x < map.width);
    assert.ok(map.spawn.y >= 0 && map.spawn.y < map.height);
  } finally {
    colony.stop();
  }
});

test("reset rejects invalid dimensions before replacing the world", async () => {
  let colony = createColony();
  let worldId = colony.getAdminPayload().worldId;
  try {
    await assert.rejects(
      async () => colony.reset({ width: 0, height: 9 }),
      /World width must be a whole number from 1 to 200/,
    );
    assert.equal(colony.getAdminPayload().worldId, worldId);
  } finally {
    colony.stop();
  }
});

test("dead names are refused, not reincarnated", async () => {
  let colony = createColony({ waitTimeoutMs: 2000, scenarios: ["survival"] });
  colony.start();
  colony.connect("a");
  colony.connect("g");
  try {
    colony.join("a", "Ara");
    // A GM starves Ara (maxed hunger gates off the well-fed recovery rule) and
    // zeroes her health; parking her lets the world tick so the scenario's death
    // rule fires and turns her into a corpse.
    colony.joinAsGm("g");
    colony.gmSetStock("g", "ara", "hunger", 100);
    colony.gmSetStock("g", "ara", "health", 0);
    colony.act("a", { type: "rest" });
    await colony.waitForChange("a");
    assert.equal(colony.getAdminPayload().state.agents.ara.alive, false);

    // Death is terminal: the name stays dead, even for a fresh session.
    colony.disconnect("a");
    colony.connect("b");
    assert.throws(() => colony.join("b", "Ara"), /died.*cannot rejoin/);
    assert.equal(colony.getAdminPayload().state.agents.ara.alive, false);

    // A different name still works fine.
    let fresh = colony.join("b", "Aria");
    assert.equal(fresh.reclaimed, false);
    assert.equal(fresh.observation.you.id, "aria");
  } finally {
    colony.stop();
  }
});

test("GM rules survive a restart but a reset wipes them and their file", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-rules-"));
  let statePath = join(dir, "world.json");
  let rulesPath = join(dir, "rules.json");
  let houseRule = {
    id: "gm-storms",
    phase: "flow",
    target: "fire",
    rate: -5,
    channel: "fire.decay",
  };
  let hasGmStorms = (colony: ReturnType<typeof createColony>) =>
    colony.getAdminPayload().rules.some((r: any) => r.id === "gm-storms");
  try {
    // A GM authors a house rule, then the server restarts. A brand-new colony
    // pointed at the same rules file picks the rule back up.
    let first = createColony({ statePath, rulesPath });
    first.start();
    first.connect("gm");
    first.joinAsGm("gm");
    first.gmAddRule("gm", houseRule);
    assert.ok(hasGmStorms(first), "rule is live after it is added");
    first.stop();

    let second = createColony({ statePath, rulesPath });
    second.start();
    assert.ok(hasGmStorms(second), "rule is re-applied on restart");

    // A reset wipes the GM scratch overlay along with the world - the rule is
    // gone from the live world and its file is deleted from disk.
    await second.reset();
    assert.ok(!hasGmStorms(second), "rule is wiped by a reset");
    assert.ok(!existsSync(rulesPath), "rules file is deleted by a reset");
    second.stop();
    assert.ok(!existsSync(rulesPath), "stop does not recreate the rules file");

    // A restart after the reset comes up clean.
    let third = createColony({ statePath, rulesPath });
    third.start();
    assert.ok(!hasGmStorms(third), "rule stays gone after a restart");
    third.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("active custom scenarios load between base rules and GM scratch", () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-scenarios-"));
  let scenariosDir = join(dir, "scenarios");
  let activeScenariosPath = join(dir, "active-scenarios.json");
  let rulesPath = join(dir, "rules.json");
  let customRule = {
    id: "custom-storms",
    phase: "flow",
    target: "fire",
    rate: -1,
    channel: "fire.decay",
  };
  let gmRule = {
    id: "gm-storms",
    phase: "flow",
    target: "fire",
    rate: -5,
    channel: "fire.decay",
  };
  try {
    mkdirSync(scenariosDir, { recursive: true });
    writeFileSync(
      join(scenariosDir, "winter.json"),
      JSON.stringify({
        name: "winter",
        overlay: { dynamicRules: [customRule], removedBaseIds: [] },
      }),
    );
    writeFileSync(activeScenariosPath, JSON.stringify({ active: ["winter"] }));
    // The running identity is the active scenario now, so the GM scratch overlay is
    // tagged with the scenario name it belongs to (see loadRules).
    writeFileSync(
      rulesPath,
      JSON.stringify({
        world: "winter",
        overlay: { dynamicRules: [gmRule], removedBaseIds: [] },
      }),
    );

    let colony = createColony({
      statePath: null,
      rulesPath,
      scenariosDir,
      activeScenariosPath,
    });
    colony.start();
    try {
      let payload = colony.getAdminPayload() as any;
      let ruleIds = payload.rules.map((rule: any) => rule.id);
      assert.ok(ruleIds.includes("custom-storms"));
      assert.ok(ruleIds.includes("gm-storms"));
      assert.ok(payload.ruleMeta.customIds.includes("custom-storms"));
      assert.ok(payload.ruleMeta.dirtyIds.includes("gm-storms"));
      assert.equal(payload.ruleMeta.dirtyIds.includes("custom-storms"), false);
    } finally {
      colony.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving GM scratch as a custom scenario promotes it out of GM edits", () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-scenario-save-"));
  let scenariosDir = join(dir, "scenarios");
  let activeScenariosPath = join(dir, "active-scenarios.json");
  let rulesPath = join(dir, "rules.json");
  let savedRule = {
    id: "gm-storms",
    phase: "flow",
    target: "fire",
    rate: -5,
    channel: "fire.decay",
  };
  let scratchRule = {
    id: "gm-fog",
    phase: "flow",
    target: "fire",
    rate: -2,
    channel: "fire.decay",
  };
  try {
    let colony = createColony({
      statePath: null,
      rulesPath,
      scenariosDir,
      activeScenariosPath,
    });
    colony.start();
    colony.connect("gm");
    try {
      assert.throws(() => colony.gmSaveScenario("gm", "blocked"), /join_as_gm/);
      assert.throws(() => colony.gmClearEdits("gm"), /join_as_gm/);
      colony.joinAsGm("gm");
      colony.gmAddRule("gm", savedRule);
      colony.gmSaveScenario("gm", "storms");

      let promoted = colony.getAdminPayload() as any;
      assert.ok(promoted.ruleMeta.customIds.includes("gm-storms"));
      assert.equal(promoted.ruleMeta.dirtyIds.includes("gm-storms"), false);
      assert.ok(
        JSON.parse(
          readFileSync(join(scenariosDir, "storms.json"), "utf8"),
        ).overlay.dynamicRules.some((rule: any) => rule.id === "gm-storms"),
      );

      colony.gmAddRule("gm", scratchRule);
      assert.ok(
        (colony.getAdminPayload() as any).ruleMeta.dirtyIds.includes("gm-fog"),
      );
      colony.gmClearEdits("gm");
      let cleared = colony.getAdminPayload() as any;
      let ruleIds = cleared.rules.map((rule: any) => rule.id);
      assert.ok(ruleIds.includes("gm-storms"));
      assert.equal(ruleIds.includes("gm-fog"), false);
    } finally {
      colony.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching scenarios replaces scenario identity and restores the switched world", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-scenario-switch-"));
  let scenariosDir = join(dir, "scenarios");
  let activeScenariosPath = join(dir, "active-scenarios.json");
  let statePath = join(dir, "state.json");
  let rulesPath = join(dir, "rules.json");
  let journalDir = join(dir, "journal");
  let scenarioRule = (id: string) => ({
    id,
    phase: "flow",
    target: "fire",
    rate: -1,
    channel: "fire.decay",
  });
  let writeScenario = (name: string, ruleId: string) =>
    writeFileSync(
      join(scenariosDir, `${name}.json`),
      JSON.stringify({
        name,
        overlay: { dynamicRules: [scenarioRule(ruleId)], removedBaseIds: [] },
      }),
    );
  try {
    mkdirSync(scenariosDir, { recursive: true });
    writeScenario("frost", "frost-storms");
    writeScenario("ember", "ember-storms");
    writeFileSync(activeScenariosPath, JSON.stringify({ active: ["frost"] }));

    let colony = createColony({
      statePath,
      rulesPath,
      journalDir,
      scenariosDir,
      activeScenariosPath,
    });
    colony.start();
    colony.connect("gm");
    try {
      let ruleIds = () =>
        (colony.getAdminPayload() as any).rules.map((rule: any) => rule.id);
      let worldId = () => (colony.getAdminPayload() as any).worldId;
      assert.ok(ruleIds().includes("frost-storms"));
      assert.equal(
        (colony.getAdminPayload() as any).state.scenario.name,
        "frost",
      );

      // GM scratch rides the run, not the ruleset - a switch discards it.
      colony.joinAsGm("gm");
      colony.gmAddRule("gm", scenarioRule("gm-fog"));
      assert.ok(ruleIds().includes("gm-fog"));

      let before = worldId();
      let listed = await colony.setScenarioActive("ember", true);
      assert.deepEqual(listed.active, ["ember"]);
      assert.ok(
        ruleIds().includes("ember-storms"),
        "new scenario's rules land",
      );
      assert.equal(
        ruleIds().includes("frost-storms"),
        false,
        "old scenario is deactivated by the switch",
      );
      assert.equal(
        ruleIds().includes("gm-fog"),
        false,
        "GM scratch is wiped with the world",
      );
      assert.notEqual(
        worldId(),
        before,
        "switching scenarios resets the world",
      );
      let switchedWorldId = worldId();
      assert.equal(
        (colony.getAdminPayload() as any).state.scenario.name,
        "ember",
      );
      assert.equal(
        JSON.parse(readFileSync(statePath, "utf8")).engine.scenario,
        "ember",
      );
      assert.deepEqual(
        JSON.parse(readFileSync(activeScenariosPath, "utf8")).active,
        ["ember"],
      );
      let journalGenesis = JSON.parse(
        readFileSync(join(journalDir, "journal.jsonl"), "utf8").split("\n")[0],
      );
      assert.equal(journalGenesis.scenario, "ember");

      // Re-selecting the active scenario is a no-op, not another wipe.
      let settled = worldId();
      await colony.setScenarioActive("ember", true);
      assert.equal(worldId(), settled);

      // A bad name fails before anything is touched.
      await assert.rejects(() =>
        colony.setScenarioActive("no-such-scenario", true),
      );
      assert.equal(worldId(), settled);
      assert.ok(ruleIds().includes("ember-storms"));

      // Persist recognizable world state and a GM overlay under the new scenario.
      colony.connect("player");
      colony.join("player", "Ara");
      colony.connect("ember-gm");
      colony.joinAsGm("ember-gm");
      colony.gmAddRule("ember-gm", scenarioRule("gm-ember"));
      colony.stop();

      assert.equal(JSON.parse(readFileSync(rulesPath, "utf8")).world, "ember");

      let restored = createColony({
        statePath,
        rulesPath,
        journalDir,
        scenariosDir,
        activeScenariosPath,
      });
      restored.start();
      try {
        let restoredPayload = restored.getAdminPayload() as any;
        let restoredRuleIds = restoredPayload.rules.map((rule: any) => rule.id);
        assert.equal(restoredPayload.worldId, switchedWorldId);
        assert.equal(restoredPayload.state.scenario.name, "ember");
        assert.ok(restoredPayload.state.agents.ara);
        assert.ok(restoredRuleIds.includes("ember-storms"));
        assert.ok(restoredRuleIds.includes("gm-ember"));

        // Deactivating drops to the bare scenario under a fresh identity.
        let cleared = await restored.setScenarioActive("ember", false);
        assert.deepEqual(cleared.active, []);
        let basePayload = restored.getAdminPayload() as any;
        assert.notEqual(basePayload.worldId, switchedWorldId);
        assert.equal(basePayload.state.scenario.name, scenario.name);
        assert.equal(
          basePayload.rules.some((rule: any) => rule.id === "ember-storms"),
          false,
        );
        assert.equal(
          JSON.parse(readFileSync(statePath, "utf8")).engine.scenario,
          scenario.name,
        );
        assert.deepEqual(
          JSON.parse(readFileSync(activeScenariosPath, "utf8")).active,
          [],
        );
        let baseGenesis = JSON.parse(
          readFileSync(join(journalDir, "journal.jsonl"), "utf8").split(
            "\n",
          )[0],
        );
        assert.equal(baseGenesis.scenario, scenario.name);

        restored.connect("base-gm");
        restored.joinAsGm("base-gm");
        restored.gmAddRule("base-gm", scenarioRule("gm-base"));
      } finally {
        restored.stop();
      }

      assert.equal(
        JSON.parse(readFileSync(rulesPath, "utf8")).world,
        scenario.name,
      );
    } finally {
      colony.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saving GM edits forks the active scenario into a standalone one", () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-scenario-fork-"));
  let scenariosDir = join(dir, "scenarios");
  let activeScenariosPath = join(dir, "active-scenarios.json");
  let baseRule = {
    id: "base-storms",
    phase: "flow",
    target: "fire",
    rate: -1,
    channel: "fire.decay",
  };
  let editRule = {
    id: "gm-fog",
    phase: "flow",
    target: "fire",
    rate: -2,
    channel: "fire.decay",
  };
  try {
    mkdirSync(scenariosDir, { recursive: true });
    writeFileSync(
      join(scenariosDir, "base.json"),
      JSON.stringify({
        name: "base",
        overlay: { dynamicRules: [baseRule], removedBaseIds: [] },
      }),
    );
    writeFileSync(activeScenariosPath, JSON.stringify({ active: ["base"] }));

    let colony = createColony({
      statePath: null,
      rulesPath: null,
      scenariosDir,
      activeScenariosPath,
    });
    colony.start();
    colony.connect("gm");
    try {
      colony.joinAsGm("gm");
      colony.gmAddRule("gm", editRule);
      let result = colony.gmSaveScenario("gm", "base-2");

      // The fork carries the base scenario's rules alongside the edit, so it is a
      // complete game on its own, and it becomes the sole active scenario.
      let saved = JSON.parse(
        readFileSync(join(scenariosDir, "base-2.json"), "utf8"),
      );
      let savedIds = saved.overlay.dynamicRules.map((rule: any) => rule.id);
      assert.ok(savedIds.includes("base-storms"));
      assert.ok(savedIds.includes("gm-fog"));
      assert.deepEqual(result.scenarios.active, ["base-2"]);

      // The live rules are unchanged - the edit just moved layers - so the
      // save is not a world reset.
      let payload = colony.getAdminPayload() as any;
      let ruleIds = payload.rules.map((rule: any) => rule.id);
      assert.ok(ruleIds.includes("base-storms"));
      assert.ok(ruleIds.includes("gm-fog"));
      assert.ok(payload.ruleMeta.customIds.includes("gm-fog"));
      assert.equal(payload.ruleMeta.dirtyIds.includes("gm-fog"), false);
    } finally {
      colony.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("custom scenario setup scatters entities on startup and reset", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-scenario-setup-"));
  let scenariosDir = join(dir, "scenarios");
  let setupScenario = {
    name: "wilds",
    overlay: {
      dynamicRules: [],
      removedBaseIds: [],
      setup: [
        {
          // Keepout/spacing must leave room for both wolves on the 21x21
          // default world from ANY rolled spawn - reset rerolls the seed, so
          // over-tight constraints make this test a coin flip.
          scatter: {
            namePrefix: "wolf",
            tags: ["predator"],
            count: 2,
            minSpacing: 4,
            spawnKeepout: 4,
            stocks: {
              health: { value: 16, min: 0, max: 16 },
            },
          },
        },
      ],
    },
  };
  try {
    mkdirSync(scenariosDir, { recursive: true });
    writeFileSync(
      join(scenariosDir, "wilds.json"),
      JSON.stringify(setupScenario),
    );
    let colony = createColony({
      statePath: null,
      rulesPath: null,
      scenariosDir,
      scenarios: ["wilds"],
    });
    colony.start();
    try {
      let predatorIds = () =>
        Object.values((colony.getAdminPayload() as any).entities)
          .filter((entity: any) => hasTag(entity, "predator"))
          .map((entity: any) => entity.id)
          .sort();
      assert.deepEqual(predatorIds(), ["wolf-1", "wolf-2"]);
      await colony.reset();
      assert.deepEqual(predatorIds(), ["wolf-1", "wolf-2"]);
    } finally {
      colony.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dashboard payload keeps heavy map and observations out of the poll", () => {
  let colony = createColony({
    statePath: null,
    rulesPath: null,
    scenarios: ["survival"],
  });
  colony.start();
  colony.connect("session");
  try {
    colony.join("session", "Ara");

    let payload = colony.getAdminPayload() as any;
    assert.equal(payload.map, undefined);
    assert.equal(payload.observations, undefined);
    assert.ok(payload.state.agents.ara);
    assert.ok(payload.controllers.ara);
    assert.ok(
      Object.values(payload.entities).every((entity: any) => {
        if (hasTag(entity, "agent")) return false;
        if (!hasTag(entity, "token")) return true;
        return Object.keys(entity.stocks).length > 0;
      }),
      "entity stream keeps only live token state, not decorative tokens",
    );

    // The map ships as three independent streams. Terrain (its own endpoint,
    // its own revision) is the tile grid alone - no tokens, no fog.
    let mapPayload = colony.getMapPayload();
    assert.equal(mapPayload.worldId, payload.worldId);
    assert.equal(mapPayload.terrainRevision, payload.terrainRevision);
    assert.ok(
      mapPayload.map.tiles.length > 0,
      "terrain stream carries the grid",
    );
    // Fog is its own endpoint; the token layer rides inline in the admin poll.
    assert.ok(
      colony.getFogPayload().fog.known?.length,
      "fog endpoint carries shared fog",
    );
    assert.ok(
      payload.tokens.some((t: any) => !!t.token && hasTag(t.token, "food")),
      "token stream carries the scattered food sources",
    );

    colony.connect("gm");
    colony.joinAsGm("gm");
    // Any in-bounds tile whose token slot is free - the default world is small
    // enough that hardcoded coordinates risk landing off-map.
    let occupied = new Set(payload.tokens.map((t: any) => `${t.x},${t.y}`));
    let freeTile = mapPayload.map.tiles.find(
      (tile) => !occupied.has(`${tile.x},${tile.y}`),
    )!;
    colony.gmSpawnEntity("gm", {
      id: "watchtower",
      tags: ["token", "structure"],
      pos: { x: freeTile.x, y: freeTile.y },
    });

    let changedPayload = colony.getAdminPayload();
    assert.equal(
      changedPayload.tokenRevision,
      payload.tokenRevision + 1,
      "spawning a token bumps the token revision",
    );
    assert.equal(
      changedPayload.terrainRevision,
      payload.terrainRevision,
      "...but leaves the terrain revision untouched",
    );
    assert.ok(
      changedPayload.tokens.some((t) => t.token?.name === "watchtower"),
      "the new structure appears in the token stream",
    );
  } finally {
    colony.stop();
  }
});

test("fog revision advances when shared fog reveals new tiles", async () => {
  let colony = createColony({
    statePath: null,
    rulesPath: null,
    scenarios: ["survival"],
  });
  colony.start();
  colony.connect("session");
  try {
    let joined = colony.join("session", "Ara");
    let before = colony.getFogPayload();
    await discoverFood(colony, "session", joined);
    let after = colony.getFogPayload();

    assert.ok(
      after.fogRevision > before.fogRevision,
      "fog discovery bumps the fog revision",
    );
    assert.ok(
      (after.fog.known?.length ?? 0) > (before.fog.known?.length ?? 0),
      "known tiles expand as the character explores",
    );
  } finally {
    colony.stop();
  }
});

test("GM inspection is a compact overview that drills down on demand", async () => {
  let colony = createColony({
    statePath: null,
    rulesPath: null,
    scenarios: ["survival"],
  });
  colony.start();
  colony.connect("gm");
  for (let [i, name] of ["Ada", "Ben"].entries()) {
    colony.connect("p" + i);
    colony.join("p" + i, name);
  }
  try {
    let overview = colony.joinAsGm("gm");
    assert.equal(overview.status, "gm");

    // The overview lists every agent and entity, but as compact lines: an agent
    // carries bare vital values (no bounds), a rule is a headline (no body).
    let ada = (overview.agents as any[]).find((a) => a.name === "Ada");
    assert.ok(ada, "overview rosters every agent");
    assert.equal(typeof ada.vitals.health, "number");
    assert.equal(
      (ada as any).stocks,
      undefined,
      "roster omits full stock objects",
    );
    let firstRule = (overview.rules as any[])[0];
    assert.ok(
      firstRule.id && firstRule.description,
      "rules carry id + description",
    );
    assert.equal(firstRule.target, undefined, "overview rules omit the body");
    let siteEntity = (overview.entities as any[]).find((e) =>
      hasTag(e, "food"),
    );
    assert.ok(siteEntity, "overview rosters the food sources");
    assert.equal(
      (overview as any).map,
      undefined,
      "the heavy map is not in the overview",
    );

    // The overview stays small however the world is sized.
    let overviewKb = JSON.stringify(overview).length / 1024;
    assert.ok(
      overviewKb < 20,
      `overview should be compact, was ${overviewKb} KB`,
    );

    // agent drill-down returns the full state plus that character's observation.
    let agent = colony.gmInspect("gm", { agent: "Ada" }) as any;
    assert.equal(agent.focus.agent.id, "ada");
    assert.ok(
      agent.focus.agent.stocks.health.max > 0,
      "full stocks carry bounds",
    );
    assert.ok(agent.focus.agent.observation.availableActions.length > 0);

    // entity and rule drill-down return the full record / body.
    let entity = colony.gmInspect("gm", { entity: siteEntity.id }) as any;
    assert.deepEqual(entity.focus.entity.pos, siteEntity.pos);
    let rule = colony.gmInspect("gm", { rule: firstRule.id }) as any;
    assert.equal(rule.focus.rule.id, firstRule.id);
    assert.ok("phase" in rule.focus.rule || "kind" in rule.focus.rule);

    // area drill-down returns a clamped sub-region around a named place, far
    // smaller than the full map, with the characters standing in it. Anchor it on
    // a character (Ada, wherever she spawned) rather than a fixed landmark.
    let area = colony.gmInspect("gm", {
      area: { around: "ada", radius: 3 },
    }) as any;
    assert.equal(typeof area.focus.area.center.x, "number");
    assert.equal(typeof area.focus.area.center.y, "number");
    let full = colony.gmInspect("gm", { include: ["map"] }) as any;
    // The box is clamped to the grid, so near an edge it is smaller than 7x7.
    let center = area.focus.area.center;
    let cols =
      Math.min(center.x + 3, full.map.width - 1) -
      Math.max(center.x - 3, 0) +
      1;
    let rows =
      Math.min(center.y + 3, full.map.height - 1) -
      Math.max(center.y - 3, 0) +
      1;
    assert.equal(area.focus.area.tiles.length, cols * rows);
    assert.ok(area.focus.area.agents.some((a: any) => a.name === "Ada"));
    assert.ok(
      area.focus.area.tiles.length < full.map.tiles.length / 4,
      "an area query covers a fraction of the full map's tiles",
    );

    // include upgrades an overview section to full data: the rules carry
    // their full bodies, not just the overview headline fields.
    let withRules = colony.gmInspect("gm", { include: ["rules"] }) as any;
    let headlineKeys = new Set(["id", "phase", "kind", "description"]);
    assert.ok(
      Object.keys(withRules.rules[0]).some((key) => !headlineKeys.has(key)),
      "included rules carry the full body",
    );

    // misses report an error in the focus block rather than throwing.
    let miss = colony.gmInspect("gm", { agent: "Nobody" }) as any;
    assert.match(miss.focus.agent.error, /No agent/);

    // a non-GM session can't inspect.
    colony.connect("intruder");
    assert.throws(() => colony.gmInspect("intruder", {}));
  } finally {
    colony.stop();
  }
});

// Phase 2 of the v2 plan: an append-only event journal backing "changes since
// your cursor" once a request falls outside the in-memory ring. These tests
// drive the coordinator's wiring (journalCommand at each mutation site, the
// ring-then-journal fallback read, and reset's era rotation) rather than the
// journal module's own write/read mechanics, which test/journal.test.ts covers
// in isolation.

test("commands and ticks are appended to the durable event journal", () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-journal-wire-"));
  let journalDir = join(dir, "journal");
  try {
    let engine = makeSurvivalEngine();
    let colony = createColony({ engine, journalDir, waitTimeoutMs: 2000 });
    colony.start();
    colony.connect("s1");
    colony.join("s1", "Ara");
    colony.speak("s1", "hello colony");

    let path = join(journalDir, "journal.jsonl");
    let records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records[0].kind, "genesis");

    let joinRecord = records.find(
      (r: any) => r.kind === "command" && r.verb === "join",
    );
    assert.ok(joinRecord, "join is journalled as a command");
    assert.equal(joinRecord.actor, "ara");
    assert.ok(joinRecord.events.some((e: any) => e.type === "joined"));

    let speakRecord = records.find(
      (r: any) => r.kind === "command" && r.verb === "speak",
    );
    assert.ok(speakRecord, "speak is journalled as a command");
    assert.equal(speakRecord.actor, "ara");
    assert.ok(speakRecord.events.some((e: any) => e.type === "said"));

    colony.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a no-op command (nothing produced) is not written to the journal", () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-journal-noop-"));
  let journalDir = join(dir, "journal");
  try {
    let engine = makeSurvivalEngine();
    let colony = createColony({ engine, journalDir, waitTimeoutMs: 2000 });
    colony.start();
    colony.connect("s1");
    colony.join("s1", "Ara");
    // get_order is a free read: no engine mutation, nothing to journal.
    colony.getOrder("s1");

    let path = join(journalDir, "journal.jsonl");
    let records = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    // Only the genesis record and the join command - the free read left no trace.
    assert.equal(records.length, 2);

    colony.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cursor that has fallen off the in-memory ring is still answered correctly, from the journal", () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-journal-fallback-"));
  let journalDir = join(dir, "journal");
  try {
    let engine = makeSurvivalEngine();
    let colony = createColony({ engine, journalDir, waitTimeoutMs: 2000 });
    colony.start();
    colony.connect("s1");
    colony.join("s1", "Ara");

    // A second character joins and speaks a few times. Ara's session never
    // calls anything else in between, so it holds a cursor pointing at the
    // moment right after her own join - increasingly stale as Ben plays on.
    colony.connect("s2");
    colony.join("s2", "Ben");
    colony.speak("s2", "one");
    colony.speak("s2", "two");
    colony.speak("s2", "three");

    // Simulate the in-memory ring having trimmed everything before the most
    // recent event - what a busy, long-running colony does for real at 50k
    // events - without actually generating 50k events here. The journal was
    // written independently of the ring and still has the full history.
    let snapshot = engine.snapshot();
    engine.restore({ ...snapshot, log: snapshot.log.slice(-1) });
    assert.ok(
      engine.oldestSeq() > 0,
      "the ring's oldest retained event is no longer the world's first",
    );

    // Ara's next observation must come back complete - Ben's three messages,
    // in order, no duplicates and no gap - stitched from the journal for the
    // part that fell off the ring, plus the ring for the rest.
    let observed = colony.sense("s1", "changes");
    let said = observed.events.filter((e: any) => e.type === "said");
    assert.deepEqual(
      said.map((e: any) => e.message),
      ["one", "two", "three"],
    );

    colony.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a journal append failure does not fail the command or authoritative state save", () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-journal-command-eio-"));
  let journalDir = join(dir, "journal");
  let statePath = join(dir, "state.json");
  try {
    let engine = makeSurvivalEngine();
    let colony = createColony({
      engine,
      journalDir,
      statePath,
      journalStorage: {
        append() {
          throw new Error("simulated command EIO");
        },
      },
    });
    colony.start();
    colony.connect("player");

    let joined = colony.join("player", "Ara");
    assert.equal(joined.status, "joined");
    assert.equal(
      (colony.getAdminPayload() as any).liveness.journal.status,
      "degraded",
    );
    colony.stop();

    let saved = JSON.parse(readFileSync(statePath, "utf8"));
    assert.ok(saved.engine.world.entities.ara);

    let restored = createColony({
      engine: makeSurvivalEngine(),
      journalDir,
      statePath,
    });
    try {
      assert.ok((restored.getAdminPayload() as any).state.agents.ara);
      assert.equal(
        (restored.getAdminPayload() as any).liveness.journal.status,
        "healthy",
      );
    } finally {
      restored.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a degraded journal reports stale-cursor history gaps explicitly", () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-journal-gap-"));
  let journalDir = join(dir, "journal");
  let appendCount = 0;
  let engine = makeSurvivalEngine();
  try {
    let colony = createColony({
      engine,
      journalDir,
      journalStorage: {
        append(path, data) {
          appendCount += 1;
          if (appendCount > 1) throw new Error("journal unavailable");
          appendFileSync(path, data);
        },
      },
    });
    colony.start();
    colony.connect("ara-session");
    colony.join("ara-session", "Ara");
    colony.connect("ben-session");
    assert.equal(colony.join("ben-session", "Ben").status, "joined");
    colony.speak("ben-session", "history after failure");

    let snapshot = engine.snapshot();
    engine.restore({ ...snapshot, log: snapshot.log.slice(-1) });
    let observed = colony.sense("ara-session", "changes") as any;
    assert.equal(observed.history.status, "incomplete");
    assert.ok(observed.history.unavailable.length > 0);
    assert.ok(
      observed.events.some(
        (event: any) => event.message === "history after failure",
      ),
    );

    let admin = colony.getAdminPayload() as any;
    assert.equal(admin.liveness.journal.status, "degraded");
    colony.connect("gm-session");
    let gm = colony.joinAsGm("gm-session") as any;
    assert.equal(gm.liveness.journal.status, "degraded");
    colony.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shutdown journal failure cannot prevent the latest state from restoring", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-journal-stop-eio-"));
  let journalDir = join(dir, "journal");
  let statePath = join(dir, "state.json");
  let failTickWrites = false;
  try {
    let colony = createColony({
      engine: makeSurvivalEngine(),
      journalDir,
      statePath,
      scenarios: ["survival"],
      waitTimeoutMs: 2000,
      journalStorage: {
        append(path, data) {
          if (failTickWrites && data.includes('"kind":"tick"'))
            throw new Error("simulated shutdown EIO");
          appendFileSync(path, data);
        },
      },
    });
    colony.start();
    colony.connect("player");
    colony.join("player", "Ara");
    colony.act("player", { type: "rest" });
    failTickWrites = true;
    let changed = await colony.waitForChange("player");
    let committedTick = changed.observation.tick;

    colony.stop();
    assert.equal(
      (colony.getAdminPayload() as any).liveness.journal.status,
      "degraded",
    );

    let restored = createColony({
      engine: makeSurvivalEngine(),
      journalDir,
      statePath,
      scenarios: ["survival"],
    });
    try {
      assert.equal(
        (restored.getAdminPayload() as any).state.tick,
        committedTick,
      );
    } finally {
      restored.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset() deletes the journal and boots a fresh one for the new world", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-journal-reset-"));
  let journalDir = join(dir, "journal");
  try {
    let colony = createColony({
      journalDir,
      scenarios: ["survival"],
      waitTimeoutMs: 2000,
    });
    colony.start();
    colony.connect("s1");
    let joined = colony.join("s1", "Ara");
    let oldWorldId = joined.worldId as string;
    colony.speak("s1", "before reset");

    let payload = (await colony.reset()) as any;
    let newWorldId = payload.worldId as string;
    assert.notEqual(newWorldId, oldWorldId);

    // The journal is state: the old world's records are gone, and the single
    // file starts over with the new world's genesis.
    let records = readFileSync(join(journalDir, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "genesis");
    assert.equal(records[0].worldId, newWorldId);

    colony.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reset() wipes character memory but leaves logs", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-reset-wipe-"));
  let charactersDir = join(dir, "characters");
  let savedCharactersDir = process.env.AGENT_ISLAND_CHARACTERS_DIR;
  let savedDirectorsDir = process.env.AGENT_ISLAND_DIRECTORS_DIR;
  try {
    let characterDir = join(charactersDir, "Ara");
    mkdirSync(join(characterDir, "logs", "codex"), { recursive: true });
    writeFileSync(join(characterDir, "memory.md"), "# old campaign");
    writeFileSync(join(characterDir, "logs", "codex", "play-1.jsonl"), "{}");
    process.env.AGENT_ISLAND_CHARACTERS_DIR = charactersDir;
    process.env.AGENT_ISLAND_DIRECTORS_DIR = join(dir, "directors");

    let colony = createColony({
      waitTimeoutMs: 2000,
      wipeCharacterMemory: () => wipeCharacterMemories(),
    });
    await colony.reset();

    assert.equal(existsSync(join(characterDir, "memory.md")), false);
    // Run logs are the run's evidence trail - the wipe leaves them alone.
    assert.equal(
      existsSync(join(characterDir, "logs", "codex", "play-1.jsonl")),
      true,
    );
  } finally {
    if (savedCharactersDir === undefined)
      delete process.env.AGENT_ISLAND_CHARACTERS_DIR;
    else process.env.AGENT_ISLAND_CHARACTERS_DIR = savedCharactersDir;
    if (savedDirectorsDir === undefined)
      delete process.env.AGENT_ISLAND_DIRECTORS_DIR;
    else process.env.AGENT_ISLAND_DIRECTORS_DIR = savedDirectorsDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("overlapping reset() calls serialize instead of interleaving", async () => {
  // Regression test: a second admin reset (or a scenario switch) arriving
  // mid-teardown used to run against the first reset's half-built world.
  // Each reset must run start-to-finish before the next.
  let order: string[] = [];
  let colony = createColony({
    waitTimeoutMs: 2000,
    wipeCharacterMemory: () => {
      order.push("wipe");
    },
  });
  await Promise.all([colony.reset(), colony.reset()]);
  assert.deepEqual(order, ["wipe", "wipe"]);
});
