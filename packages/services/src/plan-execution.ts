import type { PlanVersionSnapshot, ProviderCapabilityKey } from "@flowforge/core";
import { plannerId } from "./planner/deterministic-ids.js";
import { buildExecutionPreview, capabilityCoverageFor } from "./planning-read-models.js";
import type { ProviderRegistry } from "./ports.js";
import type { AddSceneVersionCommand, CreateSceneCommand, RequestGenerationCommand } from "./commands.js";

/**
 * Plan-to-execution *mapping* (Phase 4B).
 *
 * A production plan says what a piece needs; Phase 3 says how work is executed. This module is the seam
 * and nothing more: it turns an approved plan version's generation specs into the exact commands a
 * caller would issue — one execution scene per scene plan, one scene version per spec, one generation
 * request per scene version — and it issues none of them. No job is created, nothing is enqueued, no
 * provider is constructed, no queue is touched, no worker runs.
 *
 * It is deliberately built on the Phase 4A execution *preview* rather than beside it: which spec a
 * provider can serve, and what blocks a version, are already decided there, and a second opinion on
 * those questions is how a plan starts meaning two things. The mapping adds only what a preview does not
 * carry — command shapes and deterministic execution identities.
 *
 * Why the keys are scoped as they are:
 *
 *   - `sceneId` derives from the **plan** and the scene key, so re-planning the same piece maps onto the
 *     same execution scene instead of forking a new one per revision.
 *   - `jobKey` derives from the version's **content** — its planner output fingerprint when recorded,
 *     otherwise its content hash — so an unchanged re-plan reproduces identical job keys (idempotent for
 *     whoever stores them), while any content change yields new ones. Nothing is silently reused across
 *     different content.
 *
 * Nothing here reads a database, a clock, a random source, or a provider instance. Phase 4B proves this
 * seam with deterministic tests only; the CLI stops at the plan, and no execution command is exposed.
 */

/** One spec's translation into the commands that would execute it. */
export interface PlannedJobIntent {
  /** Plan-side identities, so an operator can trace a job back to the shot it came from. */
  scenePlanId: string;
  sceneKey: string;
  sceneNumber: number;
  specId: string;
  specNumber: number;
  kind: string;
  requires: ProviderCapabilityKey[];
  /** Execution scene id this shot belongs to: plan-scoped, so a re-plan reuses the scene. */
  sceneId: string;
  /** Stable key for a caller's own bookkeeping (dedupe, retry, reporting). */
  jobKey: string;
  /** The provider chosen by capability coverage, picked deterministically as the first candidate by id. */
  providerId: string;
  createScene: CreateSceneCommand;
  addSceneVersion: AddSceneVersionCommand;
  requestGeneration: RequestGenerationCommand;
}

export interface PlanExecutionMapping {
  planId: string;
  planVersionId: string;
  versionNumber: number;
  status: PlanVersionSnapshot["version"]["status"];
  /** What `jobKey` values are scoped by, reported so a caller can see why keys did or did not change. */
  mappingScope: string;
  /** Why nothing was mapped at all, when the version's own state blocks it (mirrors the preview). */
  blockers: string[];
  intents: PlannedJobIntent[];
  /** Specs that could not be mapped, each with the preview's reason — never a silently dropped shot. */
  skipped: { specId: string; sceneKey: string; reason: string }[];
  /**
   * Entity references (characters, worlds, visual DNA) recorded on a spec are *not* asset versions, and
   * Phase 3 accepts only asset ids as scene-version references. Binding them is a later phase's job, so
   * the mapping reports how many it left unbound instead of inventing a mapping.
   */
  unboundReferenceCount: number;
}

export interface PlanExecutionOptions {
  /** Registered providers to choose from — the same registry `markExecutable` consulted, never a new one. */
  providers: ProviderRegistry;
  /** Map from a version that is not EXECUTABLE yet, for a dry run of the seam. */
  allowUnapproved?: boolean;
  priority?: number;
  maxAttempts?: number;
}

export function mapPlanToJobs(
  snapshot: PlanVersionSnapshot,
  options: PlanExecutionOptions,
): PlanExecutionMapping {
  const { plan, version } = snapshot;
  const scope = version.plannerOutputFingerprint ?? version.contentHash;
  // The same selection rule the executability gate used: honour the approved provider list when there is
  // one, otherwise consider everything configured. Deviating here would let a job run on a provider the
  // plan was never approved for.
  const selected = version.executableProviders && version.executableProviders.length > 0 ? version.executableProviders : undefined;
  const preview = buildExecutionPreview(snapshot, options.providers, capabilityCoverageFor(snapshot, options.providers, selected));
  const mapping: PlanExecutionMapping = {
    planId: plan.id,
    planVersionId: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    mappingScope: scope,
    blockers: preview.blockers,
    intents: [],
    skipped: [],
    unboundReferenceCount: snapshot.specs.reduce((sum, spec) => sum + spec.references.length, 0),
  };
  for (const item of preview.items) {
    if (!item.acceptable && options.allowUnapproved !== true) {
      mapping.skipped.push({ specId: item.specId, sceneKey: item.sceneKey, reason: item.reason ?? "not acceptable" });
      continue;
    }
    const sceneId = plannerId(`plan:${plan.id}`, "execution-scene", item.sceneKey);
    const jobKey = plannerId(`job:${scope}`, item.kind, `${item.sceneKey}/${item.specNumber}`);
    const providerId = [...item.candidateProviders].sort()[0];
    if (providerId === undefined) {
      mapping.skipped.push({
        specId: item.specId,
        sceneKey: item.sceneKey,
        reason: "NO_CAPABLE_PROVIDER",
      });
      continue;
    }
    const metadata = { ...item.metadata, sceneId, jobKey };
    mapping.intents.push({
      scenePlanId: item.scenePlanId,
      sceneKey: item.sceneKey,
      sceneNumber: item.sceneNumber,
      specId: item.specId,
      specNumber: item.specNumber,
      kind: item.kind,
      requires: item.requiredCapabilities,
      sceneId,
      jobKey,
      providerId,
      createScene: {
        projectId: plan.projectId,
        sceneId,
        title: item.sceneTitle,
        sceneNumber: item.sceneNumber,
        description: `planned from ${plan.id} v${version.versionNumber}`,
        metadata,
      },
      addSceneVersion: {
        sceneId,
        // The instruction text becomes the prompt here, and only here: the plan never holds a prompt,
        // and Phase 3 keeps prompts on durable scene versions.
        prompt: item.prompt,
        references: [],
        metadata,
      },
      requestGeneration: {
        projectId: plan.projectId,
        sceneId,
        provider: providerId,
        parameters: {
          aspectRatio: item.aspectRatio ?? "16:9",
          outputCount: item.outputCount,
          ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
        },
        metadata,
        ...(options.priority === undefined ? {} : { priority: options.priority }),
        ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      },
    });
  }
  return mapping;
}
