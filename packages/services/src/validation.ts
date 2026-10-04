import { ApplicationError } from "./errors.js";

const MAX_TEXT_LENGTH = 8_000;
const MAX_REFERENCES = 16;
const MAX_ATTEMPTS = 25;

export function fail(message: string, field: string): never {
  throw new ApplicationError("VALIDATION_FAILED", message, { field });
}

export function requiredText(value: unknown, field: string, max = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") fail(`${field} must be a string.`, field);
  const trimmed = value.trim();
  if (!trimmed) fail(`${field} must not be empty.`, field);
  if (trimmed.length > max) fail(`${field} must be at most ${max} characters.`, field);
  return value;
}

export function optionalText(value: unknown, field: string, max = MAX_TEXT_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, field, max);
}

export function optionalIdentifier(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field, 128);
  if (text === undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    fail(`${field} may only contain letters, digits, dot, underscore, colon, or hyphen.`, field);
  }
  return text;
}

export function identifier(value: unknown, field: string): string {
  const text = requiredText(value, field, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    fail(`${field} may only contain letters, digits, dot, underscore, colon, or hyphen.`, field);
  }
  return text;
}

export function integerRange(
  value: unknown,
  field: string,
  { min, max, fallback }: { min: number; max: number; fallback?: number },
): number {
  if (value === undefined || value === null) {
    if (fallback === undefined) fail(`${field} is required.`, field);
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(`${field} must be an integer.`, field);
  }
  if (value < min || value > max) {
    fail(`${field} must be between ${min} and ${max}.`, field);
  }
  return value;
}

/** JSON-safe metadata only: no functions, no live handles, no undefined holes. */
export function metadataRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be a plain object.`, field);
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(`${field} must be JSON-serialisable.`, field);
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    fail(`${field} must be JSON-serialisable.`, field);
  }
}

/** Reference handles are opaque identifiers or URIs the provider resolves; never file bodies. */
export function referenceList(value: unknown, field = "references"): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings.`, field);
  if (value.length > MAX_REFERENCES) fail(`${field} may hold at most ${MAX_REFERENCES} entries.`, field);
  return value.map((entry, index) => requiredText(entry, `${field}[${index}]`, 2_048));
}

export function isoTimestamp(value: unknown, field: string): string | undefined {
  const text = optionalText(value, field, 40);
  if (text === undefined) return undefined;
  if (Number.isNaN(Date.parse(text))) fail(`${field} must be an ISO-8601 timestamp.`, field);
  return new Date(text).toISOString();
}

/** Bounded list of non-empty free-text entries (themes, constraints, palette entries, rules). */
export function textList(value: unknown, field: string, max = 64): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings.`, field);
  if (value.length > max) fail(`${field} may hold at most ${max} entries.`, field);
  return value.map((entry, index) => requiredText(entry, `${field}[${index}]`, 1_000));
}

export const LIMITS = Object.freeze({
  maxTextLength: MAX_TEXT_LENGTH,
  maxReferences: MAX_REFERENCES,
  maxAttempts: MAX_ATTEMPTS,
});
