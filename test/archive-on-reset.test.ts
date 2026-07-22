import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createColony } from "../src/coordinator.js";
import { survivalBoot } from "./helpers.js";

test("a reset banks the outgoing world into runsDir instead of only deleting it", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-archive-"));
  let statePath = join(dir, "world.json");
  let rulesPath = join(dir, "rules.json");
  let journalDir = join(dir, "journal");
  let runsDir = join(dir, "runs");
  let colony = createColony({
    statePath,
    rulesPath,
    journalDir,
    runsDir,
    waitTimeoutMs: 500,
    ...survivalBoot,
  });
  colony.start();
  try {
    // A GM house rule gives the archive an overlay worth banking.
    colony.connect("gm");
    colony.joinAsGm("gm");
    colony.gmAddRule("gm", {
      id: "gm-storms",
      phase: "flow",
      target: "fire",
      rate: -5,
      channel: "fire.decay",
    });

    // One character resting advances the clock past tick 0, which is what
    // qualifies the world for archiving.
    colony.connect("a");
    colony.join("a", "Ara");
    colony.act("a", { type: "rest" });
    await colony.waitForChange("a");
    let payload = colony.getAdminPayload() as any;
    let before = { worldId: payload.worldId, tick: payload.state.tick };
    assert.ok(before.tick > 0, "world advanced past tick 0");

    await colony.reset();

    let runs = readdirSync(runsDir);
    assert.equal(runs.length, 1, "exactly one run folder is banked");
    let runDir = join(runsDir, runs[0]);
    let meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    assert.equal(meta.worldId, before.worldId);
    assert.equal(meta.tick, before.tick);
    assert.equal(typeof meta.scenario, "string");

    let archivedState = JSON.parse(
      readFileSync(join(runDir, "state.json"), "utf8"),
    );
    assert.equal(archivedState.worldId, before.worldId);

    let archivedRules = JSON.parse(
      readFileSync(join(runDir, "rules.json"), "utf8"),
    );
    assert.ok(
      archivedRules.overlay.dynamicRules.some(
        (rule: any) => rule.id === "gm-storms",
      ),
      "GM overlay is banked with the run",
    );

    let genesis = JSON.parse(
      readFileSync(join(runDir, "journal.jsonl"), "utf8").split("\n")[0],
    );
    assert.equal(genesis.kind, "genesis");
    assert.equal(genesis.worldId, before.worldId);

    // The live locations belong to the fresh world: a new state file with a
    // new identity, a new journal, and no GM overlay file.
    let after = colony.getAdminPayload() as any;
    assert.notEqual(after.worldId, before.worldId);
    let liveState = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(liveState.worldId, after.worldId);
    assert.ok(!existsSync(rulesPath), "live GM overlay file is gone");

    // A fresh world on tick 0 banks nothing - an immediate second reset must
    // not litter runsDir with an empty run.
    await colony.reset();
    assert.equal(readdirSync(runsDir).length, 1, "tick-0 world is not banked");
  } finally {
    colony.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectRunArtifacts banks extra files into the run before the wipe", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-archive-mem-"));
  let runsDir = join(dir, "runs");
  let collected: string[] = [];
  let colony = createColony({
    statePath: join(dir, "world.json"),
    runsDir,
    waitTimeoutMs: 500,
    ...survivalBoot,
    collectRunArtifacts: (runDir) => {
      collected.push(runDir);
      writeFileSync(join(runDir, "memory-probe.md"), "# banked");
    },
  });
  colony.start();
  try {
    colony.connect("a");
    colony.join("a", "Ara");
    colony.act("a", { type: "rest" });
    await colony.waitForChange("a");

    await colony.reset();

    assert.equal(collected.length, 1, "the collector ran once");
    let runDir = join(runsDir, readdirSync(runsDir)[0]);
    assert.equal(collected[0], runDir, "handed the run folder");
    assert.equal(
      readFileSync(join(runDir, "memory-probe.md"), "utf8"),
      "# banked",
    );
    assert.ok(
      existsSync(join(runDir, "meta.json")),
      "meta.json still written after the collector",
    );
  } finally {
    colony.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a throwing artifact collector does not block the reset", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-archive-boom-"));
  let colony = createColony({
    statePath: join(dir, "world.json"),
    runsDir: join(dir, "runs"),
    waitTimeoutMs: 500,
    ...survivalBoot,
    collectRunArtifacts: () => {
      throw new Error("boom");
    },
  });
  colony.start();
  try {
    colony.connect("a");
    colony.join("a", "Ara");
    colony.act("a", { type: "rest" });
    await colony.waitForChange("a");

    let before = (colony.getAdminPayload() as any).worldId;
    await colony.reset();
    assert.notEqual(
      (colony.getAdminPayload() as any).worldId,
      before,
      "reset completed despite the collector throwing",
    );
  } finally {
    colony.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
