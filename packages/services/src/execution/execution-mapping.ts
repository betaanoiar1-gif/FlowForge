import type {
  PlanVersionSnapshot,
  ProviderCapabilities,
  ProviderCapabilityKey,
} from "@flowforge/core";
import { mapPlanToJobs } from "../plan-execution.js";
import type { ProviderDescriptor, ProviderRegistry } from "../ports.js";
import { executionIdentity, priorityForSceneNumber, type ExecutionIdentityUnit } from "./execution-idempotency.js";

/**
 * Plan → execution units (Phase 5).
 *
 * Phase 4B already decided *how* a generation spec becomes Phase 3 commands: `mapPlanToJobs` builds those
 * command intents from the same execution preview an operator reads, and submits none of them. This module is
 * the one step further Phase 5 needs — it turns each intent into a *materialization unit* by adding the
 * durable row identity a write requires (a scene version id, and the execution row's own id and fingerprint)
 * plus the ordering derived from the plan.
 *
 * It deliberately adds no rules of its own about prompts, capability filtering, provider selection, or scene
 * identity: those all come from the preview and the 4B mapping, so there is exactly one answer in the
 * workspace to "what does this plan ask for". A second mapping implementation would be the place where a
 * materialized job and a previewed job quietly stop meaning the same thing.
 *
 * Like the planner, this file is pure: no database, no clock, no randomness, no provider instance.
 */

/** One generation spec, ready to be materialized into durable rows. */
export interface ExecutionUnit {
  scenePlanId: string;
  sceneKey: string;
  sceneNumber: number;
  specId: string;
  specNumber: number;
  kind: string;
  providerId: string;
  requiredCapabilities: readonly ProviderCapabilityKey[];
  /** Plan-scoped, so a re-plan of the same piece lands on the same execution scene instead of forking one. */
  sceneId: string;
  /** Scene title and description, carried from the mapping so materialization invents neither. */
  sceneTitle: string;
  sceneDescription: string;
  /**
   * Execution-fingerprint-scoped, so plan v2 yields a *new* scene version for the same scene instead of
   * rewriting v1's. Filled in from the identity below, never from a write result.
   */
  sceneVersionId: string;
  jobKey: string;
  prompt: string;
  references: readonly string[];
  parameters: Record<string, unknown>;
  metadata: Record<string, unknown>;
  outputCount: number;
  aspectRatio?: string;
  durationMs?: number;
  /** Queue priority derived from the plan's scene order; the durable queue has no dependency graph to model. */
  priority: number;
  /** Keys of the scene plans this unit follows. Reported, not enforced — see `docs/plan-execution.md`. */
  dependsOn: string[];
}

export interface ExecutionMapping {
  planId: string;
  planVersionId: string;
  versionNumber: number;
  /** What the deterministic ids are scoped by: planner output fingerprint when recorded, else content hash. */
  mappingScope: string;
  executionFingerprint: string;
  executionId: string;
  rulesVersion: string;
  units: ExecutionUnit[];
  skipped: { specId: string; sceneKey: string; reason: string }[];
  /** Entity references the plan records that are not asset versions; Phase 5 leaves them unbound and says so. */
  unboundReferenceCount: number;
}

export interface ExecutionMappingOptions {
  /** Provider descriptors to choose from — the registry `markExecutable` consulted, never a new one. */
  providers: ProviderRegistry;
  /**
   * Map a version that is not EXECUTABLE yet, for a report of what the mapping would look like. Only the
   * read-only and dry-run paths set it; the write path checks lifecycle again and refuses regardless.
   */
  allowUnapproved?: boolean;
  maxAttempts?: number;
}

/**
 * Builds the units and the execution identity for one plan version.
 *
 * `selectedProviders` narrows the provider pool. It defaults to the version's `executableProviders` — the list
 * the executability gate recorded — because picking a different provider at materialization time would execute
 * work the plan was never approved against. An empty list is refused rather than silently widened to every
 * configured provider, which is the difference between "no provider was approved" and "everything is fair
 * game".
 */
