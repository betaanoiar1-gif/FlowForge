import { deriveBeats, beatKey } from "./normalize.js";
import { notice, recordTrace, type PlannerState } from "./state.js";
import { allocateDurations } from "./duration-planning.js";
import { planGenerationSpecs, recordCapabilityAdaptation } from "./generation-spec-planning.js";
import { assignCastToScenes, bindVisualDna, bindWorlds, decomposeBeats } from "./scene-decomposition.js";
import { linkContinuity, planOutputManifest } from "./continuity.js";
import type { GenerationSpecKind, ProviderCapabilityKey } from "@flowforge/core";

/**
 * The planner's rule system.
 *
 * A rule is a named, versioned, deterministic transformation of the planning state, and this registry
 * is the single list of them. Order is part of the contract: each rule reads what earlier rules wrote,
 * so the registry order is the algorithm. Every rule records a trace step, so a plan can always be
 * explained rule by rule, and a rule is free to add notices but never to read anything outside
 * `state.input` — no clock, no randomness, no I/O.
 *
 * `PLANNING_RULES_VERSION` (in `@flowforge/core`) versions this file's *behaviour*: changing what a
 * rule decides means bumping it, and any plan version already carrying provenance keeps naming the
 * version that produced it.
 */
export interface PlannerRule {
  readonly id: string;
  /** One line, mirrored in docs/planner-engine.md; what the rule decides, not how. */
  readonly summary: string;
  /** The input fields the rule reads. Documentation of the dependency graph, kept honest by tests. */
  readonly reads: readonly string[];
  apply(state: PlannerState): void;
}

/** Rule `brief-foundation`: what the plan is *for*, inherited from the brief. */
function briefFoundation(state: PlannerState): void {
  const brief = state.input.brief;
  state.planTitle = state.input.options.planTitle ?? `${brief.title} plan`;
  if (state.input.brief.constraints.length === 0) {
    notice(
      state,
      "PLANNER_BRIEF_UNCONSTRAINED",
      "INFO",
      "The brief states no constraints, so the planned specs carry none. Add MUST or MUST_NOT constraints to the brief if the piece has rules.",
      "brief.constraints",
    );
  }
  state.constraintsCarried = state.input.brief.constraints.length;
  recordTrace(
    state,
    "APPLIED",
    [brief.id],
    `plan title "${state.planTitle}", ${state.constraintsCarried} brief constraint(s) carried into every spec`,
  );
}

/**
 * Rule `story-foundation`: which beats the plan is built on.
 *
 * The operator's beats win, in their order. Without them the story's prose is *partitioned*, never
 * summarised: one establishing beat from `beginning`, one developing beat per `developmentScenes` slice
 * of `development`, one resolving beat from `ending`, each carrying its own sentences verbatim. A
 * language model is not consulted, so the beats of a plan are readable from the story that produced them.
 */
