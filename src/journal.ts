import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { GameEvent } from "./rules/engine.js";

// Append-only JSONL log of the live world's events, queryable by cursor/seq
// range. Backs `sense`'s "changes since your cursor" once a request falls
// outside the in-memory event ring or across a restart. It is NOT the source
// of truth for world state - state.json stays authoritative for that - and it
// is never replayed into the engine. See docs/v2-event-journal-plan.md.
//
// One file, one world: the journal belongs to the world state.json holds.
// A reset deletes it along with the rest of the state; boot() starts it over.

export interface GenesisRecord {
  kind: "genesis";
  v: 1;
  worldId: string;
  scenario: string;
  seed?: number;
  at: number;
}

export interface CommandRecord {
  kind: "command";
  n: number;
  id: string;
  tick: number;
  seq: number; // cursor before this command's events
  actor: string | null;
  verb: string;
  events: GameEvent[];
  at: number;
}

export interface TickRecord {
  kind: "tick";
  n: number;
  tick: number;
  seq: number; // cursor before this tick's events
  events: GameEvent[];
}

export interface RecoveryRecord {
  kind: "recovery";
  n: number;
  seq: number;
  events: GameEvent[];
}

export type JournalRecord =
  GenesisRecord | CommandRecord | TickRecord | RecoveryRecord;

interface ParsedJournal {
  records: JournalRecord[];
  malformedTail: boolean;
}

function parseJournal(raw: string): ParsedJournal {
  let lines = raw.split("\n");
  let records: JournalRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (!line) continue;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch (error) {
      let hasLaterRecord = lines
        .slice(index + 1)
        .some((later) => later.trim().length > 0);
      if (hasLaterRecord) throw error;
      return { records, malformedTail: true };
    }
  }
  return { records, malformedTail: false };
}

export interface EventJournal {
  // Open the journal for a world. If the file on disk already belongs to this
  // worldId (a server restart), the monotonic record counter resumes; a file
  // for any other world is leftover state and is started over.
  open(worldId: string, scenario: string, options?: JournalOpenOptions): void;
  // Record the events produced by a single actor-driven command. A no-op
  // (nothing written) when there are no events, so free reads and no-op
  // commands don't bloat the file.
  command(
    actor: string | null,
    verb: string,
    tick: number,
    seqBefore: number,
    events: GameEvent[],
    at?: number,
  ): void;
  // Record the events produced by a single tick. Buffered and flushed on a
  // short timer (or the next command/delete/stop), never held across ticks.
  tick(tick: number, seqBefore: number, events: GameEvent[]): void;
  // Drop any buffered records and remove the file - the journal is state,
  // and this is its half of "delete all state". boot() re-opens it after.
  delete(): void;
  // Flush buffered records and move the file to `target` instead of deleting
  // it - the run-archive half of a reset. Leaves the journal in the same
  // closed state delete() does, so boot() re-opens fresh either way. Returns
  // whether a file was actually moved.
  archiveTo(target: string): boolean;
  // Force any buffered tick records to disk.
  flush(): void;
  // Flush and release the flush timer, for a clean shutdown.
  stop(): void;
  // Read every journalled event with seq >= cursor, in order. Used only as
  // the fallback when a diff request's cursor predates the in-memory ring's
  // oldest retained event.
  readEventsSince(cursor: number, until: number): JournalReadResult;
  health(): JournalHealth;
}

export interface JournalOpenOptions {
  seed?: number;
  at?: number;
  cursor?: number;
  events?: GameEvent[];
}

export interface JournalGap {
  from: number;
  to: number | null;
}

export interface JournalReadResult {
  events: GameEvent[];
  unavailable: JournalGap[];
}

export interface JournalHealth {
  status: "disabled" | "healthy" | "degraded";
  writable: boolean;
  error?: string;
  gaps: JournalGap[];
}

export interface JournalStorage {
  append(path: string, data: string): void;
  exists(path: string): boolean;
  mkdir(path: string): void;
  read(path: string): string;
  remove(path: string): void;
  rename(from: string, to: string): void;
  write(path: string, data: string): void;
}

// How long a burst of same-tick events (order continuations, terrain rules)
// may sit buffered before hitting disk. Short enough that a crash loses at
// most a sliver of a single tick, long enough to coalesce a fast-forward
// burst into one write.
const TICK_FLUSH_DELAY_MS = 25;

