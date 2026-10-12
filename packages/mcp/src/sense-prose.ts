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

import {
  bandedStocks,
  bandSentence,
  carriedStocks,
} from "@agent-island/engine/vitals";

type Dict = Record<string, any>;

// The banded digest for one role: only the gauges in trouble, in the
// scenario's own words, worst first. A figure never appears - see
// packages/engine/src/vitals.ts for why.
function bandedLine(
  stocks: Dict | undefined,
  display: Dict | undefined,
  role: "vital" | "stat",
): string {
  return bandedStocks(stocks, display, role)
    .map((entry) => bandSentence(entry.name, entry.band, display?.[entry.name]))
    .join(" ");
}

// The vitals digest. Silence would be ambiguous ("nothing wrong? or nothing
// looked at?"), so a character with nothing pressing is told so outright, in
// one short clause - unlike stats, which stay silent when nothing is notable
// (a stat is worth a mention only when it's low, never an ambient status
// line the way health gets one).
function vitals(stocks: Dict | undefined, display?: Dict): string {
  let line = bandedLine(stocks, display, "vital");
  if (line) return line;
  return stocks ? "You are well." : "";
}

// What's in the pack, held items and pack figures together on one line - held
// discrete items first (named, no figure - one axe is one axe), then fungible
// pack stocks with their counts (see carriedStocks for why those keep numbers
// when vitals don't). One "Carrying:" the character reads as their whole
// inventory, though the two halves are different substrates underneath (an
// item entity vs. a stock count).
function carriedLine(you: Dict | undefined, display?: Dict): string {
  let stocks = you?.stocks;
  let parts: string[] = [];
  for (let item of (you?.held ?? []) as Dict[])
    parts.push(String(item.kind ?? item.id));
  let carried = carriedStocks(stocks, display);
  for (let c of carried)
    parts.push(`${c.name} ${c.value}${c.max !== undefined ? `/${c.max}` : ""}`);
  if (!parts.length) return "";
  return "Carrying: " + parts.join(", ") + ".";
}

// Shared quantities the whole world holds - a bay's fish, a common granary -
// as figures, like the pack line: a world stock whose role is "pack" is a
// count everyone can see and argue over. World vitals and stats stay out of
// prose; a scenario reaches characters about those through events.
function worldLine(world: Dict | undefined, display?: Dict): string {
  let shared = carriedStocks(world?.stocks, display).filter(
    (c) => display?.[c.name]?.scope === "world",
  );
  if (!shared.length) return "";
  let parts = shared.map((c) => {
    let label = display?.[c.name]?.label ?? c.name;
    return `${label} ${c.value}${c.max !== undefined ? `/${c.max}` : ""}`;
  });
  return "The world holds: " + parts.join(", ") + ".";
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
  world?: Dict,
): string {
  let at = you.at ? ` at ${you.at}` : "";
  let terrain = here?.terrain ? ` (${here.terrain})` : "";
  let dead = you.alive === false ? " - NO LONGER ALIVE" : "";
  let lines = [
    `Tick ${tick}. You are ${you.name}${at}${terrain}${dead}.`,
    vitals(you.stocks, display),
    bandedLine(you.stocks, display, "stat"),
    carriedLine(you, display),
    worldLine(world, display),
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
  let lines = [envelope(r.tick, r.you, r.here, r.display, r.world)];
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
  lines.push(...mapBlock(r.grid));
  lines.push(...inSightLines(r.inSight));
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

// Live reserves of tokens in sight - the only place a depletion figure is
// ever a bare number, because it is a live sighting. Name and figure only;
// WHERE it stands is the map's job.
function inSightLines(inSight: Dict[] | undefined): string[] {
  let lines: string[] = [];
  for (let t of inSight ?? []) {
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
  return lines;
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

// The action menu in one compact block - the ONLY place a character learns the
// action vocabulary, since the observation's availableActions array never
// reaches them as data (see the file header). Three salience tiers: what you
// can do now (with the arg values actually valid from here, so an order fills
// in without guessing), any action the world just handed you (`isNew` - high
// signal, so it carries its description), and the verbs that exist but are
// blocked where you stand. A blocked verb's reason ("stand at the outcrop")
// rides only in the teaching window, next to the description - the same static
// precondition sentence every wake is bloat, so slim wakes list the verb by
// name alone. Lists are capped: the point is the shape and a few real options,
// not to enumerate a big world.
const OPTION_CAP = 6;
const BLOCKED_CAP = 6;

function actionsBlock(actions: Dict[] | undefined): string[] {
  if (!actions?.length) return [];
  let lines: string[] = [];

  let usable = actions.filter((a) => a.applicable);
  if (usable.length)
    lines.push("You can: " + usable.map(actionPhrase).join(", ") + ".");

  // New actions ride even when blocked - their arrival is the signal to
  // reconsider, so they surface above the routine blocked list, with the
  // description the engine keeps attached to anything `isNew`.
  let fresh = actions.filter((a) => a.isNew);
  if (fresh.length)
    lines.push(
      "New: " +
        fresh
          .map((a) => (a.description ? `${a.name} - ${a.description}` : a.name))
          .join("; ") +
        ".",
    );

  let blocked = actions.filter((a) => !a.applicable && !a.isNew);
  if (blocked.length) {
    let shown = blocked.slice(0, BLOCKED_CAP);
    let phrases = shown.map((a) =>
      // `description` is the engine's teaching-window marker; the reason rides
      // with it and is dropped on slim wakes for the same reason.
      a.description && a.unavailableReason
        ? `${a.name} (${a.unavailableReason})`
        : a.name,
    );
    if (blocked.length > shown.length)
      phrases.push(`+${blocked.length - shown.length} more`);
    lines.push("Blocked here: " + phrases.join(", ") + ".");
  }

  return lines;
}

// One applicable action: its name, plus the arg values valid from here when the
// action narrows the choice (travel's reachable places, give's recipients). An
// action with no such narrowing is just its bare name.
function actionPhrase(action: Dict): string {
  let paramOptions = action.paramOptions as
    Record<string, unknown[]> | undefined;
  if (!paramOptions) return action.name;
  let parts: string[] = [];
  for (let [param, opts] of Object.entries(paramOptions)) {
    if (!opts?.length) continue;
    let vals = opts.slice(0, OPTION_CAP).map(optionLabel);
    let tail = opts.length > vals.length ? "|..." : "";
    parts.push(`${param}: ${vals.join("|")}${tail}`);
  }
  return parts.length ? `${action.name}(${parts.join("; ")})` : action.name;
}

// An arg option is either a bare string value or an entity target that carries
// its own label (a recipient, a prey token); either way the player needs the
// word, not the shape.
function optionLabel(opt: unknown): string {
  if (typeof opt === "string") return opt;
  let o = opt as Dict;
  return String(o.label ?? o.id ?? "");
}

function describeChanges(r: Dict): string {
  let you = r.observation?.you;
  let lines = you
    ? [
        envelope(
          r.observation.tick,
          you,
          undefined,
          r.observation.display,
          r.observation.world,
        ),
      ]
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
      r.observation.world,
    )}`;
  lines.push(...receipt(r));
  let events = eventLines(r.events);
  if (events.length) lines.push(...events);
  lines.push(...actionsBlock(r.observation?.availableActions));
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
    case "changes":
      return describeChanges(r);
    default:
      return `sense ${r.sense}`;
  }
}
