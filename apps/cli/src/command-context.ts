import type { FlowForgeApplication } from "@flowforge/services";
import type { ParsedArgs } from "./args.js";
import type { OpenedApplication, ResolvedGlobals } from "./runtime.js";

/**
 * Shared plumbing for operator commands. Command definitions and their output live here (rather
 * than inside `operator.ts`) so the Phase 3 command set and the Phase 4A planning command set can
 * share one renderer without either module importing the other.
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
/** The request was well formed but durable state legitimately blocks it. */
export const EXIT_BLOCKED = 3;

export interface CommandDefinition {
  /** Human usage line, shown by `flowforge help <command>`. */
  usage: string;
  summary: string;
  /** Command-specific flags; global flags are always accepted. */
  flags: readonly string[];
  /** Whether the command needs a durable worker (execution, provider-side cancellation). */
  execution?: boolean;
  /**
   * Whether the command needs the AI planner adapter wired into its application. Only the AI planning
   * command sets it, and setting it is what makes the CLI read the configured environment variable — no
   * other invocation touches a credential, and none ever receives a worker or a browser.
   */
  ai?: boolean;
  run: (context: CommandContext) => Promise<void> | void;
}

export interface CommandContext {
  options: ParsedArgs["options"];
  globals: ResolvedGlobals;
  app: FlowForgeApplication;
  opened: OpenedApplication;
}

/** Human-readable output for operators, structured output for scripts — from one read model. */
export function emit<T>(globals: ResolvedGlobals, value: T, human: (value: T) => string[]): void {
  if (globals.json) {
    console.log(JSON.stringify({ ok: true, data: value }, null, 2));
    return;
  }
  const lines = human(value);
  if (lines.length > 0) console.log(lines.join("\n"));
}

export function defaultReviewer(options: ParsedArgs["options"]): string {
  return optionalStringOr(options, "reviewer") ?? process.env.USER ?? "cli-operator";
}

function optionalStringOr(options: ParsedArgs["options"], name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}
