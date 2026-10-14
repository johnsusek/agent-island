// The augury scenario: lightning with a hidden law. Booted on the real world
// file, these pin its core: lightning strikes only someone carrying more fish
// than the living average, an offering needs the shrine and does nothing but
// burn one fish, fishing needs a shore, and the agent-facing description
// keeps the law secret.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createWorld } from "@agent-island/engine/engine";
import {
  createScenarioStore,
  scenarioBootScenario,
  scenarioFromWorldFile,
} from "../packages/mcp/src/index.js";

let dir = new URL("../config/scenarios", import.meta.url).pathname;
let base = scenarioFromWorldFile(
  JSON.parse(
    readFileSync(new URL("../config/config.json", import.meta.url), "utf8"),
  ),
  "config.json",
);
let augury = createScenarioStore(dir, dir).load("augury");

function boot(names: string[]) {
  let engine = createWorld(scenarioBootScenario(base, augury));
  engine.applyOverlay(augury.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

function entities(engine: ReturnType<typeof createWorld>) {
  return engine.getEntities() as Record<string, any>;
}

function stock(engine: ReturnType<typeof createWorld>, id: string, s: string) {
  return entities(engine)[id].stocks[s].value as number;
}

function gap(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

test("the description names lightning and the shrine, never the law", () => {
  let text = augury.description ?? "";
  assert.match(text, /lightning/i);
  assert.match(text, /shrine/i);
  assert.doesNotMatch(text, /average|more fish|most fish|count|carry/i);
  let offer = augury.overlay.dynamicRules.find((r: any) => r.id === "offer");
  assert.doesNotMatch(
    (offer as any).description,
    /average|protect|safe|lightning/i,
  );
});

test("lightning hunts the hoarder and never touches anyone at or below average", () => {
  let { engine, ids } = boot(["Hoarder", "Fair", "Poor"]);
  let [hoarder, fair, poor] = ids;
  let struck: Record<string, number> = {};
  let seen = new Set<string>();
  for (let i = 0; i < 400; i += 1) {
    // Pin the shares: 10 / 4 / 1 gives an average of 5, so only the hoarder
    // is above it, and Fair sits below. Keep everyone alive and fed.
    engine.setStock(hoarder, "fish", 10);
    engine.setStock(fair, "fish", 4);
    engine.setStock(poor, "fish", 1);
    for (let id of ids) {
      engine.setStock(id, "health", 100);
      engine.setStock(id, "satiation", 100);
    }
    engine.tick();
    for (let e of engine.recentEvents()) {
      let who = (e as any).agentId as string;
      let key = `${e.tick}:${e.type}:${who}`;
      if (e.type !== "struck" || seen.has(key)) continue;
      seen.add(key);
      struck[who] = (struck[who] ?? 0) + 1;
    }
  }
  let hits = struck[hoarder] ?? 0;
  assert.ok(hits >= 4 && hits <= 30, `hoarder struck ${hits} times in 400`);
  assert.equal(struck[fair] ?? 0, 0, "below average is never struck");
  assert.equal(struck[poor] ?? 0, 0, "far below average is never struck");
});

test("a strike burns 35 health, is heard by all, and stops the hoarder's hands", () => {
  let { engine, ids } = boot(["Hoarder", "Other"]);
  let [hoarder, other] = ids;
  engine.setStock(hoarder, "fish", 12);
  engine.setStock(other, "fish", 0);
  let event: any;
  for (let i = 0; i < 400 && !event; i += 1) {
    engine.setStock(hoarder, "health", 100);
    // Keep the hoarder busy walking, so we can see the strike stop them.
    if (!entities(engine)[hoarder].action)
      engine.commitIntent(hoarder, {
        type: "explore",
        direction: i % 20 < 10 ? "north" : "south",
      });
    engine.tick();
    event = engine
      .recentEvents()
      .find(
        (e: any) =>
          e.type === "struck" && e.tick === engine.getAdminState().tick,
      );
  }
  assert.ok(event, "struck within 400 ticks");
  assert.equal(event.agentId, hoarder);
  assert.equal(event.global, true);
  assert.match(event.text, /Lightning strikes Hoarder/);
  assert.ok(event.audience.includes(other), "the other hears it");
  let health = stock(engine, hoarder, "health");
  assert.ok(health <= 66 && health >= 64, `health ${health}`);
  assert.equal(entities(engine)[hoarder].action ?? null, null, "interrupted");
  assert.ok(
    engine
      .recentEvents()
      .some(
        (e: any) =>
          e.type === "action_abandoned" &&
          e.agentId === hoarder &&
          e.tick === event.tick,
      ),
    "the walk was abandoned",
  );
  assert.equal(stock(engine, hoarder, "calm"), 1, "marker clears same tick");
});

test("everyone equal: nobody is above the average, so nobody is struck", () => {
  let { engine, ids } = boot(["Ara", "Bo", "Cy"]);
  for (let i = 0; i < 300; i += 1) {
    for (let id of ids) engine.setStock(id, "satiation", 100);
    engine.tick();
  }
  assert.ok(!engine.recentEvents().some((e) => e.type === "struck"));
  for (let id of ids) assert.equal(stock(engine, id, "fish"), 3);
});

test("an offering needs the shrine and only burns one fish", () => {
  let { engine, ids } = boot(["Ara"]);
  let ara = ids[0];
  let shrine = entities(engine)["shrine"];
  assert.ok(shrine?.pos, "the shrine stands at camp");
  assert.ok(gap(shrine.pos, entities(engine)[ara].pos) <= 1);

  let before = { ...entities(engine)[ara].stocks };
  let health = before.health.value;
  engine.commitIntent(ara, { type: "offer" });
  engine.tick();
  let after = entities(engine)[ara].stocks;
  assert.equal(after.fish.value, before.fish.value - 1);
  assert.equal(after.health.value, health, "no other effect");
  assert.ok(engine.recentEvents().some((e) => e.type === "offering"));

  // With nothing to burn, the shrine refuses.
  engine.setStock(ara, "fish", 0);
  assert.throws(() => engine.commitIntent(ara, { type: "offer" }), /shrine/);

  // Away from the shrine an offering is not made where you stand: the
  // character walks back to the shrine first.
  engine.setStock(ara, "fish", 3);
  engine.commitIntent(ara, { type: "explore", direction: "north" });
  for (let i = 0; i < 6; i += 1) engine.tick();
  assert.ok(gap(shrine.pos, entities(engine)[ara].pos) > 1, "walked away");
  let result = engine.commitIntent(ara, { type: "offer" }) as any;
  assert.equal(result.approaching, true);
  engine.tick();
  assert.equal(stock(engine, ara, "fish"), 3, "nothing burned on the road");
});

test("fishing works from a shore and feeds", () => {
  let { engine, ids } = boot(["Ara"]);
  let ara = ids[0];
  let map = engine.getMap() as any;
  assert.ok(JSON.stringify(map).includes("water"), "the map has lakes");
  // Fishing walks to the nearest known shore by itself when out of reach,
  // then the character casts on arrival.
  engine.tick();
  engine.commitIntent(ara, { type: "fish" });
  for (let i = 0; i < 60 && entities(engine)[ara].action; i += 1) engine.tick();
  engine.commitIntent(ara, { type: "fish" });
  for (let i = 0; i < 4; i += 1) engine.tick();
  assert.equal(stock(engine, ara, "fish"), 4);
  engine.commitIntent(ara, { type: "eat" });
  engine.tick();
  assert.equal(stock(engine, ara, "fish"), 3);
});
