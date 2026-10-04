import { createHash } from "node:crypto";

/**
 * Shared persistence primitives for FlowForge's SQLite layer.
 *
 * Canonical JSON is the single mechanism behind both durable idempotency keys and planning content
 * hashes, so an identical logical entity always hashes identically regardless of key order.
 */

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Persisted JSON data must contain finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  throw new Error(`Unsupported value in JSON data: ${typeof value}`);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Durable identity for generation jobs (unchanged since Phase 1). */
export function createIdempotencyKey(identityJson: string): string {
  return sha256Hex(`flowforge:generation:v1:${identityJson}`);
}

/**
 * Durable identity for planning writes. Same canonicalization and hash construction as generation
 * jobs, with a separate namespace prefix so a planning key can never be mistaken for a job key.
 */
export function createPlanningIdempotencyKey(identityJson: string): string {
  return sha256Hex(`flowforge:planning:v1:${identityJson}`);
}

/** Content hash for versioned planning aggregates. */
export function createPlanningContentHash(value: unknown): string {
  return sha256Hex(`flowforge:planning-content:v1:${stableJson(value)}`);
}

export function requiredText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
}

export function optionalText(value: string | undefined): string | null {
  return value === undefined ? null : value.trim();
}

export function encodeJson(value: unknown): string {
  return stableJson(value);
}

export function encodeOptionalJson(value: Record<string, unknown> | undefined): string | null {
  return value === undefined ? null : stableJson(value);
}

export function decodeOptionalJson(value: string | null): Record<string, unknown> | undefined {
  return value === null ? undefined : decodeJson<Record<string, unknown>>(value, {});
}

export function decodeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
