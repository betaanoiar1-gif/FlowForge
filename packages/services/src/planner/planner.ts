import type { PlanningFinding, PlannerTraceStep } from "@flowforge/core";
import { validatePlanVersion } from "../plan-validation.js";
import { applyPlannerRules, PLANNER_RULES } from "./rules.js";
import { draftToSnapshot } from "./snapshot.js";
import { createPlannerState, outputFingerprintOf } from "./state.js";
import { inputFingerprintOf, normalizePlannerInput, type NormalizedPlannerInput } from "./normalize.js";
import { plannerFingerprint, plannerId } from "./deterministic-ids.js";
import {
  PLANNER_ID_NAMESPACE,
  PLANNER_PLAN_IDENTITY_NAMESPACE,
  type PlannerDraft,
  type PlannerInput,
  type PlannerNotice,
  type PlannerRun,
} from "./types.js";

/**
 * The deterministic planner: `PlannerInput -> PlannerRun`, in full control of what it reads.
 *
 * `runPlanner` normalizes the input, executes the rule registry in order, assembles a draft, and then
 * *validates its own draft* with the Phase 4A validator. Three outcomes, never mixed:
 *
 *   - `SUCCESS` — a complete draft that passes validation. The caller may persist it.
 *   - `VALIDATION_FAILURE` — a complete draft that the planning rules reject. Nothing is persisted, so
 *     there is no half-planned version to reason about later; the findings say precisely what is short.
 *   - `PLANNING_FAILURE` — the rules could not produce a draft at all (bad or missing input, an
 *     unsatisfiable capability request, an internal integrity check that failed). Nothing is persisted.
 *
 * The engine never writes, never reads, never calls a provider, and never asks a model. A run whose
 * input is byte-identical after normalization produces byte-identical output — scene keys, ids,
 * durations, instructions, fingerprints — because the only clock it can see is `asOf`, which is
 * excluded from every fingerprint by design.
 */
export function runPlanner(input: PlannerInput): PlannerRun {
  const normalized = normalizePlannerInput(input);
  const inputFingerprint = inputFingerprintOf(normalized);
  const state = createPlannerState(normalized, inputFingerprint);
  const { aborted } = applyPlannerRules(state);
  const base = {
    plannerVersion: normalized.plannerVersion,
    rulesVersion: normalized.rulesVersion,
    inputFingerprint,
    seed: normalized.options.seed,
    notices: [...state.notices] as PlannerNotice[],
    trace: [...state.trace] as PlannerTraceStep[],
    rulesApplied: [...state.rulesRun],
  };
  const errorNotices = state.notices.filter((entry) => entry.severity === "ERROR");
  if (aborted || errorNotices.length > 0) {
    // A refused run reports the refusal; it does not also run validation over a draft that never finished.
    return {
      ...base,
      outcome: "PLANNING_FAILURE",
      outputFingerprint: null,
      findings: [],
      errors: errorNotices.map((entry) => ({ code: entry.code, message: entry.message, field: entry.field })),
    };
  }
  const draft = assembleDraft(state, normalized);
  const snapshot = draftToSnapshot({
    state,
    input: normalized,
    draft,
    brief: input.brief,
    characters: input.definitions.characters,
    worlds: input.definitions.worlds,
    visualDna: input.definitions.visualDna,
    trace: base.trace,
  });
  // The draft self-check runs without a provider map on purpose: the planner already adapted the plan
  // to the declarations it was given, and provider *registry* membership is the service's business.
  const findings: PlanningFinding[] = validatePlanVersion(snapshot);
  const blocking = findings.filter((finding) => finding.severity === "ERROR");
  const outputFingerprint = outputFingerprintOf(state);
  if (blocking.length > 0) {
    return { ...base, outcome: "VALIDATION_FAILURE", outputFingerprint, draft, findings, errors: [] };
  }
  return { ...base, outcome: "SUCCESS", outputFingerprint, draft, findings, errors: [] };
}

/**
 * Which plan a run targets, without running it: the deterministic plan id for (project, brief, title).
 *
 * Callers use this to look up the target before they commit to a write, and the engine uses it for the
 * draft it hands back. It derives from those three fields alone — deliberately not from the seed or the
 * prose — so re-planning the same piece lands on the same plan while the content fingerprints say
 * whether anything actually changed.
 */
export function planIdentityId(arguments_: { projectId: string; briefId: string; title: string }): string {
  return plannerId(
    plannerFingerprint(PLANNER_PLAN_IDENTITY_NAMESPACE, {
      namespace: PLANNER_ID_NAMESPACE,
      projectId: arguments_.projectId,
      briefId: arguments_.briefId,
      title: arguments_.title,
    }),
    "plan",
    "",
  );
}

/**
 * The draft, with its identity. The plan id derives from (project, brief, title) alone, so re-planning
 * the same piece with a new seed lands on the *same* plan instead of forking a new one; the content
 * fingerprints say whether anything actually changed.
 */
function assembleDraft(state: ReturnType<typeof createPlannerState>, normalized: NormalizedPlannerInput): PlannerDraft {
  const draft: PlannerDraft = {
    projectId: normalized.projectId,
    planId: planIdentityId({ projectId: normalized.projectId, briefId: normalized.brief.id, title: state.planTitle }),
    title: state.planTitle,
    briefId: normalized.brief.id,
    ...(state.versionVisualDnaId === undefined ? {} : { visualDnaId: state.versionVisualDnaId }),
    story: {
      premise: state.story.premise,
      structure: state.story.structure,
      themes: [...state.story.themes],
      beginning: state.story.beginning,
      development: state.story.development,
      ending: state.story.ending,
    },
    cast: state.cast.map((entry) => ({ ...entry })),
    scenePlans: state.scenes.map((scene) => ({
      ...scene,
      cast: scene.cast.map((link) => ({ ...link })),
      continuity: scene.continuity.map((entry) => ({ ...entry })),
      requiredReferences: scene.requiredReferences.map((entry) => ({ ...entry })),
      plannedOutputs: scene.plannedOutputs.map((entry) => ({ ...entry })),
      specs: scene.specs.map((spec) => ({
        ...spec,
        references: spec.references.map((reference) => ({ ...reference })),
        constraints: [...spec.constraints],
        requiredCapabilities: [...spec.requiredCapabilities],
      })),
    })),
  };
  return draft;
}

/** The rule registry, exposed for `planner rules` and for tests that assert on the shape of the engine. */
export { PLANNER_RULES };
export type { PlannerRule } from "./rules.js";
