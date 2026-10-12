#!/usr/bin/env node
// `serve` from the command line: run a world from a world file and a folder
// of scenarios, and stop it cleanly on Ctrl-C.

import { parseServeArgs, serve, SERVE_USAGE } from "./serve.js";

let args = process.argv.slice(2);
if (args[0] === "serve") args = args.slice(1);
if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(SERVE_USAGE);
  process.exit(args.length === 0 ? 1 : 0);
}

let options;
try {
  options = parseServeArgs(args);
} catch (error) {
  console.error((error as Error).message);
  console.error(SERVE_USAGE);
  process.exit(1);
}

let server = await serve(options);
console.log(`Serving at ${server.url}`);
console.log(`  characters connect to ${server.url}/mcp`);
console.log(`  game masters connect to ${server.url}/gm`);

let stopping = false;
for (let signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  });
