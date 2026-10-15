// The herd scenario: one wandering herd on a huge fogged map, and the only
// meat. Booted on the real world file, these pin its core: the map is the
// declared size, the herd starts far from camp, drifts when left alone, bolts
// from a lone hunter, holds still between two hunters on opposite sides, and
// can only be hunted by two people beside it at once.

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
let herdScenario = createScenarioStore(dir, dir).load("herd");

type Engine = ReturnType<typeof createWorld>;
type Pos = { x: number; y: number };

function boot(names: string[]) {
  let engine = createWorld(scenarioBootScenario(base, herdScenario));
  engine.applyOverlay(herdScenario.overlay);
  let ids = names.map((n) => engine.addAgent(n).id);
  return { engine, ids };
}

function entities(engine: Engine) {
  return engine.getEntities() as Record<string, any>;
}

function herd(engine: Engine) {
  let found = Object.values(entities(engine)).filter((e) => e.kind === "herd");
  assert.equal(found.length, 1, "exactly one herd");
  return found[0];
}

function gap(a: Pos, b: Pos) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

// Test-only staging: teleport entities to fixed tiles in open country with a
// one-shot world rule, so a chase starts from a known geometry.
function place(engine: Engine, spots: Record<string, Pos>) {
  engine.addRule({
    id: "test-place",
    phase: "transition",
    when: { cmp: "gte", left: { tick: true }, right: 0 },
    do: Object.entries(spots).map(([id, to]) => ({ moveTo: { of: id, to } })),
  } as any);
  engine.tick();
  engine.removeRule("test-place");
  for (let [id, to] of Object.entries(spots))
    assert.deepEqual(entities(engine)[id].pos, to, `${id} placed`);
}

// Walk each hunter toward the herd; once beside it, try to hunt.
function chase(engine: Engine, hunters: string[], ticks: number) {
  let closest = Infinity;
  for (let i = 0; i < ticks; i += 1) {
    for (let id of hunters) {
      let me = entities(engine)[id];
      if (me.action?.type === "hunt") continue;
      if (gap(me.pos, herd(engine).pos) <= 1) {
        try {
          engine.commitIntent(id, { type: "hunt" });
          continue;
        } catch {}
      }
      // Right after staging the herd is not yet in the hunter's fog; the
      // next tick's sight pass discovers it.
      if (!me.action)
        try {
          engine.commitIntent(id, {
            type: "travel",
            location: herd(engine).id,
          });
        } catch {}
    }
    engine.tick();
    for (let id of hunters)
      closest = Math.min(
        closest,
        gap(entities(engine)[id].pos, herd(engine).pos),
      );
  }
  return closest;
}

const CENTER = { x: 48, y: 48 };

test("a 64x64 fogged map with the herd far from camp", () => {
  let { engine, ids } = boot(["Ara"]);
  let map = engine.getMap() as { width: number; height: number };
  assert.equal(map.width, 64);
  assert.equal(map.height, 64);
  let ara = entities(engine)[ids[0]];
  assert.ok(gap(herd(engine).pos, ara.pos) >= 20, "far beyond sight");
  assert.equal(herd(engine).stocks.meat.value, 12);
  let roots = Object.values(entities(engine)).filter((e) => e.kind === "roots");
  assert.ok(roots.length >= 10, `${roots.length} root patches`);
});

test("left alone, the herd drifts", () => {
  let { engine } = boot(["Ara"]);
  let start = { ...herd(engine).pos };
  let moves = 0;
  let last = { ...start };
  for (let i = 0; i < 60; i += 1) {
    engine.tick();
    let now = herd(engine).pos;
    assert.ok(gap(now, last) <= 1, "grazing steps are single tiles");
    if (gap(now, last) > 0) moves += 1;
    last = { ...now };
  }
  assert.ok(moves >= 5, `drifted ${moves} times in 60 ticks`);
});

