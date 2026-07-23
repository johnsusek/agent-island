import { activateScenario, launchCrew, pauseWorld, personaNames, resetWorld, restoreRun, setClock, stopCrew } from "./actions.mjs";
import { enterScreen, leaveScreen, writeScreen } from "./ansi.mjs";
import { renderDashboard } from "./views.mjs";
import { defaultDirectorCadenceTicks, parseDirectorCadenceTicks, parseMaxTicks } from "../crew-policy.mjs";

let filters = ["all", "running", "idle", "dead"];

export function createOperatorApp(options, paths, runtime) {
  let state = {
    snapshot: null,
    visibleSeats: [],
    selectedId: null,
    selectedSeat: null,
    filter: "all",
    query: "",
    follow: true,
    logOffset: 0,
    rawLogs: false,
    modal: null,
    notice: null,
  };
  let context = { options, paths };
  let refreshing = false;
  let stopped = false;
  let refreshTimer = null;
  let renderTimer = null;
  let finishRun = null;

  async function refresh() {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      state.snapshot = await runtime.refresh();
      reconcileSelection(state, options.selectedName);
    } catch (error) {
      notice(errorMessage(error), "error", 6000);
    } finally {
      refreshing = false;
      render();
    }
  }

  function render() {
    if (stopped) return;
    if (state.snapshot?.world)
      state.snapshot.world.elapsedMs =
        Date.now() - state.snapshot.world.runStartedAt;
    let width = process.stdout.columns ?? 100;
    let height = process.stdout.rows ?? 30;
    writeScreen(renderDashboard(state, width, height), width, height);
  }

  function notice(text, kind = "success", duration = 4000) {
    state.notice = {
      text: String(text).replace(/\s+/g, " ").trim(),
      kind,
      until: Date.now() + duration,
    };
    render();
  }

  async function perform(task, successText) {
    state.modal = null;
    notice("Working…", "success", 30_000);
    try {
      let result = await task();
      notice(
        typeof successText === "function" ? successText(result) : successText,
      );
      await refresh();
    } catch (error) {
      notice(errorMessage(error), "error", 8000);
    }
  }

  function handleData(data) {
    for (let token of tokenizeInput(data)) {
      if (stopped) return;
      handleInput(token);
    }
  }

  function handleInput(data) {
    if (state.modal) {
      handleModalInput(data, state, { perform, context, refresh, render });
      return;
    }
    if (data === "\u0003" || data === "q") {
      stop();
      return;
    }
    if (data === "\x1b[A" || data === "k") moveSelection(state, -1);
    else if (data === "\x1b[B" || data === "j") moveSelection(state, 1);
    else if (data === "\x1b[5~") scrollLog(state, 12);
    else if (data === "\x1b[6~") scrollLog(state, -12);
    else if (data === "g") {
      state.follow = false;
      state.logOffset = 1_000_000;
    } else if (data === "G") {
      state.follow = true;
      state.logOffset = 0;
    } else if (data === " ") {
      state.follow = !state.follow;
      if (state.follow) state.logOffset = 0;
    } else if (data === "f") cycleFilter(state);
    else if (data === "/") openSearch(state);
    else if (data === "\x1b") {
      state.query = "";
      reconcileSelection(state);
    } else if (data === "l") openLaunch(state, context);
    else if (data === "x") openStopSelected(state, context, perform);
    else if (data === "X") openStopAll(state, context, perform);
    else if (data === "w") openWorldMenu(state);
    else if (data === "?") openHelp(state);
    else if (data === "v") state.rawLogs = !state.rawLogs;
    else if (data === "r") void refresh();
    render();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (refreshTimer) clearInterval(refreshTimer);
    if (renderTimer) clearInterval(renderTimer);
    process.stdin.off("data", handleData);
    process.stdout.off("resize", render);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    leaveScreen();
    finishRun?.();
  }

  async function run() {
    enterScreen();
    process.stdin.setEncoding("utf8");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", handleData);
    process.stdout.on("resize", render);
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    await refresh();
    refreshTimer = setInterval(() => void refresh(), options.refreshMs);
    renderTimer = setInterval(render, 1000);
    return new Promise((resolve) => {
      finishRun = resolve;
    });
  }

  return { run, stop, state, refresh, handleInput, handleData };
}

