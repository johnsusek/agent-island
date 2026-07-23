import { box, formatDuration, joinColumns, overlay, padAnsi, palette, style, truncateAnsi, wrapText } from "./ansi.mjs";

export function renderDashboard(state, width, height) {
  if (width < 58 || height < 14) return renderTooSmall(width, height);
  let header = renderHeader(state, width);
  let footer = renderFooter(state, width);
  let contentHeight = height - 2;
  let rosterWidth = Math.min(36, Math.max(24, Math.floor(width * 0.27)));
  let logWidth = width - rosterWidth;
  let roster = renderRoster(state, rosterWidth, contentHeight);
  let transcript = renderTranscript(state, logWidth, contentHeight);
  let screen = [header, ...joinColumns([roster, transcript]), footer];
  if (!state.modal) return screen;
  return renderModal(screen, state.modal, width, height);
}

function renderHeader(state, width) {
  let world = state.snapshot?.world;
  if (!world)
    return padAnsi(
      style(" AGENT ISLAND · loading…", palette.bold, palette.brightCyan),
      width,
    );
  let status = world.ended
    ? "ENDED"
    : world.paused
      ? "PAUSED"
      : state.snapshot.online
        ? "RUNNING"
        : "OFFLINE";
  let statusColor = world.ended
    ? palette.red
    : world.paused
      ? palette.yellow
      : state.snapshot.online
        ? palette.green
        : palette.red;
  let clock =
    world.realTimeMs > 0
      ? `${(world.realTimeMs / 1000).toFixed(1)}s`
      : "lockstep";
  let worldId =
    world.worldId === "unknown" ? "unknown" : String(world.worldId).slice(0, 8);
  let elapsed = formatDuration(world.elapsedMs);
  let left = style(" AGENT ISLAND", palette.bold, palette.brightCyan);
  let details = ` · ${world.scenario} · ${worldId} · tick ${world.tick} · ${style(status, palette.bold, statusColor)} · ${clock} · ${elapsed}`;
  return padAnsi(`${left}${details}`, width);
}

function renderFooter(state, width) {
  let notice = state.notice;
  if (notice && notice.until > Date.now()) {
    let color =
      notice.kind === "error" ? palette.brightRed : palette.brightGreen;
    return padAnsi(style(` ${notice.text}`, color), width);
  }
  let follow = state.follow ? "follow:on" : "follow:off";
  let text = ` ↑↓ select  l launch  x stop  f filter  / search  Space ${follow}  w world  ? help  q quit`;
  return padAnsi(style(text, palette.inverse), width);
}

function renderRoster(state, width, height) {
  let seats = state.visibleSeats ?? [];
  let title = `Agents ${seats.length}/${state.snapshot?.seats.length ?? 0}`;
  let rows = [];
  let filterText = state.query
    ? `${state.filter} · /${state.query}`
    : state.filter;
  rows.push(style(`Filter: ${filterText}`, palette.gray));
  rows.push("");

  let directors = seats.filter((seat) => seat.role === "director");
  let characters = seats.filter((seat) => seat.role === "character");
  if (directors.length) {
    rows.push(style("DIRECTORS", palette.bold, palette.gray));
    for (let seat of directors)
      rows.push(rosterSeat(seat, seat.id === state.selectedId, width - 2));
    rows.push("");
  }
  rows.push(style("CHARACTERS", palette.bold, palette.gray));
  for (let seat of characters)
    rows.push(rosterSeat(seat, seat.id === state.selectedId, width - 2));
  if (!seats.length) rows.push(style("No matching agents", palette.gray));

  let available = height - 2;
  rows = windowAround(rows, available, state.selectedSeat?.name);
  return box(title, width, height, rows, { focused: true });
}

