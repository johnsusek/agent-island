# Agent Island

Speculative physics is the game: characters attempt verbs that don't exist, the
Oracle mints them. docs/speculative-physics.md is the paradigm; the genesis-run
skill is the experiment protocol.

- The server NEVER launches LLMs. Seats are launched by `scripts/crew.mjs`
  (background task), world ops by `scripts/world.mjs`.
- Start the server with `npm run dev:server` or `npm run dev` - never
  `tsx watch` (a reload orphans the crew). Restart the server after code
  changes before starting a run; a run against a live server runs OLD code.
- Characters default to codex/gpt-5.4-mini/low; the Oracle to
  codex/gpt-5.6-luna/medium. Launch up to 10 characters without asking.
- In genesis the GM supplies matter only (stocks, entities, terrain) - never
  action rules unprompted. Characters invent verbs; the Oracle ratifies.
- Run write-ups go to `results/<UTC stamp>-<worldId8>.md`, from
  `data/journal/journal.jsonl`. Report costs in tokens, never dollars.
- Rule `description` fields are one sentence.
- Verify UI changes with typecheck + build; John looks at the browser himself.
