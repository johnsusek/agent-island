import test from "node:test";
import assert from "node:assert/strict";

import { createColony } from "../src/coordinator.js";
import { makeSurvivalEngine } from "./helpers.js";

// getDormantVerbs is the deterministic half of the Steward's "verb waiting on a
// noun" inference (docs deliverable 3): for each minted verb nobody has used, it
// names the nouns its `requires` gate asks for and splits them by whether the
// world can ever supply them. Genesis cb263000 minted `tame_animal` and
// `collect_from_companion` and never used either, because nothing in the world
// prompted or satisfied them - exactly what this surfaces.

function action(id: string, extra: Record<string, unknown>) {
  return {
    id,
    kind: "action",
    duration: 1,
    description: id,
    do: [{ adjust: { target: "food", by: 1 } }],
    ...extra,
  } as never;
}

// Age every minted rule past the grace window so it counts as dormant.
function agePastGrace(engine: ReturnType<typeof makeSurvivalEngine>) {
  for (let i = 0; i < 101; i += 1) engine.tick();
}

test("a verb requiring a kind nothing can make is a hard missing noun", () => {
  let engine = makeSurvivalEngine();
  engine.addRule(
    action("assemble_totem", { requires: { holds: { kind: "totem_core" } } }),
  );
  agePastGrace(engine);

  let dormant = engine.getDormantVerbs();
  let verb = dormant.verbs.find((v) => v.id === "assemble_totem");
  assert.ok(verb, "the unused verb is dormant");
  assert.deepEqual(verb.hardMissing, [{ ref: "totem_core", type: "kind" }]);
  assert.deepEqual(verb.absentButProducible, []);
});

test("a required kind another rule can spawn is a stalled chain, not a missing noun", () => {
  let engine = makeSurvivalEngine();
  // A rule that can produce "widget" exists, so widget is producible...
  engine.addRule(
    action("make_widget", {
      do: [{ spawn: { kind: "widget", tags: ["portable"] } }],
    }),
  );
  // ...but no widget instance is on the map, so a verb needing one is stalled.
  engine.addRule(
    action("polish_widget", { requires: { holds: { kind: "widget" } } }),
  );
  agePastGrace(engine);

  let verb = engine
    .getDormantVerbs()
    .verbs.find((v) => v.id === "polish_widget");
  assert.ok(verb);
  assert.deepEqual(verb.hardMissing, [], "producible, so not a missing noun");
  assert.deepEqual(verb.absentButProducible, [{ ref: "widget", type: "kind" }]);
});

test("a terrain no rule paints and the map lacks is a hard missing noun", () => {
  let engine = makeSurvivalEngine();
  engine.addRule(
    action("tap_lava", {
      requires: { nearTerrain: { type: "lava", range: 0 } },
    }),
  );
  agePastGrace(engine);

  let verb = engine.getDormantVerbs().verbs.find((v) => v.id === "tap_lava");
  assert.deepEqual(verb?.hardMissing, [{ ref: "lava", type: "terrain" }]);
});

test("a referent the world already satisfies is not reported as missing", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  // Every actor carries the `agent` tag, so a colocated-agent gate is satisfiable.
  engine.addRule(
    action("salute", { requires: { colocated: { tag: "agent", other: false } } }),
  );
  agePastGrace(engine);

  let verb = engine.getDormantVerbs().verbs.find((v) => v.id === "salute");
  assert.ok(verb, "still dormant - nobody used it");
  assert.deepEqual(verb.hardMissing, [], "the agent tag is present in the world");
  assert.deepEqual(verb.absentButProducible, []);
  assert.ok(engine.getObservation(ara).you, "the actor outlived the aging loop");
});

test("the verb's own spawn output is surfaced as a catalyst hint", () => {
  let engine = makeSurvivalEngine();
  engine.addRule(
    action("tame_beast", {
      requires: { nearTerrain: { type: "forest", range: 0 } },
      do: [{ spawn: { kind: "companion", tags: ["companion"] } }],
    }),
  );
  agePastGrace(engine);

  let verb = engine.getDormantVerbs().verbs.find((v) => v.id === "tame_beast");
  assert.deepEqual(verb?.spawns, ["companion"]);
});

test("missing nouns are ranked by how many dormant verbs each would unblock", () => {
  let engine = makeSurvivalEngine();
  engine.addRule(
    action("mine_ember", { requires: { holds: { kind: "ember" } } }),
  );
  engine.addRule(
    action("forge_ember", { requires: { holds: { kind: "ember" } } }),
  );
  engine.addRule(
    action("carve_idol", { requires: { holds: { kind: "idolstone" } } }),
  );
  agePastGrace(engine);

  // The bare test world also has the survival fixture's own unused actions in the
  // ranking, so assert on our nouns rather than absolute positions.
  let { missingNounLeverage } = engine.getDormantVerbs();
  let ember = missingNounLeverage.find((n) => n.ref === "ember");
  let idol = missingNounLeverage.find((n) => n.ref === "idolstone");
  assert.deepEqual(ember?.blocks.sort(), ["forge_ember", "mine_ember"]);
  assert.deepEqual(idol?.blocks, ["carve_idol"]);
  assert.ok(
    missingNounLeverage.indexOf(ember!) < missingNounLeverage.indexOf(idol!),
    "the shared noun ranks above the single-verb one",
  );
});

test("used, baseline, and just-minted verbs are not dormant", () => {
  let engine = makeSurvivalEngine();
  let ara = engine.addAgent("Ara").id;
  engine.addRule(action("used_verb", {}));
  engine.addRule(action("fresh_verb", { requires: { holds: { kind: "nothing" } } }));

  // Use one of them, then age.
  assert.ok(engine.commitIntent(ara, { type: "used_verb" }).accepted);
  agePastGrace(engine);
  // Mint another right at the end: it is inside the grace window.
  engine.addRule(action("brandnew_verb", { requires: { holds: { kind: "nothing" } } }));

  let ids = engine.getDormantVerbs().verbs.map((v) => v.id);
  assert.ok(!ids.includes("used_verb"), "a started verb is alive");
  assert.ok(!ids.includes("brandnew_verb"), "a just-minted verb is within grace");
  assert.ok(ids.includes("fresh_verb"), "an aged, unused verb is dormant");
});

test("inspect_world exposes the dormant report as an include section", () => {
  let colony = createColony({ engine: makeSurvivalEngine() });
  colony.start();
  colony.connect("gm");
  try {
    colony.joinAsGm("gm");
    let inspection = colony.gmInspect("gm", { include: ["dormant"] }) as any;
    assert.ok(Array.isArray(inspection.dormant.verbs), "verbs section present");
    assert.ok(
      Array.isArray(inspection.dormant.missingNounLeverage),
      "leverage rollup present",
    );
  } finally {
    colony.stop();
  }
});
