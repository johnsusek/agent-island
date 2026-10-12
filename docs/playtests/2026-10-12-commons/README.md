# Commons playtest, 12 October 2026

Five Claude agents (Haiku 5.5) played the `commons` example from
[`packages/mcp`](../../../packages/mcp) for a full season, with the Clerk
persona (Sonnet 5.5) as game master. They agreed on a fishing limit, shared
food, had the Clerk make the limit a rule of the world, and amended it. All
five were alive at tick 380 and the bay ended at 33.7 fish (it started at 30).

The write-up is [`page/commons-playtest.html`](page/commons-playtest.html);
open it in a browser.

## What is here

| Path | Contents |
|---|---|
| `page/` | The write-up as a standalone page. |
| `speech.txt` | Every line the villagers said, plus the council notices and the victory, by tick. |
| `transcripts/` | One readable transcript per seat: every launch, every tool call, trimmed tool results. |
| `memory/` | Each seat's `memory.md` at the end of the run. The Clerk's shows its reasoning about when agreement was clear enough to act on. |
| `raw/` | The full records, gzipped: each seat's `claude -p` stream-json output, the server's event journal, the final world state, the GM rule overlay, and the supervisor log. |
| `harness/` | The prompts each seat was launched with, the seat supervisor (`seat.sh`), the status monitor (`status.py`), and the script and data that built the page. |

## How it was run

- `serve` ran the commons example with its data in a scratch directory, on
  port 3920.
- Each seat ran under `seat.sh`: `claude -p` with the seat's prompt, the
  commons MCP server only (`--strict-mcp-config`), and the same blocked-tool
  list `scripts/crew.mjs` uses. Villagers played stretches of about 60 ticks
  and were relaunched under the same name; the Clerk ran one wake per
  launch.
- The villager prompt is the project's `agents/characters/character-minimal.md`
  (with the hydration line removed, since this world has no thirst) plus the
  scenario's flow descriptions. The Clerk prompt is `agents/directors/clerk.md`
  plus one standing instruction, quoted in full in `harness/Clerk.prompt.txt`.

The harness files are kept as they ran, with their original scratch layout,
so they document the run rather than run from this folder.

## Sanitizing

Local paths are replaced with `playtest/`, `<repo>`, `~` or `<tmp>`. Each
transcript's Claude Code init record keeps only the model, tools, MCP server
status, version, permission mode, session id and working directory; the rest
described the operator's machine and installed skills.

## Known issues the run exposed

- After the world closed, players got `[ended]` but kept issuing orders and
  waiting; they had to be stopped by hand. Fixed after this run (see the
  commit that follows this one).
- Movement verbs (`explore`, `scan`) are offered in a one-room world: 62 scans
  and 40 refused moves.
- Ara gave away both of her fish and called it a mistake; the `give` action's
  amount may be unclear to players.