test("the herd bolts from a lone hunter, who never closes in", () => {
  let { engine, ids } = boot(["Ara"]);
  let [ara] = ids;
  place(engine, {
    [herd(engine).id]: CENTER,
    [ara]: { x: CENTER.x - 6, y: CENTER.y + 1 },
  });
  let closest = chase(engine, [ara], 20);
  assert.ok(closest >= 2, `the lone hunter got within ${closest}`);
  assert.ok(
    gap(herd(engine).pos, CENTER) >= 10,
    "the herd ran a long way from where it was found",
  );
  assert.equal(entities(engine)[ara].stocks.meat.value, 1, "no meat alone");
});

test("two hunters closing from opposite sides pin the herd and bring it down", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  place(engine, {
    [herd(engine).id]: CENTER,
    [ara]: { x: CENTER.x - 6, y: CENTER.y },
    [bo]: { x: CENTER.x + 6, y: CENTER.y },
  });
  chase(engine, [ara, bo], 20);
  assert.ok(
    gap(herd(engine).pos, CENTER) <= 3,
    "pinned between them, the herd barely moved",
  );
  let ate = (id: string) => entities(engine)[id].stocks.meat.value - 1;
  assert.ok(ate(ara) >= 3, `Ara took ${ate(ara)} meat`);
  assert.ok(ate(bo) >= 3, `Bo took ${ate(bo)} meat`);
  assert.ok(
    herd(engine).stocks.meat.value <= 12 + 0.05 * 21 - ate(ara) - ate(bo),
    "the meat came from the herd",
  );
  assert.ok(engine.recentEvents().some((e) => e.type === "kill"));
});

test("hunting is refused alone and works with two beside the herd", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  // Freeze the herd so this pins only the hunt gate.
  engine.removeRule("herd-flees");
  engine.removeRule("herd-drifts");
  place(engine, {
    [herd(engine).id]: CENTER,
    [ara]: { x: CENTER.x - 1, y: CENTER.y },
    [bo]: { x: CENTER.x + 8, y: CENTER.y },
  });
  assert.throws(
    () => engine.commitIntent(ara, { type: "hunt" }),
    /one hunter alone/,
  );

  place(engine, { [bo]: { x: CENTER.x + 1, y: CENTER.y + 1 } });
  engine.commitIntent(ara, { type: "hunt" });
  for (let i = 0; i < 3; i += 1) engine.tick();
  assert.equal(entities(engine)[ara].stocks.meat.value, 4);
  assert.equal(entities(engine)[bo].stocks.meat.value, 1, "only the hunter");
  assert.ok(Math.abs(herd(engine).stocks.meat.value - 9) < 0.5);

  engine.commitIntent(ara, { type: "eat", food: "meat" });
  engine.tick();
  assert.equal(entities(engine)[ara].stocks.meat.value, 3);
});

test("two diggers at a one-root patch: one gets it, the other's dig fizzles cleanly", () => {
  let { engine, ids } = boot(["Ara", "Bo"]);
  let [ara, bo] = ids;
  let patch = Object.values(entities(engine)).find(
    (e) => e.kind === "roots" && e.pos.x > 2 && e.pos.y > 2,
  );
  place(engine, {
    [ara]: { x: patch.pos.x - 1, y: patch.pos.y },
    [bo]: { x: patch.pos.x + 1, y: patch.pos.y },
  });
  engine.setStock(patch.id, "roots", 1);
  engine.commitIntent(ara, { type: "dig" });
  engine.commitIntent(bo, { type: "dig" });
  let seen: any[] = [];
  for (let i = 0; i < 3; i += 1) {
    engine.tick();
    seen.push(...engine.recentEvents());
  }
  let dug = [ara, bo].map((id) => entities(engine)[id].stocks.roots.value);
  assert.deepEqual(dug.sort(), [2, 3], "2 at start each; exactly one root dug");
  assert.ok(!seen.some((e) => e.type === "rule_error"), "no rule error");
});