function storyFoundation(state: PlannerState): void {
  // The plan stores a story, and the Phase 4A rules require all three movements. The planner will not
  // write narrative on the operator's behalf, so a missing movement is refused here, by name, instead of
  // surfacing later as a validation finding against a plan that could never be used.
  const missing = (
    [
      ["beginning", state.input.story.beginning],
      ["development", state.input.story.development],
      ["ending", state.input.story.ending],
    ] as const
  )
    .filter(([, value]) => value.trim().length === 0)
    .map(([field]) => field);
  if (missing.length > 0) {
    notice(
      state,
      "PLANNER_STORY_INCOMPLETE",
      "ERROR",
      `The story has no ${missing.join(", ")} text. A plan records the whole narrative movement, and the planner never invents the parts that are missing.`,
      "story",
    );
    recordTrace(state, "SKIPPED", undefined, `missing movement(s): ${missing.join(", ")}`);
    return;
  }
  if (state.input.explicitBeats.length > 0) {
    state.beats = [...state.input.explicitBeats];
    recordTrace(
      state,
      "APPLIED",
      state.beats.map((beat, index) => beatKey(beat, index)),
      `${state.beats.length} beat(s) authored by the operator`,
    );
  } else {
    state.beats = deriveBeats({ ...state.input.story, options: state.input.options });
    if (state.beats.length === 0) {
      notice(
        state,
        "PLANNER_BEATS_EMPTY",
        "ERROR",
        "The story has no beats and no prose to derive them from. Provide story.beats or beginning/development/ending text.",
        "story",
      );
      recordTrace(state, "SKIPPED", undefined, "no beats authored and none derivable");
      return;
    }
    recordTrace(
      state,
      "APPLIED",
      state.beats.map((beat, index) => beatKey(beat, index)),
      `${state.beats.length} beat(s) partitioned from the story's movements`,
    );
  }
  state.story = {
    ...state.input.story,
    structure: state.input.story.structure.trim().length > 0 ? state.input.story.structure : deriveStructure(state),
  };
  // Cast and world `scenes` lists name beats by key; a typo must be reported, not silently ignored.
  const keys = new Set(state.beats.map((beat, index) => beatKey(beat, index)));
  for (const entry of state.input.cast) {
    const unknown = entry.scenes.filter((scene) => !keys.has(scene));
    if (unknown.length > 0) {
      notice(
        state,
        "PLANNER_BEAT_KEY_UNKNOWN",
        "ERROR",
        `Cast member ${entry.characterId} claims beat(s) this plan does not have: ${unknown.join(", ")}.`,
        "cast[].scenes",
      );
    }
  }
  for (const entry of state.input.worlds) {
    const unknown = entry.scenes.filter((scene) => !keys.has(scene));
    if (unknown.length > 0) {
      notice(
        state,
        "PLANNER_BEAT_KEY_UNKNOWN",
        "ERROR",
        `World ${entry.worldId} claims beat(s) this plan does not have: ${unknown.join(", ")}.`,
        "worlds[].scenes",
      );
    }
  }
}