export function tokenizeInput(data) {
  let tokens = [];
  let remaining = String(data);
  let sequences = [
    "\x1b[5~",
    "\x1b[6~",
    "\x1b[A",
    "\x1b[B",
    "\x1b[C",
    "\x1b[D",
    "\x1b[Z",
  ];
  while (remaining) {
    let sequence = sequences.find((candidate) =>
      remaining.startsWith(candidate),
    );
    if (sequence) {
      tokens.push(sequence);
      remaining = remaining.slice(sequence.length);
      continue;
    }
    let character = Array.from(remaining)[0];
    tokens.push(character);
    remaining = remaining.slice(character.length);
  }
  return tokens;
}

export function filterSeats(seats, filter, query) {
  let wanted = query.trim().toLowerCase();
  return seats.filter((seat) => {
    if (
      filter === "running" &&
      ![
        "running",
        "working",
        "waiting",
        "connected",
        "connecting",
        "relaunching",
        "scheduled",
        "errored",
      ].includes(seat.state)
    )
      return false;
    if (filter === "idle" && seat.state !== "idle" && seat.state !== "stopped")
      return false;
    if (filter === "dead" && seat.state !== "dead") return false;
    if (!wanted) return true;
    let identity = `${seat.name} ${seat.role} ${seat.state} ${seat.engine ?? ""} ${seat.model ?? ""}`;
    let transcript = (seat.log?.entries ?? [])
      .map((entry) => `${entry.label} ${entry.text}`)
      .join(" ");
    return `${identity} ${transcript}`.toLowerCase().includes(wanted);
  });
}

export function reconcileSelection(state, preferredName = null) {
  state.visibleSeats = filterSeats(
    state.snapshot?.seats ?? [],
    state.filter,
    state.query,
  );
  let selected = state.visibleSeats.find(
    (seat) => seat.id === state.selectedId,
  );
  if (!selected && preferredName) {
    let wanted = preferredName.toLowerCase();
    selected = state.visibleSeats.find(
      (seat) =>
        seat.name.toLowerCase() === wanted ||
        seat.name.toLowerCase().startsWith(wanted),
    );
  }
  selected ??= state.visibleSeats[0] ?? null;
  state.selectedId = selected?.id ?? null;
  state.selectedSeat = selected;
}

function moveSelection(state, direction) {
  if (!state.visibleSeats.length) return;
  let current = state.visibleSeats.findIndex(
    (seat) => seat.id === state.selectedId,
  );
  let next = Math.max(
    0,
    Math.min(state.visibleSeats.length - 1, current + direction),
  );
  state.selectedSeat = state.visibleSeats[next];
  state.selectedId = state.selectedSeat.id;
  state.follow = true;
  state.logOffset = 0;
}

function scrollLog(state, amount) {
  state.follow = false;
  state.logOffset = Math.max(0, state.logOffset + amount);
  if (state.logOffset === 0) state.follow = true;
}

function cycleFilter(state) {
  let index = filters.indexOf(state.filter);
  state.filter = filters[(index + 1) % filters.length];
  reconcileSelection(state);
}

function openSearch(state) {
  state.modal = {
    type: "form",
    title: "Search",
    selected: 0,
    fields: [
      {
        key: "query",
        label: "Filter",
        type: "text",
        value: state.query,
        placeholder: "name, state, model, or transcript text",
      },
    ],
    submit: (values) => {
      state.query = values.query.trim();
      state.modal = null;
      reconcileSelection(state);
    },
  };
}

