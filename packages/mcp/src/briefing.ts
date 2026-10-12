import { readFileSync } from "node:fs";

// The canonical agent briefing: everything universal about playing the game
// (orders, goals, memory protocol). It ships from the server two ways - as the
// MCP server's `instructions` at connect, and in the join_game result for a
// fresh spawn - so a client only needs a tiny local prompt (name, personality,
// how to reach the server). Edit briefing.md, not client prompts, to change
// how agents play.
export const characterBriefing = readFileSync(
  new URL("./briefing.md", import.meta.url),
  "utf8",
);

// The GM-side counterpart, served as the /gm endpoint's `instructions`: the
// mechanics of the GM seat (tools, the wait_for_world wake cycle, the pulse).
// Personality stays client-side - a bring-your-own-director ships its own
// voice and gets the mechanics here at connect.
export const gmBriefing = readFileSync(
  new URL("./gm-briefing.md", import.meta.url),
  "utf8",
);
