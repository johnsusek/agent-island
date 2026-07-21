import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEventJournal } from "../src/journal.js";

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  let dir = mkdtempSync(join(tmpdir(), "agent-island-journal-"));
  return Promise.resolve(fn(dir)).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

function event(seq: number, type = "said") {
  return { seq, tick: seq, type, text: `event ${seq}` };
}

function journalPath(dir: string) {
  return join(dir, "journal.jsonl");
}

test("a null dir disables the journal entirely", () => {
  let journal = createEventJournal(null);
  journal.open("w1", "survival");
  journal.command("ara", "act", 1, 0, [event(0)]);
  journal.tick(1, 1, [event(1)]);
  journal.flush();
  assert.deepEqual(journal.readEventsSince(0, 2).events, []);
  assert.equal(journal.health().status, "disabled");
});

test("genesis writes once; command records flush synchronously", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    journal.open("w1", "survival", { seed: 42 });
    journal.command("ara", "act", 1, 0, [event(0)]);

    let lines = readFileSync(journalPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).kind, "genesis");
    assert.equal(JSON.parse(lines[0]).seed, 42);
    let commandRecord = JSON.parse(lines[1]);
    assert.equal(commandRecord.kind, "command");
    assert.equal(commandRecord.actor, "ara");
    assert.equal(commandRecord.verb, "act");
    assert.equal(commandRecord.events.length, 1);
  }));

test("a command with no events is not written", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    journal.open("w1", "survival");
    journal.command("ara", "look", 1, 0, []);

    let lines = readFileSync(journalPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 1); // genesis only
  }));

test("tick records buffer and flush on demand", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    journal.open("w1", "survival");
    journal.tick(1, 0, [event(0)]);
    journal.tick(2, 1, [event(1)]);

    // Still buffered - only genesis on disk so far.
    assert.equal(
      readFileSync(journalPath(dir), "utf8").trim().split("\n").length,
      1,
    );

    journal.flush();
    let lines = readFileSync(journalPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[1]).kind, "tick");
    assert.equal(JSON.parse(lines[2]).kind, "tick");
  }));

test("a command flushes any buffered tick records first, preserving seq order", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    journal.open("w1", "survival");
    journal.tick(1, 0, [event(0)]);
    journal.command("ara", "act", 2, 1, [event(1)]);

    let events = journal.readEventsSince(0, 2).events;
    assert.deepEqual(
      events.map((e) => e.seq),
      [0, 1],
    );
  }));

test("readEventsSince filters to seq >= cursor across records", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    journal.open("w1", "survival");
    journal.command("ara", "act", 1, 0, [event(0), event(1)]);
    journal.tick(2, 2, [event(2), event(3)]);
    journal.flush();

    let events = journal.readEventsSince(2, 4).events;
    assert.deepEqual(
      events.map((e) => e.seq),
      [2, 3],
    );
  }));

test("opening a different worldId starts the journal over", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    journal.open("w1", "survival");
    journal.command("ara", "act", 1, 0, [event(0)]);
    // The file belongs to w1; a new world must not resume it. (In the live
    // server delete() runs first - this covers the crash-between path.)
    journal.open("w2", "survival", { seed: 7 });

    let lines = readFileSync(journalPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    let genesis = JSON.parse(lines[0]);
    assert.equal(genesis.kind, "genesis");
    assert.equal(genesis.worldId, "w2");
    assert.equal(genesis.seed, 7);
    assert.deepEqual(journal.readEventsSince(0, 1).events, []);
  }));

test("delete drops buffered records and removes the file", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    journal.open("w1", "survival");
    journal.command("ara", "act", 1, 0, [event(0)]);
    journal.tick(2, 1, [event(1)]); // still buffered
    journal.delete();

    assert.ok(!existsSync(journalPath(dir)), "file removed");
    assert.deepEqual(journal.readEventsSince(0, 1).events, []);

    // A fresh world boots cleanly after the delete, counter back at 0.
    journal.open("w2", "survival");
    journal.command("ara", "act", 1, 0, [event(5)]);
    let lines = readFileSync(journalPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).worldId, "w2");
    assert.equal(JSON.parse(lines[1]).n, 1);
  }));

test("deleting a never-opened journal is a no-op", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    assert.doesNotThrow(() => journal.delete());
  }));

test("re-opening the same worldId resumes the monotonic record counter", () =>
  withTempDir((dir) => {
    let first = createEventJournal(dir);
    first.open("w1", "survival");
    first.command("ara", "act", 1, 0, [event(0)]);
    first.command("ara", "speak", 2, 1, [event(1)]);
    first.stop();

    let second = createEventJournal(dir);
    second.open("w1", "survival"); // resumes, does not rewrite genesis
    second.command("ara", "act", 3, 2, [event(2)]);

    let lines = readFileSync(journalPath(dir), "utf8").trim().split("\n");
    assert.equal(lines.length, 4); // genesis + 3 commands, no duplicate genesis
    let ns = lines.slice(1).map((line) => JSON.parse(line).n);
    assert.deepEqual(ns, [1, 2, 3]); // strictly increasing across the restart
  }));

