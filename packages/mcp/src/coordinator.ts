import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join as joinPath } from "node:path";

import {
  createWorld,
  normalizeId,
  type ActionInput,
  type RuleOverlay,
  type VisibleEventsOptions,
  type WorldEngine,
} from "@agent-island/engine/engine";
import { createEventJournal, type JournalStorage } from "./journal.js";
import {
  emptyOverlay,
  mergeOverlays,
  overlayCounts,
  overlayRuleIds,
  pickOverlay,
  removeOverlayRules,
  subtractOverlay,
} from "@agent-island/engine/overlays";
import { normalizeScenarioName, type ScenarioFile } from "./scenarios.js";
import { characterBriefing } from "./briefing.js";
import type { InspectionContext } from "./coordinator-inspection.js";
import {
  createScenarioBoot,
  type ScenarioBootOptions,
} from "./coordinator-scenarios.js";
import { DEFAULT_GRAPHICS, type GraphicsConfig } from "./world-file.js";
import {
  buildAdminPayload,
  buildMapPayload,
  buildFogPayload,
  type AdminPayloadContext,
} from "./coordinator-admin.js";
import { createGmCommands } from "./coordinator-gm.js";

// The coordinator brokers MCP sessions onto the engine. The world is turn-based
// on a LOGICAL clock, not a wall clock: a tick happens the moment every active
// player has committed its action and parked in `wait_for_change`. Reasoning
// costs no game time - while any player is still thinking, the world is paused
// for everyone, so a slower or more deliberate model is never punished.
//
// A backstop (`maxWaitMs`) forces a tick if the world stays paused too long with
// a player still un-parked, so one slow, hung, or endlessly chatting model
// cannot freeze the colony. Each tick opens a fresh wait window.
//
// A minimum turn length (`minTurnMs`) may also pace all-parked turns, so a small
// fast colony cannot burn through days as quickly as clients can loop.
//
// Speak/whisper are decoupled from turns: they are free, instantaneous, and may
// be used even mid-action. A spoken message wakes every listener out of their
// park (speak is colony-wide chat; whisper wakes just its target), so a
// back-and-forth can play out in real time within a single frozen moment of
// game time, before anyone's action resolves.
//
// The roster is open: any number of players can join at any time. A character
// persists even if its session drops (the seat is vacated for reclaim); the
// world keeps its state but only advances while at least one live player drives
// it.

export interface ColonyOptions extends ScenarioBootOptions {
  engine?: WorldEngine;
  // Presentation config the map payload carries for spectator UIs.
  graphics?: GraphicsConfig;
  // Force a tick if the world stays paused this long waiting on an un-parked
  // player (the cap on how long any one model may hold up the turn).
  maxWaitMs?: number;
  // Minimum wall-clock time a fully parked turn waits before ticking. Defaults
  // to 0 for tests and embeds; the server sets a live-game default.
  minTurnMs?: number;
  // When > 0, the world advances one tick every this many wall-clock ms
  // REGARDLESS of whether players have parked - time keeps moving while agents
  // deliberate, so hunger, fire, and decay apply real-time pressure. 0 keeps the
  // lockstep barrier where thinking is free. Defaults to 0 here (tests and
  // embeds); the server ships the live game with the real-time clock on.
  // Runtime-toggleable through setRealTime.
  realTimeMs?: number;
  // Longest a single wait_for_change call blocks before returning `idle`, a
  // transport keepalive so an MCP request never hangs indefinitely.
  waitTimeoutMs?: number;
  // Wall-clock silence after which any session's MCP transport is torn down.
  // Once a session has been silent this long it is almost certainly gone for
  // good (a reconnecting agent gets a brand-new session), so we close its
  // transport to stop sessions piling up. Defaults to 45s.
  sessionTtlMs?: number;
  // A joined character that goes this long (wall-clock ms) without an act of
  // play (a committed action, order, or utterance) releases control of its
  // character and has its transport torn down. The body stays in the world for
  // same-name reclaim. Wall-clock, not ticks, so the grace period doesn't shrink
  // when other characters play fast. Can afford to be generous: a character that
  // stalls one full turn stops counting toward the turn barrier
  // (Session.stalled), so an absent player holds the game up for at most one
  // maxWaitMs turn. Defaults to 60s.
  idleMs?: number;
  // Where to persist the world. When set, the colony loads this file on startup
  // and writes the full world state back to it (atomically, coalesced) on every
  // change; when null/omitted the world is purely in-memory. Sessions are never
  // persisted - a returning client just rejoins by name and reclaims its still-
  // living character.
  statePath?: string | null;
  // Where to persist the GM's rule overlay, kept apart from the state file so a
  // director's scratch rules survive a server restart. When set, the overlay is
  // loaded on startup and rewritten whenever the GM edits a rule. A reset()
  // deletes it along with the world: scratch edits belong to the run being
  // wiped, and rules meant to outlive a reset belong in a saved scenario.
  rulesPath?: string | null;
  // Directory of file-backed custom scenarios. These load between the scenario
  // baseline and the GM scratch overlay. This is the READ source for the bundled
  // starter scenarios shipped in the repo.
  scenariosDir?: string | null;
  // Where GM save_scenario writes, kept out of the repo. Also read from (in
  // addition to scenariosDir), so a saved scenario shadows a bundled one of the
  // same name. Defaults to scenariosDir when unset (single-dir behavior).
  scenariosSaveDir?: string | null;
  // Optional file that remembers which custom scenarios are active.
  activeScenariosPath?: string | null;
  // Initial custom scenarios when no active-scenario state file exists.
  scenarios?: string[];
  // Directory for the append-only event journal (a single journal.jsonl for
  // the live world; a reset deletes it with the rest of the state). Backs
  // long-range "changes since your cursor" answers once a request's cursor
  // has fallen off the in-memory event ring - see
  // docs/v2-event-journal-plan.md. When null/omitted the journal is disabled
  // and stale-cursor requests simply see whatever the ring still holds.
  journalDir?: string | null;
  // Injectable journal-only filesystem operations for deterministic fault tests.
  journalStorage?: Partial<JournalStorage>;
  // Directory that receives the outgoing world's files when the world is
  // reset. When set, reset() moves the state file, journal, and GM rule
  // overlay into runsDir/<run-id>/ (plus a small meta.json) before
  // deleteAllState() wipes; when null/omitted a reset simply deletes them. A
  // "run" exists only as one of these archived folders after the fact - never
  // as identity in live state (docs/project-goals.md, run storage). Worlds
  // still on tick 0 are not archived.
  runsDir?: string | null;
  // Copy extra artifacts into a run's archive folder before meta.json is
  // written - the server uses it to bank the GM console's, director seats', and
  // characters' memory files (retro gold the wipe would otherwise delete).
  // Best-effort like the rest of archiveRun; the coordinator stays ignorant of
  // the runtime paths involved.
  collectRunArtifacts?: (runDir: string) => void;
  // The restore-time mirror of collectRunArtifacts: copy a run archive's banked
  // memory files back onto the live character/director workdirs before the
  // restored world boots. Injected by the server; omitted in tests and embeds,
  // where restore leaves the filesystem alone.
  restoreRunArtifacts?: (runDir: string) => void;
  // Wipe every character's persisted memory when the world is reset. Injected by
  // the server so the coordinator stays ignorant of character-runtime paths;
  // omitted in tests and embeds, where reset leaves the filesystem alone. A
  // relaunched character must not inherit a wiped campaign's beliefs.
  wipeCharacterMemory?: () => void;
  // How many ticks the colony keeps playing after a scenario declares victory
  // (see VICTORY_EVENT) before the world is frozen and the characters are
  // stopped. A grace window rather than an instant halt so a win reads as an
  // earned ending the characters get to witness and wind down from, not a rug
  // pull mid-turn. Defaults to 40; 0 concludes on the winning tick itself.
  victoryGraceTicks?: number;
}

export interface WorldDimensions {
  width: number;
  height: number;
}

export let MAX_WORLD_DIMENSION = 200;

function worldDimension(name: string, value: unknown): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_WORLD_DIMENSION
  )
    return value;
  throw new Error(
    `World ${name} must be a whole number from 1 to ${MAX_WORLD_DIMENSION}.`,
  );
}

export function parseWorldDimensions(
  value: unknown,
): WorldDimensions | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("World dimensions must be an object.");
  let dimensions = value as Partial<WorldDimensions>;
  if (dimensions.width === undefined && dimensions.height === undefined)
    return undefined;
  return {
    width: worldDimension("width", dimensions.width),
    height: worldDimension("height", dimensions.height),
  };
}

// The reserved event type a scenario emits to declare the game won. It is not a
// special rule kind - it is an ordinary event any rule can raise (a `watch` on a
// stock threshold, a `transition` on a population quorum, an `event`-phase
// reaction, ...), so the victory *condition* is authored entirely in the
// scenario's rules and can be anything the rule DSL expresses. The coordinator
// only watches the event stream for the first one; the kernel stays ignorant of
// it. Compose several rules that each emit it for an "any of these ends it" win.
const VICTORY_EVENT = "victory";

