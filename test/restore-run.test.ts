import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createColony } from "../src/coordinator.js";
import { survivalBoot } from "./helpers.js";

test("restore banks the current world and loads a previously archived run back as live", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-restore-"));
  let statePath = join(dir, "world.json");
  let rulesPath = join(dir, "rules.json");
  let journalDir = join(dir, "journal");
  let runsDir = join(dir, "runs");
  let restored: string[] = [];
  let colony = createColony({
    statePath,
    rulesPath,
    journalDir,
    runsDir,
    waitTimeoutMs: 500,
    ...survivalBoot,
    collectRunArtifacts: (runDir) => {
      writeFileSync(join(runDir, "probe.md"), "# banked");
    },
    restoreRunArtifacts: (runDir) => {
      restored.push(runDir);
    },
  });
  colony.start();
  try {
    // A GM house rule to confirm the overlay round-trips through restore too.
    colony.connect("gm");
    colony.joinAsGm("gm");
    colony.gmAddRule("gm", {
      id: "gm-storms",
      phase: "flow",
      target: "fire",
      rate: -5,
      channel: "fire.decay",
    });

    colony.connect("a");
    colony.join("a", "Ara");
    colony.act("a", { type: "rest" });
    await colony.waitForChange("a");
    let before = colony.getAdminPayload() as any;
    assert.ok(before.state.tick > 0, "world advanced past tick 0");

    await colony.reset();
    let runs = readdirSync(runsDir);
    assert.equal(runs.length, 1, "the first world is banked");
    let runId = runs[0];

    // Advance the fresh (post-reset) world a little so restoring back has
    // something distinct to discard.
    let afterReset = colony.getAdminPayload() as any;
    assert.notEqual(afterReset.worldId, before.worldId);
    colony.connect("b");
    colony.join("b", "Bea");
    colony.act("b", { type: "rest" });
    await colony.waitForChange("b");

    let payload = (await colony.restoreRun(runId)) as any;

    assert.equal(payload.worldId, before.worldId, "restored the banked world");
    assert.equal(payload.state.tick, before.state.tick);
    assert.ok(payload.state.agents.ara?.alive, "Ara is back and alive");
    assert.ok(
      payload.ruleMeta.dirtyIds.includes("gm-storms"),
      "the GM overlay round-tripped through restore",
    );

    // Restoring auto-archives the world that was live just before the swap
    // (the post-reset one Bea joined), so nothing is lost.
    let runsAfter = readdirSync(runsDir);
    assert.equal(runsAfter.length, 2, "the discarded live world got banked too");

    assert.equal(restored.length, 1, "restoreRunArtifacts ran once");
    assert.equal(restored[0], join(runsDir, runId), "handed the right run folder");
  } finally {
    colony.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoring an unknown run id fails without touching the live world", async () => {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-restore-missing-"));
  let statePath = join(dir, "world.json");
  let colony = createColony({
    statePath,
    runsDir: join(dir, "runs"),
    waitTimeoutMs: 500,
    ...survivalBoot,
  });
  colony.start();
  try {
    colony.connect("a");
    colony.join("a", "Ara");
    let before = (colony.getAdminPayload() as any).worldId;

    await assert.rejects(() => colony.restoreRun("does-not-exist"));

    assert.equal(
      (colony.getAdminPayload() as any).worldId,
      before,
      "the live world is untouched by a failed restore",
    );
  } finally {
    colony.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