export function createLaunchModal(personas = {}) {
  let characterPersonas = personas.characters?.length
    ? personas.characters
    : ["character-minimal"];
  return {
    type: "form",
    title: "Launch agents",
    selected: 0,
    fields: [
      {
        key: "role",
        label: "Role",
        type: "choice",
        choices: ["character", "director"],
        choice: 0,
      },
      {
        key: "names",
        label: "Names",
        type: "text",
        value: "",
        placeholder: "auto-pick",
      },
      { key: "count", label: "Seats", type: "text", value: "1" },
      {
        key: "engine",
        label: "Engine",
        type: "choice",
        choices: ["claude", "codex"],
        choice: 0,
      },
      {
        key: "model",
        label: "Model",
        type: "choice",
        choices: ["fable", "opus", "sonnet", "haiku"],
        choice: 3,
      },
      {
        key: "effort",
        label: "Effort",
        type: "choice",
        choices: ["low", "medium", "high", "xhigh", "max"],
        choice: 0,
      },
      {
        key: "persona",
        label: "Persona",
        type: "choice",
        choices: characterPersonas,
        choice: Math.max(0, characterPersonas.indexOf("character-minimal")),
      },
      {
        key: "maxTicks",
        label: "Run ticks",
        type: "text",
        value: "2000",
        placeholder: "off",
      },
      { key: "ocean", label: "OCEAN", type: "boolean", value: true },
      {
        key: "instructions",
        label: "Instructions",
        type: "text",
        value: "",
        placeholder: "optional",
      },
    ],
  };
}

function openLaunch(state, context) {
  let personas = {
    characters: personaNames(context.paths.characterPersonasDir),
    directors: personaNames(context.paths.directorPersonasDir),
  };
  if (!personas.characters.length) personas.characters = ["character-minimal"];
  if (!personas.directors.length) personas.directors = ["oracle"];
  let modal = createLaunchModal(personas);
  modal.submit = (values, helpers) => {
    let count = Number(values.count);
    if (
      values.role === "character" &&
      !values.names &&
      (!Number.isFinite(count) || count < 1)
    ) {
      helpers.notice("Seats must be at least 1.", "error", 5000);
      return;
    }
    try {
      parseMaxTicks(values.maxTicks);
      if (values.role === "director")
        parseDirectorCadenceTicks(values.cadenceTicks, values.persona);
    } catch (error) {
      helpers.notice(errorMessage(error).replace(/^--/, ""), "error", 5000);
      return;
    }
    void helpers.perform(
      () => launchCrew({ ...values, count }, helpers.context),
      (result) =>
        `${result.role} launched · pid ${result.pid} · ${result.file}`,
    );
  };
  modal.change = (field, values) => {
    let role = values.role;
    let engine = values.engine;
    if (field.key === "engine") {
      configureModelField(modal, engine, role);
      return;
    }
    if (field.key === "persona") {
      if (role === "director") setDirectorCadenceField(modal, values.persona);
      return;
    }
    if (field.key === "names") {
      if (role === "director") {
        let typed = String(values.names ?? "").trim().toLowerCase();
        let match = personas.directors.find(
          (candidate) => candidate.toLowerCase() === typed,
        );
        if (match) setField(modal, "persona", match);
      }
      return;
    }
    if (field.key !== "role") return;
    let personaField = modal.fields.find(
      (candidate) => candidate.key === "persona",
    );
    personaField.label = role === "director" ? "Director" : "Persona";
    personaField.choices =
      role === "director" ? personas.directors : personas.characters;
    personaField.choice = Math.max(
      0,
      personaField.choices.indexOf(
        role === "director" ? "oracle" : "character-minimal",
      ),
    );
    setField(modal, "effort", role === "director" ? "medium" : "low");
    if (engine === "codex") configureModelField(modal, engine, role);
    configureLaunchRoleFields(modal, role, fieldValue(personaField));
    let names = fieldValue(
      modal.fields.find((candidate) => candidate.key === "names"),
    );
    if (role === "director" && !names) setField(modal, "names", "Oracle");
    if (role === "character" && names === "Oracle")
      setField(modal, "names", "");
  };
  if (state.selectedSeat?.role === "director") {
    setField(modal, "role", "director");
    modal.change({ key: "role" }, formValues(modal));
    setField(modal, "persona", state.selectedSeat.persona);
    modal.change({ key: "persona" }, formValues(modal));
    setField(modal, "names", state.selectedSeat.name);
  }
  state.modal = modal;
}

