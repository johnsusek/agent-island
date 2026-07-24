import type { Filter, LogEntry, OperatorSnapshot, Seat } from "./types.js";

export function filterSeats(
  seats: Seat[],
  filter: Filter,
  query: string,
  selectedId: string | null = null,
  selectedLog: { entries: LogEntry[] } | null = null,
): Seat[] {
  let wanted = query.trim().toLowerCase();
  return seats.filter((seat) => {
    if (filter === "running" && !seat.processRunning) return false;
    if (
      filter === "idle" &&
      !["idle", "scheduled", "stopped"].includes(seat.state)
    )
      return false;
    if (filter === "dead" && seat.state !== "dead") return false;
    if (!wanted) return true;
    let entries = seat.log?.entries ?? [];
    if (seat.id === selectedId && selectedLog)
      entries = [...entries, ...selectedLog.entries];
    let transcript = entries
      .map((entry) => `${entry.label} ${entry.text}`)
      .join(" ");
    let identity = [
      seat.name,
      seat.role,
      seat.state,
      seat.engine,
      seat.model,
      seat.effort,
    ].join(" ");
    return `${identity} ${transcript} ${seat.memory ?? ""}`
      .toLowerCase()
      .includes(wanted);
  });
}

export function reconcileSelection(
  visibleSeats: Seat[],
  selectedId: string | null,
  preferredName: string | null = null,
): Seat | null {
  let selected = visibleSeats.find((seat) => seat.id === selectedId);
  if (selected) return selected;
  let preferred = preferredName?.toLowerCase();
  if (preferred) {
    selected = visibleSeats.find(
      (seat) => seat.name.toLowerCase() === preferred,
    );
    if (selected) return selected;
  }
  return visibleSeats[0] ?? null;
}

export function rosterItems(seats: Seat[], width: number) {
  let items: {
    content: string;
    disabled?: boolean;
    value: string;
  }[] = [];
  let roles: ("character" | "director")[] = ["director", "character"];
  for (let role of roles) {
    let roleSeats = seats.filter((seat) => seat.role === role);
    if (!roleSeats.length) continue;
    items.push({
      content: role === "director" ? "DIRECTORS" : "CHARACTERS",
      disabled: true,
      value: `heading:${role}`,
    });
    for (let seat of roleSeats) {
      let stateWidth = Math.min(12, Math.max(7, width - 17));
      let nameWidth = Math.max(7, width - stateWidth - 3);
      items.push({
        content: ` ${truncate(seat.name, nameWidth).padEnd(nameWidth)} ${truncate(seat.state, stateWidth)}`,
        value: seat.id,
      });
    }
  }
  return items;
}

export function detailText(
  seat: Seat | null,
  view: "activity" | "memory",
  selectedEntries: LogEntry[] | null,
  query: string,
): string {
  if (!seat) return "Select an agent.";
  if (view === "memory") return filteredMemory(seat.memory, query);
  let entries = selectedEntries ?? seat.log?.entries ?? [];
  let wanted = query.toLowerCase();
  if (wanted)
    entries = entries.filter((entry) =>
      `${entry.label} ${entry.text}`.toLowerCase().includes(wanted),
    );
  if (!entries.length)
    return seat.log ? "No matching activity." : "No activity yet.";
  return entries
    .map((entry) => {
      let timestamp = entry.timestamp
        ? new Date(entry.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "     ";
      return `${timestamp} ${entry.label.padEnd(12)} ${entry.text}`.trimEnd();
    })
    .join("\n\n");
}

export function headerText(snapshot: OperatorSnapshot | null): string {
  if (!snapshot) return " Agent Island · connecting…";
  let world = snapshot.world;
  let status = world.ended
    ? "ENDED"
    : world.paused
      ? "PAUSED"
      : snapshot.online
        ? "ONLINE"
        : "OFFLINE";
  return ` Agent Island · Logs · ${world.scenario} · tick ${world.tick} · ${status}`;
}

export function seatHeading(seat: Seat | null): string {
  if (!seat) return "No agent selected";
  let identity = [seat.state, seat.engine, seat.model, seat.effort]
    .filter(Boolean)
    .join(" · ");
  let cadence =
    seat.role === "director" && seat.cadenceTicks !== null
      ? seat.cadenceTicks
        ? ` · cadence ${seat.cadenceTicks}`
        : " · event cadence"
      : "";
  return ` ${seat.name} · ${identity}${cadence}`;
}

function filteredMemory(memory: string | null, query: string): string {
  if (!memory) return "No memory yet.";
  if (!query) return memory;
  let wanted = query.toLowerCase();
  let lines = memory
    .split("\n")
    .filter((line) => line.toLowerCase().includes(wanted));
  return lines.length ? lines.join("\n") : "No matching memory.";
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return width > 1 ? `${value.slice(0, width - 1)}…` : value.slice(0, width);
}
