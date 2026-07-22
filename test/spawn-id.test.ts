import assert from "node:assert/strict";
import test from "node:test";

import { makeSurvivalEngine, placeAt, runToIdle } from "./helpers.js";

// Genesis run cc3d1956: the Oracle minted build-shelter with
// `spawn.id: "shelter-{{self}}-{{tick}}"`, and the substrate used that string
// verbatim. One entity was created, literally named "shelter-{{self}}-{{tick}}";
// the second builder passed the gate, paid 5 stone, and hit "already exists".
// The braces then leaked into character-facing prose ("Cygnus arrives at
// shelter-{{self}}-{{tick}}") and both characters started routing to the broken
// name as if it were a landmark.
//
// The Oracle reaches for this syntax because `{{ ... }}` renders everywhere else
// in the system, so the fix makes the reflex work rather than training it away.

function addBuildRule(
  engine: ReturnType<typeof makeSurvivalEngine>,
  id: string,
) {
  engine.addRule({
    id: "build-shelter",
    kind: "action",
    duration: 1,
    do: [
      {
        spawn: { id, kind: "shelter", at: "self", occupancy: "tile" },
      },
    ],
  });
}

test("{{self}} and {{tick}} render inside a spawn id", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  addBuildRule(engine, "shelter-{{self}}-{{tick}}");

  engine.commitIntent(ara, { type: "build-shelter" });
  runToIdle(engine, ara);

  let ids = Object.keys(engine.getEntities());
  assert.ok(
    !ids.some((i) => i.includes("{{")),
    `no entity should carry raw braces, got ${JSON.stringify(ids.filter((i) => i.includes("shelter")))}`,
  );
  assert.ok(
    ids.some((i) => i.startsWith(`shelter-${ara}-`)),
    "the id names its builder",
  );
});

// The failure the run actually hit: two builders, one law, and the second one
// charged for an error.
test("two builders each get their own structure", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  let bo = engine.addAgent("Bo").id;
  addBuildRule(engine, "shelter-{{self}}-{{tick}}");

  // Apart, so neither build is refused for standing on the other's ground.
  placeAt(engine, ara, 5, 5);
  placeAt(engine, bo, 12, 12);

  engine.commitIntent(ara, { type: "build-shelter" });
  runToIdle(engine, ara);
  engine.commitIntent(bo, { type: "build-shelter" });
  runToIdle(engine, bo);

  let shelters = Object.values(engine.getEntities()).filter(
    (e: any) => e.kind === "shelter",
  );
  assert.equal(shelters.length, 2, "one shelter per builder, not a singleton");
});

// A typo'd placeholder would otherwise bake itself into a key nothing can
// address, which is the silent-corruption failure all over again.
test("an unknown placeholder in a spawn id is refused, not baked in", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  addBuildRule(engine, "shelter-{{owner}}");

  engine.commitIntent(ara, { type: "build-shelter" });
  runToIdle(engine, ara);

  let error = engine
    .recentEvents()
    .find((e) => e.type === "rule_error" && /owner/.test(e.text ?? ""));
  assert.ok(error, "the bad placeholder surfaced as a rule error");
  assert.ok(
    !Object.keys(engine.getEntities()).some((i) => i.includes("{{")),
    "and nothing with braces reached the world",
  );
});

// Shape-level authoring check: a constant id is legal (some things there is
// genuinely one of) but for a build verb it is the singleton trap, so the
// Oracle hears about it at mint time rather than at the second builder.
test("a build action with a fixed spawn id is flagged at dry run", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  addBuildRule(engine, "shelter");

  assert.ok(
    engine
      .dryRunRule("build-shelter")
      .warnings.some((w) => /only one can ever exist/.test(w)),
  );
});

// Two structures can never share a square, which is why "a fire inside the
// shelter" was unbuildable in cc3d1956. A note, not a warning - building on
// open ground is the normal case.
test("a ground-holding spawn at self notes the one-structure-per-tile rule", () => {
  let engine = makeSurvivalEngine();
  engine.addAgent("Ara");
  addBuildRule(engine, "shelter-{{self}}-{{tick}}");

  assert.ok(
    engine
      .dryRunRule("build-shelter")
      .notes.some((n) => /nothing else can be built there/.test(n)),
  );
});