function rosterSeat(seat, selected, width) {
  let presentation = statusPresentation(seat.state);
  let statusWidth = Math.min(12, Math.max(7, Math.floor(width * 0.36)));
  let nameWidth = Math.max(4, width - statusWidth - 3);
  let action = seat.action ?? seat.pending;
  let status =
    seat.state === "scheduled" && Number.isFinite(seat.nextLaunchTick)
      ? `tick ${seat.nextLaunchTick}`
      : action && ["working", "waiting", "running"].includes(seat.state)
        ? action
        : seat.state;
  let line = `${style(presentation.icon, presentation.color)} ${padAnsi(seat.name, nameWidth)} ${padAnsi(status, statusWidth)}`;
  return selected
    ? style(truncateAnsi(line, width), palette.inverse)
    : truncateAnsi(line, width);
}

function renderTranscript(state, width, height) {
  let seat = state.selectedSeat;
  if (!seat)
    return box("Transcript", width, height, [
      style("Select an agent", palette.gray),
    ]);
  let mode = state.rawLogs ? "raw" : "rendered";
  let follow = state.follow ? "follow" : `-${state.logOffset}`;
  let identity = [seat.engine, seat.model, seat.effort]
    .filter(Boolean)
    .join("/");
  let cadence =
    seat.role === "director" && Number.isFinite(seat.cadenceTicks)
      ? seat.cadenceTicks > 0
        ? ` · every ${seat.cadenceTicks}t`
        : " · event-woken"
      : "";
  let title = `${seat.name}${cadence}${identity ? ` · ${identity}` : ""} · ${mode} · ${follow}`;
  let innerWidth = width - 2;
  let entries = seat.log?.entries ?? [];
  if (state.query) {
    let wanted = state.query.toLowerCase();
    entries = entries.filter((entry) =>
      `${entry.label} ${entry.text} ${entry.raw}`
        .toLowerCase()
        .includes(wanted),
    );
  }
  let lines = transcriptLines(entries, innerWidth, state.rawLogs);
  if (!lines.length)
    lines = [
      {
        text: style(
          seat.log ? "No matching transcript entries" : "No transcript yet",
          palette.gray,
        ),
        startsEntry: true,
      },
    ];
  let available = height - 2;
  let offset = state.follow ? 0 : state.logOffset;
  let end = Math.max(0, lines.length - offset);
  let start = Math.max(0, end - available);
  if (start > 0) {
    while (start < end && !lines[start].startsEntry) start += 1;
  }
  let visible = lines.slice(start, end).map((line) => line.text);
  if (start > 0 && visible.length) {
    visible = [
      style(`↑ ${start} earlier lines`, palette.gray),
      ...visible.slice(0, Math.max(0, available - 1)),
    ];
  }
  return box(title, width, height, visible);
}

function transcriptLines(entries, width, raw) {
  let lines = [];
  for (let entry of entries) {
    if (raw) {
      let wrappedRaw = wrapText(entry.raw, width);
      for (let index = 0; index < wrappedRaw.length; index += 1) {
        lines.push({
          text: style(wrappedRaw[index], palette.gray),
          startsEntry: index === 0,
        });
      }
      continue;
    }
    let color = entryColor(entry.kind);
    let labelWidth = Math.min(14, Math.max(8, Math.floor(width * 0.2)));
    let textWidth = Math.max(1, width - labelWidth - 1);
    let wrapped = wrapText(entry.text, textWidth);
    if (!wrapped.length) wrapped = [""];
    for (let index = 0; index < wrapped.length; index += 1) {
      let label = index === 0 ? truncateAnsi(entry.label, labelWidth) : "";
      lines.push({
        text: `${style(padAnsi(label, labelWidth), color)} ${wrapped[index]}`,
        startsEntry: index === 0,
      });
    }
  }
  return lines;
}

