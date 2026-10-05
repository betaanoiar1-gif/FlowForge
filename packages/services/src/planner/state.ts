import type { PlannerTraceStep } from "@flowforge/core";
import type { NormalizedBeat, NormalizedPlannerInput } from "./normalize.js";
import { plannerFingerprint, plannerId, slugify } from "./deterministic-ids.js";
import {
  PLANNER_OUTPUT_FINGERPRINT_NAMESPACE,
  type PlannedScenePlan,
  type PlannerNotice,
} from "./types.js";

/**
 * Mutable working state of one planning run.
 *
 * The engine is still a pure function — this object is created inside a run, never escapes it except
 * through the returned result, and no rule reads anything the input did not provide. A rule may only
 * append to `scenes`/`notices`/`trace` or fill in a field of a scene it was given, in the fixed rule
 * order, which is what keeps a run reproducible and the trace readable.
 */
export interface PlannerState {
  readonly input: NormalizedPlannerInput;
  readonly inputFingerprint: string;
  readonly ruleId: string;
  /** The beats the story-foundation rule settled on: the operator's, or derived from the prose. */
  beats: NormalizedBeat[];
  /** The plan title, decided by the brief-foundation rule. */
  planTitle: string;
  /**
   * The story the plan records, as `story-foundation` settled it: the input's fields, plus a structure
   * naming the shape the beats actually have when the operator did not state one. Filled by a rule so a
   * run that never reached it cannot quietly store a half-story.
   */
  story: {
    premise: string;
    structure: string;
    themes: readonly string[];
    beginning: string;
    development: string;
    ending: string;
  };
  scenes: PlannedScenePlan[];
  /** The version-level visual DNA the binding rule resolved (or left undefined on purpose). */
  versionVisualDnaId?: string;
  cast: { characterId: string; role: string }[];
  /** How many brief constraints the specs inherited (recorded by `brief-foundation`). */
  constraintsCarried: number;
  /** The duration the plan actually totals once allocation ran, reported by `plan-integrity`. */
  plannedTotalDurationMs: number;
  /** Rule ids that actually ran, in order; a refused run stops early and says where. */
  rulesRun: string[];
  notices: PlannerNotice[];
  trace: PlannerTraceStep[];
  currentRule: string;
}

export function createPlannerState(input: NormalizedPlannerInput, inputFingerprint: string): PlannerState {
  return {
    input,
    inputFingerprint,
    beats: [],
    // The title is the brief-foundation rule's decision; it starts unset so a rule that forgets to run
    // cannot silently plan with a borrowed one.
    planTitle: "",
    story: {
      premise: input.story.premise,
      structure: input.story.structure,
      themes: [...input.story.themes],
      beginning: input.story.beginning,
      development: input.story.development,
      ending: input.story.ending,
    },
    ruleId: input.rulesVersion,
    scenes: [],
    cast: input.cast.map((entry) => ({ characterId: entry.characterId, role: entry.role })),
    constraintsCarried: 0,
    plannedTotalDurationMs: 0,
    rulesRun: [],
    notices: [],
    trace: [],
    currentRule: "",
  };
}

export function idFor(state: PlannerState, kind: string, path: string): string {
  return plannerId(state.inputFingerprint, kind, path);
}

/** A short, stable reference to an id for trace lines; full ids stay in the persisted rows. */
export function shortId(value: string): string {
  return value.slice(0, 8);
}

/**
 * A scene key is the *stable logical identity* of a planned scene, preserved across plan versions — so
 * it is a slug of the beat's own key when it has one, else of its title, and deliberately **not** prefixed
 * with its position: inserting a scene at the front must not rename every scene after it. Order belongs to
 * `sceneNumber`, which is dense and re-derived on every run.
 *
 * Two beats that slug to the same string collide, and the collision resolves positionally (`-2`, `-3`, …)
 * rather than by hashing prose, so the operator's words stay legible inside the id.
 */
export function uniqueSceneKey(state: PlannerState, index: number, seed: string): string {
  const base = slugify(seed, `scene-${index + 1}`);
  const taken = new Set(state.scenes.map((scene) => scene.sceneKey));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function notice(
  state: PlannerState,
  code: string,
  severity: PlannerNotice["severity"],
  message: string,
  field?: string,
): void {
  state.notices.push({ code, severity, message, rule: state.currentRule, field });
}

export function recordTrace(
  state: PlannerState,
  outcome: PlannerTraceStep["outcome"],
  subjects?: string[],
  detail?: string,
): void {
  if (!state.input.options.includeTrace) return;
  state.trace.push({
    rule: state.currentRule,
    outcome,
    ...(subjects && subjects.length > 0 ? { subjects } : {}),
    ...(detail === undefined ? {} : { detail }),
  });
}

export function outputFingerprintOf(state: PlannerState): string {
  return plannerFingerprint(PLANNER_OUTPUT_FINGERPRINT_NAMESPACE, {
    plannerVersion: state.input.plannerVersion,
    rulesVersion: state.input.rulesVersion,
    plan: {
      title: state.planTitle,
      briefId: state.input.brief.id,
      visualDnaId: state.versionVisualDnaId ?? null,
    },
    story: state.story,
    cast: state.cast,
    scenePlans: state.scenes,
  });
}
