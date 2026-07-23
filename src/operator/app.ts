import {
  activateScenario,
  launchCrew,
  pauseWorld,
  parseResetDimensions,
  resetWorld,
  restoreRun,
  setClock,
  stopCrew,
} from "./actions.js";
import {
  choiceDialog,
  confirmDialog,
  dimensionsDialog,
  helpDialog,
  launchWizard,
  searchDialog,
  valueDialog,
  worldChoice,
} from "./dialogs.js";
import { personaNames } from "./actions.js";
import { filterSeats, reconcileSelection } from "./presentation.js";
import { createOperatorScreen } from "./screen.js";
import type {
  ActionContext,
  Filter,
  OperatorOptions,
  OperatorPaths,
  OperatorRuntime,
  OperatorState,
} from "./types.js";

let filters: Filter[] = ["all", "running", "idle", "dead"];

export function createOperatorApp(
  options: OperatorOptions,
  paths: OperatorPaths,
  runtime: OperatorRuntime,
) {
  let state: OperatorState = {
    detailScrollY: 0,
    detailView: "activity",
    filter: "all",
    follow: true,
    notice: null,
    query: "",
    rawLogs: false,
    selectedId: null,
    selectedLog: null,
    selectedSeat: null,
    snapshot: null,
    visibleSeats: [],
  };
  let context: ActionContext = { options, paths };
  let stopped = false;
  let refreshing = false;
  let refreshTimer: NodeJS.Timeout | null = null;
  let resolveRun: (() => void) | null = null;

  let screen = createOperatorScreen(
    state,
    {
      cycleFilter,
      find: openFind,
      help: openHelp,
      launch: openLaunch,
      quit: stop,
      refresh,
      reportError,
      select,
      stopAll: openStopAll,
      stopSelected: openStopSelected,
      tail,
      toggleDetail,
      toggleRaw,
      world: openWorld,
    },
    options.monochrome,
  );

  async function run(): Promise<void> {
    screen.start();
    await refresh();
    refreshTimer = setInterval(() => void refresh(), options.refreshMs);
    return new Promise((resolve) => {
      resolveRun = resolve;
    });
  }

  async function refresh(): Promise<void> {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      state.snapshot = await runtime.refresh();
      reconcile();
      loadSelectedLog();
      screen.update(state);
    } catch (error) {
      notice(errorMessage(error), "error", 6000);
    } finally {
      refreshing = false;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (refreshTimer) clearInterval(refreshTimer);
    screen.stop();
    resolveRun?.();
  }

  function select(seatId: string): void {
    if (state.selectedId === seatId) return;
    state.selectedId = seatId;
    state.selectedSeat =
      state.visibleSeats.find((seat) => seat.id === seatId) ?? null;
    state.follow = true;
    state.detailScrollY = 0;
    loadSelectedLog();
    screen.update(state);
  }

  function reconcile(): void {
    if (!state.snapshot) return;
    state.visibleSeats = filterSeats(
      state.snapshot.seats,
      state.filter,
      state.query,
      state.selectedId,
      state.selectedLog,
    );
    state.selectedSeat = reconcileSelection(
      state.visibleSeats,
      state.selectedId,
      options.selectedName,
    );
    state.selectedId = state.selectedSeat?.id ?? null;
  }

  function loadSelectedLog(): void {
    state.selectedLog = state.selectedSeat
      ? runtime.logView(state.selectedSeat.seatDir)
      : null;
  }

  function toggleDetail(): void {
    state.detailView = state.detailView === "activity" ? "memory" : "activity";
    state.detailScrollY = 0;
    screen.update(state);
  }

  function toggleRaw(): void {
    if (state.detailView !== "activity") return;
    state.rawLogs = !state.rawLogs;
    screen.update(state);
  }

  function tail(): void {
    state.follow = true;
    state.detailScrollY = 0;
    screen.update(state);
    screen.tail();
  }

  function cycleFilter(): void {
    let currentIndex = filters.indexOf(state.filter);
    state.filter = filters[(currentIndex + 1) % filters.length] ?? "all";
    reconcile();
    loadSelectedLog();
    screen.update(state);
  }

  async function openLaunch(): Promise<void> {
    let form = await withModal(() =>
      launchWizard(
        screen.getDocument(),
        screen.getTerminal(),
        {
          characters: personaNames(paths.characterPersonasDir),
          directors: personaNames(paths.directorPersonasDir),
        },
        state.selectedSeat,
        { monochrome: options.monochrome },
      ),
    );
    if (!form) return;
    await perform(async () => {
      let result = await launchCrew(form, context);
      return `Launched ${result.role} crew · pid ${result.pid ?? "unknown"}`;
    }, 1200);
  }

  async function openFind(): Promise<void> {
    let query = await withModal(() =>
      searchDialog(screen.getDocument(), screen.getTerminal(), state.query, {
        monochrome: options.monochrome,
      }),
    );
    if (query === null) return;
    state.query = query;
    reconcile();
    loadSelectedLog();
    screen.update(state);
  }

  async function openStopSelected(): Promise<void> {
    let seat = state.selectedSeat;
    if (!seat?.processRunning) {
      notice("Selected agent has no running crew.", "error");
      return;
    }
    let confirmed = await withModal(() =>
      confirmDialog(
        screen.getDocument(),
        screen.getTerminal(),
        "Stop crew",
        `Stop ${seat.name}?`,
        { monochrome: options.monochrome },
      ),
    );
    if (!confirmed) return;
    await perform(async () => {
      let output = await stopCrew(seat.role, seat.name, context);
      return output || `Stopped ${seat.name}.`;
    }, 800);
  }

  async function openStopAll(): Promise<void> {
    let confirmed = await withModal(() =>
      confirmDialog(
        screen.getDocument(),
        screen.getTerminal(),
        "Stop all crews",
        "Stop every character and Director crew?",
        { monochrome: options.monochrome },
      ),
    );
    if (!confirmed) return;
    await perform(
      async () =>
        (await stopCrew("all", null, context)) || "Stopped all crews.",
      800,
    );
  }

  async function openWorld(): Promise<void> {
    let choice = await withModal(() =>
      worldChoice(screen.getDocument(), screen.getTerminal(), {
        monochrome: options.monochrome,
      }),
    );
    if (!choice || !state.snapshot) return;
    if (choice === "pause") {
      let paused = !state.snapshot.world.paused;
      await perform(async () => {
        await pauseWorld(paused, context);
        return paused ? "World paused." : "World resumed.";
      });
      return;
    }
    if (choice === "clock") {
      let value = await promptValue("Set clock", "Milliseconds", "1000");
      if (value === null) return;
      let realTimeMs = Number(value);
      if (!Number.isFinite(realTimeMs) || realTimeMs <= 0) {
        notice("Clock must be a positive number.", "error");
        return;
      }
      await perform(async () => {
        await setClock(realTimeMs, context);
        return `Clock set to ${realTimeMs}ms.`;
      });
      return;
    }
    if (choice === "scenario") {
      let scenarios = state.snapshot.scenarios.scenarios ?? [];
      let name = await promptChoice(
        "Activate scenario",
        scenarios.map((scenario) => ({
          content: scenario.name,
          value: scenario.name,
        })),
      );
      if (!name) return;
      await perform(async () => {
        await activateScenario(name, context);
        return `Activated ${name}.`;
      });
      return;
    }
    if (choice === "restore") {
      let runs = state.snapshot.runs.filter((run) => run.runId);
      let runId = await promptChoice(
        "Restore run",
        runs.map((run) => ({
          content: String(run.runId),
          value: String(run.runId),
        })),
      );
      if (!runId) return;
      await perform(async () => {
        await restoreRun(runId, context);
        return `Restored ${runId}.`;
      }, 1000);
      return;
    }
    if (choice === "reset") await openReset();
  }

  async function openReset(): Promise<void> {
    let dimensions = await withModal(() =>
      dimensionsDialog(screen.getDocument(), screen.getTerminal(), {
        monochrome: options.monochrome,
      }),
    );
    if (!dimensions) return;
    let parsedDimensions;
    try {
      parsedDimensions = parseResetDimensions(dimensions);
    } catch (error) {
      reportError(error);
      return;
    }
    let confirmed = await withModal(() =>
      confirmDialog(
        screen.getDocument(),
        screen.getTerminal(),
        "Reset world",
        "Reset the world and wipe character memory?",
        { monochrome: options.monochrome },
      ),
    );
    if (!confirmed) return;
    await perform(async () => {
      await resetWorld(parsedDimensions, context);
      return "World reset.";
    }, 1200);
  }

  async function openHelp(): Promise<void> {
    await withModal(() =>
      helpDialog(screen.getDocument(), screen.getTerminal(), {
        monochrome: options.monochrome,
      }),
    );
  }

  async function promptValue(
    title: string,
    label: string,
    value: string,
  ): Promise<string | null> {
    return withModal(() =>
      valueDialog(
        screen.getDocument(),
        screen.getTerminal(),
        title,
        label,
        value,
        { monochrome: options.monochrome },
      ),
    );
  }

  async function promptChoice(
    title: string,
    choices: { content: string; value: string }[],
  ): Promise<string | null> {
    if (!choices.length) {
      notice(`No ${title.toLowerCase()} options.`, "error");
      return null;
    }
    return withModal(() =>
      choiceDialog(
        screen.getDocument(),
        screen.getTerminal(),
        title,
        choices,
        null,
        { monochrome: options.monochrome },
      ),
    );
  }

  async function withModal<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    screen.setModal(true);
    try {
      return await operation();
    } finally {
      screen.setModal(false);
    }
  }

  async function perform(
    operation: () => Promise<string>,
    refreshDelay = 0,
  ): Promise<void> {
    try {
      let message = await operation();
      notice(message || "Done.");
      if (refreshDelay)
        await new Promise((resolve) => setTimeout(resolve, refreshDelay));
      await refresh();
    } catch (error) {
      notice(errorMessage(error), "error", 6000);
    }
  }

  function notice(
    text: string,
    kind: "error" | "success" = "success",
    duration = 4000,
  ): void {
    state.notice = {
      kind,
      text: text.replace(/\s+/g, " ").trim(),
      until: Date.now() + duration,
    };
    screen.update(state);
  }

  function reportError(error: unknown): void {
    notice(errorMessage(error), "error", 6000);
  }

  return {
    refresh,
    run,
    select,
    state,
    stop,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