function renderModal(base, modal, width, height) {
  let modalWidth = Math.min(68, width - 6);
  let rows = [];
  if (modal.type === "help") {
    for (let paragraph of modal.text.split("\n"))
      rows.push(...wrapText(paragraph, modalWidth - 4));
  } else if (modal.type === "menu") {
    if (modal.message)
      rows.push(...wrapText(modal.message, modalWidth - 4), "");
    for (let index = 0; index < modal.items.length; index += 1) {
      let item = modal.items[index];
      let line = `${index === modal.selected ? "›" : " "} ${item.label}`;
      rows.push(index === modal.selected ? style(line, palette.inverse) : line);
    }
    rows.push("", style("↑↓ choose · Enter select · Esc cancel", palette.gray));
  } else if (modal.type === "form") {
    if (modal.message)
      rows.push(...wrapText(modal.message, modalWidth - 4), "");
    for (let index = 0; index < modal.fields.length; index += 1) {
      let field = modal.fields[index];
      let marker = index === modal.selected ? "›" : " ";
      let value = formValue(field);
      let line = `${marker} ${padAnsi(field.label, 14)} ${value}`;
      rows.push(index === modal.selected ? style(line, palette.inverse) : line);
    }
    rows.push(
      "",
      style(
        "Tab/↑↓ field · ←→ choice · Enter continue/submit · Esc cancel",
        palette.gray,
      ),
    );
  } else if (modal.type === "confirm") {
    rows.push(
      ...wrapText(modal.message, modalWidth - 4),
      "",
      style("Enter confirm · Esc cancel", palette.brightYellow),
    );
  }
  let modalHeight = Math.min(height - 4, Math.max(5, rows.length + 2));
  let rendered = box(modal.title, modalWidth, modalHeight, rows, {
    focused: true,
  });
  let left = Math.floor((width - modalWidth) / 2);
  let top = Math.floor((height - modalHeight) / 2);
  return overlay(base, rendered, left, top);
}

function formValue(field) {
  if (field.type === "choice") {
    let value = field.choices[field.choice] ?? "";
    if (field.key === "persona")
      value = value
        .split("-")
        .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
        .join(" ");
    return `< ${value} >`;
  }
  if (field.type === "boolean") return field.value ? "[x]" : "[ ]";
  let value = field.value ?? "";
  return value || style(field.placeholder ?? "", palette.gray);
}

function statusPresentation(status) {
  let values = {
    running: { icon: "●", color: palette.brightGreen },
    working: { icon: "●", color: palette.brightGreen },
    waiting: { icon: "●", color: palette.brightCyan },
    connected: { icon: "●", color: palette.green },
    connecting: { icon: "◐", color: palette.brightYellow },
    relaunching: { icon: "◐", color: palette.brightYellow },
    scheduled: { icon: "◷", color: palette.brightCyan },
    errored: { icon: "!", color: palette.brightRed },
    idle: { icon: "○", color: palette.gray },
    dead: { icon: "✕", color: palette.brightRed },
    stopped: { icon: "·", color: palette.gray },
  };
  return values[status] ?? values.stopped;
}

function entryColor(kind) {
  if (kind === "think") return palette.magenta;
  if (kind === "tool") return palette.yellow;
  if (kind === "result") return palette.green;
  if (kind === "file") return palette.blue;
  if (kind === "error") return palette.brightRed;
  if (kind === "meta") return palette.gray;
  return palette.cyan;
}

function windowAround(rows, height, selectedName) {
  if (rows.length <= height) return rows;
  let selectedIndex = rows.findIndex(
    (row) => selectedName && row.includes(selectedName),
  );
  if (selectedIndex < 0) return rows.slice(0, height);
  let start = Math.max(0, selectedIndex - Math.floor(height / 2));
  start = Math.min(start, rows.length - height);
  return rows.slice(start, start + height);
}

function renderTooSmall(width, height) {
  let message = "Agent Island needs a terminal at least 58×14.";
  let rows = Array.from({ length: height }, () => " ".repeat(width));
  let target = Math.max(0, Math.floor(height / 2));
  rows[target] = padAnsi(message, width, "center");
  return rows;
}
