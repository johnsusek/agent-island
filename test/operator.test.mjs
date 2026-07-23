import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultDirectorCadenceTicks, parseDirectorCadenceTicks, parseMaxTicks, targetTick } from "../scripts/crew-policy.mjs";
import { buildCrewArgs, personaNames } from "../scripts/operator/actions.mjs";
import { configureLaunchRoleFields, createLaunchModal, filterSeats, tokenizeInput } from "../scripts/operator/app.mjs";
import { operatorPaths, parseOperatorArgs } from "../scripts/operator/config.mjs";
import { createLogStore } from "../scripts/operator/logs.mjs";
import { createRuntime } from "../scripts/operator/runtime.mjs";
import { renderDashboard } from "../scripts/operator/views.mjs";

test("operator arguments and crew launch arguments preserve explicit settings", () => {
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
  assert.deepEqual(tokenizeInput("\x1b[Aq"), ["\x1b[A", "q"]);
  assert.deepEqual(tokenizeInput("Alba"), ["A", "l", "b", "a"]);
  let modelField = createLaunchModal().fields.find(
    (field) => field.key === "model",
  );
  assert.equal(modelField.type, "choice");
  assert.deepEqual(modelField.choices, ["fable", "opus", "sonnet", "haiku"]);
  let directorModal = createLaunchModal({
    characters: ["character-minimal"],
    directors: ["auditor", "oracle"],
  });
  configureLaunchRoleFields(directorModal, "director", "auditor");
  assert.equal(
    directorModal.fields.find((field) => field.key === "cadenceTicks").value,
    "500",
  );
  assert.equal(
    directorModal.fields.some((field) => field.key === "count"),
    false,
  );
  assert.equal(
    directorModal.fields.some((field) => field.key === "ocean"),
    false,
  );

  assert.deepEqual(
    buildCrewArgs({
      role: "character",
      names: "Alba,Linden",
      count: 2,
      engine: "codex",
      model: "gpt-test",
      effort: "high",
      persona: "character-minimal",
      maxTicks: "off",
      ocean: false,
      instructions: "build carefully",
      url: "http://island.test",
    }),
    [
      "characters",
      "--max-ticks",
      "off",
      "--engine",
      "codex",
      "--model",
      "gpt-test",
      "--effort",
      "high",
      "--persona",
      "character-minimal",
      "--instructions",
      "build carefully",
      "--url",
      "http://island.test",
      "--names",
      "Alba,Linden",
      "--no-ocean",
    ],
  );
  assert.deepEqual(
    buildCrewArgs({
      role: "director",
      names: "Auditor",
      persona: "auditor",
      engine: "claude",
      model: "haiku",
      effort: "medium",
      maxTicks: "2000",
      cadenceTicks: "500",
    }),
    [
      "director",
      "--max-ticks",
      "2000",
      "--engine",
      "claude",
      "--model",
      "haiku",
      "--effort",
      "medium",
      "--persona",
      "auditor",
      "--cadence-ticks",
      "500",
      "--name",
      "Auditor",
    ],
  );
});