function openStopSelected(state, context, perform) {
  let seat = state.selectedSeat;
  if (!seat?.processRunning) {
    state.notice = {
      text: seat
        ? `${seat.name} has no supervised process.`
        : "No agent selected.",
      kind: "error",
      until: Date.now() + 4000,
    };
    return;
  }
  let batch = state.snapshot.seats
    .filter(
      (candidate) => seat.role === "character" && candidate.pid === seat.pid,
    )
    .map((candidate) => candidate.name);
  let description =
    seat.role === "director"
      ? `Stop and drain ${seat.name}?`
      : batch.length > 1
        ? `Stop ${seat.name}'s whole batch: ${batch.join(", ")}?`
        : `Stop and drain ${seat.name}?`;
  state.modal = {
    type: "confirm",
    title: "Stop agent",
    message: description,
    confirm: () =>
      void perform(
        () =>
          stopCrew(
            seat.role === "director" ? "director" : "characters",
            seat.name,
            context,
          ),
        (result) => result || `${seat.name} stopping`,
      ),
  };
}

function openStopAll(state, context, perform) {
  state.modal = {
    type: "confirm",
    title: "Stop all crews",
    message:
      "Drain every supervised director and character? The world keeps its current clock state.",
    confirm: () =>
      void perform(
        () => stopCrew(null, null, context),
        (result) => result || "All crews stopping",
      ),
  };
}

function openWorldMenu(state) {
  let paused = state.snapshot?.world.paused;
  state.modal = {
    type: "menu",
    title: "World operations",
    selected: 0,
    items: [
      {
        label: paused ? "Resume world" : "Pause world",
        action: paused ? "resume" : "pause",
      },
      { label: "Set clock cadence", action: "clock" },
      { label: "Activate scenario", action: "scenario" },
      { label: "Restore archived run", action: "restore" },
      { label: "Reset world", action: "reset" },
    ],
  };
}

function openHelp(state) {
  state.modal = {
    type: "help",
    title: "Console keys",
    text: [
      "↑/↓ or j/k   Select agent",
      "PgUp/PgDn    Scroll transcript; G returns to live tail",
      "l             Launch character or director crews",
      "x / X         Stop selected batch / stop all crews",
      "f             Cycle all, running, idle, and dead agents",
      "/             Search roster and selected transcript",
      "Space         Pause or resume transcript following",
      "v             Toggle rendered and raw JSONL",
      "w             World operations",
      "r             Refresh immediately",
      "q             Leave console; crews continue running",
      "",
      "Esc or Enter closes this help.",
    ].join("\n"),
  };
}

