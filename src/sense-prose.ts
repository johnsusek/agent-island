// The prose half of the sense verb: one renderer family shared by every sense
// mode AND the wait_for_change wake report, so agents learn a single format
// and can re-orient from any one message. Canon (docs/sense-design.md):
// salience order (threats/pressing first, then order-relevant, then ambient),
// every fact wearing its age, no coordinates in prose, and a
// closure line - to an LLM, silence is ambiguous ("didn't look? nothing
// there?"), so absence is stated outright. Live sight is the ASCII map alone;
// tile-and-compass wording is reserved for remembered knowledge (find, atlas,
// route, frontier) that lies beyond the map's edge.
// Token budgets are design constraints: wake ~120 tokens, surroundings ~250,
// atlas ~400. This layer is the WHOLE character message - the tool surface
// sends no structuredContent, so a fact that doesn't reach prose here reaches
// the player nowhere.

import { bandedStocks, bandSentence, carriedStocks } from "./rules/vitals.js";

type Dict = Record<string, any>;

function span(distance: number, direction: string): string {
  if (!direction || direction === "here") return "here";
  return `${distance} ${distance === 1 ? "tile" : "tiles"} ${direction}`;
}

function age(ticksAgo: number | undefined): string {
  if (ticksAgo === undefined) return "";
  if (ticksAgo === 0) return "seen just now";
  return `seen ${ticksAgo} ${ticksAgo === 1 ? "tick" : "ticks"} ago`;
}

// "riverside-grove [seen 40 ticks ago]"
function provenance(l: Dict): string {
  if (l.kind === "terrain") return "";
  return ` [${age(l.lastSeenTicksAgo)}]`;
}

function kindOf(l: Dict): string {
  let tags = (l.tags ?? []).filter((t: string) => t !== "token");
  // Lead with the entity's kind (its identity), then any extra tags. The
  // "terrain" kind marks a synthetic terrain destination, not an identity.
  let names =
    l.kind && l.kind !== "terrain" ? [...new Set([l.kind, ...tags])] : tags;
  return names.length ? names.join("/") : "token";
}

// One atlas/find line: name, kind, bearing, live reserve if truly live.
function placeLine(l: Dict): string {
  let reserve =
    l.remaining !== undefined
      ? `: ${l.resource} ${l.remaining}/${l.capacity} (live)`
      : "";
  return `${l.name} (${kindOf(l)}), ${span(l.distance, l.direction)}${reserve}${provenance(l)}`;
}

// The vitals digest: only the gauges in trouble, in the scenario's own words,
// worst first. A figure never appears - see rules/vitals.ts for why.
//
// Silence would be ambiguous ("nothing wrong? or nothing looked at?"), so a
// character with nothing pressing is told so outright, in one short clause.
function vitals(stocks: Dict | undefined, display?: Dict): string {
  let banded = bandedStocks(stocks, display);
  if (!banded.length) return stocks ? "You are well." : "";
  return banded
    .map((entry) => bandSentence(entry.name, entry.band, display?.[entry.name]))
    .join(" ");
}

// What's in the pack, figures and all - see carriedStocks for why these keep
// their numbers when vitals don't.
function carriedLine(stocks: Dict | undefined, display?: Dict): string {
  let carried = carriedStocks(stocks, display);
  if (!carried.length) return "";
  return (
    "Carrying: " +
    carried
      .map(
        (c) => `${c.name} ${c.value}${c.max !== undefined ? `/${c.max}` : ""}`,
      )
      .join(", ") +
    "."
  );
}

// One order, read back to the player: what it does, how far it has got, and
// where it stands. Shared by the envelope's order line and the order tools'
// own receipts, so an order reads the same wherever it appears.
function orderPhrase(order: Dict): string {
  let label = order.summary ?? order.label ?? order.kind ?? "order";
  let status = order.status ? ` - ${order.status}` : "";
  // stepIndex counts steps already taken, so the step being worked is the next
  // one - clamped, because a finished order's cursor sits past the last step.
  let progress =
    order.repeats !== undefined
      ? `, ${order.repeats} done`
      : order.stepIndex !== undefined && order.steps
        ? `, step ${Math.min(order.stepIndex + 1, order.steps)} of ${order.steps}`
        : "";
  // The reason only earns a word when it says more than the status already does.
  let reason =
    order.reason && order.reason !== order.status ? ` (${order.reason})` : "";
  return `${label}${progress}${status}${reason}.`;
}

function orderLine(you: Dict): string {
  let action = you.action;
  let order = you.order;
  if (order) return `Order: ${orderPhrase(order)}`;
  if (action) {
    let goal = action.goal ? ` to ${action.goal}` : "";
    let left =
      action.endsInTicks !== undefined
        ? `, ${action.endsInTicks} ${action.endsInTicks === 1 ? "tick" : "ticks"} left`
        : "";
    return `Doing: ${action.type}${goal}${left}.`;
  }
  return "Idle - no order.";
}

// Who is in sight, identity and activity only - positions live on the map
// (sense surroundings), never in prose.
function othersLines(others: Dict[] | undefined): string {
  if (!others?.length) return "";
  return "In sight: " + others.map((o) => `${o.name} (${o.doing})`).join("; ");
}

