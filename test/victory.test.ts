import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createColony } from "./helpers.js";
import { createWorld } from "@agent-island/engine/engine";
import { resolveIncludes, rulesetsDirFor } from "@agent-island/mcp/scenarios";
import { renderCharacterResult } from "@agent-island/mcp/sense-prose";
import type { Scenario } from "@agent-island/engine/scenario";
import { declareProgress } from "./helpers.js";

test("shipped victory scenarios expose agent-facing descriptions", () => {
  let expected = ["quiet-world", "survival"];
  let actual: string[] = [];

  // The shipped scenarios live in config/scenarios; the survival fixture lives
  // in test/. Sweep both, with includes always resolving from config/rulesets.
  let files = [
    ...readdirSync("config/scenarios").map((f) => `config/scenarios/${f}`),
    "test/survival.json",
  ].sort();
  for (let filePath of files) {
    let scenario = JSON.parse(readFileSync(filePath, "utf8"));
    // Resolve includes so a victory rule carried by an included ruleset is still
    // seen (today they ride the scenario, but the sweep shouldn't assume that).
    let victoryRules = (
      resolveIncludes(scenario, rulesetsDirFor("config/scenarios"))
        .dynamicRules as any[]
    ).filter((rule) => rule.emit?.type === "victory");
    if (!victoryRules.length) continue;

    actual.push(scenario.name);
    assert.ok(
      scenario.description?.trim(),
      `${scenario.name} needs a scenario description`,
    );
    for (let rule of victoryRules) {
      assert.ok(
        rule.description?.trim(),
        `${scenario.name} victory rule "${rule.id}" needs a description`,
      );
      // Victory is a world-level declaration the whole colony must witness, so
      // it has to opt into colony-wide reach - otherwise the flipped default
      // scopes it to whoever happened to stand by the winning tile.
      assert.equal(
        rule.emit.global,
        true,
        `${scenario.name} victory rule "${rule.id}" must emit \`global: true\` to reach the colony`,
      );
    }
  }

  assert.deepEqual(actual, expected);
});

// A deliberately tiny scenario whose whole point is the victory hook: a world
// `progress` stock ticks up by one each turn, and a watch rule declares the game
// won once it reaches `at`. The condition is authored entirely in the rules (here
// a stock ceiling, but it could be any Cond the DSL expresses - a population
// quorum, a composite any/all, a resource total), which is exactly the
// flexibility the coordinator relies on: it only watches for the emitted
// `victory` event, never for a particular rule shape. `progress` crossing the
// threshold within the winning tick is a real edge, which is what a watch rule
// fires on.
function victoryScenario(at: number): Scenario {
  return {
    name: "victory-demo",
    spawn: { x: 1, y: 1 },
    agentTemplate: { tags: ["agent"], stocks: {} },
    rules: [
      {
        id: "progress",
        phase: "flow",
        target: "progress",
        rate: 1,
      },
      {
        id: "win-at-progress",
        phase: "watch",
        when: {
          cmp: "gte",
          left: { stock: "progress", of: "world" },
          right: at,
        },
        emit: { type: "victory", text: "The colony has won.", global: true },
      },
    ],
  };
}

test("a scenario's victory rule ends the run after a grace window", async () => {
  let colony = createColony({
    engine: declareProgress(createWorld(victoryScenario(5))),
    victoryGraceTicks: 3,
    waitTimeoutMs: 2000,
  });
  colony.start();
  colony.connect("s1");
  try {
    colony.join("s1", "Ara");

    // Sole parked player: the world fast-forwards to the winning tick, where the
    // watch rule fires `victory` - a visible event that wakes the character.
    let won = await colony.waitForChange("s1");
    assert.ok(
      won.events.some((event: any) => event.type === "victory"),
      "the character should witness the victory event",
    );

    let mid = colony.getAdminPayload().liveness;
    assert.equal(
      mid.victoryTick,
      5,
      "victory clock starts at the winning tick",
    );
    assert.equal(
      mid.ended,
      false,
      "the colony keeps playing through the grace",
    );

    // Park again: the colony plays on for the grace window, then locks. The
    // park itself completes the barrier and drives the fast-forward, so the
    // conclusion resolves this very wait with the terminal `ended` status.
    let ended = await colony.waitForChange("s1");
    assert.equal(ended.status, "ended");

    let after = colony.getAdminPayload();
    assert.equal(after.liveness.ended, true);
    assert.equal(after.liveness.endedAt, 8, "grace of 3 ticks from a win at 5");
    assert.equal(after.state.tick, 8, "the clock froze on the concluding tick");
  } finally {
    colony.stop();
  }
});

