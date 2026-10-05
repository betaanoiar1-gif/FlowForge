import type {
  CreativeBrief,
  GenerationSpec,
  PlanVersionSnapshot,
  PlanningCharacterRecord,
  PlannerTraceStep,
  VisualDnaDefinition,
  WorldDefinition,
} from "@flowforge/core";
import type { NormalizedPlannerInput } from "./normalize.js";
import { idFor, type PlannerState } from "./state.js";
import type { PlannerDraft, PlannedSpec } from "./types.js";

/**
 * The drafted plan as a Phase 4A snapshot.
 *
 * The engine's final rule is not a second validator: it runs *the* planning validator over the draft,
 * through this builder, so "would this plan pass?" is answered with the same code that will judge the
 * stored rows. Rows here are candidates — the ids are the deterministic ones the engine chose, and the
 * version is a stand-in for the one the service will author into. Nothing is persisted by building it.
 */
export function draftToSnapshot(args: {
  state: PlannerState;
  input: NormalizedPlannerInput;
  draft: PlannerDraft;
  brief: CreativeBrief;
  characters: readonly PlanningCharacterRecord[];
  worlds: readonly WorldDefinition[];
  visualDna: readonly VisualDnaDefinition[];
  trace: readonly PlannerTraceStep[];
  versionNumber?: number;
}): PlanVersionSnapshot {
  const { state, draft, brief } = args;
  const asOf = state.input.asOf;
  // A stable stand-in: the checks that matter here are content checks, and the real version id exists
  // only once the service has authored. Ties every drafted row to the same version the way storage will.
  const versionId = "planner-self-check-version";
  const scenePlans = draft.scenePlans.map((scene) => ({
    scenePlan: {
      id: scene.id,
      planVersionId: versionId,
      sceneKey: scene.sceneKey,
      sceneNumber: scene.sceneNumber,
      title: scene.title,
      narrativePurpose: scene.narrativePurpose,
      description: scene.description,
      durationTargetMs: scene.durationTargetMs,
      ...(scene.worldId === undefined ? {} : { worldId: scene.worldId }),
      ...(scene.visualDnaId === undefined ? {} : { visualDnaId: scene.visualDnaId }),
      continuity: scene.continuity.map((entry) => ({ ...entry })),
      requiredReferences: scene.requiredReferences.map((entry) => ({ ...entry })),
      plannedOutputs: scene.plannedOutputs.map((entry) => ({ ...entry })),
      createdAt: asOf,
      updatedAt: asOf,
    },
    cast: scene.cast.map((link) => ({ ...link })),
    specs: scene.specs.map((spec) => specRow(spec, scene.id, asOf)),
  }));
  return {
    projectId: draft.projectId,
    plan: {
      id: draft.planId,
      projectId: draft.projectId,
      title: draft.title,
      briefId: draft.briefId,
      idempotencyKey: `planner-self-check:${draft.planId}`,
      createdAt: asOf,
      updatedAt: asOf,
    },
    version: {
      id: versionId,
      planId: draft.planId,
      versionNumber: args.versionNumber ?? 1,
      status: "DRAFT",
      contentHash: "",
      ...(draft.visualDnaId === undefined ? {} : { visualDnaId: draft.visualDnaId }),
      plannerVersion: state.input.plannerVersion,
      plannerRulesVersion: state.input.rulesVersion,
      plannerSeed: state.input.options.seed,
      plannerTrace: args.trace.map((step) => ({ ...step })),
      createdAt: asOf,
      updatedAt: asOf,
    },
    brief,
    story: {
      id: idFor(state, "story", "story"),
      planVersionId: versionId,
      premise: draft.story.premise,
      structure: draft.story.structure,
      themes: [...draft.story.themes],
      beginning: draft.story.beginning,
      development: draft.story.development,
      ending: draft.story.ending,
      createdAt: asOf,
      updatedAt: asOf,
    },
    cast: draft.cast.map((entry) => ({ ...entry })),
    characters: [...args.characters],
    worlds: [...args.worlds],
    visualDna: [...args.visualDna],
    scenePlans,
    specs: scenePlans.flatMap((node) => node.specs),
  };
}

function specRow(spec: PlannedSpec, scenePlanId: string, asOf: string): GenerationSpec {
  return {
    id: spec.id,
    scenePlanId,
    specNumber: spec.specNumber,
    kind: spec.kind,
    instructions: spec.instructions,
    outputCount: spec.outputCount,
    ...(spec.aspectRatio === undefined ? {} : { aspectRatio: spec.aspectRatio }),
    ...(spec.durationMs === undefined ? {} : { durationMs: spec.durationMs }),
    references: spec.references.map((reference) => ({ ...reference })),
    constraints: [...spec.constraints],
    providerRequirements: { capabilities: [...spec.requiredCapabilities], notes: spec.requirementNotes },
    createdAt: asOf,
  };
}