interface Waiter {
  promise: Promise<any>;
  resolve: (result: any) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Session {
  agentId: string | null;
  cursor: number;
  // The world tick this session was last handed an observation. Lets `deliver`
  // tell the engine which actions are newer than the character's last look, so a
  // GM-added capability is flagged `isNew` exactly once. Set to the current tick
  // when a body is seated, so a fresh joiner isn't told the standing action set
  // is all "new" - only what appears while it plays.
  lastSeenTick: number;
  actionDetailsDelivered: boolean;
  // Non-null exactly while this session is parked in wait_for_change. A parked
  // session has submitted its turn and is ready for time to pass.
  waiter: Waiter | null;
  // Wall-clock ms of this session's last tool call - refreshed on every request,
  // including a passive wait_for_change poll. Tracks transport liveness, so the
  // reaper uses it to decide when to tear the session down entirely.
  lastSeen: number;
  // Wall-clock ms of this session's last act of *play* - a committed action,
  // order, or utterance, not a passive poll. A character that merely re-arms
  // wait_for_change forever never advances this, so it's what tells a thinking
  // player from one that has wandered off. Wall-clock rather than engine
  // ticks, so the grace period is the same whether the world is racing along
  // under fast script-driven characters or barely ticking at all.
  lastActedAt: number;
  // Set when a backstop fires while this session sat un-parked - it has now
  // held everyone up for one full maxWaitMs turn, so it stops counting toward
  // the turn barrier and the game flows on without it. Parking still counts
  // it back in for that wait, and any act of play clears the flag entirely.
  // This is what lets the body's idle grace (idleMs) stay generous: an absent
  // player stalls the game for at most one turn, not until the reaper runs.
  stalled: boolean;
  // A GM session that drives the world's rules rather than a character - the
  // manual admin console, or a resident director like the Clerk.
  // Mutually exclusive with controlling an agent: a GM has god-powers but no
  // body, never gates the logical clock, and is never reaped for idleness.
  isGm: boolean;
  // The GM-audit-stream half of a GM waiter's cursor pair (session.cursor is
  // reused for the character event stream, which a GM session never spends it
  // on). Both streams feed wait_for_world's filter.
  gmEventCursor: number;
  // Non-null exactly while a GM session is parked in wait_for_world (or between
  // re-arms): the event types it wants to wake on and/or its tick cadence. The
  // per-call filter lives on the session so the wake sweep can evaluate it.
  gmWake: { events: Set<string>; everyTicks: number | null } | null;
  // The world tick of this GM session's last wait_for_world delivery - the
  // reference point its everyTicks cadence counts from.
  gmDeliveredTick: number;
  // Set once the reaper has asked the transport layer to close this session, so
  // a later sweep doesn't ask again while the async close is still in flight
  // (the session isn't removed until its onclose fires and calls disconnect).
  closing: boolean;
}

export function createColony(options: ColonyOptions) {
  let scenarios = createScenarioBoot(options);
  let graphics = options.graphics ?? DEFAULT_GRAPHICS;
  let { scenarioStore, activeScenarios, writeActiveScenarios } = scenarios;
  // An injected engine may run a scenario the scenario boot knows nothing
  // about, so the reset-time terrain merge (built from the config scenario)
  // only applies to the engine we build ourselves.
  let ownEngine = !options.engine;
  let engine = options.engine ?? createWorld(scenarios.bootScenario());
  let maxWaitMs = options.maxWaitMs ?? 30_000;
  let minTurnMs = Math.max(0, options.minTurnMs ?? 0);
  // Mutable so setRealTime can change it at runtime. 0 = the lockstep barrier.
  let realTimeMs = Math.max(0, Math.floor(options.realTimeMs ?? 0));
  let waitTimeoutMs = options.waitTimeoutMs ?? 30_000;
  let sessionTtlMs = options.sessionTtlMs ?? 45_000;
  let idleMs = options.idleMs ?? 60_000;
  let victoryGraceTicks = Math.max(
    0,
    Math.floor(options.victoryGraceTicks ?? 80),
  );

  let statePath = options.statePath ?? null;
  let rulesPath = options.rulesPath ?? null;
  let runsDir = options.runsDir ?? null;
  let customRules = emptyOverlay();
  // Which active scenario contributed each custom rule id. When scenarios overlap,
  // the last one in merge order wins (matching mergeOverlays), so the dashboard
  // badge names the scenario the live rule actually came from.
  let customRuleSources: Record<string, string> = {};
  let wipeCharacterMemory = options.wipeCharacterMemory ?? null;
  let collectRunArtifacts = options.collectRunArtifacts ?? null;
  let restoreRunArtifacts = options.restoreRunArtifacts ?? null;
  let journalDir = options.journalDir ?? null;
  let journalEnabled = Boolean(journalDir);
  let journal = createEventJournal(journalDir, options.journalStorage);
  // The GM's scratch rule overlay, kept in memory so rule application never
  // has to touch disk. Seeded from rulesPath on startup, refreshed whenever
  // the GM edits a rule, and wiped by reset(); null when no GM rules are in
  // force.
  let savedRules: RuleOverlay | null = null;
  let worldId = randomUUID();
  let sessions = new Map<string, Session>();
  let seats = new Map<string, string>(); // characterId -> sessionId
  // How the reaper tears down a long-dead session's transport. Wired up by the
  // MCP handler, which owns the transports; null when the colony runs headless
  // (tests, library embeds), in which case a reaped session simply lingers in
  // the map until disconnect() - harmless without a transport behind it.
  let closeTransport: ((sessionId: string) => void) | null = null;
  let backstop: ReturnType<typeof setTimeout> | null = null;
  let turnTimer: ReturnType<typeof setTimeout> | null = null;
  let realTimeClock: ReturnType<typeof setInterval> | null = null;
  let reaper: ReturnType<typeof setInterval> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let rulesSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  // Operator pause (the HUD pause button). When true, no tick advances by any
  // driver - the real-time clock, the lockstep barrier, and the backstop all
  // stand down - so the world freezes in place until it's unpaused. Distinct
  // from `endedAt` (a permanent victory freeze) and from realTimeMs (which
  // picks the driver, not whether it runs). Not persisted: a restart resumes.
  let paused = false;
  // Wall-clock liveness, surfaced to the dashboard so a viewer can tell a live
  // world from a frozen one. `lastTickAt` is when the clock last advanced;
  // `lastTickError` holds the message from a tick that threw (a GM rule the
  // kernel choked on), cleared the next time a tick succeeds.
  let lastTickAt: number | null = null;
  let lastTickError: string | null = null;
  let turnReadyAt: number | null = null;
  // The victory lifecycle, both null in a live, unwon world. `victoryTick` is
  // the tick a scenario rule first raised VICTORY_EVENT (the grace clock starts
  // there); `endedAt` is the tick the world locked once the grace window
  // elapsed. Persisted with the snapshot (see writeState) so a server restart
  // can't un-conclude a game the characters already finished. A reset clears both
  // (see deleteAllState).
  let victoryTick: number | null = null;
  let endedAt: number | null = null;

  // Dev-only narration: stream every newly-appended engine event to stdout so a
  // human (or Claude, via the preview panel) can watch the colony live. Gated on
  // AGENT_ISLAND_LOG so tests and library embeds stay quiet; the `dev` script sets it.
  let narrate = process.env.AGENT_ISLAND_LOG === "1";
  let loggedSeq = 0;

  // Timers must never keep the process alive on their own: the server stays up
  // for real work, not for a pacing or save timer still counting down. unref is
  // absent in some embeds (mocked timers), hence the guard.
  function unref<T extends { unref?: () => void }>(timer: T): T {
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function flushLog() {
    if (!narrate) return;
    for (let e of engine.getEventsSince(loggedSeq))
      console.log(
        `  t${String(e.tick).padStart(3, " ")} · ${e.text ?? e.type}`,
      );
    loggedSeq = engine.cursor();
  }
  function note(message: string) {
    if (narrate) console.log(message);
  }

  // Wrap a single actor-driven command (act, speak, an order edit, ...) so its
  // events are captured into the journal as one record. Skipped entirely when
  // the journal is disabled - a no-op command costs nothing then, not even
  // the cursor read.
  function journalCommand<T>(
    actor: string | null,
    verb: string,
    run: () => T,
  ): T {
    if (!journalEnabled) return run();
    let before = engine.cursor();
    let result = run();
    let events = engine.getEventsSince(before);
    if (events.length)
      journal.command(actor, verb, engine.currentTick(), before, events);
    return result;
  }

  // A diff read that reaches past the in-memory ring into the durable journal
  // when the requested cursor predates the ring's oldest retained event (a
  // character away long enough, in a busy enough colony, to fall off the 50k
  // ring). The common case - a cursor still inside the ring - never touches
  // the journal at all.
  function visibleEventsSince(
    agentId: string | null,
    cursor: number,
    options?: VisibleEventsOptions,
  ) {
    let floor = engine.oldestSeq();
    if (cursor >= floor)
      return {
        events: engine.visibleEventsSince(agentId, cursor, options),
        unavailable: [],
      };
    if (!journalEnabled)
      return {
        events: engine.visibleEventsSince(agentId, floor, options),
        unavailable: [{ from: cursor, to: floor }],
      };
    let includeRoutine = options?.includeRoutine ?? true;
    let historical = journal.readEventsSince(cursor, floor);
    let fromJournal = historical.events
      .filter((event) => event.seq < floor)
      .filter((event) => includeRoutine || event.wake !== "routine")
      .filter((event) => engine.visibleTo(event, agentId));
    return {
      events: [
        ...fromJournal,
        ...engine.visibleEventsSince(agentId, floor, options),
      ],
      unavailable: historical.unavailable,
    };
  }

  // --- persistence ------------------------------------------------------
  //
  // The world is written to a single JSON file, rewritten in full on every
  // change. Writes are coalesced behind a short timer so a burst (a tick that
  // wakes a dozen agents, a fast-forward through many ticks) costs one write,
  // and go through a temp file + rename so a crash mid-write can't leave a
  // half-written, unparseable world on disk.

  function loadState(): boolean {
    if (!statePath) return false;
    let raw: string;
    try {
      raw = readFileSync(statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; // first run
      throw error;
    }
    let saved = JSON.parse(raw);
    if (engine.restore(saved.engine)) {
      worldId = saved.worldId ?? worldId;
      victoryTick = saved.victoryTick ?? null;
      endedAt = saved.endedAt ?? null;
      loggedSeq = engine.cursor();
      note(`* restored world ${worldId.slice(0, 8)} from ${statePath}`);
      return true;
    }
    note(`! ignoring incompatible state file ${statePath} — starting fresh`);
    return false;
  }

  function writeState() {
    if (!statePath) return;
    let payload = JSON.stringify(
      { worldId, engine: engine.snapshot(), victoryTick, endedAt },
      null,
      2,
    );
    let tmp = `${statePath}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, statePath);
  }

  // Schedule a coalesced write. Unref'd so a pending save never holds the
  // process open; stop() does a final synchronous flush so the last change
  // always lands on a graceful shutdown.
  function scheduleSave() {
    if (!statePath || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        writeState();
      } catch (error) {
        note(`! state save failed: ${(error as Error).message}`);
      }
    }, 100);
    unref(saveTimer);
  }

  // --- GM rule overlay persistence --------------------------------------
  //
  // The GM's rule edits are persisted to their own file, apart from the world
  // snapshot, so they survive a server restart without dragging the whole
  // world along. They do NOT survive a reset(): scratch edits are part of the
  // run being wiped, and the file is deleted with it - saving a scenario is
  // how a director keeps rules across resets. Same atomic temp-file + rename
  // and coalesced-write discipline as the state file. When both files carry
  // an overlay, the rules file is the source of truth - it is re-applied over
  // whatever the restored world snapshot brought along.

  function loadRules() {
    if (!rulesPath) return;
    let raw: string;
    try {
      raw = readFileSync(rulesPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    let saved = JSON.parse(raw);
    // An overlay's rule ids are only meaningful against the baseline it was
    // authored on, so refuse one from a different world.
    let savedWorld = saved.world;
    if (savedWorld && savedWorld !== engine.scenarioName) {
      note(
        `! ignoring rule overlay for world "${savedWorld}" (running "${engine.scenarioName}")`,
      );
      return;
    }
    if (saved.overlay) {
      let overlay = saved.overlay as RuleOverlay;
      savedRules = overlay;
      applyRuleLayers();
      let edits = overlay.dynamicRules.length + overlay.removedBaseIds.length;
      note(`* applied ${edits} persisted GM rule edit(s) from ${rulesPath}`);
    }
  }

  function readCustomOverlay(): RuleOverlay {
    if (!scenarioStore) return emptyOverlay();
    let baselineIds = engine.getRuleMeta().baselineIds;
    let overlays: RuleOverlay[] = [];
    let sources: Record<string, string> = {};
    for (let name of activeScenarios) {
      let scenario: ScenarioFile;
      try {
        scenario = scenarioStore.load(name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        note(`! ignoring missing scenario "${name}"`);
        continue;
      }
      overlays.push(scenario.overlay);
      for (let id of overlayRuleIds(scenario.overlay))
        sources[id] = scenario.ruleSources?.[id] ?? name;
    }
    customRuleSources = sources;
    return mergeOverlays(baselineIds, overlays);
  }

  // The character-facing intro of the active scenario(s): the optional
  // top-level `intro` a scenario author wrote for newcomers. Read at join time
  // so a runtime scenario switch changes what the next fresh body hears;
  // missing files are skipped exactly as readCustomOverlay skips them.
  function activeScenarioIntro(): string | undefined {
    if (!scenarioStore) return undefined;
    let intros: string[] = [];
    for (let name of activeScenarios) {
      try {
        let intro = scenarioStore.load(name).intro?.trim();
        if (intro) intros.push(intro);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return intros.length > 0 ? intros.join("\n\n") : undefined;
  }

  function combinedOverlay() {
    return mergeOverlays(engine.getRuleMeta().baselineIds, [
      customRules,
      savedRules ?? undefined,
    ]);
  }

  function applyRuleLayers() {
    customRules = readCustomOverlay();
    engine.applyOverlay(combinedOverlay());
  }

  function writeRules() {
    if (!rulesPath) return;
    let payload = JSON.stringify(
      { world: engine.scenarioName, overlay: savedRules ?? emptyOverlay() },
      null,
      2,
    );
    let tmp = `${rulesPath}.tmp`;
    writeFileSync(tmp, payload);
    renameSync(tmp, rulesPath);
  }

  // Capture the GM's latest overlay synchronously - so a reset that lands before
  // the file is written still re-applies the newest rules - then schedule a
  // coalesced write of the rules file.
  function scheduleRulesSave() {
    if (!rulesPath) return;
    savedRules = subtractOverlay(engine.getOverlay(), customRules);
    if (rulesSaveTimer) return;
    rulesSaveTimer = setTimeout(() => {
      rulesSaveTimer = null;
      try {
        writeRules();
      } catch (error) {
        note(`! rule overlay save failed: ${(error as Error).message}`);
      }
    }, 100);
    unref(rulesSaveTimer);
  }

  // --- boot / delete all state -------------------------------------------
  //
  // The lifecycle is two verbs, not a transition protocol. boot() brings the
  // world in the engine online reading nothing but config, the active scenario,
  // and the GM's own rules file; deleteAllState() removes exactly everything
  // boot() doesn't read. A reset is: stop characters, deleteAllState(),
  // reshape the map, boot().

  function tryUnlink(path: string) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  function tryRename(from: string, to: string) {
    try {
      renameSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // The archive half of a reset: bank the outgoing world's files under
  // runsDir/<run-id>/ so deleteAllState()'s unlinks find nothing left to
  // remove. Moves rather than copies - the files were about to be deleted
  // anyway. A world still on tick 0 banks nothing, so a double reset or a
  // scenario switch on a fresh world doesn't litter runsDir with empty runs.
  function archiveRun(): string | null {
    if (!runsDir) return null;
    if (engine.currentTick() === 0) return null;
    let stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
    let runId = `${stamp}-${worldId.slice(0, 8)}`;
    let runDir = joinPath(runsDir, runId);
    try {
      mkdirSync(runDir, { recursive: true });
      // Flush the coalesced writers first so the archive holds the newest
      // world, then move each file that exists.
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (statePath) {
        writeState();
        tryRename(statePath, joinPath(runDir, "state.json"));
      }
      if (rulesSaveTimer) {
        clearTimeout(rulesSaveTimer);
        rulesSaveTimer = null;
        writeRules();
      }
      if (rulesPath) tryRename(rulesPath, joinPath(runDir, "rules.json"));
      journal.archiveTo(joinPath(runDir, "journal.jsonl"));
      // Copies, not moves: the memory wipe that follows owns the deletions.
      collectRunArtifacts?.(runDir);
      writeFileSync(
        joinPath(runDir, "meta.json"),
        JSON.stringify(
          {
            runId,
            worldId,
            scenario: engine.scenarioName,
            tick: engine.currentTick(),
            victoryTick,
            endedAt,
            archivedAt: Date.now(),
          },
          null,
          2,
        ),
      );
      note(`* archived run ${runId}`);
      return runId;
    } catch (error) {
      // Archiving is best-effort: a failed bank must never block the reset.
      note(`! run archive failed: ${(error as Error).message}`);
      return null;
    }
  }

  // Bring the world currently in the engine online: layer the active scenario's
  // rules (plus any GM scratch already in memory), mint a fresh identity,
  // start its journal, and put the snapshot on disk.
  function boot(seed?: number) {
    applyRuleLayers();
    worldId = randomUUID();
    loggedSeq = engine.cursor();
    openJournal(seed);
    if (statePath) writeState();
  }

  function openJournal(seed?: number) {
    if (!journalEnabled) return;
    journal.open(worldId, engine.scenarioName, {
      seed,
      cursor: engine.cursor(),
      events: engine.getEventsSince(engine.oldestSeq()),
    });
  }

  // The one place that knows what "state" is: the world snapshot, the GM
  // scratch overlay, the event journal, character memory, every live session,
  // and any pending timer that could rewrite one of those after it's gone.
  // What survives is exactly what boot() reads or other owners keep: config,
  // saved scenarios, the active-scenario selection, character logs, seat locks.
  function deleteAllState() {
    clearBackstop();
    clearTurnTimer();
    turnReadyAt = null;
    // The victory lifecycle is per-run state: a wiped world is unwon and live
    // again, so a reset lifts the freeze and re-arms victory detection.
    victoryTick = null;
    endedAt = null;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (rulesSaveTimer) {
      clearTimeout(rulesSaveTimer);
      rulesSaveTimer = null;
    }
    if (savedRules) note(`* discarded GM scratch rules`);
    savedRules = null;
    if (statePath) tryUnlink(statePath);
    if (rulesPath) tryUnlink(rulesPath);
    if (journalEnabled) journal.delete();
    // A character must not relaunch onto a memory file describing the colony
    // being deleted. logs/ stay - the run's evidence trail is not world state.
    if (wipeCharacterMemory) {
      wipeCharacterMemory();
      note(`* wiped character memory`);
    }
    // Sessions are state too. Parked waiters get a final {status: "reset"} so
    // an in-flight wait_for_change returns before its transport drops; every
    // client then re-initializes from scratch and rejoins by name.
    for (let [sessionId, session] of [...sessions]) {
      if (session.waiter) finishWaiter(session, { status: "reset" });
      if (closeTransport && !session.closing) {
        session.closing = true;
        closeTransport(sessionId);
      }
    }
    sessions.clear();
    seats.clear();
  }

  // The constructor built a fresh world from config + the active scenario. A
  // compatible snapshot on disk replaces it wholesale; either way the GM's
  // own rules file is re-applied over whichever world came up.
  if (statePath) mkdirSync(dirname(statePath), { recursive: true });
  if (rulesPath) mkdirSync(dirname(rulesPath), { recursive: true });
  if (loadState()) {
    applyRuleLayers();
    loadRules();
    // Resume the restored world's journal (boot() would start a fresh one).
    openJournal();
  } else {
    loadRules();
    boot();
  }

  // Defensive cap on a single fast-forward burst so a pathological all-parked
  // state can never spin the event loop forever.
  let ADVANCE_CAP = 100_000;

  // How much recent history a reincarnating character is replayed on rejoin, so
  // it sees what changed while its session was away rather than restarting blind.
  let BACKFILL_TICKS = 10;

  function start() {
    running = true;
    if (!reaper) {
      // Sweep often enough that the reap lands within a fraction of the timeout,
      // but never more than every 30s. Unref'd so it never holds the process up.
      reaper = setInterval(reapIdle, Math.min(sessionTtlMs, 30_000));
      unref(reaper);
    }
    startRealTimeClock();
    maybeAdvance();
  }

  function stop() {
    running = false;
    clearBackstop();
    clearTurnTimer();
    stopRealTimeClock();
    if (reaper) {
      clearInterval(reaper);
      reaper = null;
    }
    // Flush the secondary journal first, then persist authoritative state even
    // if that flush degraded. The journal contains its own error boundary.
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (journalEnabled) journal.stop();
    if (statePath) {
      try {
        writeState();
      } catch (error) {
        note(`! state save failed: ${(error as Error).message}`);
      }
    }
    if (rulesSaveTimer) {
      clearTimeout(rulesSaveTimer);
      rulesSaveTimer = null;
    }
    // Nothing to flush when savedRules is null - and after a reset, writing
    // would recreate the rules file the reset just deleted.
    if (rulesPath && savedRules) {
      try {
        writeRules();
      } catch (error) {
        note(`! rule overlay save failed: ${(error as Error).message}`);
      }
    }
  }

  // Sweep silent controller sessions in two stages. First, a joined session that
  // has gone idleMs without committing any act of play releases its character and
  // has its transport closed. This reads lastActedAt, not lastSeen, so a client
  // that only re-arms wait_for_change forever still gets detached. A character
  // with a running order is being driven by the engine, so the controller is
  // spared until the order ends. GM sessions are exempt from idle reaping.
  // Second, any session (joined or not) whose transport has been silent past
  // sessionTtlMs - no tool calls at all, passive polls included - is torn down.
  // None of this removes the character body; reconnecting by name reclaims it.
  function reapIdle() {
    if (!running) return;
    let now = Date.now();
    for (let [sessionId, session] of [...sessions]) {
      if (session.isGm) continue;
      if (session.agentId && engine.isAlive(session.agentId)) {
        let staleMs = now - session.lastActedAt;
        let hasRunningOrder =
          engine.getOrder(session.agentId).order?.status === "running";
        if (staleMs > idleMs && !hasRunningOrder) {
          let stale = Math.round(staleMs / 1000);
          note(`~ ${session.agentId} controller idle ${stale}s — releasing`);
          releaseControl(sessionId, session, "disconnected");
          if (closeTransport && !session.closing) {
            session.closing = true;
            closeTransport(sessionId);
          }
        }
      }
      // Stage 2: once the transport itself has been silent past the TTL - no tool
      // calls at all, passive polls included - tear the whole session down.
      let silentMs = now - session.lastSeen;
      let silent = Math.round(silentMs / 1000);
      if (silentMs > sessionTtlMs && closeTransport && !session.closing) {
        note(
          `~ session ${sessionId.slice(0, 8)} silent ${silent}s — closing transport`,
        );
        session.closing = true;
        closeTransport(sessionId);
      }
    }
  }

  // --- the logical clock ------------------------------------------------

  // Only sessions driving a living character gate the clock. Unattended or dead
  // characters neither block nor drive time.
  function activeSessions(): Session[] {
    let out: Session[] = [];
    for (let session of sessions.values())
      if (session.agentId && engine.isAlive(session.agentId)) out.push(session);
    return out;
  }

  // The sessions the turn barrier actually waits on. A stalled session that
  // sits un-parked has already cost everyone one full backstop turn, so it no
  // longer holds the clock; the moment it parks (or acts, which clears the
  // flag) it counts again.
  function gatingSessions(): Session[] {
    return activeSessions().filter((s) => s.waiter !== null || !s.stalled);
  }

  function allParked(active: Session[]): boolean {
    return active.length > 0 && active.every((s) => s.waiter !== null);
  }

  // Advance while every active player is parked, fast-forwarding through ticks
  // that need no input (a lone gatherer's 8 ticks, a traveller following a
  // path). Stops the instant a tick surfaces something a parked player can see
  // - which un-parks it - or no living player remains.
  function maybeAdvance() {
    if (!running || endedAt !== null || paused) return;
    // The real-time clock owns advancement when it's on; the barrier stands down.
    if (realTimeMs > 0) return;
    if (minTurnMs > 0 && allParked(gatingSessions())) {
      let now = Date.now();
      turnReadyAt ??= now;
      let delayMs = turnReadyAt + minTurnMs - now;
      if (delayMs > 0) {
        armTurnTimer(delayMs);
        return;
      }
      turnReadyAt = null;
      clearTurnTimer();
      if (step()) maybeAdvance();
      return;
    }

    let guard = 0;
    while (allParked(gatingSessions()) && guard < ADVANCE_CAP) {
      if (!step()) return; // a failed tick pauses the clock - don't spin on it
      guard += 1;
    }
    armBackstop();
  }

  // Advance one tick. Returns false if the tick itself threw - a GM can author a
  // rule the kernel accepts structurally but that blows up when it runs (a stock
  // or entity it names doesn't exist). Rather than let that escape and crash the
  // process (taking down every player's world) or spin the advance loop, we pause
  // the clock and leave the world live, so a GM can remove or fix the rule and
  // time resumes on the next nudge. The broken tick is not persisted.
  function step(): boolean {
    // A concluded world is frozen: its clock never advances again (only a reset
    // moves it forward), so short-circuit before touching the engine.
    if (endedAt !== null) return false;
    let before = engine.cursor();
    try {
      engine.tick();
      lastTickAt = Date.now();
      lastTickError = null;
    } catch (error) {
      lastTickError = (error as Error).message;
      note(`! tick failed, clock paused: ${lastTickError}`);
      clearBackstop();
      return false;
    }
    let fresh = engine.getEventsSince(before);
    if (journalEnabled && fresh.length)
      journal.tick(engine.currentTick(), before, fresh);
    // Victory is whatever the scenario's rules say it is: the first tick any
    // rule emits VICTORY_EVENT starts the grace clock. Nothing re-arms it - a
    // watch rule is edge-triggered and fires once - so a later win is ignored.
    if (victoryTick === null && fresh.some((e) => e.type === VICTORY_EVENT)) {
      victoryTick = engine.currentTick();
      note(
        `* victory reached at tick ${victoryTick} — colony plays on for ${victoryGraceTicks} more tick(s)`,
      );
    }
    clearBackstop(); // a tick opens a fresh wait window
    flushLog();
    wakeVisibleWaiters();
    scheduleSave();
    // Once the grace window has fully elapsed, lock the world and stop the
    // characters. Reported here (not the moment of victory) so the colony gets
    // its full send-off first.
    if (
      victoryTick !== null &&
      engine.currentTick() - victoryTick >= victoryGraceTicks
    ) {
      concludeGame();
      return false;
    }
    return true;
  }

  // Freeze a won world and stop its characters. The world stays fully loaded -
  // the dashboard, GM tools, and same-name reclaim all keep working - but its
  // logical clock is now parked for good; reset() is the only way forward. The
  // scenario's own VICTORY_EVENT (victoryGraceTicks earlier) is what the
  // characters actually witnessed in-world; this records the mechanical close.
  function concludeGame() {
    if (endedAt !== null) return;
    endedAt = engine.currentTick();
    clearBackstop();
    clearTurnTimer();
    stopRealTimeClock();
    turnReadyAt = null;
    engine.recordGm(
      "game_over",
      `colony concluded at tick ${endedAt} — victory reached at tick ${victoryTick}`,
    );
    note(`* colony concluded at tick ${endedAt} — stopping live agents`);
    // Release any parked character so its wait_for_change returns now instead of
    // hanging to the transport timeout; a frozen world has nothing left to wait
    // for. Their clients see the final observation and can leave cleanly.
    for (let session of sessions.values()) {
      if (!session.waiter) continue;
      if (session.agentId)
        finishWaiter(session, {
          status: "ended",
          worldId,
          ...deliver(session),
        });
      // A parked GM (e.g. a director) learns the run is over the same way -
      // its wake loop should stop re-arming and write its retrospective.
      else if (session.isGm)
        finishWaiter(session, {
          status: "ended",
          worldId,
          ...deliverGm(session),
        });
    }
    scheduleSave();
  }

  function wakeVisibleWaiters() {
    for (let session of sessions.values()) {
      if (!session.waiter) continue;
      if (session.isGm) {
        if (gmHasUnseen(session))
          finishWaiter(session, {
            status: "changed",
            ...deliverGm(session),
          });
        continue;
      }
      if (hasUnseen(session)) finishWaiter(session, changeResult(session));
    }
  }

  // Force the world forward one tick when it has stayed paused for maxWaitMs
  // with a player still un-parked - the guard against a slow, hung, or
  // over-chatty model holding up everyone else. Re-arms itself if still waiting.
  function onBackstop() {
    backstop = null;
    if (!running || endedAt !== null || paused) return;
    let active = activeSessions();
    if (active.length === 0 || allParked(active)) return;
    // Whoever is still un-parked has now held the world for a full maxWaitMs
    // turn; stop waiting on them from here on. They rejoin the barrier by
    // parking, and shed the flag entirely with their next act of play.
    for (let session of active) {
      if (session.waiter === null && !session.stalled) {
        session.stalled = true;
        note(
          `~ ${session.agentId} stalled a turn — no longer gating the clock`,
        );
      }
    }
    if (!step()) return;
    maybeAdvance();
  }

  function armBackstop() {
    // Don't extend a window that is already counting down - the cap is measured
    // from when the world began waiting, not reset by each bit of chatter.
    if (backstop || !running || endedAt !== null || paused) return;
    let active = activeSessions();
    if (active.length === 0 || allParked(active)) return;
    clearTurnTimer();
    turnReadyAt = null;
    backstop = setTimeout(onBackstop, maxWaitMs);
    unref(backstop);
  }

  function clearBackstop() {
    if (!backstop) return;
    clearTimeout(backstop);
    backstop = null;
  }

  function armTurnTimer(delayMs: number) {
    if (turnTimer || !running) return;
    turnTimer = setTimeout(() => {
      turnTimer = null;
      maybeAdvance();
    }, delayMs);
    unref(turnTimer);
  }

  function clearTurnTimer() {
    if (!turnTimer) return;
    clearTimeout(turnTimer);
    turnTimer = null;
  }

  // The real-time clock (on in the live game, off in tests/embeds). When
  // realTimeMs > 0 it advances the world one tick every realTimeMs of wall-clock,
  // regardless of whether players have parked - so time keeps moving while agents think and
  // hunger/fire/decay apply real pressure. It owns advancement entirely: the
  // barrier, minTurnMs pacing, and backstop all stand down (maybeAdvance
  // early-returns), while step()'s own wakeVisibleWaiters still notifies parked
  // agents of what they can see. Unref'd like every other timer, and idle when
  // no one is living in the world so a paused colony doesn't burn ticks.
  function startRealTimeClock() {
    if (realTimeClock || realTimeMs <= 0 || !running) return;
    clearBackstop();
    clearTurnTimer();
    turnReadyAt = null;
    realTimeClock = setInterval(() => {
      if (!running || endedAt !== null || paused) return;
      if (activeSessions().length === 0) return;
      // step() may return false on a paused (thrown) tick; the next beat retries.
      step();
    }, realTimeMs);
    unref(realTimeClock);
  }

  function stopRealTimeClock() {
    if (!realTimeClock) return;
    clearInterval(realTimeClock);
    realTimeClock = null;
  }

  // Runtime toggle for the real-time clock. Pass 0 to hand the clock back to the
  // lockstep barrier, or a positive cadence to restart the interval. Returns the
  // fresh admin payload.
  function setRealTime(ms: unknown) {
    realTimeMs = Math.max(0, Math.floor(typeof ms === "number" ? ms : 0));
    stopRealTimeClock();
    if (realTimeMs > 0) startRealTimeClock();
    else maybeAdvance(); // barrier resumes ownership of the clock
    return getAdminPayload();
  }

  // Runtime toggle for the operator pause (the HUD pause button). Pausing
  // freezes the world under whichever clock is active; unpausing lets the barrier
  // catch up (the real-time interval keeps beating on its own and resumes the
  // moment the flag clears). Returns the fresh admin payload so the UI reflects
  // the new state without a follow-up poll.
  function setPaused(on: unknown) {
    paused = Boolean(on);
    if (paused) {
      clearBackstop();
      clearTurnTimer();
      turnReadyAt = null;
    } else {
      maybeAdvance();
    }
    return getAdminPayload();
  }

  // --- sessions ---------------------------------------------------------

  function connect(sessionId: string) {
    if (sessions.has(sessionId)) return;
    sessions.set(sessionId, {
      agentId: null,
      cursor: engine.cursor(),
      lastSeenTick: engine.currentTick(),
      actionDetailsDelivered: false,
      waiter: null,
      lastSeen: Date.now(),
      lastActedAt: Date.now(),
      stalled: false,
      isGm: false,
      gmEventCursor: engine.gmCursor(),
      gmWake: null,
      gmDeliveredTick: engine.currentTick(),
      closing: false,
    });
    note(
      `+ session ${sessionId.slice(0, 8)} connected (${sessions.size} open)`,
    );
  }

  function disconnect(sessionId: string) {
    let session = sessions.get(sessionId);
    if (!session) return;
    releaseSeat(sessionId, session);
    if (session.isGm)
      engine.recordGm("gm_left", "the director left the GM seat");
    if (session.waiter) finishWaiter(session, { status: "disconnected" });
    sessions.delete(sessionId);
    note(
      `- session ${sessionId.slice(0, 8)} disconnected${
        session.agentId ? ` (was ${session.agentId})` : ""
      }`,
    );
    maybeAdvance(); // its controller departure may leave remaining players parked
  }

  function join(sessionId: string, name: string) {
    let session = requireSession(sessionId);
    if (session.isGm)
      throw new Error(
        "This session is the GM and cannot also join as an agent.",
      );
    let id = normalizeId(name);

    // Release any prior character this session controlled if it has since died
    // or been removed; otherwise one session may only drive one live character.
    if (session.agentId && session.agentId !== id) {
      if (engine.isAlive(session.agentId))
        throw new Error(`This session already controls ${session.agentId}.`);
      releaseSeat(sessionId, session);
    }

    // Death is terminal: a dead name never comes back, so the character can't
    // silently reincarnate into a fresh body under its old identity. Refuse
    // the join and tell them plainly, so a character that dies mid-launch
    // finds out for certain rather than getting a quiet fresh spawn.
    if (engine.isDead(id)) {
      let diedAt = engine.diedAt(id);
      throw new Error(
        `${engine.displayName(id)} died` +
          (diedAt !== null ? ` at tick ${diedAt}` : "") +
          ` and cannot rejoin. Starting a new agent is a decision for your operator, not something to do automatically.`,
      );
    }

    let reclaimed = false;
    if (engine.hasAgent(id)) {
      // Reclaim an existing, living agent - always allowed, even if another
      // session currently holds the seat. No public multi-tenant guarantees
      // yet, so we don't police duplicate control.
      seats.set(id, sessionId);
      session.agentId = id;
      reclaimed = true;
    } else {
      let added = journalCommand(id, "join", () => engine.addAgent(name));
      seats.set(added.id, sessionId);
      session.agentId = added.id;
    }

    // Anchor the "new action" cursor at the moment of taking a body, so the first
    // observation doesn't flag the entire standing action set as new - only what
    // the GM introduces from here on.
    session.lastSeenTick = engine.currentTick();
    session.actionDetailsDelivered = false;
    // Taking a body is an act of play - start the idle clock from here so a fresh
    // joiner gets the full grace period before controller reaping can release it.
    session.lastActedAt = Date.now();
    session.stalled = false;

    // The colony-wide `joined` event is something parked players can see; wake
    // them so they greet the newcomer in real time, as speak/whisper do. A
    // fresh, un-parked player now gates the clock; make sure the backstop is
    // watching in case it never responds.
    wakeVisibleWaiters();
    flushLog();
    maybeAdvance();
    scheduleSave();
    // A reclaimed character is reincarnating into a body that kept living while
    // its session was gone - rewind its cursor so the delivered events backfill
    // what changed during the gap. A freshly spawned character has no past.
    if (reclaimed) session.cursor = engine.backfillCursor(BACKFILL_TICKS);
    // A fresh body gets the briefing in-band for clients that don't surface MCP
    // instructions, plus the active scenario's `intro` - the one line of
    // scenario-authored fiction a newcomer hears. Reclaims already have their
    // prompt and memory, so do not resend either alongside their recent history.
    let intro = reclaimed ? undefined : activeScenarioIntro();
    return {
      status: "joined",
      worldId,
      reclaimed,
      ...(reclaimed ? {} : { briefing: characterBriefing }),
      ...(intro !== undefined ? { intro } : {}),
      ...deliver(session),
    };
  }

  // Voluntary controller exit: the character stays in the world, but this MCP
  // session stops driving it. The same or a later session can reclaim by name.
  function leave(sessionId: string) {
    let session = requireJoined(sessionId);
    return releaseControl(sessionId, session, "left");
  }

  function releaseControl(
    sessionId: string,
    session: Session,
    status: "left" | "disconnected",
  ) {
    let agentId = session.agentId!;
    releaseSeat(sessionId, session);
    if (session.waiter) finishWaiter(session, { status });
    maybeAdvance();
    return { status, worldId, agentId };
  }

  // Force a live agent's controller loose right now, regardless of idleMs -
  // an operator-driven equivalent of reapIdle's stage-one release for a
  // single named agent. A killed client (crew.mjs SIGTERMing a character's
  // process, say) never sends the MCP session's own disconnect, so without
  // this the seat would otherwise read as "connected" until the idle sweep
  // catches up (up to idleMs), which is long enough that a same-second
  // relaunch sees the body as still taken and spawns a fresh one instead of
  // reclaiming it. No-op (returns false) if the agent has no live controller.
  function releaseAgent(name: string) {
    let id = normalizeId(name);
    let sessionId = seats.get(id);
    if (!sessionId) return false;
    let session = sessions.get(sessionId);
    if (!session) return false;
    releaseControl(sessionId, session, "disconnected");
    if (closeTransport && !session.closing) {
      session.closing = true;
      closeTransport(sessionId);
    }
    return true;
  }

  // The sense verb. `situation` answers from the character's own knowledge;
  // `changes` touches session state (it reads and advances the event cursor,
  // exactly as observe always has - deliver() owns that). The payload shape is
  // per-mode protocol data, so it is deliberately untyped here.
  function sense(sessionId: string, mode: string): any {
    let session = requireJoined(sessionId);
    if (mode === "changes") return { sense: "changes", ...deliver(session) };
    return engine.sense(session.agentId!, mode);
  }

  // Commit an intent or order: flush the new events, let the clock advance if
  // everyone is now parked, persist, and return the standard envelope. None of
  // these advance time on their own - the player must still park - so the
  // backstop keeps watching for the follow-up wait_for_change.
  function commitAndDeliver<T extends object>(
    session: Session,
    status: string,
    result: T,
  ) {
    session.lastActedAt = Date.now();
    session.stalled = false;
    flushLog();
    maybeAdvance();
    scheduleSave();
    return { status, worldId, ...result, ...deliver(session) };
  }

  function commitWithoutDeliver<T extends object>(
    session: Session,
    status: string,
    result: T,
  ) {
    session.lastActedAt = Date.now();
    session.stalled = false;
    flushLog();
    maybeAdvance();
    scheduleSave();
    // Do NOT snapshot session.cursor here: setOrder's inline first step (run
    // synchronously inside engine.setOrder above) can already push events -
    // e.g. a blocked order on step one of a single-action order. Leave
    // the cursor where it was so the next deliver() (via wait_for_change)
    // picks those up instead of silently skipping past them.
    return { status, worldId, ...result };
  }

  // Like commitAndDeliver, but for free actions (speak/whisper/inscribe) that wake
  // parked listeners into real time instead of advancing the clock - they
  // need wakeVisibleWaiters + armBackstop where an intent/order needs maybeAdvance.
  function commitAndWake<T extends object>(
    session: Session,
    status: string,
    result: T,
  ) {
    session.lastActedAt = Date.now();
    session.stalled = false;
    wakeVisibleWaiters();
    flushLog();
    armBackstop(); // a woken listener is now un-parked; keep the window bounded
    scheduleSave();
    return { status, worldId, ...result, ...deliver(session) };
  }

  function act(sessionId: string, action: ActionInput) {
    let session = requireJoined(sessionId);
    let agentId = session.agentId!;
    return commitAndDeliver(
      session,
      "acting",
      journalCommand(agentId, "act", () =>
        engine.commitIntent(agentId, action),
      ),
    );
  }

  function setOrder(sessionId: string, order: unknown) {
    let session = requireJoined(sessionId);
    let agentId = session.agentId!;
    return commitWithoutDeliver(
      session,
      "ordered",
      journalCommand(agentId, "set_order", () =>
        engine.setOrder(agentId, order),
      ),
    );
  }

  function setOrderAndWait(sessionId: string, order: unknown) {
    let ordered = setOrder(sessionId, order);
    if (ordered.order?.status !== "running") return Promise.resolve(ordered);
    return waitForChange(sessionId);
  }

  function cancelOrder(sessionId: string) {
    let session = requireJoined(sessionId);
    let agentId = session.agentId!;
    return commitAndDeliver(
      session,
      "order_cancelled",
      journalCommand(agentId, "cancel_order", () =>
        engine.cancelOrder(agentId),
      ),
    );
  }

  function getOrder(sessionId: string) {
    let session = requireJoined(sessionId);
    return { status: "ok", worldId, ...engine.getOrder(session.agentId!) };
  }

  // Free, instantaneous, colony-wide chat. It never advances the clock, but it
  // does wake every parked player out of their park so a conversation can play
  // out in real time within the same frozen moment of game time.
  function speak(sessionId: string, message: string) {
    let session = requireJoined(sessionId);
    let agentId = session.agentId!;
    return commitAndWake(
      session,
      "spoke",
      journalCommand(agentId, "speak", () => engine.speak(agentId, message)),
    );
  }

  function whisper(sessionId: string, target: string, message: string) {
    let session = requireJoined(sessionId);
    let agentId = session.agentId!;
    return commitAndWake(
      session,
      "whispered",
      journalCommand(agentId, "whisper", () =>
        engine.whisper(agentId, target, message),
      ),
    );
  }

  function inscribe(sessionId: string, message: string) {
    let session = requireJoined(sessionId);
    let agentId = session.agentId!;
    return commitAndWake(
      session,
      "inscribed",
      journalCommand(agentId, "inscribe", () =>
        engine.inscribe(agentId, message),
      ),
    );
  }

  // Park until the character sees something new (its action completed, a message
  // arrived, the fire went out, ...). Parking signals "I'm ready for time to
  // pass"; once every active player is parked, the world advances.
  function waitForChange(sessionId: string) {
    let session = requireJoined(sessionId);
    if (session.waiter) return session.waiter.promise;
    if (hasUnseen(session)) return Promise.resolve(changeResult(session));

    let resolveWaiter: Waiter["resolve"] = () => {};
    let promise = new Promise<any>((resolve) => {
      resolveWaiter = resolve;
    });
    let waiter: Waiter = { promise, resolve: resolveWaiter, timer: null };
    waiter.timer = setTimeout(() => {
      finishWaiter(session, { status: "idle", ...deliver(session) });
      armBackstop();
    }, waitTimeoutMs);
    unref(waiter.timer);
    session.waiter = waiter;
    // This park may complete the barrier - advance immediately if so.
    maybeAdvance();
    return promise;
  }

  // The GM's wait_for_change: park until an event matching the session's
  // filter lands (in either stream) or its tick cadence comes due. Unlike a
  // character park this never touches the turn barrier - a GM session doesn't
  // gate the clock, so parking it must neither advance time nor arm the
  // backstop. Threshold triggers are deliberately not a parameter: the GM (the
  // director in the automated case) authors watch rules that emit its own
  // event types and subscribes to those, so the wake vocabulary stays
  // "events + cadence".
  function waitForWorld(
    sessionId: string,
    params: { events?: string[]; everyTicks?: number } = {},
  ) {
    let session = requireGm(sessionId);
    let events = new Set(
      (params.events ?? []).map((e) => String(e).trim()).filter(Boolean),
    );
    let everyTicks =
      typeof params.everyTicks === "number" &&
      Number.isFinite(params.everyTicks) &&
      params.everyTicks >= 1
        ? Math.floor(params.everyTicks)
        : null;
    if (events.size === 0 && everyTicks === null)
      throw new Error(
        "Pass `events` (event types to wake on) and/or `everyTicks` (a tick cadence).",
      );
    session.gmWake = { events, everyTicks };
    if (session.waiter) return session.waiter.promise;
    if (gmHasUnseen(session))
      return Promise.resolve({
        status: "changed",
        ...deliverGm(session),
      });

    let resolveWaiter: Waiter["resolve"] = () => {};
    let promise = new Promise<any>((resolve) => {
      resolveWaiter = resolve;
    });
    let waiter: Waiter = { promise, resolve: resolveWaiter, timer: null };
    // The idle timeout still delivers a pulse, so even an empty wake is a
    // usable heartbeat for the GM's pacing decisions.
    waiter.timer = setTimeout(() => {
      finishWaiter(session, { status: "idle", ...deliverGm(session) });
    }, waitTimeoutMs);
    unref(waiter.timer);
    session.waiter = waiter;
    return promise;
  }

  // Two admin resets can overlap: the second would re-run the whole teardown
  // against the first's freshly-built world. Serialize them - each reset waits
  // for the one in flight, then runs whole.
  let resetChain: Promise<unknown> = Promise.resolve();

  function reset(dimensions?: WorldDimensions) {
    let parsedDimensions = parseWorldDimensions(dimensions);
    if (parsedDimensions && !ownEngine)
      throw new Error("World dimensions require the coordinator-owned engine.");
    let run = resetChain.then(() => resetNow(parsedDimensions));
    resetChain = run.catch(() => {});
    return run;
  }

  async function resetNow(dimensions?: WorldDimensions) {
    archiveRun();
    deleteAllState();
    // Replace the full scenario from the scenarios active NOW, under a fresh seed.
    // The same producer owns startup and runtime identity, terrain, worldgen,
    // spawn, and any future scenario-level program data.
    let seed = Math.floor(Math.random() * 0x7fffffff);
    let nextScenario = scenarios.bootScenario();
    if (dimensions)
      nextScenario = {
        ...nextScenario,
        worldgen: { ...(nextScenario.worldgen ?? dimensions), ...dimensions },
      };
    engine.reset(ownEngine ? { seed, scenario: nextScenario } : { seed });
    boot(seed);
    note(`* world reset (${worldId.slice(0, 8)}, seed ${seed})`);
    return getAdminPayload();
  }

  // Every archived run under runsDir, newest first - what the operator picks
  // a restore target from. Best-effort per folder: a meta.json that fails to
  // parse is skipped rather than failing the whole listing.
  function listRuns() {
    if (!runsDir) return [];
    let entries: Dirent[];
    try {
      entries = readdirSync(runsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    let runs: Record<string, unknown>[] = [];
    for (let entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        let raw = readFileSync(
          joinPath(runsDir, entry.name, "meta.json"),
          "utf8",
        );
        runs.push(JSON.parse(raw));
      } catch {
        // skip a run whose meta.json is missing or unreadable
      }
    }
    runs.sort(
      (a, b) =>
        ((b.archivedAt as number) ?? 0) - ((a.archivedAt as number) ?? 0),
    );
    return runs;
  }

  function tryCopy(from: string, to: string) {
    try {
      copyFileSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  // The restore half of the reset/restore pair: bank the current world (same
  // as a reset would), then copy a previously-archived run's files back into
  // the live paths and boot from them - the mirror image of archiveRun(),
  // followed by the exact same load sequence the constructor uses when it
  // finds a compatible state file on disk (see the loadState() branch below).
  async function restoreRunNow(runId: string) {
    if (!runsDir)
      throw new Error("No runsDir configured - nothing to restore from.");
    // runId names a runsDir subfolder - refuse anything that could climb out
    // of it (a path separator or "..").
    if (!/^[^/\\]+$/.test(runId) || runId === "." || runId === "..")
      throw new Error(`Invalid run id: ${runId}`);
    let runDir = joinPath(runsDir, runId);
    let archivedStatePath = joinPath(runDir, "state.json");
    if (!existsSync(archivedStatePath))
      throw new Error(`No such run: ${runId}`);

    archiveRun();
    deleteAllState();

    if (statePath) tryCopy(archivedStatePath, statePath);
    if (rulesPath) tryCopy(joinPath(runDir, "rules.json"), rulesPath);
    if (journalDir) {
      mkdirSync(journalDir, { recursive: true });
      tryCopy(
        joinPath(runDir, "journal.jsonl"),
        joinPath(journalDir, "journal.jsonl"),
      );
    }
    restoreRunArtifacts?.(runDir);

    if (!loadState()) {
      // The wipe above already happened - leaving the coordinator with no
      // world at all would be worse than the failed restore, so boot a fresh
      // one (same fallback the constructor takes) and surface the error.
      loadRules();
      boot();
      throw new Error(
        `Run ${runId}'s state.json is incompatible with this world - booted a fresh world instead.`,
      );
    }
    applyRuleLayers();
    loadRules();
    openJournal();
    note(`* world restored from run ${runId} (${worldId.slice(0, 8)})`);
    return getAdminPayload();
  }

  function restoreRun(runId: string) {
    let run = resetChain.then(() => restoreRunNow(runId));
    resetChain = run.catch(() => {});
    return run;
  }

  function getAdminPayload() {
    return buildAdminPayload(adminPayloadContext());
  }

  function adminPayloadContext(): AdminPayloadContext {
    return {
      engine,
      worldId,
      maxWaitMs,
      minTurnMs,
      realTimeMs,
      paused,
      running,
      lastTickAt,
      lastTickError,
      victoryTick,
      endedAt,
      victoryGraceTicks,
      activeSessions: activeSessions(),
      sessions: [...sessions.values()],
      seats,
      customRules,
      customRuleSources,
      savedRules,
      journalHealth: journal.health(),
    };
  }

  function getMapPayload() {
    return buildMapPayload(engine, worldId, graphics);
  }

  function getFogPayload() {
    return buildFogPayload(engine, worldId);
  }

  // --- Custom scenarios -------------------------------------------------
  //
  // Custom scenarios are file-backed and mutually exclusive: at most one scenario
  // is active, and that scenario IS the game. Switching scenarios resets the world
  // - the old colony's state is meaningless under new rules, and a fresh worldgen
  // lets the incoming scenario's fixtures and setup entities spawn onto a clean map.

  function listScenarios() {
    return {
      active: [...activeScenarios].sort(),
      scenarios: scenarioStore?.list(activeScenarios) ?? [],
      gm: overlayCounts(savedRules ?? undefined),
    };
  }

  async function setScenarioActive(name: string, active: boolean) {
    if (!scenarioStore) throw new Error("Scenarios are not configured.");
    let normalized = normalizeScenarioName(name);
    if (active) {
      // Validate before touching anything: activating is destructive (it
      // resets the world), so a missing scenario or one that paints undefined
      // terrain must fail here, not after the colony is gone.
      let scenario: ScenarioFile;
      try {
        scenario = scenarioStore.load(normalized);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        throw new Error(`There is no scenario named "${normalized}".`);
      }
      scenarios.validateScenario(scenario);
      // Re-selecting the scenario already in force is a no-op, not a world wipe.
      if (activeScenarios.size === 1 && activeScenarios.has(normalized))
        return listScenarios();
      activeScenarios.clear();
      activeScenarios.add(normalized);
    } else {
      if (!activeScenarios.has(normalized)) return listScenarios();
      activeScenarios.delete(normalized);
    }
    writeActiveScenarios();
    note(`* scenario switched to ${[...activeScenarios].join(", ") || "none"}`);
    // reset() re-rolls the map under the new scenario's terrain, re-applies the
    // scenario's rule layer, and persists the fresh world.
    await reset();
    return listScenarios();
  }

  // Saving forks the WHOLE current ruleset into a standalone scenario: the active
  // scenario's overlay plus the chosen GM edits. Scenarios are mutually exclusive, so
  // a scenario holding only the edits would be a game missing its base rules. The
  // fork becomes the active scenario without a reset - the live rules don't
  // change, the edits just move from GM scratch into the scenario layer.
  function saveScenario(name: string, ids?: string[]) {
    if (!scenarioStore) throw new Error("Scenarios are not configured.");
    let normalized = normalizeScenarioName(name);
    let gmOverlay = subtractOverlay(engine.getOverlay(), customRules);
    let picked = pickOverlay(gmOverlay, ids);
    let ruleIds = overlayRuleIds(picked);
    if (!ruleIds.length && ids?.length)
      throw new Error("None of the selected rules are GM edits.");
    if (!ruleIds.length) throw new Error("There are no GM edits to save.");

    let overlay = mergeOverlays(engine.getRuleMeta().baselineIds, [
      customRules,
      picked,
    ]);
    let scenario = scenarioStore.save(normalized, overlay);
    activeScenarios.clear();
    activeScenarios.add(scenario.name);
    savedRules = removeOverlayRules(gmOverlay, ruleIds);
    // Re-read the scenario layer from disk so customRules and the per-rule source
    // badges reflect the fork, then land the unchanged combined rule set.
    applyRuleLayers();
    writeActiveScenarios();
    writeRules();
    scheduleSave();
    return {
      scenario: { ...scenario, counts: overlayCounts(scenario.overlay) },
      scenarios: listScenarios(),
    };
  }

  function clearGmRules() {
    savedRules = emptyOverlay();
    engine.applyOverlay(combinedOverlay());
    writeRules();
    scheduleSave();
    return listScenarios();
  }

  function inspectionContext(): InspectionContext {
    return {
      engine,
      worldId,
      running,
      lastTickAt,
      lastTickError,
      journalHealth: journal.health(),
      seats,
    };
  }

  let gmCommands = createGmCommands({
    engine,
    requireSession,
    requireGm,
    inspectionContext,
    note,
    scheduleSave,
    scheduleRulesSave,
    journalCommand,
    maybeAdvance,
    wakeVisibleWaiters,
    flushLog,
    armBackstop,
  });

  // --- internals --------------------------------------------------------

  function deliver(session: Session) {
    let observation = engine.getObservation(
      session.agentId!,
      session.lastSeenTick,
      !session.actionDetailsDelivered,
    );
    session.lastSeenTick = observation.tick;
    session.actionDetailsDelivered = true;
    let history = visibleEventsSince(session.agentId, session.cursor);
    session.cursor = engine.cursor();
    return {
      observation,
      events: history.events,
      ...(history.unavailable.length
        ? {
            history: {
              status: "incomplete",
              unavailable: history.unavailable,
            },
          }
        : {}),
    };
  }

  function changeResult(session: Session) {
    return { status: "changed", ...deliver(session) };
  }

  // Whether a parked GM session's wake condition holds: its cadence came due,
  // or an event matching its filter landed in either stream. The character
  // stream is read unfiltered - the GM is omniscient, so even events no
  // character perceives (rule_error) are matchable.
  function gmHasUnseen(session: Session): boolean {
    let wake = session.gmWake;
    if (!wake) return false;
    if (
      wake.everyTicks !== null &&
      engine.currentTick() - session.gmDeliveredTick >= wake.everyTicks
    )
      return true;
    if (wake.events.size === 0) return false;
    return (
      engine
        .getEventsSince(session.cursor)
        .some((e) => wake.events.has(e.type)) ||
      engine
        .gmEventsSince(session.gmEventCursor)
        .some((e) => wake.events.has(e.kind))
    );
  }

  // A GM session's wake digest: matched events from both streams since its
  // cursors, plus the pulse. Compact projections, not whole events - the GM
  // reads trends and reacts to types; drill-down is inspect_world's job.
  // Advances all cursors, so nothing is re-delivered.
  function deliverGm(session: Session) {
    let wake = session.gmWake;
    let types = wake?.events ?? new Set<string>();
    let stale = session.cursor < engine.oldestSeq();
    let events = engine
      .getEventsSince(session.cursor)
      .filter((e) => types.has(e.type))
      .map((e) => ({
        tick: e.tick,
        type: e.type,
        ...(e.agentId ? { agentId: e.agentId } : {}),
        ...(e.text ? { text: e.text } : {}),
        ...(e.message ? { message: e.message } : {}),
      }));
    let truncated = events.length > 100;
    if (truncated) events = events.slice(-100);
    let gmEvents = engine
      .gmEventsSince(session.gmEventCursor)
      .filter((e) => types.has(e.kind))
      .map((e) => ({
        tick: e.tick,
        kind: e.kind,
        summary: e.summary,
        ...(e.target ? { target: e.target } : {}),
      }));
    session.cursor = engine.cursor();
    session.gmEventCursor = engine.gmCursor();
    session.gmDeliveredTick = engine.currentTick();
    return {
      tick: engine.currentTick(),
      events,
      gmEvents,
      ...(truncated ? { truncated: true } : {}),
      // A cursor that predates the in-memory ring means events fell off before
      // this delivery; a GM that fell far behind wants the pulse, not a
      // replay, so flag the gap and move on (no journal backfill).
      ...(stale ? { history: { status: "incomplete" } } : {}),
      pulse: engine.getPulse(),
    };
  }

  // A session is "ready to wake" only when an event it can actually see has
  // landed since its last look - private action chatter from other characters
  // must not wake it.
  function hasUnseen(session: Session): boolean {
    let history = visibleEventsSince(session.agentId, session.cursor, {
      includeRoutine: false,
    });
    return history.events.length > 0 || history.unavailable.length > 0;
  }

  function releaseSeat(sessionId: string, session: Session) {
    if (session.agentId && seats.get(session.agentId) === sessionId)
      seats.delete(session.agentId);
    session.agentId = null;
  }

  function finishWaiter(session: Session, result: any) {
    let waiter = session.waiter;
    if (!waiter) return;
    if (waiter.timer) clearTimeout(waiter.timer);
    session.waiter = null;
    waiter.resolve(result);
  }

  function requireSession(sessionId: string): Session {
    let session = sessions.get(sessionId);
    if (!session) throw new Error("Unknown MCP session.");
    // Every tool call routes through here - the single place to mark the session
    // alive so the silent-session sweep leaves it be.
    session.lastSeen = Date.now();
    return session;
  }

  function requireJoined(sessionId: string): Session {
    let session = requireSession(sessionId);
    if (!session.agentId)
      throw new Error("Call join_game before using this tool.");
    return session;
  }

  function requireGm(sessionId: string): Session {
    let session = requireSession(sessionId);
    if (!session.isGm)
      throw new Error("Call join_as_gm before using GM tools.");
    return session;
  }

  function gmSaveScenario(sessionId: string, name: string, ids?: string[]) {
    requireGm(sessionId);
    return saveScenario(name, ids);
  }

  function gmClearEdits(sessionId: string) {
    requireGm(sessionId);
    return clearGmRules();
  }

  // Let the transport layer (the MCP handler) register how to close a session's
  // transport, so the silent-session sweep can tear down sessions that are gone
  // for good.
  function setTransportCloser(fn: (sessionId: string) => void) {
    closeTransport = fn;
  }

  return {
    start,
    stop,
    setTransportCloser,
    connect,
    disconnect,
    join,
    leave,
    releaseAgent,
    sense,
    act,
    setOrder,
    setOrderAndWait,
    cancelOrder,
    getOrder,
    speak,
    whisper,
    inscribe,
    waitForChange,
    waitForWorld,
    reset,
    listRuns,
    restoreRun,
    setRealTime,
    setPaused,
    getAdminPayload,
    getMapPayload,
    getFogPayload,
    listScenarios,
    setScenarioActive,
    saveScenario,
    clearGmRules,
    joinAsGm: gmCommands.joinAsGm,
    gmInspect: gmCommands.gmInspect,
    gmRules: gmCommands.gmRules,
    gmAddRule: gmCommands.gmAddRule,
    gmDryRunRule: gmCommands.gmDryRunRule,
    gmRemoveRule: gmCommands.gmRemoveRule,
    gmPatchRule: gmCommands.gmPatchRule,
    gmSaveScenario,
    gmClearEdits,
    gmSetStock: gmCommands.gmSetStock,
    gmSetStockDefault: gmCommands.gmSetStockDefault,
    gmSpawnEntity: gmCommands.gmSpawnEntity,
    gmRegisterTerrain: gmCommands.gmRegisterTerrain,
    gmRegisterKindVisual: gmCommands.gmRegisterKindVisual,
    gmSetTerrain: gmCommands.gmSetTerrain,
    gmAnnounce: gmCommands.gmAnnounce,
  };
}

export type Colony = ReturnType<typeof createColony>;