// The commons playtest's players were told "[ended]" and kept going: orders
// were accepted into a frozen world and wait_for_change idled every 30s, so
// they had to be stopped by hand. A closed world now says so in every result,
// refuses play, and answers waits at once.
test("a closed world tells players the game is over and stops taking play", async () => {
  let colony = createColony({
    engine: declareProgress(createWorld(victoryScenario(2))),
    victoryGraceTicks: 0,
    // Long enough that a wait which parked instead of answering would hang
    // the test well past the elapsed-time check below.
    waitTimeoutMs: 60_000,
  });
  colony.start();
  colony.connect("s1");
  colony.connect("gm");
  try {
    let joined = colony.join("s1", "Ara");
    assert.equal("gameOver" in joined, false, "a live world has no notice");
    colony.joinAsGm("gm");

    // Grace 0: the world closes on the winning tick, and Ara's wait returns
    // that tick's victory in an `ended` result that carries the notice.
    let closing = await colony.waitForChange("s1");
    assert.equal(closing.status, "ended");
    assert.ok(closing.events.some((event: any) => event.type === "victory"));
    assert.match(closing.gameOver, /^The colony has won\. The game is over/);
    assert.match(closing.gameOver, /Call leave_game and stop\./);

    let started = Date.now();
    let again = await colony.waitForChange("s1");
    assert.equal(again.status, "ended");
    assert.ok(Date.now() - started < 1000, "answered at once, not parked");
    assert.match(
      renderCharacterResult(again).split("\n")[0],
      /The game is over: the world closed at tick 2/,
      "the notice is the first line a player reads",
    );
    assert.ok(colony.sense("s1", "situation").gameOver);

    for (let play of [
      () => colony.act("s1", { type: "rest" }),
      () =>
        colony.setOrder("s1", { kind: "sequence", steps: [{ type: "rest" }] }),
      () => colony.speak("s1", "is anyone there?"),
    ])
      assert.throws(play, /The game is over/);

    let gmWake = await colony.waitForWorld("gm", { everyTicks: 5 });
    assert.equal(gmWake.status, "ended");
    assert.equal(colony.leave("s1").status, "left", "leaving still works");
  } finally {
    colony.stop();
  }
});

test("a concluded world stays concluded across a restart", async () => {
  let dir = mkdtempSync(join(tmpdir(), "victory-"));
  let statePath = join(dir, "state.json");
  try {
    let first = createColony({
      engine: declareProgress(createWorld(victoryScenario(2))),
      victoryGraceTicks: 0,
      waitTimeoutMs: 2000,
      statePath,
    });
    first.start();
    first.connect("s1");
    first.join("s1", "Ara");
    // Grace 0: the character is woken by the victory event, and the world
    // concludes on that same winning tick.
    let seen = await first.waitForChange("s1");
    assert.ok(seen.events.some((event: any) => event.type === "victory"));
    assert.equal(first.getAdminPayload().liveness.ended, true);
    first.stop();

    // A fresh coordinator over the same state file must come up already
    // concluded - the edge-triggered watch will never re-fire, so a lost
    // `endedAt` would silently un-freeze a finished game.
    let second = createColony({
      engine: declareProgress(createWorld(victoryScenario(2))),
      victoryGraceTicks: 0,
      waitTimeoutMs: 500,
      statePath,
    });
    let concludedTick = first.getAdminPayload().state.tick;
    second.start();
    second.connect("s2");
    // Joining re-runs the advance path; a concluded world restored from disk
    // must refuse to tick, so the clock stays exactly where it locked.
    second.join("s2", "Ara");
    let payload = second.getAdminPayload();
    assert.equal(
      payload.liveness.ended,
      true,
      "the restart restores the freeze",
    );
    assert.equal(
      payload.state.tick,
      concludedTick,
      "a restarted concluded world never advances",
    );
    second.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