test("crew policy gives each director a cadence and measures run ticks from launch", () => {
  assert.equal(defaultDirectorCadenceTicks("oracle"), 0);
  assert.equal(defaultDirectorCadenceTicks("auditor"), 500);
  assert.equal(defaultDirectorCadenceTicks("tuner"), 300);
  assert.equal(defaultDirectorCadenceTicks("seeder"), 500);
  assert.equal(parseDirectorCadenceTicks(undefined, "auditor"), 500);
  assert.equal(parseDirectorCadenceTicks("125", "auditor"), 125);
  assert.throws(() => parseDirectorCadenceTicks("1.5", "auditor"));
  assert.equal(parseMaxTicks("off"), 0);
  assert.equal(parseMaxTicks("2000"), 2000);
  assert.equal(targetTick(4200, 2000), 6200);
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

    let inspected = createLogStore().inspectSeat(directory, 0);
    assert.equal(inspected.totalUsage.inputTokens, 1450);
    assert.equal(inspected.totalUsage.cachedInputTokens, 1050);
    assert.equal(inspected.totalUsage.uncachedInputTokens, 400);
    assert.equal(inspected.totalUsage.outputTokens, 120);
    assert.equal(inspected.totalUsage.completedRuns, 2);
    assert.equal(inspected.latest.engine, "claude");
    assert.match(inspected.latest.entries[0].text, /450/);
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
      path.join(paths.directorPersonasDir, "auditor.md"),
      "# Auditor",
    );
    fs.writeFileSync(
      path.join(paths.directorPersonasDir, "oracle.md"),
      "# Oracle",
    );
    assert.deepEqual(personaNames(paths.directorPersonasDir), [
      "auditor",
      "oracle",
    ]);
    fs.mkdirSync(path.join(paths.charactersDir, "Linden", "logs", "codex"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(paths.charactersDir, "Previous", "logs", "codex"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(paths.directorsDir, "Auditor", "logs", "codex"), {
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
        names: ["Auditor"],
        persona: "auditor",
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
    let directorLog = path.join(
      paths.directorsDir,
      "Auditor",
      "logs",
      "codex",
      "play-1.jsonl",
    );
    fs.writeFileSync(directorLog, JSON.stringify({ type: "turn.started" }));
    fs.writeFileSync(
      `${directorLog}.meta`,
      JSON.stringify({
        name: "Auditor",
        role: "director",
        engine: "codex",
        model: "gpt-director",
        effort: "medium",
        startedAt: new Date().toISOString(),
      }),
    );

    let snapshot = await createRuntime(options, paths).refresh();
    let linden = snapshot.seats.find((seat) => seat.name === "Linden");
    let auditor = snapshot.seats.find((seat) => seat.name === "Auditor");
    let oracle = snapshot.seats.find((seat) => seat.name === "Oracle");
    let previous = snapshot.seats.find((seat) => seat.name === "Previous");
    assert.equal(snapshot.online, false);
    assert.equal(snapshot.world.tick, 42);
    assert.equal(linden.processRunning, true);
    assert.equal(linden.state, "relaunching");
    assert.equal(linden.model, "gpt-test");
    assert.equal(linden.usage.total.cachedInputTokens, 80);
    assert.equal(auditor.persona, "auditor");
    assert.equal(auditor.processRunning, true);
    assert.equal(auditor.state, "scheduled");
    assert.equal(auditor.cadenceTicks, 500);
    assert.equal(auditor.nextLaunchTick, 542);
    assert.equal(oracle.persona, "oracle");
    assert.equal(oracle.processRunning, true);
    assert.equal(oracle.state, "running");
    assert.notEqual(oracle.pid, auditor.pid);
    assert.equal(previous, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("roster filtering and dashboard rendering preserve the two-pane operator surface", () => {
  let seats = [
    {
      id: "director:oracle",
      name: "Oracle",
      role: "director",
      state: "running",
      engine: "codex",
      model: "gpt",
      effort: "medium",
      usage: { run: {} },
    },
    {
      id: "character:linden",
      name: "Linden",
      role: "character",
      state: "idle",
      engine: "claude",
      model: "haiku",
      effort: "low",
      usage: { run: {} },
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

  let state = {
    snapshot: {
      online: true,
      seats,
      world: {
        worldId: "12345678-abcd",
        scenario: "genesis",
        tick: 12,
        elapsedMs: 10_000,
        realTimeMs: 2000,
        alive: 1,
        activeCount: 0,
        idle: 1,
        dead: 0,
        usage: {
          inputTokens: 0,
          cachedInputTokens: 0,
          uncachedInputTokens: 0,
          outputTokens: 0,
        },
        tokensPerMinute: 0,
        openAttempts: 0,
        nounAttempts: 0,
        mintedRules: 0,
        unsavedRules: 0,
        ruleCount: 1,
      },
    },
    visibleSeats: seats,
    selectedId: "director:oracle",
    selectedSeat: {
      ...seats[0],
      log: {
        entries: [
          { kind: "text", label: "agent", text: "Listening.", raw: "{}" },
        ],
      },
      logCount: 1,
      startedAt: Date.now(),
      pid: 1,
    },
    filter: "all",
    query: "",
    follow: true,
    logOffset: 0,
    rawLogs: false,
    modal: null,
    notice: null,
  };
  let rendered = renderDashboard(state, 120, 30).join("\n");
  assert.match(rendered, /Agents 2\/2/);
  assert.match(rendered, /DIRECTORS/);
  assert.match(rendered, /Oracle/);
  assert.match(rendered, /Listening/);
  let topBorder = rendered.split("\n")[1];
  assert.equal((topBorder.match(/┌/g) ?? []).length, 2);
});
