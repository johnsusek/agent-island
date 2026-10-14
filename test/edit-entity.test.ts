// The GM's edit_entity: rewrite a sign's words, move a stake's ownership tag.

import test from "node:test";
import assert from "node:assert/strict";

import { makeSurvivalEngine } from "./helpers.js";

test("edit_entity rewrites an inscription and swaps tags", () => {
  let engine = makeSurvivalEngine();
  engine.spawnEntity({
    id: "monument",
    kind: "sign",
    tags: ["sign", "ara"],
    text: "Here the founders swore.",
  });

  let edited = engine.editEntity("monument", {
    text: "Here the founders lied.",
    addTags: ["bo"],
    removeTags: ["ara"],
  });
  assert.equal(edited.text, "Here the founders lied.");
  assert.deepEqual([...edited.tags].sort(), ["bo", "sign"]);
  assert.ok(
    engine.recentGmEvents().some((e) => e.kind === "entity_edited"),
    "the edit is in the GM audit stream",
  );
});

test("edit_entity refuses an empty edit, a missing entity, and retired tags", () => {
  let engine = makeSurvivalEngine();
  assert.throws(() => engine.editEntity("nobody", { text: "x" }), /No entity/);
  engine.spawnEntity({ id: "post", kind: "sign", tags: [] });
  assert.throws(() => engine.editEntity("post", {}), /Nothing to edit/);
  assert.throws(
    () => engine.editEntity("post", { addTags: ["solid"] }),
    /occupancy/,
  );
});
