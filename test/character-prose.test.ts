// The character surface is prose-only: content[].text is the whole message and
// there is no structuredContent twin behind it. So every fact a player needs
// must survive the renderer, and no result may fall back to serialized data.

import assert from "node:assert/strict";
import test from "node:test";

import { createColony } from "../src/coordinator.js";
import { survivalBoot } from "./helpers.js";
import { renderCharacterResult } from "../src/sense-prose.js";

function withColony(fn: (colony: any) => void | Promise<void>) {
  let colony = createColony({
    statePath: null,
    rulesPath: null,
    waitTimeoutMs: 2000,
    ...survivalBoot,
  });
  colony.start();
  colony.connect("s");
  colony.connect("t");
  return Promise.resolve(fn(colony)).finally(() => colony.stop());
}

// The join briefing used to ride in structuredContent; prose has to carry it
// now, or a fresh spawn whose client ignores MCP instructions learns nothing.
test("a fresh join renders its envelope and the briefing", () =>
  withColony((colony) => {
    let text = renderCharacterResult(colony.join("s", "Ara"));
    assert.match(text, /^\[joined\] Tick 0\. You are Ara/);
    assert.match(text, /# Agent Island - agent briefing/);
  }));

test("order tools read their order back in words", () =>
  withColony((colony) => {
    colony.join("s", "Ara");

    let ordered = renderCharacterResult(
      colony.setOrder("s", {
        kind: "repeat",
        action: { type: "explore", direction: "north" },
        maxRepeats: 3,
      }),
    );
    assert.match(ordered, /^\[ordered\] repeat explore\(direction:north\)/);
    assert.match(ordered, /running/);

    assert.match(
      renderCharacterResult(colony.getOrder("s")),
      /^Standing order: repeat explore/,
    );

    // The wake envelope already carries the order line - the receipt must not
    // say it a second time.
    let cancelled = renderCharacterResult(colony.cancelOrder("s"));
    assert.equal(cancelled.match(/repeat explore/g)?.length, 1);
    assert.match(cancelled, /cancelled/);
  }));

test("an idle character is told it has no order, not given an empty field", () =>
  withColony((colony) => {
    colony.join("s", "Ara");
    assert.equal(
      renderCharacterResult(colony.getOrder("s")),
      "You have no standing order.",
    );
  }));

// heardBy/to/sign live only in the result - the observation can't say them.
test("speech results say who received them", () =>
  withColony((colony) => {
    colony.join("s", "Ara");
    assert.match(
      renderCharacterResult(colony.speak("s", "anyone there?")),
      /No one was in earshot/,
    );

    colony.join("t", "Bren");
    assert.match(
      renderCharacterResult(colony.speak("s", "hello Bren")),
      /Heard by Bren\./,
    );
    assert.match(
      renderCharacterResult(colony.whisper("s", "bren", "psst")),
      /Whispered to bren\./,
    );
    assert.match(
      renderCharacterResult(colony.inscribe("s", "here lies stone")),
      /You write on sign-1\./,
    );
  }));

test("leaving names the body it released", () =>
  withColony((colony) => {
    colony.join("s", "Ara");
    assert.match(renderCharacterResult(colony.leave("s")), /^\[left\] ara/);
  }));

test("errors come back as sentences", () => {
  assert.equal(
    renderCharacterResult({ error: "No agent named nobody." }),
    "error: No agent named nobody.",
  );
});

// The regression that matters: no character result may render as data. Braces
// and bracket-quote pairs are the tell - the briefing (which documents order
// JSON on purpose) is the one sanctioned exception, so it is excluded here.
test("no character result renders as serialized data", () =>
  withColony(async (colony) => {
    let joined = colony.join("s", "Ara");
    colony.join("t", "Bren");
    let results = [
      { ...joined, briefing: undefined },
      colony.setOrder("s", {
        kind: "sequence",
        steps: [{ type: "explore", direction: "north" }],
      }),
      colony.getOrder("s"),
      colony.cancelOrder("s"),
      colony.speak("s", "hello"),
      colony.whisper("s", "bren", "psst"),
      colony.inscribe("s", "a warning"),
      colony.sense("s", "situation"),
      colony.sense("s", "changes"),
      // Bren speaking leaves something unseen, so the park returns at once
      // instead of hanging on the turn barrier.
      colony.speak("t", "over here"),
      await colony.waitForChange("s"),
      colony.leave("s"),
    ];
    for (let result of results) {
      let text = renderCharacterResult(result);
      assert.doesNotMatch(text, /[{}]/, `braces in: ${text.slice(0, 120)}`);
      assert.doesNotMatch(
        text,
        /"\w+":/,
        `JSON keys in: ${text.slice(0, 120)}`,
      );
    }
  }));

// The action menu never reaches a character as data (prose-only surface), so
// the wake renderer has to carry it. A wake without this block leaves an agent
// guessing verb names and bumping into blocked orders.
function wake(actions: any[], tick = 4) {
  return renderCharacterResult({
    status: "changed",
    observation: {
      tick,
      you: { name: "Ara", alive: true, stocks: {} },
      availableActions: actions,
    },
  });
}

test("a wake lists what you can do, with the args valid from here", () => {
  let text = wake([
    { name: "rest", applicable: true },
    {
      name: "travel",
      applicable: true,
      paramOptions: { location: ["berry-thicket", "forest"] },
    },
    // An entity target carries its own label; the player needs the word.
    {
      name: "give",
      applicable: true,
      paramOptions: { to: [{ id: "bren", label: "Bren" }] },
    },
  ]);
  assert.match(
    text,
    /You can: rest, travel\(location: berry-thicket\|forest\), give\(to: Bren\)\./,
  );
});

test("a new action surfaces above the blocked list, with its description", () => {
  let text = wake([
    { name: "rest", applicable: true },
    {
      name: "build",
      applicable: false,
      isNew: true,
      description: "raise a shelter",
    },
  ]);
  assert.match(text, /New: build - raise a shelter\./);
  // A new action is a "reconsider" signal, not routine churn - it must not be
  // filed away in the blocked line.
  assert.doesNotMatch(text, /Blocked here:/);
});

test("blocked reasons ride the teaching window, then slim to names", () => {
  // `description` is the engine's teaching-window marker: present on the first
  // observation, gone on later slim wakes. The reason follows it.
  let taught = wake([
    { name: "rest", applicable: true },
    {
      name: "gather_stone",
      applicable: false,
      unavailableReason: "stand at a stone outcrop",
      description: "chip stone from an outcrop",
    },
  ]);
  assert.match(
    taught,
    /Blocked here: gather_stone \(stand at a stone outcrop\)\./,
  );

  let slim = wake([
    { name: "rest", applicable: true },
    {
      name: "gather_stone",
      applicable: false,
      unavailableReason: "stand at a stone outcrop",
    },
  ]);
  assert.match(slim, /Blocked here: gather_stone\./);
  assert.doesNotMatch(slim, /stand at a stone outcrop/);
});

// Which gauge is in trouble is not a per-stock choice: every vital reads up
// as good, so low is always dire, and the renderer never needs to know what
// any stock is called to say so. A world whose vitality is called `integrity`
// reads exactly the same as one that calls it health.
test("the vitals alarm reads low as dire, whatever the stock is called", () => {
  let render = (stocks: any, display: any) =>
    renderCharacterResult({
      sense: "situation",
      tick: 3,
      you: { name: "Bex", stocks, alive: true },
      display,
    });

  assert.match(
    render(
      { warmth: { value: 4, min: 0, max: 100 } },
      { warmth: { role: "vital" } },
    ),
    /Your warmth is critical\./,
    "a vital near its floor is dire",
  );
  assert.match(
    render(
      { integrity: { value: 8, min: 0, max: 100 } },
      { integrity: { role: "vital" } },
    ),
    /Your integrity is critical\./,
    "the alarm never depended on the stock being called health",
  );
  // A full gauge reads as well - the renderer never needs a direction to
  // guess at, only the fraction.
  assert.match(
    render(
      { warmth: { value: 96, min: 0, max: 100 } },
      { warmth: { role: "vital" } },
    ),
    /You are well\./,
  );
});

// A figure is a decision input for "is it worth it" and a distraction for "when
// do I act". Vitals lost their numbers; the pack kept them.
test("vitals speak in bands while the pack still counts", () => {
  let text = renderCharacterResult({
    sense: "situation",
    tick: 3,
    you: {
      name: "Bex",
      alive: true,
      stocks: {
        warmth: { value: 8, min: 0, max: 100 },
        food: { value: 2, min: 0, max: 5 },
        wood: { value: 0, min: 0, max: 5 },
      },
    },
    display: {
      warmth: { role: "vital" },
      food: { role: "pack" },
      wood: { role: "pack" },
    },
  });

  assert.doesNotMatch(text, /\b8\b|\/100/, "no vital ever shows a figure");
  assert.match(text, /Carrying: food 2\/5\./);
  assert.doesNotMatch(text, /wood/, "an empty pack slot is not worth a word");
});

// A scenario's own words for its own pressures beat any default this layer
// could invent - that is the whole reason bands are authored data.
test("an authored band sentence wins over the generic one", () => {
  let text = renderCharacterResult({
    sense: "situation",
    tick: 3,
    you: {
      name: "Bex",
      alive: true,
      stocks: { satiation: { value: 4, min: 0, max: 100 } },
    },
    display: {
      satiation: {
        role: "vital",
        bands: { critical: "You are starving. Eat now." },
      },
    },
  });

  assert.match(text, /You are starving\. Eat now\./);
  assert.doesNotMatch(text, /is critical/);
});

// A stat (role: "stat") is the personal-dimension sibling of a vital: adjectival
// prose only when it's in a band, silent otherwise, and - like a vital, unlike
// pack - never a bare figure.
test("a stat speaks adjectivally when banded, and never shows a figure", () => {
  let text = renderCharacterResult({
    sense: "situation",
    tick: 3,
    you: {
      name: "Bex",
      alive: true,
      stocks: { courage: { value: 8, min: 0, max: 100 } },
    },
    display: {
      courage: { role: "stat" },
    },
  });

  assert.match(text, /Your courage is/);
  assert.doesNotMatch(text, /\b8\b|\/100/, "a stat never shows a figure");
});

test("a stat stays silent when it's not in a band", () => {
  let text = renderCharacterResult({
    sense: "situation",
    tick: 3,
    you: {
      name: "Bex",
      alive: true,
      stocks: { courage: { value: 90, min: 0, max: 100 } },
    },
    display: {
      courage: { role: "stat" },
    },
  });

  assert.doesNotMatch(text, /courage/i, "a fine stat earns no line at all");
});

test("a stat is excluded from the Carrying line even when it isn't banded", () => {
  let text = renderCharacterResult({
    sense: "situation",
    tick: 3,
    you: {
      name: "Bex",
      alive: true,
      stocks: {
        courage: { value: 90, min: 0, max: 100 },
        wood: { value: 4, min: 0, max: 10 },
      },
    },
    display: {
      courage: { role: "stat" },
      wood: { role: "pack" },
    },
  });

  assert.match(text, /Carrying: wood 4\/10\./);
  assert.doesNotMatch(text, /courage/i);
});