function handleModalInput(data, state, helpers) {
  let modal = state.modal;
  if (data === "\u0003") {
    state.modal = null;
    helpers.render();
    return;
  }
  if (data === "\x1b") {
    state.modal = null;
    helpers.render();
    return;
  }
  if (modal.type === "help") {
    if (data === "\r" || data === "?" || data === "q") state.modal = null;
    helpers.render();
    return;
  }
  if (modal.type === "confirm") {
    if (data === "\r") modal.confirm();
    helpers.render();
    return;
  }
  if (modal.type === "menu") {
    if (data === "\x1b[A" || data === "k")
      modal.selected = Math.max(0, modal.selected - 1);
    else if (data === "\x1b[B" || data === "j")
      modal.selected = Math.min(modal.items.length - 1, modal.selected + 1);
    else if (data === "\r")
      handleMenu(modal.items[modal.selected], state, helpers);
    helpers.render();
    return;
  }
  if (modal.type !== "form") return;
  let field = modal.fields[modal.selected];
  if (data === "\t" || data === "\x1b[B")
    modal.selected = (modal.selected + 1) % modal.fields.length;
  else if (data === "\x1b[Z" || data === "\x1b[A")
    modal.selected =
      (modal.selected - 1 + modal.fields.length) % modal.fields.length;
  else if (data === "\x1b[D") changeChoice(field, -1);
  else if (data === "\x1b[C") changeChoice(field, 1);
  else if (data === " " && field.type === "boolean") field.value = !field.value;
  else if (data === "\u007f" && field.type === "text")
    field.value = Array.from(field.value).slice(0, -1).join("");
  else if (data === "\r") {
    if (modal.selected < modal.fields.length - 1) modal.selected += 1;
    else
      modal.submit?.(formValues(modal), {
        ...helpers,
        notice: (text, kind, duration) => {
          state.notice = { text, kind, until: Date.now() + duration };
        },
      });
  } else if (field.type === "text" && printable(data)) field.value += data;
  modal.change?.(field, formValues(modal));
  helpers.render();
}

function handleMenu(item, state, helpers) {
  if (!item) return;
  if (item.action === "pause" || item.action === "resume") {
    let paused = item.action === "pause";
    void helpers.perform(
      () => pauseWorld(paused, helpers.context),
      paused ? "World paused" : "World resumed",
    );
    return;
  }
  if (item.action === "clock") {
    state.modal = {
      type: "form",
      title: "Clock cadence",
      message: "Milliseconds per tick. Use 0 for lockstep.",
      selected: 0,
      fields: [
        {
          key: "milliseconds",
          label: "Milliseconds",
          type: "text",
          value: String(state.snapshot.world.realTimeMs),
        },
      ],
      submit: (values) => {
        let milliseconds = Number(values.milliseconds);
        if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
        void helpers.perform(
          () => setClock(milliseconds, helpers.context),
          milliseconds
            ? `Clock set to ${milliseconds} ms`
            : "Clock set to lockstep",
        );
      },
    };
    return;
  }
  if (item.action === "scenario") {
    let scenarios = state.snapshot.scenarios?.scenarios ?? [];
    state.modal = {
      type: "menu",
      title: "Activate scenario",
      message: "Activating a scenario archives and resets the current world.",
      selected: 0,
      items: scenarios.map((scenario) => ({
        label: `${scenario.active ? "●" : "○"} ${scenario.name}`,
        action: "scenario-name",
        value: scenario.name,
      })),
    };
    return;
  }
  if (item.action === "scenario-name") {
    state.modal = {
      type: "confirm",
      title: "Activate scenario",
      message: `Archive the current world and activate ${item.value}? Running crews should be stopped first.`,
      confirm: () =>
        void helpers.perform(
          () => activateScenario(item.value, helpers.context),
          `Scenario ${item.value} active`,
        ),
    };
    return;
  }
  if (item.action === "restore") {
    let runs = state.snapshot.runs ?? [];
    state.modal = {
      type: "menu",
      title: "Restore archived run",
      message: runs.length
        ? "Restoring first archives the current world."
        : "No archived runs.",
      selected: 0,
      items: runs.slice(0, 30).map((run) => ({
        label: `${run.runId} · ${run.scenario} · tick ${run.tick}`,
        action: "restore-run",
        value: run.runId,
      })),
    };
    return;
  }
  if (item.action === "restore-run") {
    state.modal = {
      type: "confirm",
      title: "Restore run",
      message: `Archive the current world and restore ${item.value}? Stop running crews first.`,
      confirm: () =>
        void helpers.perform(
          () => restoreRun(item.value, helpers.context),
          `Restored ${item.value}`,
        ),
    };
    return;
  }
  if (item.action === "reset") {
    state.modal = {
      type: "form",
      title: "Reset world",
      message:
        "The current world is archived. Character and director memories are wiped. Leave dimensions blank for defaults.",
      selected: 0,
      fields: [
        {
          key: "width",
          label: "Width",
          type: "text",
          value: "",
          placeholder: "default",
        },
        {
          key: "height",
          label: "Height",
          type: "text",
          value: "",
          placeholder: "default",
        },
      ],
      submit: (values) => {
        state.modal = {
          type: "confirm",
          title: "Confirm reset",
          message: "Archive and reset the world now? Stop running crews first.",
          confirm: () =>
            void helpers.perform(
              () => resetWorld(values, helpers.context),
              "World reset",
            ),
        };
      },
    };
  }
}

