/**
 * Shared persistence primitives for FlowForge's SQLite layer.
 *
 * Canonical JSON lives in `@flowforge/core` so that persistence, planning content hashes, and the
 * deterministic planner fingerprint the same data identically. These re-exports keep the storage
 * internals using one implementation rather than a second copy.
 */
export { canonicalize, sha256Hex, stableJson } from "@flowforge/core";

import { sha256Hex, stableJson } from "@flowforge/core";

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