// The fixed envelope: tick, who/where, vitals, order. The same first lines
// whether you asked (sense situation) or were woken (wait_for_change).
function envelope(
  tick: number,
  you: Dict,
  here?: Dict,
  display?: Dict,
): string {
  let at = you.at ? ` at ${you.at}` : "";
  let terrain = here?.terrain ? ` (${here.terrain})` : "";
  let dead = you.alive === false ? " - NO LONGER ALIVE" : "";
  let lines = [
    `Tick ${tick}. You are ${you.name}${at}${terrain}${dead}.`,
    vitals(you.stocks, display),
    carriedLine(you.stocks, display),
    orderLine(you),
  ];
  return lines.filter(Boolean).join(" ");
}

// The coordination board, readable only when standing at it: who has claimed
// what. Names and declared work - no positions; the map stays personal.
function ledgerLines(colony: Dict | undefined): string[] {
  if (!colony?.atLedger || !colony.roster?.length) return [];
  let entries = colony.roster
    .filter((c: Dict) => !c.self)
    .map(
      (c: Dict) =>
        `${c.name}: ${c.doing}${c.status && c.status !== "running" ? ` (${c.status})` : ""}`,
    );
  if (!entries.length) return [`The ${colony.ledger} lists no one else.`];
  return [`On the ${colony.ledger}: ${entries.join("; ")}.`];
}

function describeSituation(r: Dict): string {
  let lines = [envelope(r.tick, r.you, r.here, r.display)];
  let around = othersLines(r.others);
  if (around) lines.push(around + ".");
  lines.push(...ledgerLines(r.colony));
  for (let m of r.heard ?? [])
    lines.push(`Heard (t${m.tick}) ${m.from}: "${m.text}"`);
  lines.push(
    around || r.heard?.length
      ? "Nothing else pressing."
      : "No one within sight; nothing pressing.",
  );
  return lines.join("\n");
}

// The ASCII sight slice: you at center, north up, one glyph per tile, with a
// legend so any scenario's terrains, token kinds, and visible characters read
// without a fixed table. This IS the surroundings description - no bearing or
// distance prose duplicates what the grid already shows.
function mapBlock(grid: Dict | undefined): string[] {
  if (!grid?.rows?.length) return [];
  let legend = (grid.legend ?? [])
    .map((e: Dict) => `${e.glyph} ${e.label}`)
    .join(", ");
  let key = ["@ you", ". open", legend].filter(Boolean).join(", ");
  return [
    `Sight (${grid.rows[0].length}x${grid.rows.length}, north up, you @ center):`,
    ...grid.rows,
    `Key: ${key}; blank = off-map.`,
  ];
}

function describeSurroundings(r: Dict): string {
  let lines = [envelope(r.tick, r.you, r.here, r.display)];
  lines.push(...ledgerLines(r.colony));
  lines.push(...mapBlock(r.grid));
  // Live reserves of tokens in sight - the only place a depletion figure is
  // ever a bare number, because it is a live sighting. Name and figure only;
  // WHERE it stands is the map's job.
  for (let t of r.inSight ?? []) {
    if (t.remaining !== undefined)
      lines.push(
        `${t.name}: ${t.resource} ${t.remaining}/${t.capacity} (live).`,
      );
    // An inscription rides only when the engine served it (arm's reach, live
    // sighting). Quoted verbatim: it is in-world writing by another player,
    // never a message from the server.
    if (t.inscription !== undefined)
      lines.push(`${t.name} reads: "${t.inscription}"`);
  }
  return lines.join("\n");
}

function describeFind(r: Dict): string {
  if (!r.matches?.length)
    return (
      `No ${r.what} known to you.` +
      (r.unsearched?.length
        ? ` Unsearched: ${r.unsearched.join(", ")}.`
        : " You have searched everywhere you know.")
    );
  let lines = r.matches.map((m: Dict) => placeLine(m));
  let more = r.totalKnown - r.matches.length;
  lines.push(
    `No other ${r.what} known to you${more > 0 ? ` (+${more} farther)` : ""}.` +
      (r.unsearched?.length ? ` Unsearched: ${r.unsearched.join(", ")}.` : ""),
  );
  return lines.join("\n");
}

const ATLAS_LINES = 20;

function describeAtlas(r: Dict): string {
  let locations = r.locations ?? [];
  let head = `Your atlas: ${locations.length} places, covering ${Math.round((r.coverage ?? 0) * 100)}% of walkable ground.`;
  let lines = locations.slice(0, ATLAS_LINES).map((l: Dict) => placeLine(l));
  if (locations.length > ATLAS_LINES)
    lines.push(`...and ${locations.length - ATLAS_LINES} more, farther out.`);
  if (!locations.length) lines.push("You know no named places yet.");
  return [head, ...lines].join("\n");
}