test("a truncated trailing record is ignored and repaired on resume", () =>
  withTempDir((directory) => {
    let first = createEventJournal(directory);
    first.open("w1", "survival");
    first.command("ara", "act", 1, 0, [event(0)]);
    appendFileSync(journalPath(directory), '{"kind":"command","n":2');

    assert.deepEqual(
      first.readEventsSince(0, 1).events.map((item) => item.seq),
      [0],
      "valid history remains readable",
    );

    let resumed = createEventJournal(directory);
    resumed.open("w1", "survival");
    resumed.command("ara", "speak", 2, 1, [event(1)]);

    let records = readFileSync(journalPath(directory), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records.slice(1).map((record) => record.n),
      [1, 2],
    );
  }));

test("stop() flushes pending tick records", () =>
  withTempDir((dir) => {
    let journal = createEventJournal(dir);
    journal.open("w1", "survival");
    journal.tick(1, 0, [event(0)]);
    journal.stop();

    let events = journal.readEventsSince(0, 1).events;
    assert.deepEqual(
      events.map((e) => e.seq),
      [0],
    );
  }));

test("startup removes journal events beyond the authoritative cursor", () =>
  withTempDir((directory) => {
    let first = createEventJournal(directory);
    first.open("w1", "survival");
    first.command("ara", "speak", 1, 0, [{ ...event(0), text: "ghost" }]);

    let resumed = createEventJournal(directory);
    resumed.open("w1", "survival", { cursor: 0, events: [] });
    resumed.command("ara", "speak", 1, 0, [{ ...event(0), text: "committed" }]);

    let read = resumed.readEventsSince(0, 1);
    assert.deepEqual(
      read.events.map((item) => item.text),
      ["committed"],
    );
    assert.deepEqual(read.unavailable, []);
  }));

test("startup backfills a missing journal tail from authoritative events", () =>
  withTempDir((directory) => {
    let first = createEventJournal(directory);
    first.open("w1", "survival");
    first.command("ara", "act", 1, 0, [event(0)]);

    let resumed = createEventJournal(directory);
    resumed.open("w1", "survival", {
      cursor: 3,
      events: [event(0), event(1), event(2)],
    });

    let read = resumed.readEventsSince(0, 3);
    assert.deepEqual(
      read.events.map((item) => item.seq),
      [0, 1, 2],
    );
    assert.deepEqual(read.unavailable, []);
    assert.equal(resumed.health().status, "healthy");
    resumed.command("ara", "act", 4, 3, [event(3)]);
    let records = readFileSync(journalPath(directory), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.kind === "recovery"));
    assert.deepEqual(
      records.slice(1).map((record) => record.n),
      [1, 2, 3],
    );
  }));

test("startup reports a history gap older than the retained authoritative log", () =>
  withTempDir((directory) => {
    let first = createEventJournal(directory);
    first.open("w1", "survival");
    first.command("ara", "act", 1, 0, [event(0)]);

    let resumed = createEventJournal(directory);
    resumed.open("w1", "survival", {
      cursor: 4,
      events: [event(3)],
    });

    let read = resumed.readEventsSince(0, 4);
    assert.deepEqual(
      read.events.map((item) => item.seq),
      [0, 3],
    );
    assert.deepEqual(read.unavailable, [{ from: 1, to: 3 }]);
    assert.deepEqual(resumed.health(), {
      status: "degraded",
      writable: true,
      gaps: [{ from: 1, to: 3 }],
    });
  }));

test("a command append failure degrades the journal without escaping", () =>
  withTempDir((directory) => {
    let journal = createEventJournal(directory, {
      append() {
        throw new Error("simulated EIO");
      },
    });
    journal.open("w1", "survival");

    assert.doesNotThrow(() => journal.command("ara", "act", 1, 0, [event(0)]));
    assert.deepEqual(journal.health(), {
      status: "degraded",
      writable: false,
      error: "simulated EIO",
      gaps: [{ from: 0, to: null }],
    });
  }));

test("an asynchronous tick flush failure cannot escape its timer", async () =>
  withTempDir(async (directory) => {
    let journal = createEventJournal(directory, {
      append() {
        throw new Error("timer EIO");
      },
    });
    journal.open("w1", "survival");
    journal.tick(1, 0, [event(0)]);

    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(journal.health().status, "degraded");
    assert.equal(journal.health().error, "timer EIO");
  }));
