// An overlay's describeEvent prose survives a snapshot and restore.

import test from "node:test";
import assert from "node:assert/strict";

import { makeSurvivalEngine } from "./helpers.js";

test("a restored world keeps the overlay's event prose", () => {
  let engine = makeSurvivalEngine();
  engine.applyOverlay({
    ...engine.getOverlay(),
    describeEvent: { omen: "A crow circles over {{ ctx.name }}." },
  });
  let snap = engine.snapshot();
  engine.restore(snap);
  assert.equal(
    engine.getOverlay().describeEvent?.omen,
    "A crow circles over {{ ctx.name }}.",
  );
});