// A null directory disables the journal entirely (matches the statePath/
// rulesPath null-disables-persistence convention elsewhere in the coordinator).
export function createEventJournal(
  dir: string | null,
  overrides: Partial<JournalStorage> = {},
): EventJournal {
  let storage: JournalStorage = {
    append: appendFileSync,
    exists: existsSync,
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    read: (path) => readFileSync(path, "utf8"),
    remove: unlinkSync,
    rename: renameSync,
    write: writeFileSync,
    ...overrides,
  };
  let recordNumber = 0;
  let file: string | null = null;
  let pending: TickRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writable = Boolean(dir);
  let lastError: string | null = null;
  let gaps: JournalGap[] = [];

  function journalPath() {
    return join(dir!, "journal.jsonl");
  }

  function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  function clearTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  }

  function addGap(from: number, to: number | null) {
    if (to !== null && to <= from) return;
    let combined = [...gaps, { from, to }].sort(
      (left, right) => left.from - right.from,
    );
    let merged: JournalGap[] = [];
    for (let gap of combined) {
      let previous = merged[merged.length - 1];
      if (!previous) {
        merged.push({ ...gap });
        continue;
      }
      let previousEnd = previous.to ?? Infinity;
      if (gap.from > previousEnd) {
        merged.push({ ...gap });
        continue;
      }
      previous.to =
        previous.to === null || gap.to === null
          ? null
          : Math.max(previous.to, gap.to);
    }
    gaps = merged;
  }

  function degrade(error: unknown, from?: number) {
    lastError = message(error);
    writable = false;
    clearTimer();
    pending = [];
    if (from !== undefined) addGap(from, null);
  }

  function recordStart(record: Exclude<JournalRecord, GenesisRecord>) {
    return record.events[0]?.seq ?? record.seq;
  }

  function appendRecords(records: Exclude<JournalRecord, GenesisRecord>[]) {
    if (!file || !writable || !records.length) return false;
    try {
      storage.append(
        file,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      return true;
    } catch (error) {
      degrade(error, Math.min(...records.map(recordStart)));
      return false;
    }
  }

  function flush() {
    clearTimer();
    if (!pending.length) return;
    let batch = pending;
    pending = [];
    appendRecords(batch);
  }

  function armFlush() {
    if (timer) return;
    timer = setTimeout(flush, TICK_FLUSH_DELAY_MS);
    if (typeof timer.unref === "function") timer.unref();
  }

  function genesis(
    worldId: string,
    scenario: string,
    options: JournalOpenOptions,
  ): GenesisRecord {
    return {
      kind: "genesis",
      v: 1,
      worldId,
      scenario,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      at: options.at ?? Date.now(),
    };
  }

  function rewrite(records: JournalRecord[]) {
    if (!file || !writable) return;
    let temporary = `${file}.tmp`;
    try {
      storage.write(
        temporary,
        records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      );
      storage.rename(temporary, file);
    } catch (error) {
      try {
        storage.remove(temporary);
      } catch {}
      degrade(error, 0);
    }
  }

  function recoveryRecords(events: GameEvent[]): RecoveryRecord[] {
    let groups: GameEvent[][] = [];
    for (let event of events) {
      let group = groups[groups.length - 1];
      if (!group || event.seq !== group[group.length - 1].seq + 1)
        groups.push([event]);
      else group.push(event);
    }
    return groups.map((group) => ({
      kind: "recovery",
      n: 0,
      seq: group[0].seq,
      events: group,
    }));
  }

  function reconcile(
    records: JournalRecord[],
    cursor: number,
    authoritativeEvents: GameEvent[],
  ): JournalRecord[] {
    let first = records.find(
      (record): record is GenesisRecord => record.kind === "genesis",
    )!;
    let authoritative = new Map(
      authoritativeEvents
        .filter((event) => event.seq < cursor)
        .map((event) => [event.seq, event]),
    );
    let seen = new Set<number>();
    let data: Exclude<JournalRecord, GenesisRecord>[] = [];
    for (let record of records) {
      if (record.kind === "genesis") continue;
      let events: GameEvent[] = [];
      for (let event of record.events) {
        if (event.seq >= cursor || seen.has(event.seq)) continue;
        events.push(authoritative.get(event.seq) ?? event);
        seen.add(event.seq);
      }
      if (events.length) data.push({ ...record, events });
    }

    let missing = [...authoritative.values()]
      .filter((event) => !seen.has(event.seq))
      .sort((left, right) => left.seq - right.seq);
    data.push(...recoveryRecords(missing));
    data.sort((left, right) => recordStart(left) - recordStart(right));
    data = data.map((record, index) => {
      let nextRecordNumber = index + 1;
      return record.kind === "command"
        ? {
            ...record,
            n: nextRecordNumber,
            id: `c${nextRecordNumber}`,
          }
        : { ...record, n: nextRecordNumber };
    });
    recordNumber = data.length;

    let covered = [
      ...new Set(
        data.flatMap((record) => record.events.map((event) => event.seq)),
      ),
    ].sort((left, right) => left - right);
    gaps = [];
    let expected = 0;
    for (let sequence of covered) {
      if (sequence >= cursor) break;
      if (sequence > expected) addGap(expected, sequence);
      expected = Math.max(expected, sequence + 1);
    }
    if (expected < cursor) addGap(expected, cursor);
    return [first, ...data];
  }

  function open(
    worldId: string,
    scenario: string,
    options: JournalOpenOptions = {},
  ) {
    if (!dir) return;
    clearTimer();
    pending = [];
    gaps = [];
    lastError = null;
    writable = true;
    file = journalPath();
    let records: JournalRecord[];
    let needsRewrite = false;
    try {
      storage.mkdir(dir);
      if (storage.exists(file)) {
        let parsed = parseJournal(storage.read(file));
        let first = parsed.records[0];
        if (first?.kind === "genesis" && first.worldId === worldId) {
          records = parsed.records;
          needsRewrite = parsed.malformedTail;
        } else {
          records = [genesis(worldId, scenario, options)];
          needsRewrite = true;
        }
      } else {
        records = [genesis(worldId, scenario, options)];
        needsRewrite = true;
      }
    } catch (error) {
      records = [genesis(worldId, scenario, options)];
      lastError = message(error);
      needsRewrite = true;
    }

    if (options.cursor !== undefined) {
      records = reconcile(records, options.cursor, options.events ?? []);
      needsRewrite = true;
    } else {
      recordNumber = records.reduce(
        (highest, record) =>
          record.kind === "genesis" ? highest : Math.max(highest, record.n),
        0,
      );
    }
    if (needsRewrite) rewrite(records);
  }

  function command(
    actor: string | null,
    verb: string,
    tick: number,
    seqBefore: number,
    events: GameEvent[],
    at = Date.now(),
  ) {
    if (!dir || !writable || !events.length) return;
    // Commands flush synchronously and must land after any tick records
    // still buffered, so the file stays in seq order.
    flush();
    if (!writable) return;
    let nextNumber = recordNumber + 1;
    let record: CommandRecord = {
      kind: "command",
      n: nextNumber,
      id: `c${nextNumber}`,
      tick,
      seq: seqBefore,
      actor,
      verb,
      events,
      at,
    };
    if (appendRecords([record])) recordNumber = nextNumber;
  }

  function tick(tickNumber: number, seqBefore: number, events: GameEvent[]) {
    if (!dir || !writable || !events.length) return;
    recordNumber += 1;
    pending.push({
      kind: "tick",
      n: recordNumber,
      tick: tickNumber,
      seq: seqBefore,
      events,
    });
    armFlush();
  }

  function remove() {
    if (!dir) return;
    // Buffered records belong to the world being deleted - drop, don't flush.
    clearTimer();
    pending = [];
    file = null;
    recordNumber = 0;
    gaps = [];
    try {
      storage.remove(journalPath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") degrade(error);
    }
  }

  function archiveTo(target: string) {
    if (!dir) return false;
    // Unlike remove(), buffered records are exactly what the archive is for.
    flush();
    let moved = false;
    try {
      if (storage.exists(journalPath())) {
        storage.rename(journalPath(), target);
        moved = true;
      }
    } catch (error) {
      degrade(error);
    }
    file = null;
    recordNumber = 0;
    gaps = [];
    return moved;
  }

  function stop() {
    flush();
  }

  function readEventsSince(cursor: number, until: number): JournalReadResult {
    if (!dir)
      return {
        events: [],
        unavailable: until > cursor ? [{ from: cursor, to: until }] : [],
      };
    let events: GameEvent[] = [];
    try {
      for (let record of parseJournal(storage.read(journalPath())).records) {
        if (record.kind === "genesis") continue;
        for (let event of record.events)
          if (event.seq >= cursor && event.seq < until) events.push(event);
      }
    } catch (error) {
      degrade(error, cursor);
    }
    let unique = new Map(events.map((event) => [event.seq, event]));
    let unavailable = gaps
      .map((gap) => ({
        from: Math.max(cursor, gap.from),
        to: gap.to === null ? until : Math.min(until, gap.to),
      }))
      .filter((gap) => gap.to > gap.from);
    return {
      events: [...unique.values()].sort((left, right) => left.seq - right.seq),
      unavailable,
    };
  }

  function health(): JournalHealth {
    if (!dir) return { status: "disabled", writable: false, gaps: [] };
    return {
      status: lastError || gaps.length ? "degraded" : "healthy",
      writable,
      ...(lastError ? { error: lastError } : {}),
      gaps: structuredClone(gaps),
    };
  }

  return {
    open,
    command,
    tick,
    delete: remove,
    archiveTo,
    flush,
    stop,
    readEventsSince,
    health,
  };
}
