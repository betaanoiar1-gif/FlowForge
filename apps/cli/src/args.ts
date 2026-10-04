export class UsageError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedArgs {
  /** Leading bare words, e.g. ["review", "approve"]. */
  command: string[];
  options: Record<string, string | boolean>;
}

/**
 * Minimal operator-friendly parsing: bare words form the command path, `--flag value` and
 * `--flag=value` set options, a bare `--flag` sets true. Anything else is a usage error so a
 * typo never silently changes which durable entity a command touches.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const command: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      if (Object.keys(options).length > 0) {
        throw new UsageError(`Unexpected argument "${token}" after options.`, "Place all --flags after the command path.");
      }
      if (token.startsWith("-")) throw new UsageError(`Unknown short option "${token}".`);
      command.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      options[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[body] = next;
      index += 1;
    } else {
      options[body] = true;
    }
  }
  return { command, options };
}

export function requireString(options: ParsedArgs["options"], name: string): string {
  const value = optionalString(options, name);
  if (value === undefined) {
    throw new UsageError(`--${name} is required.`, `flowforge … --${name} <value>`);
  }
  return value;
}

export function optionalString(options: ParsedArgs["options"], name: string): string | undefined {
  const value = options[name];
  if (typeof value !== "string") {
    if (value === true) throw new UsageError(`--${name} requires a value.`);
    return undefined;
  }
  if (!value.trim()) throw new UsageError(`--${name} must not be empty.`);
  return value;
}

export function optionalNumber(options: ParsedArgs["options"], name: string): number | undefined {
  const raw = optionalString(options, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new UsageError(`--${name} must be an integer.`);
  return parsed;
}

export function isSet(options: ParsedArgs["options"], name: string): boolean {
  const value = options[name];
  if (value === undefined) return false;
  if (value === true) return true;
  const text = String(value).toLowerCase();
  if (["true", "1", "yes"].includes(text)) return true;
  if (["false", "0", "no"].includes(text)) return false;
  throw new UsageError(`--${name} is a boolean flag.`, `Use --${name} or --${name}=false.`);
}

export function parseJsonOption<T>(options: ParsedArgs["options"], name: string): T | undefined {
  const value = optionalString(options, name);
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new UsageError(`--${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function rejectUnknown(options: ParsedArgs["options"], allowed: readonly string[], where: string): void {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new UsageError(`Unknown option(s) for ${where}: ${unknown.map((key) => `--${key}`).join(", ")}.`, `flowforge ${where} --help`);
  }
}
