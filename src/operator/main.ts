#!/usr/bin/env node

import { createOperatorApp } from "./app.js";
import { operatorHelp, operatorPaths, parseOperatorArgs } from "./config.js";
import { createRuntime, snapshotText } from "./runtime.js";

async function main(): Promise<void> {
  let options;
  try {
    options = parseOperatorArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`operator: ${errorMessage(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${operatorHelp()}\n`);
    return;
  }

  let paths = operatorPaths(options);
  let runtime = createRuntime(options, paths);
  if (options.snapshot) {
    process.stdout.write(`${snapshotText(await runtime.refresh())}\n`);
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "operator: interactive mode requires a TTY. Use --snapshot for non-interactive status.\n",
    );
    process.exitCode = 1;
    return;
  }

  let app = createOperatorApp(options, runtime);
  try {
    await app.run();
  } finally {
    app.stop();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

await main();