/** Rule `plan-integrity`: the engine's own promise, checked before anything is written. */
function planIntegrity(state: PlannerState): void {
  const problems: string[] = [];
  const scenes = state.scenes;
  if (scenes.length === 0) {
    problems.push("the plan contains no scene plans");
  }
  const keys = new Set<string>();
  const ids = new Set<string>();
  const specIds = new Set<string>();
  const minSceneDurationMs = state.input.options.minSceneDurationMs;
  const castIds = new Set(state.input.cast.map((entry) => entry.characterId));
  const knownCharacters = new Set(state.input.characters.map((character) => character.id));
  let total = 0;
  for (const [index, scene] of scenes.entries()) {
    if (scene.sceneNumber !== index + 1) problems.push(`scene ${scene.sceneKey} is numbered ${scene.sceneNumber}, expected ${index + 1}`);
    if (keys.has(scene.sceneKey)) problems.push(`duplicate scene key ${scene.sceneKey}`);
    keys.add(scene.sceneKey);
    if (ids.has(scene.id)) problems.push(`duplicate scene plan id ${scene.id}`);
    ids.add(scene.id);
    if (scene.specs.length === 0) problems.push(`scene ${scene.sceneKey} carries no generation spec`);
    if (scene.durationTargetMs < minSceneDurationMs) {
      problems.push(`scene ${scene.sceneKey} duration ${scene.durationTargetMs} ms is below the ${minSceneDurationMs} ms floor`);
    }
    total += scene.durationTargetMs;
    for (const spec of scene.specs) {
      if (specIds.has(spec.id)) problems.push(`duplicate generation spec id ${spec.id}`);
      specIds.add(spec.id);
      // Drift guard: the capabilities a spec declares must be exactly what its own shape requires,
      // because that equality is what the Phase 4A validator will insist on once the row exists.
      const required = new Set<ProviderCapabilityKey>();
      required.add(spec.kind === "video" ? "videoGeneration" : "imageGeneration");
      if (spec.references.length > 0) required.add("referenceImages");
      if (spec.outputCount > 1) required.add("batchGeneration");
      const declared = new Set(spec.requiredCapabilities);
      if (declared.size !== required.size || [...required].some((capability) => !declared.has(capability))) {
        problems.push(`spec ${spec.id} declares [${[...declared].join(", ")}] but its shape requires [${[...required].join(", ")}]`);
      }
      if (spec.kind === "video" && spec.durationMs !== scene.durationTargetMs) {
        problems.push(`spec ${spec.id} duration ${String(spec.durationMs)} ms diverges from its scene target ${scene.durationTargetMs} ms`);
      }
      if (spec.outputCount > state.input.options.outputCountPerSpec) {
        problems.push(`spec ${spec.id} asks for ${spec.outputCount} outputs, above the ${state.input.options.outputCountPerSpec} the plan allows`);
      }
    }
    for (const link of scene.cast) {
      if (!knownCharacters.has(link.characterId)) problems.push(`scene ${scene.sceneKey} casts unknown character ${link.characterId}`);
      else if (!castIds.has(link.characterId)) problems.push(`scene ${scene.sceneKey} casts ${link.characterId}, which the plan's cast does not declare`);
    }
    const plannedKinds = scene.plannedKinds ?? [];
    const manifestKinds = scene.plannedOutputs.map((entry) => entry.kind);
    if (plannedKinds.length !== new Set(manifestKinds).size) {
      problems.push(`scene ${scene.sceneKey} promises ${manifestKinds.join(", ") || "no"} output kinds but planned ${plannedKinds.join(", ") || "none"}`);
    }
    const promised = scene.plannedOutputs.reduce((sum, entry) => sum + entry.count, 0);
    const specified = scene.specs.reduce((sum, spec) => sum + spec.outputCount, 0);
    if (promised !== specified) problems.push(`scene ${scene.sceneKey} manifests ${promised} output(s) but its specs produce ${specified}`);
  }
  if (total > state.input.options.maxTotalDurationMs) {
    problems.push(`the plan totals ${total} ms, above the ${state.input.options.maxTotalDurationMs} ms ceiling`);
  }
  state.plannedTotalDurationMs = total;
  if (problems.length > 0) {
    for (const problem of problems) {
      notice(state, "PLANNER_INTEGRITY_FAILURE", "ERROR", `Internal planning check failed: ${problem}.`, "scenePlans");
    }
    recordTrace(state, "SKIPPED", undefined, `${problems.length} integrity problem(s)`);
    return;
  }
  recordTrace(
    state,
    "APPLIED",
    scenes.map((scene) => scene.sceneKey),
    `${scenes.length} scene plan(s), ${specIds.size} spec(s), ${total} ms total, keys and ids unique`,
  );
}

/**
 * The registry, in the order the engine runs it. `docs/planner-engine.md` documents each entry; the
 * CLI's `planner rules` prints this list, so what an operator reads is what the engine executes.
 */
