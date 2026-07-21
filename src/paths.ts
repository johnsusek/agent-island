import os from "node:os";
import path from "node:path";

// The root for everything the world generates as it runs - the state snapshot,
// GM rule overlay, event journal, run archives, character/director workdirs, and
// GM-saved scenarios. It lives OUTSIDE the repo by default so nothing runtime
// ever writes into the working tree; the source tree carries only code and the
// bundled starter content (agents/, config/). Override the whole root with
// AGENT_ISLAND_HOME; individual AGENT_ISLAND_* path vars still override their own
// slot on top of this. A leading ~ in the env value expands to the home dir.
export function agentIslandHome(): string {
  let raw = process.env.AGENT_ISLAND_HOME?.trim();
  if (raw) return path.resolve(expandTilde(raw));
  return path.join(os.homedir(), ".agent-island");
}

// Join segments under the runtime home. Used to build the default for each
// runtime path so they all sit under one relocatable root.
export function homePath(...segments: string[]): string {
  return path.join(agentIslandHome(), ...segments);
}

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}
