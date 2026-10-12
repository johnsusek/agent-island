// `npm run dev` for a hot-reloading dashboard.
//
// Two processes run together:
//   - the Express backend (API + MCP) on :3000, via tsx
//   - the Vite dev server (the Vue dashboard, with HMR) on :5173, which proxies
//     /api and /mcp through to the backend (see vite.config.ts)
//
// Open the Vite URL (http://localhost:5173) — edits to anything under web/ hot
// reload instantly. The old `dev` did a one-time `vite build` and served the
// static bundle from Express, so web changes never showed up without a manual
// rebuild and restart.
import { spawn } from "node:child_process";

let procs = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (let p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  process.exit(code);
}

// Spawn a node_modules/.bin executable, inheriting stdio. npm puts .bin on PATH
// for the script's children, so bare "tsx"/"vite" resolve. If either process
// exits, tear the other down too so a dead backend never leaves a zombie Vite.
function run(cmd, args, env) {
  let p = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  p.on("exit", (code) => shutdown(code ?? 0));
  p.on("error", (err) => {
    console.error(`Failed to start ${cmd}:`, err.message);
    shutdown(1);
  });
  procs.push(p);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run(
  "tsx",
  [
    "watch",
    // Resolve the workspace packages to their TypeScript sources, not dist.
    "--conditions=source",
    "--include",
    "config/config.json",
    "--include",
    "config/scenarios/*.json",
    "src/server.ts",
  ],
  {
    AGENT_ISLAND_LOG: "1",
    AGENT_ISLAND_SESSION_TTL_MS: "600000",
    AGENT_ISLAND_IDLE_MS: "900000",
  },
);
run("vite", []);
