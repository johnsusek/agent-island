import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createScenarioStore } from "../src/scenarios.js";

function scenarioDirectory(recommendedPlayers: unknown): string {
  let directory = mkdtempSync(path.join(tmpdir(), "agent-island-scenario-"));
  writeFileSync(
    path.join(directory, "example.json"),
    JSON.stringify({
      name: "example",
      recommendedPlayers,
      overlay: {},
    }),
  );
  return directory;
}

test("scenario summaries include recommended player counts", () => {
  let store = createScenarioStore(scenarioDirectory({ min: 2, max: 6 }));
  assert.deepEqual(store.list([])[0].recommendedPlayers, { min: 2, max: 6 });
});

test("scenario stores reject invalid recommended player counts", () => {
  let store = createScenarioStore(scenarioDirectory({ min: 4, max: 2 }));
  assert.throws(() => store.list([]), /recommendedPlayers.max/);
});
