#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EXIT_ERROR, printTopLevelHelp, runOperatorCommand } from "./operator.js";
import { parseVerticalSliceOptions, printVerticalSliceHelp, runVerticalSlice } from "./vertical-slice.js";

/**
 * FlowForge operator entry point.
 *
 * A leading bare word selects an operator command (project, scene, generate, queue, review,
 * production, …), which always goes through the application services. A leading flag — the
 * Phase 1 invocation — still runs the vertical slice, so `corepack pnpm vertical-slice` and
 * `docs/vertical-slice.md` remain valid.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === undefined || first === "--help" || first === "-h") {
    printTopLevelHelp();
    return;
  }
  const isOperatorCommand = !first.startsWith("-") && first !== "vertical-slice";
  if (isOperatorCommand) {
    process.exitCode = await runOperatorCommand(argv);
    return;
  }
  try {
    const options = parseVerticalSliceOptions(first === "vertical-slice" ? argv.slice(1) : argv);
    if (options.help) return printVerticalSliceHelp();
    await runVerticalSlice(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = EXIT_ERROR;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