export const PLANNER_RULES: readonly PlannerRule[] = Object.freeze([
  {
    id: "brief-foundation",
    summary: "Inherit the plan title, brief constraints, and creative objective the plan serves.",
    reads: ["brief", "planningOptions.planTitle"],
    apply: briefFoundation,
  },
  {
    id: "story-foundation",
    summary: "Resolve the ordered beats: the operator's own, or partitioned from the story's prose.",
    reads: ["story", "planningOptions.developmentScenes", "cast[].scenes", "worlds[].scenes"],
    apply: storyFoundation,
  },
  {
    id: "beat-decomposition",
    summary: "Turn each beat into one scene plan, numbered densely in beat order.",
    reads: ["beats"],
    apply: decomposeBeats,
  },
  {
    id: "cast-assignment",
    summary: "Decide who appears in each scene: explicit beat cast, declared scene lists, then seeded rotation.",
    reads: ["cast", "beats[].characters", "planningOptions.seed"],
    apply: assignCastToScenes,
  },
  {
    id: "world-binding",
    summary: "Bind each scene to a world by explicit beat claim, world claim, or the plan's only world.",
    reads: ["worlds", "beats[].worldId"],
    apply: bindWorlds,
  },
  {
    id: "visual-dna-binding",
    summary: "Resolve the plan's aesthetic contract: named snapshot, or the project's only one.",
    reads: ["visualDnaId", "project visual DNA"],
    apply: bindVisualDna,
  },
  {
    id: "duration-allocation",
    summary: "Divide the duration budget by beat weight, whole milliseconds, with fixed beats honoured exactly.",
    reads: ["beats[].durationMs", "planningOptions.totalDurationMs", "planningOptions.minSceneDurationMs"],
    apply: allocateDurations,
  },
  {
    id: "capability-adaptation",
    summary: "Establish what the declared providers can do, and plan within that envelope.",
    reads: ["providerCandidates"],
    apply: recordCapabilityAdaptation,
  },
  {
    id: "generation-spec-planning",
    summary: "Compose one spec per scene per requested kind: instructions, references, counts, capabilities.",
    reads: ["beats[].outputKinds", "brief constraints", "visual DNA", "worlds", "cast"],
    apply: planGenerationSpecs,
  },
  {
    id: "continuity-linking",
    summary: "State each scene's seams and the artefacts that carry them.",
    reads: ["scene plans", "previous scene plan", "world bindings", "cast"],
    apply: linkContinuity,
  },
  {
    id: "planned-output-manifest",
    summary: "Manifest the outputs each scene promises, per kind.",
    reads: ["generation specs"],
    apply: planOutputManifest,
  },
  {
    id: "plan-integrity",
    summary: "Prove the draft is internally consistent before any of it can be written.",
    reads: ["the assembled draft"],
    apply: planIntegrity,
  },
] as PlannerRule[]);

/** The kinds this planner version can plan for, in the order it evaluates them. */
export const PLANNER_PLANNABLE_KINDS: readonly GenerationSpecKind[] = Object.freeze(["image", "video"] as const);

/** Run every rule in registry order, stopping as soon as the plan is known to be unauthorable. */
export function applyPlannerRules(state: PlannerState): { aborted: boolean } {
  const started = state.notices.length;
  for (const rule of PLANNER_RULES) {
    state.currentRule = rule.id;
    state.rulesRun.push(rule.id);
    rule.apply(state);
    // An ERROR at any point means the draft cannot become a plan; later rules would only describe a
    // half-built one, so the run stops with the notices it has. The caller turns those into the outcome.
    if (state.notices.slice(started).some((entry) => entry.severity === "ERROR")) {
      state.currentRule = rule.id;
      return { aborted: true };
    }
  }
  state.currentRule = "";
  return { aborted: false };
}

/**
 * The structure line a plan carries when its author wrote none: a factual description of the shape the
 * beats have, computed from the beats themselves. It names no story content, so it is not the planner
 * inventing a narrative — it is the planner describing its own plan.
 */
function deriveStructure(state: PlannerState): string {
  const counts: Record<string, number> = {};
  for (const beat of state.beats) counts[beat.emphasis] = (counts[beat.emphasis] ?? 0) + 1;
  const parts = (["establish", "develop", "resolve"] as const)
    .filter((emphasis) => (counts[emphasis] ?? 0) > 0)
    .map((emphasis) => `${counts[emphasis]} ${emphasis}`);
  const movements = (["beginning", "development", "ending"] as const).filter(
    (movement) => state.input.story[movement].trim().length > 0,
  ).length;
  return `${movements}-movement story in ${state.beats.length} beat(s): ${parts.join(", ")}`;
}
