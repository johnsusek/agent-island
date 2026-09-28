import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// prettier-ignore
import { directorWake, parseDirectorCadenceTicks, parseMaxTicks, parseMinWakeMs, parsePersona, targetTick, wakeCadenceTicks, wakeDelayMs } from "../scripts/crew-policy.mjs";
// prettier-ignore
import { detailText, filterSeats, headerText, reconcileSelection, rosterItems, seatHeading } from "../src/operator/presentation.ts";
import {
  operatorHelp,
  operatorPaths,
  parseOperatorArgs,
} from "../src/operator/config.ts";
import { createLogStore } from "../src/operator/logs.ts";
import { createRuntime } from "../src/operator/runtime.ts";
import { nextFocusPane } from "../src/operator/screen.ts";

test("operator pane focus toggles without traversing roster items", () => {
  assert.equal(nextFocusPane("roster"), "detail");
  assert.equal(nextFocusPane("detail"), "roster");
});

test("operator arguments and help expose only viewer controls", () => {
  let options = parseOperatorArgs([
    "--url",
    "http://island.test/",
    "--refresh",
    "500",
    "--agent",
    "Linden",
    "--monochrome",
  ]);
  assert.equal(options.url, "http://island.test");
  assert.equal(options.refreshMs, 500);
  assert.equal(options.selectedName, "Linden");
  assert.equal(options.monochrome, true);

  let help = operatorHelp();
  assert.match(help, /Activity \/ memory/);
  assert.doesNotMatch(help, /Launch|Raw|Stop|World operations/);
});

test("persona frontmatter parses into meta and stripped body", () => {
  let { meta, body } = parsePersona(
    "---\nmodel: haiku\neffort: medium\nwake:\n  events: [speculative_attempt, noun_attempt]\n  every_ticks: 50\n---\nYou are the Oracle.",
  );
  assert.equal(meta.model, "haiku");
  assert.equal(meta.effort, "medium");
  assert.deepEqual(meta.wake.events, ["speculative_attempt", "noun_attempt"]);
  assert.equal(meta.wake.every_ticks, 50);
  assert.equal(body, "You are the Oracle.");
  // No frontmatter: the whole file is body and there is no wake policy.
  let plain = parsePersona("You are a helper.");
  assert.deepEqual(plain.meta, {});
  assert.equal(plain.body, "You are a helper.");
  assert.equal(directorWake(plain.meta), null);
});

test("persona wake policy drives director cadence and run ticks measure from launch", () => {
  let eventWoken = directorWake({
    wake: { events: ["speculative_attempt"], every_ticks: 50 },
  });
  assert.equal(wakeCadenceTicks(eventWoken), 0);
  let scheduled = directorWake({ wake: { every_ticks: 600 } });
  assert.equal(wakeCadenceTicks(scheduled), 600);
  assert.throws(() => directorWake({ wake: {} }));
  assert.throws(() => directorWake({ wake: { every_ticks: 1.5 } }));
  assert.equal(parseDirectorCadenceTicks(undefined, scheduled), 600);
  assert.equal(parseDirectorCadenceTicks("125", scheduled), 125);
  assert.throws(() => parseDirectorCadenceTicks("1.5", scheduled));
  assert.equal(parseMaxTicks("off"), 0);
  assert.equal(parseMaxTicks("2000"), 2000);
  assert.equal(targetTick(4200, 2000), 6200);
});

test("an event-woken seat's wake throttle rate-limits passes without delaying slow ones", () => {
  let throttled = directorWake({
    wake: { events: ["speculative_attempt"], min_interval_ms: 30000 },
  });
  assert.equal(throttled.minIntervalMs, 30000);
  // Frontmatter is the default; the flag overrides it, `off` removes it.
  assert.equal(parseMinWakeMs(undefined, throttled), 30000);
  assert.equal(parseMinWakeMs("5000", throttled), 5000);
  assert.equal(parseMinWakeMs("off", throttled), 0);
  // A persona with no floor is unthrottled.
  let plain = directorWake({ wake: { events: ["speculative_attempt"] } });
  assert.equal(plain.minIntervalMs, null);
  assert.equal(parseMinWakeMs(undefined, plain), 0);
  assert.throws(() =>
    directorWake({ wake: { events: ["x"], min_interval_ms: 0 } }),
  );
  assert.throws(() => parseMinWakeMs("-1", plain));

  // The floor is measured from the last pass's START: a 4s pass waits out the
  // rest of the 30s window, a 45s pass already outran it and pays only the
  // ordinary gap, and an unthrottled seat always pays only the gap.
  assert.equal(wakeDelayMs(30000, 4000, 3000), 26000);
  assert.equal(wakeDelayMs(30000, 45000, 3000), 3000);
  assert.equal(wakeDelayMs(30000, 28000, 3000), 3000);
  assert.equal(wakeDelayMs(0, 4000, 3000), 3000);
});

