import { fingerprintJson, sha256Hex } from "@flowforge/core";
import { PLANNER_ID_NAMESPACE } from "./types.js";

/**
 * Identifiers for planned content are derived, never drawn: `id = f(fingerprint of the normalized
 * input, kind, path)`. Two consequences matter more than the shape:
 *
 * 1. Re-running the planner over the same input produces the *same* ids, so the write path is
 *    idempotent row by row (the repository's planning idempotency keys also match), and re-mapping an
 *    unchanged plan to execution reuses the same scenes and jobs.
 * 2. Changing any input changes the fingerprint, so a re-plan cannot silently claim the previous
 *    plan's identifiers.
 *
 * The value is formatted as a UUID (version/variant nibbles fixed) purely so that planner-authored
 * ids are indistinguishable in shape from `randomUUID()` ones; they are not random.
 */
export function plannerId(inputFingerprint: string, kind: string, path: string): string {
  const digest = sha256Hex(`${PLANNER_ID_NAMESPACE}:${inputFingerprint}:${kind}:${path}`);
  const hex = (start: number, length: number): string => digest.slice(start, start + length);
  const variant = ((parseInt(hex(16, 2), 16) & 0b0011_1000) | 0b1000_0000).toString(16).padStart(2, "0");
  return [
    hex(0, 8),
    hex(8, 4),
    `4${hex(13, 3)}`,
    variant + hex(18, 2),
    hex(20, 12),
  ].join("-");
}

/** Slug used for scene keys and beat keys: lowercase, alphanumeric, single hyphens. */
export function slugify(value: string, fallback = "beat"): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

/** Deterministic digest helper for content sets, namespaced so keys of different kinds never collide. */
export function plannerFingerprint(namespace: string, value: unknown): string {
  return fingerprintJson(namespace, value);
}

/**
 * Row ids for a *specific* plan version.
 *
 * The engine's own ids identify a planned object within a draft; they must not depend on which version
 * the draft is authored into, or re-planning the same piece would look like different content. Storage
 * needs the opposite: one global id per row. So authoring scopes the deterministic id with the target
 * version id — still reproducible (same input, same version, same ids), and still collision-free across
 * versions of the same plan.
 */
export function authoringId(inputFingerprint: string, planVersionId: string, kind: string, path: string): string {
  return plannerId(`${inputFingerprint}#${planVersionId}`, kind, path);
}