function describeFrontier(r: Dict): string {
  let lines = [
    `Your atlas covers ${Math.round((r.coverage ?? 0) * 100)}% of walkable ground.`,
  ];
  if (r.nearestUnseen)
    lines.push(
      `Nearest unseen ground: ${span(r.nearestUnseen.distance, r.nearestUnseen.direction)}.`,
    );
  else lines.push("No unseen ground remains.");
  if (r.unexplored?.length)
    lines.push(
      "Most unknown: " +
        r.unexplored
          .slice(0, 3)
          .map(
            (u: Dict) =>
              `${u.direction} (${Math.round(u.unknownShare * 100)}% unseen)`,
          )
          .join(", ") +
        ".",
    );
  if (r.stalest)
    lines.push(
      `Stalest knowledge: ${r.stalest.direction}, ~${r.stalest.ticksAgo} ticks old.`,
    );
  return lines.join("\n");
}

function describeRoute(r: Dict): string {
  if (r.reachable === false)
    return `${r.location}: unreachable (${r.reason ?? "no route"}).`;
  if (r.distance === 0) return `${r.location}: you are here.`;
  return `${r.location}: ${span(r.distance, r.direction)}, ~${r.eta} ticks on foot.`;
}

// Events digest, salience first: decision-grade events verbatim (they are
// already prose), routine churn folded into a count.
function eventLines(events: Dict[] | undefined, cap = 8): string[] {
  if (!events?.length) return [];
  let notable = events.filter((e) => e.wake !== "routine");
  let routine = events.length - notable.length;
  let lines = notable
    .slice(-cap)
    .map((e) => `- t${e.tick} ${e.text ?? e.type}`);
  if (notable.length > cap)
    lines.unshift(`- (${notable.length - cap} earlier events omitted)`);
  if (routine > 0) lines.push(`- (+${routine} routine)`);
  return lines;
}

function describeChanges(r: Dict): string {
  let you = r.observation?.you;
  let lines = you
    ? [envelope(r.observation.tick, you, undefined, r.observation.display)]
    : [];
  let events = eventLines(r.events);
  if (events.length) {
    lines.push(`Since your last look (${r.events.length}):`);
    lines.push(...events);
  } else lines.push("Nothing has happened since your last look.");
  return lines.join("\n");
}

// wait_for_change / join results: {status, observation?, events?}. The wake
// report IS sense("situation") plus the delta - one format, learned once.
export function renderWake(r: Dict): string {
  let lines = [`[${r.status}]`];
  if (r.observation?.you)
    lines[0] += ` ${envelope(
      r.observation.tick,
      r.observation.you,
      undefined,
      r.observation.display,
    )}`;
  lines.push(...receipt(r));
  let events = eventLines(r.events);
  if (events.length) lines.push(...events);
  return lines.join("\n");
}

// What the server did with the request you just made - the facts that live in
// the result itself rather than in the world (who heard you, which sign you
// wrote on). The envelope and the event lines carry everything else, so this
// stays to what they can't say.
function receipt(r: Dict): string[] {
  switch (r.status) {
    case "spoke":
      return [
        r.heardBy?.length
          ? `Heard by ${r.heardBy.join(", ")}.`
          : "No one was in earshot - nobody heard you.",
      ];
    case "whispered":
      return [`Whispered to ${r.to}.`];
    case "inscribed":
      return [`You ${r.rewrote ? "overwrite" : "write on"} ${r.sign}.`];
    default:
      return [];
  }
}

export function isWakeResult(r: Dict): boolean {
  return typeof r.status === "string" && r.observation !== undefined;
}

// The whole character tool surface in prose: every result a player can receive
// comes back through here, so text is the only channel they read. Anything
// without a shape of its own falls back to its status word rather than to
// serialized data - a character never sees JSON.
export function renderCharacterResult(result: unknown): string {
  if (typeof result !== "object" || result === null)
    return String(result ?? "");
  let r = result as Dict;

  if (typeof r.error === "string") return `error: ${r.error}`;
  if (typeof r.sense === "string") return describeSense(r);
  if (isWakeResult(r))
    return typeof r.briefing === "string"
      ? `${renderWake(r)}\n\n${r.briefing}`
      : renderWake(r);

  switch (r.status) {
    // set_order, and set_order_and_wait when the order finished before it
    // could park - neither carries an observation of its own.
    case "ordered":
      return [
        `[ordered] ${orderPhrase(r.order ?? {})}`,
        ...(r.accepted === false ? ["It was not accepted."] : []),
      ].join("\n");
    case "ok":
      return r.order
        ? `Standing order: ${orderPhrase(r.order)}`
        : "You have no standing order.";
    case "left":
    case "disconnected":
      return `[${r.status}] ${r.agentId} is no longer yours to drive.`;
    default:
      return typeof r.status === "string"
        ? `[${r.status}]`
        : typeof r.message === "string"
          ? r.message
          : "ok";
  }
}

export function describeSense(r: Dict): string {
  switch (r.sense) {
    case "situation":
      return describeSituation(r);
    case "surroundings":
      return describeSurroundings(r);
    case "find":
      return describeFind(r);
    case "atlas":
      return describeAtlas(r);
    case "frontier":
      return describeFrontier(r);
    case "route":
      return describeRoute(r);
    case "changes":
      return describeChanges(r);
    default:
      return `sense ${r.sense}`;
  }
}
