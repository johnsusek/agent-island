import { helpDialog, searchDialog } from "./dialogs.js";
import { filterSeats, reconcileSelection } from "./presentation.js";
import { createOperatorScreen } from "./screen.js";
import type {
  Filter,
  OperatorOptions,
  OperatorRuntime,
  OperatorState,
} from "./types.js";

let filters: Filter[] = ["all", "running", "idle", "dead"];

export function createOperatorApp(
  options: OperatorOptions,
  runtime: OperatorRuntime,
) {
  let state: OperatorState = {
    detailScrollY: 0,
    detailView: "activity",
    filter: "all",
    follow: true,
    notice: null,
    query: "",
    selectedId: null,
    selectedLog: null,
    selectedSeat: null,
    snapshot: null,
    visibleSeats: [],
  };
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
      quit: stop,
      refresh,
      reportError,
      select,
      tail,
      toggleDetail,
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
      notice(errorMessage(error), 6000);
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

  async function openHelp(): Promise<void> {
    await withModal(() =>
      helpDialog(screen.getDocument(), screen.getTerminal(), {
        monochrome: options.monochrome,
      }),
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

  function notice(text: string, duration = 4000): void {
    state.notice = {
      kind: "error",
      text: text.replace(/\s+/g, " ").trim(),
      until: Date.now() + duration,
    };
    screen.update(state);
  }

  function reportError(error: unknown): void {
    notice(errorMessage(error), 6000);
  }

  return {
    refresh,
    run,
    stop,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
