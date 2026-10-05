import {
  EXECUTION_FINGERPRINT_NAMESPACE,
  EXECUTION_ID_NAMESPACE,
  EXECUTION_RULES_VERSION,
  fingerprintJson,
  stableJson,
} from "@flowforge/core";
import { plannerId } from "../planner/deterministic-ids.js";

/**
 * Execution identity (Phase 5): one deterministic digest over the canonical inputs of a materialization, and
 * the ids derived from it.
 *
 * The rule the brief states and this file enforces:
 *
 *   same plan content + same execution rules = same execution identity, therefore the same work.
 *
 * So the fingerprint covers exactly what decides *what work exists*: the plan version's identity and content,
 * the rules version, and per unit the planned scene/spec identity, kind, provider, prompt, references, and
 * generation parameters. It deliberately excludes everything that describes a *particular attempt* — the
 * clock, random ids, queue leases, claim counts, worker identities, retry state, provider responses, and the
 * operator's write-only knobs. Including any of those would make an unchanged plan look like new work on
 * every run, which is precisely the failure Phase 5 must not have.
 *
 * Nothing here reads a database, a clock, or a provider. `plannerId` is reused from Phase 4B on purpose:
 * derived identifiers must come from one derivation function so that a planned row and an execution row built
 * from the same digest are reproducible in the same way.
 */

/** The part of a unit that decides what work it is. Anything else is bookkeeping. */
export interface ExecutionIdentityUnit {
  scenePlanId: string;
  sceneKey: string;
  sceneNumber: number;
  specId: string;
  specNumber: number;
  kind: string;
  providerId: string;
  prompt: string;
  references: readonly string[];
  parameters: Record<string, unknown>;
  requiredCapabilities: readonly string[];
  outputCount: number;
  aspectRatio?: string;
  durationMs?: number;
}

export interface ExecutionIdentityInput {
  projectId: string;
  planId: string;
  planVersionId: string;
  versionNumber: number;
  contentHash: string;
  /** What the ids are scoped by, recorded verbatim so a report can explain itself. */
  mappingScope: string;
  rulesVersion?: string;
  units: readonly ExecutionIdentityUnit[];
}

export interface ExecutionIdentity {
  rulesVersion: string;
  executionFingerprint: string;
  /** Deterministic `plan_executions` row id, so two processes materializing the same plan agree on it. */
  executionId: string;
  /** Per-unit deterministic ids, keyed by `${sceneKey}/${specNumber}`. */
  sceneVersionIds: Map<string, string>;
}

/**
 * UUID-shaped derived value. `plannerId` is Phase 4B's single derivation function, reused rather than
 * duplicated: one implementation means a planned row and an execution row built from the same digest are
 * reproducible in exactly the same way, and a bug fixed in one is fixed in both. The execution namespace is
 * folded into the scope, so an execution id can never collide with a planner-authored row id.
 */
function derivedId(fingerprint: string, kind: string, path: string): string {
  return plannerId(`${EXECUTION_ID_NAMESPACE}:${fingerprint}`, kind, path);
}

function canonicalIdentity(input: ExecutionIdentityInput): Record<string, unknown> {
  return {
    projectId: input.projectId,
    planId: input.planId,
    planVersionId: input.planVersionId,
    versionNumber: input.versionNumber,
    contentHash: input.contentHash,
    mappingScope: input.mappingScope,
    rulesVersion: input.rulesVersion ?? EXECUTION_RULES_VERSION,
    units: input.units.map((unit) => ({
      scenePlanId: unit.scenePlanId,
      sceneKey: unit.sceneKey,
      sceneNumber: unit.sceneNumber,
      specId: unit.specId,
      specNumber: unit.specNumber,
      kind: unit.kind,
      providerId: unit.providerId,
      prompt: unit.prompt,
      references: [...unit.references],
      // Canonicalized here so the identity of the work does not depend on how a spec happened to be authored.
      parameters: stableJson(unit.parameters),
      requiredCapabilities: [...unit.requiredCapabilities].sort(),
      outputCount: unit.outputCount,
      aspectRatio: unit.aspectRatio,
      durationMs: unit.durationMs,
    })),
  };
}

/**
 * Computes the execution fingerprint and every derived id. Pure: same input, byte-identical output, in every
 * process and on every restart — which is what makes materialization idempotent *across* processes rather
 * than only inside one.
 */
export function executionIdentity(input: ExecutionIdentityInput): ExecutionIdentity {
  const rulesVersion = input.rulesVersion ?? EXECUTION_RULES_VERSION;
  const executionFingerprint = fingerprintJson(EXECUTION_FINGERPRINT_NAMESPACE, canonicalIdentity(input));
  const sceneVersionIds = new Map<string, string>();
  for (const unit of input.units) {
    const path = `${unit.sceneKey}/${unit.specNumber}`;
    if (sceneVersionIds.has(path)) {
      throw new Error(`Duplicate execution unit for ${path}; a plan version cannot map one unit twice.`);
    }
    sceneVersionIds.set(path, derivedId(executionFingerprint, "execution-scene-version", path));
  }
  return {
    rulesVersion,
    executionFingerprint,
    executionId: derivedId(executionFingerprint, "plan-execution", input.planVersionId),
    sceneVersionIds,
  };
}

/** The id a caller may use for a scene version before any write, for an exact reuse check. */
export function sceneVersionIdFor(identity: ExecutionIdentity, sceneKey: string, specNumber: number): string {
  const id = identity.sceneVersionIds.get(`${sceneKey}/${specNumber}`);
  if (!id) throw new Error(`No deterministic scene version id for ${sceneKey}/${specNumber}.`);
  return id;
}

/**
 * Queue ordering derived from the plan's own scene order: earlier scenes get higher priority so the durable
 * queue drains a piece in story order without a dependency graph. Saturated into the range the existing
 * `priority` column accepts, and purely a function of `sceneNumber`.
 */
export function priorityForSceneNumber(sceneNumber: number): number {
  if (!Number.isSafeInteger(sceneNumber) || sceneNumber < 1) {
    throw new Error("Scene number must be a positive integer to derive a queue priority.");
  }
  return Math.max(-1000, 1000 - (sceneNumber - 1));
}
