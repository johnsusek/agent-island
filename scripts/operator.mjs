#!/usr/bin/env node

import { createOperatorApp } from "./operator/app.mjs";
import { setColorsEnabled } from "./operator/ansi.mjs";
import { operatorHelp, operatorPaths, parseOperatorArgs } from "./operator/config.mjs";
import { createRuntime, snapshotText } from "./operator/runtime.mjs";

async function main() {
  let options;
  try {
    options = parseOperatorArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `operator: ${error instanceof Error ? error.message : String(error)}\n`,
    );
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

  setColorsEnabled(!options.monochrome && process.env.NO_COLOR === undefined);
  let app = createOperatorApp(options, paths, runtime);
  try {
    await app.run();
  } finally {
    app.stop();
  }
}

await main();
