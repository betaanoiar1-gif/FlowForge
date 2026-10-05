import { createHash } from "node:crypto";

/**
 * Canonical JSON and digest primitives shared by persistence, planning content hashes, and the
 * deterministic planner.
 *
 * There is deliberately exactly one implementation in the workspace. Durable idempotency keys, plan
 * version content hashes, and planner fingerprints all have to agree byte for byte about what "the
 * same input" means, so a second canonicalizer anywhere would be a correctness bug waiting to happen
 * (object key order, `undefined` omission, and number handling all change the digest).
 *
 * `canonicalize` is structural, not creative: it sorts object keys, drops `undefined` members, and
 * leaves array order and string content exactly as authored — array order is meaningful in planning
 * data (scene order, cast order, constraint order), so it is never "normalized" here.
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

/**
 * A namespaced digest over canonical data. The namespace is part of the pre-image, so a fingerprint
 * can never be mistaken for another kind of key (a job idempotency key, a plan content hash, or a
 * planner input fingerprint) even when the underlying value is identical.
 */
export function fingerprintJson(namespace: string, value: unknown): string {
  return sha256Hex(`${namespace}:${stableJson(value)}`);
}