export function buildExecutionMapping(
  snapshot: PlanVersionSnapshot,
  options: ExecutionMappingOptions,
  selectedProviders?: readonly string[],
): ExecutionMapping {
  const { plan, version } = snapshot;
  if (selectedProviders !== undefined && selectedProviders.length === 0) {
    throw new Error("An empty provider selection cannot be widened to every configured provider.");
  }
  const selected =
    selectedProviders ??
    (version.executableProviders && version.executableProviders.length > 0 ? version.executableProviders : undefined);
  // The 4B mapping is the single source for prompts, capability filtering, scene identity, and job keys.
  const mapping = mapPlanToJobs(snapshot, {
    providers: narrowRegistry(options.providers, selected),
    allowUnapproved: options.allowUnapproved === true,
    maxAttempts: options.maxAttempts,
  });

  const sceneOrder = snapshot.scenePlans.map((node) => node.scenePlan.sceneKey);
  const identityUnits: ExecutionIdentityUnit[] = [];
  const units: ExecutionUnit[] = [];
  for (const intent of mapping.intents) {
    const position = sceneOrder.indexOf(intent.sceneKey);
    const unit: ExecutionUnit = {
      scenePlanId: intent.scenePlanId,
      sceneKey: intent.sceneKey,
      sceneNumber: intent.sceneNumber,
      specId: intent.specId,
      specNumber: intent.specNumber,
      kind: intent.kind,
      providerId: intent.providerId,
      requiredCapabilities: intent.requires,
      sceneId: intent.sceneId,
      sceneTitle: intent.createScene.title,
      sceneDescription: intent.createScene.description ?? "",
      sceneVersionId: "",
      jobKey: intent.jobKey,
      // The instruction text became a prompt here and nowhere else, exactly as in 4B's mapping.
      prompt: intent.addSceneVersion.prompt,
      references: intent.addSceneVersion.references ?? [],
      parameters: intent.requestGeneration.parameters ?? {},
      metadata: intent.requestGeneration.metadata ?? {},
      outputCount: numberOr(intent.requestGeneration.parameters?.outputCount, 1),
      aspectRatio: stringOr(intent.requestGeneration.parameters?.aspectRatio),
      durationMs: numberOrUndefined(intent.requestGeneration.parameters?.durationMs),
      priority: priorityForSceneNumber(intent.sceneNumber),
      // Sequence only: the plan's own scene order, reported so an operator can see what follows what.
      dependsOn: position > 0 ? [sceneOrder[position - 1]] : [],
    };
    identityUnits.push({
      scenePlanId: unit.scenePlanId,
      sceneKey: unit.sceneKey,
      sceneNumber: unit.sceneNumber,
      specId: unit.specId,
      specNumber: unit.specNumber,
      kind: unit.kind,
      providerId: unit.providerId,
      prompt: unit.prompt,
      references: unit.references,
      parameters: unit.parameters,
      requiredCapabilities: unit.requiredCapabilities,
      outputCount: unit.outputCount,
      aspectRatio: unit.aspectRatio,
      durationMs: unit.durationMs,
    });
    units.push(unit);
  }

  const identity = executionIdentity({
    projectId: plan.projectId,
    planId: plan.id,
    planVersionId: version.id,
    versionNumber: version.versionNumber,
    contentHash: version.contentHash,
    mappingScope: mapping.mappingScope,
    units: identityUnits,
  });
  for (const unit of units) {
    const sceneVersionId = identity.sceneVersionIds.get(`${unit.sceneKey}/${unit.specNumber}`);
    if (!sceneVersionId) {
      throw new Error(`No deterministic scene version id for ${unit.sceneKey}/${unit.specNumber}.`);
    }
    unit.sceneVersionId = sceneVersionId;
  }

  return {
    planId: plan.id,
    planVersionId: version.id,
    versionNumber: version.versionNumber,
    mappingScope: mapping.mappingScope,
    executionFingerprint: identity.executionFingerprint,
    executionId: identity.executionId,
    rulesVersion: identity.rulesVersion,
    units,
    skipped: mapping.skipped,
    unboundReferenceCount: mapping.unboundReferenceCount,
  };
}

/** The capability data readiness needs, without handing that module the port or a provider instance. */
export function capabilityMapFor(
  providers: ProviderRegistry,
  selected?: readonly string[],
): Map<string, ProviderCapabilities> {
  const map = new Map<string, ProviderCapabilities>();
  for (const [id, descriptor] of providers) {
    if (selected && !selected.includes(id)) continue;
    map.set(id, descriptor.capabilities);
  }
  return map;
}

function narrowRegistry(providers: ProviderRegistry, selected: readonly string[] | undefined): ProviderRegistry {
  if (!selected) return providers;
  const narrowed = new Map<string, ProviderDescriptor>();
  for (const id of selected) {
    const descriptor = providers.get(id);
    if (descriptor) narrowed.set(id, descriptor);
  }
  return narrowed;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