test("shipped director personas declare their seats in frontmatter", () => {
  let personaDir = new URL("../agents/directors/", import.meta.url);
  let read = (name) =>
    parsePersona(fs.readFileSync(new URL(`${name}.md`, personaDir), "utf8"));
  let oracle = directorWake(read("oracle").meta);
  assert.deepEqual(oracle.events, ["speculative_attempt", "noun_attempt"]);
  assert.equal(wakeCadenceTicks(oracle), 0);
  // The Oracle wakes on every attempt, but at most twice a minute.
  assert.equal(oracle.minIntervalMs, 30000);
  assert.equal(wakeCadenceTicks(directorWake(read("steward").meta)), 250);
});

test("log store normalizes Codex and Claude usage and renders their tool activity", () => {
  let directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-island-operator-logs-"),
  );
  try {
    let codexDir = path.join(directory, "logs", "codex");
    let claudeDir = path.join(directory, "logs", "claude");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.mkdirSync(claudeDir, { recursive: true });
    let codexFile = path.join(codexDir, "play-1.jsonl");
    let claudeFile = path.join(claudeDir, "play-2.jsonl");
    fs.writeFileSync(
      codexFile,
      [
        JSON.stringify({
          type: "item.started",
          item: {
            id: "tool-1",
            type: "mcp_tool_call",
            tool: "sense",
            arguments: { mode: "situation" },
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: {
            id: "tool-1",
            type: "mcp_tool_call",
            tool: "sense",
            result: { content: [{ type: "text", text: "Tick 4" }] },
          },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 1000,
            cached_input_tokens: 750,
            output_tokens: 80,
          },
        }),
      ].join("\n"),
    );
    fs.writeFileSync(
      `${codexFile}.meta`,
      JSON.stringify({
        startedAt: "2026-07-22T10:00:00Z",
        model: "gpt-test",
        effort: "low",
      }),
    );
    fs.writeFileSync(
      claudeFile,
      JSON.stringify({
        type: "result",
        duration_ms: 2000,
        total_cost_usd: 0.1,
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 300,
          output_tokens: 40,
        },
      }),
    );
    fs.writeFileSync(
      `${claudeFile}.meta`,
      JSON.stringify({
        startedAt: "2026-07-22T11:00:00Z",
        model: "haiku",
        effort: "medium",
      }),
    );

    let logStore = createLogStore();
    let inspected = logStore.inspectSeat(directory, 0);
    assert.equal(inspected.totalUsage.inputTokens, 1450);
    assert.equal(inspected.totalUsage.cachedInputTokens, 1050);
    assert.equal(inspected.totalUsage.uncachedInputTokens, 400);
    assert.equal(inspected.totalUsage.outputTokens, 120);
    assert.equal(inspected.totalUsage.completedRuns, 2);
    assert.equal(inspected.latest.engine, "claude");
    assert.match(inspected.latest.entries[0].text, /450/);
    let view = logStore.inspectView(directory);
    assert.equal(view.logCount, 2);
    assert.deepEqual(
      view.entries.map((entry) => entry.label),
      ["→ sense", "← sense", "usage", "complete"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("log store consumes appended JSONL once and waits for partial records", () => {
  let directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-island-operator-incremental-"),
  );
  try {
    let logsDir = path.join(directory, "logs", "codex");
    let logFile = path.join(logsDir, "play-1.jsonl");
    fs.mkdirSync(logsDir, { recursive: true });
    let firstEvent = JSON.stringify({
      type: "turn.completed",
      usage: {
        cached_input_tokens: 60,
        input_tokens: 100,
        output_tokens: 10,
      },
    });
    let secondEvent = JSON.stringify({
      type: "turn.completed",
      usage: {
        cached_input_tokens: 25,
        input_tokens: 50,
        output_tokens: 5,
      },
    });
    fs.writeFileSync(logFile, `${firstEvent}\n`);

    let logStore = createLogStore();
    let first = logStore.inspectSeat(directory);
    assert.equal(first.totalUsage.inputTokens, 100);
    assert.equal(first.totalUsage.completedRuns, 1);

    let splitAt = Math.floor(secondEvent.length / 2);
    fs.appendFileSync(logFile, secondEvent.slice(0, splitAt));
    let partial = logStore.inspectSeat(directory);
    assert.equal(partial.totalUsage.inputTokens, 100);
    assert.equal(logStore.inspectView(directory)?.entries.length, 1);

    fs.appendFileSync(logFile, `${secondEvent.slice(splitAt)}\n`);
    let complete = logStore.inspectSeat(directory);
    assert.equal(complete.totalUsage.inputTokens, 150);
    assert.equal(complete.totalUsage.cachedInputTokens, 85);
    assert.equal(complete.totalUsage.completedRuns, 2);
    assert.equal(logStore.inspectView(directory)?.entries.length, 2);

    let repeated = logStore.inspectSeat(directory);
    assert.equal(repeated.totalUsage.inputTokens, 150);
    assert.equal(repeated.totalUsage.completedRuns, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("offline runtime reconciles saved agents, crew batches, and log metadata", async () => {
  let home = fs.mkdtempSync(
    path.join(os.tmpdir(), "agent-island-operator-runtime-"),
  );
  try {
    let options = { home, url: "http://127.0.0.1:1" };
    let paths = operatorPaths(options);
    paths.directorPersonasDir = path.join(home, "director-personas");
    fs.mkdirSync(paths.directorPersonasDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.directorPersonasDir, "steward.md"),
      "---\nwake:\n  every_ticks: 600\n---\n# Steward",
    );
    fs.writeFileSync(
      path.join(paths.directorPersonasDir, "oracle.md"),
      "---\nwake:\n  events: [speculative_attempt]\n---\n# Oracle",
    );
    // No wake frontmatter: not a seat, never listed.
    fs.writeFileSync(
      path.join(paths.directorPersonasDir, "helper.md"),
      "# Helper",
    );
    fs.mkdirSync(path.join(paths.charactersDir, "Linden", "logs", "codex"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(paths.charactersDir, "Previous", "logs", "codex"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(paths.directorsDir, "Steward", "logs", "codex"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(paths.directorsDir, "Retired", "logs", "codex"), {
      recursive: true,
    });
    fs.mkdirSync(paths.batchesDir, { recursive: true });
    fs.mkdirSync(paths.directorBatchesDir, { recursive: true });
    fs.writeFileSync(
      paths.stateFile,
      JSON.stringify({
        worldId: "world-test",
        endedAt: null,
        engine: {
          scenario: "genesis",
          world: {
            tick: 42,
            entities: {
              linden: {
                id: "linden",
                tags: ["agent"],
                stocks: { health: { value: 80 } },
                action: { type: "explore" },
              },
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(paths.batchesDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, names: ["Linden"] }),
    );
    fs.writeFileSync(
      path.join(paths.directorBatchesDir, `${process.pid}.json`),
      JSON.stringify({
        pid: process.pid,
        names: ["Steward"],
        persona: "steward",
        cadenceTicks: 500,
        state: "scheduled",
        nextLaunchTick: 542,
        startTick: 42,
        stopTick: 2042,
      }),
    );
    fs.writeFileSync(
      path.join(paths.directorBatchesDir, `${process.ppid}.json`),
      JSON.stringify({
        pid: process.ppid,
        names: ["Oracle"],
        persona: "oracle",
        cadenceTicks: 0,
        state: "running",
        startTick: 42,
        stopTick: 2042,
      }),
    );
    let logFile = path.join(
      paths.charactersDir,
      "Linden",
      "logs",
      "codex",
      "play-1.jsonl",
    );
    fs.writeFileSync(
      logFile,
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 80,
          output_tokens: 10,
        },
      }),
    );
    fs.writeFileSync(
      `${logFile}.meta`,
      JSON.stringify({
        name: "Linden",
        role: "character",
        engine: "codex",
        model: "gpt-test",
        effort: "low",
        startedAt: new Date().toISOString(),
      }),
    );
    fs.writeFileSync(
      path.join(paths.charactersDir, "Linden", "memory.md"),
      "# Linden\n\nRemember the quarry.",
    );
    let directorLog = path.join(
      paths.directorsDir,
      "Steward",
      "logs",
      "codex",
      "play-1.jsonl",
    );
    fs.writeFileSync(directorLog, JSON.stringify({ type: "turn.started" }));
    fs.writeFileSync(
      `${directorLog}.meta`,
      JSON.stringify({
        name: "Steward",
        role: "director",
        engine: "codex",
        model: "gpt-director",
        effort: "medium",
        startedAt: new Date().toISOString(),
      }),
    );

    let snapshot = await createRuntime(options, paths).refresh();
    assert.equal(
      snapshot.seats.find((seat) => seat.name === "Helper"),
      undefined,
    );
    let linden = snapshot.seats.find((seat) => seat.name === "Linden");
    let steward = snapshot.seats.find((seat) => seat.name === "Steward");
    let oracle = snapshot.seats.find((seat) => seat.name === "Oracle");
    let previous = snapshot.seats.find((seat) => seat.name === "Previous");
    let retired = snapshot.seats.find((seat) => seat.name === "Retired");
    assert.equal(snapshot.online, false);
    assert.equal(snapshot.world.tick, 42);
    assert.equal(linden.processRunning, true);
    assert.equal(linden.state, "relaunching");
    assert.equal(linden.model, "gpt-test");
    assert.match(linden.memory, /Remember the quarry/);
    assert.equal(linden.usage.total.cachedInputTokens, 80);
    assert.equal(steward.persona, "steward");
    assert.equal(steward.processRunning, true);
    assert.equal(steward.state, "scheduled");
    assert.equal(steward.cadenceTicks, 500);
    assert.equal(steward.nextLaunchTick, 542);
    assert.equal(oracle.persona, "oracle");
    assert.equal(oracle.processRunning, true);
    assert.equal(oracle.state, "running");
    assert.notEqual(oracle.pid, steward.pid);
    assert.equal(previous, undefined);
    assert.equal(retired, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("operator presentation filters and builds TerminalKit widget content", () => {
  let emptyUsage = {
    cachedInputTokens: 0,
    completedRuns: 0,
    costUsd: 0,
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    uncachedInputTokens: 0,
  };
  let seats = [
    {
      alive: null,
      controllerConnected: true,
      id: "director:oracle",
      log: {
        entries: [
          { kind: "text", label: "agent", text: "Listening.", raw: "{}" },
        ],
        file: "oracle.jsonl",
        mtime: 1,
        size: 1,
        startedAt: 1,
      },
      logCount: 1,
      memory: "# Oracle\n\nWatch the world.",
      name: "Oracle",
      persona: "oracle",
      processRunning: true,
      role: "director",
      seatDir: "/tmp/oracle",
      startedAt: 1,
      state: "running",
      updatedAt: 1,
      engine: "codex",
      model: "gpt",
      effort: "medium",
      usage: {
        run: emptyUsage,
        total: emptyUsage,
      },
    },
    {
      alive: true,
      controllerConnected: false,
      id: "character:linden",
      log: null,
      logCount: 0,
      memory: null,
      name: "Linden",
      persona: "character-minimal",
      processRunning: false,
      role: "character",
      seatDir: "/tmp/linden",
      startedAt: null,
      state: "idle",
      updatedAt: null,
      engine: "claude",
      model: "haiku",
      effort: "low",
      usage: {
        run: emptyUsage,
        total: emptyUsage,
      },
    },
  ];
  assert.deepEqual(
    filterSeats(seats, "running", "").map((seat) => seat.name),
    ["Oracle"],
  );
  assert.deepEqual(
    filterSeats(seats, "all", "hai").map((seat) => seat.name),
    ["Linden"],
  );
  assert.deepEqual(
    filterSeats(seats, "all", "earlier", "director:oracle", {
      entries: [{ label: "agent", text: "An earlier thought." }],
    }).map((seat) => seat.name),
    ["Oracle"],
  );

  let items = rosterItems(seats, 32);
  assert.deepEqual(
    items.filter((item) => item.disabled).map((item) => item.content),
    ["DIRECTORS", "CHARACTERS"],
  );
  assert.match(seatHeading(seats[0]), /Oracle · running/);
  assert.match(detailText(seats[0], "activity", null, ""), /Listening/);
  assert.match(detailText(seats[0], "memory", null, ""), /Watch/);
  assert.match(
    headerText({
      online: true,
      world: {
        scenario: "genesis",
        tick: 12,
        alive: 1,
        activeCount: 0,
      },
    }),
    /genesis · tick 12 · ONLINE/,
  );
  assert.equal(reconcileSelection([], "director:oracle", null), null);
});