function formValues(modal) {
  return Object.fromEntries(
    modal.fields.map((field) => [field.key, fieldValue(field)]),
  );
}

function fieldValue(field) {
  if (!field) return "";
  if (field.type === "choice") return field.choices[field.choice];
  return field.value;
}

function setField(modal, key, value) {
  let field = modal.fields.find((candidate) => candidate.key === key);
  if (!field) return;
  if (field.type === "choice") {
    let choice = field.choices.indexOf(value);
    if (choice >= 0) field.choice = choice;
    return;
  }
  field.value = value;
}

function setDirectorCadenceField(modal, persona, visible = true) {
  let index = modal.fields.findIndex(
    (candidate) => candidate.key === "cadenceTicks",
  );
  if (!visible) {
    if (index >= 0) modal.fields.splice(index, 1);
    return;
  }
  let value = String(defaultDirectorCadenceTicks(persona));
  if (index >= 0) {
    modal.fields[index].value = value;
    return;
  }
  let personaIndex = modal.fields.findIndex(
    (candidate) => candidate.key === "persona",
  );
  modal.fields.splice(personaIndex + 1, 0, {
    key: "cadenceTicks",
    label: "Cadence ticks",
    type: "text",
    value,
    placeholder: "0 = event-woken",
  });
}

export function configureLaunchRoleFields(modal, role, persona) {
  let names = modal.fields.find((candidate) => candidate.key === "names");
  names.label = role === "director" ? "Name" : "Names";
  names.placeholder = role === "director" ? "director name" : "auto-pick";
  if (role === "director") {
    modal.fields = modal.fields.filter(
      (field) => field.key !== "count" && field.key !== "ocean",
    );
    setDirectorCadenceField(modal, persona);
    return;
  }
  setDirectorCadenceField(modal, persona, false);
  insertFieldAfter(modal, "names", {
    key: "count",
    label: "Seats",
    type: "text",
    value: "1",
  });
  insertFieldAfter(modal, "maxTicks", {
    key: "ocean",
    label: "OCEAN",
    type: "boolean",
    value: true,
  });
}

function insertFieldAfter(modal, key, field) {
  if (modal.fields.some((candidate) => candidate.key === field.key)) return;
  let index = modal.fields.findIndex((candidate) => candidate.key === key);
  modal.fields.splice(index + 1, 0, field);
}

function configureModelField(modal, engine, role) {
  let field = modal.fields.find((candidate) => candidate.key === "model");
  if (!field) return;
  if (engine === "claude") {
    field.type = "choice";
    field.choices = ["fable", "opus", "sonnet", "haiku"];
    field.choice = 3;
    delete field.value;
    return;
  }
  field.type = "text";
  field.value = role === "director" ? "gpt-5.6-luna" : "gpt-5.4-mini";
  delete field.choices;
  delete field.choice;
}

function changeChoice(field, direction) {
  if (field.type === "boolean") {
    field.value = !field.value;
    return;
  }
  if (field.type !== "choice") return;
  field.choice =
    (field.choice + direction + field.choices.length) % field.choices.length;
}

function printable(data) {
  return (
    !data.includes("\x1b") &&
    !data.includes("\r") &&
    !data.includes("\n") &&
    Array.from(data).every((character) => character >= " ")
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
