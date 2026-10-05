import type { ProviderCapabilityKey } from "@flowforge/core";
import { idFor, notice, recordTrace, type PlannerState } from "./state.js";
import type { PlannedScenePlan, PlannedSpec } from "./types.js";

/** The capability a spec of this kind cannot exist without. */
const KIND_CAPABILITY: Record<string, ProviderCapabilityKey> = {
  image: "imageGeneration",
  video: "videoGeneration",
};

/**
 * What the declared providers can actually do, as far as this run knows.
 *
 * `declares` is *permissive when unknown*: with no candidates at all the planner cannot claim a
 * capability is missing, so nothing is adapted and the Phase 4A executability gate keeps that job.
 * With candidates, a capability is available only if at least one of them declares it — the same
 * rule the executability gate uses, applied at planning time so an unsatisfiable plan is never
 * written in the first place.
 */
function capabilityProbe(state: PlannerState): (capability: ProviderCapabilityKey) => boolean {
  const providers = state.input.providers;
  if (providers.length === 0) return () => true;
  return (capability) => providers.some((provider) => provider.declares.includes(capability));
}

/**
 * Rule `generation-spec-planning`: one executable spec per scene per requested output kind.
 *
 * Each spec carries the *instruction text* the shot will be generated from — assembled from the plan's
 * own definitions by a fixed template, never by a language model — plus the mechanical requirements
 * (aspect ratio, count, duration for video), the brief's constraints, and the references the shot is
 * built on. Spec numbers are dense per scene, in the order the kinds were requested, and ids derive
 * from the input fingerprint plus that position, so re-planning the same input yields the same ids.
 *
 * Instruction template (documented, quoted verbatim, never paraphrased):
 *
 *   [<kind>] <scene title> — <narrative purpose>.
 *   Look: <dna.style>; <dna.renderingStyle>; <dna.lighting>; <dna.composition>; <dna.cameraLanguage>; palette: <dna.palette>; mood: <dna.atmosphere>.
 *   Setting: <world name> — <world environment>.
 *   Cast: <name> as <role>, …
 *   Delivery: <brief.style>, <brief.tone> tone, target <ms>ms[ scene], aspect <ratio>.
 *   Reference material: world <name>, visualDna <name>, character <name>, …
 *
 * An absent field contributes nothing (not even its label), so a plan without a world does not say
 * "Setting: ." and a project with no visual DNA says nothing about look.
 */
export function planGenerationSpecs(state: PlannerState): void {
  const probe = capabilityProbe(state);
  const referencesAllowed = probe("referenceImages");
  const batchAllowed = probe("batchGeneration");
  let countClamped = 0;
  let dropped = 0;
  let written = 0;
  for (const scene of state.scenes) {
    const kinds = scene.outputKinds;
    scene.specs = [];
    let refusedForScene = 0;
    kinds.forEach((kind, index) => {
      const required = KIND_CAPABILITY[kind] ?? "imageGeneration";
      if (!probe(required)) {
        dropped += 1;
        refusedForScene += 1;
        notice(
          state,
          "PLANNER_KIND_UNAVAILABLE",
          "ERROR",
          `Scene "${scene.sceneKey}" was asked to produce ${kind} output, but no declared provider supports "${required}". Configure such a provider, or limit the plan's output kinds.`,
          "providerCandidates",
        );
        return;
      }
      const wanted = state.input.options.outputCountPerSpec;
      let outputCount = wanted;
      if (wanted > 1 && !batchAllowed) {
        outputCount = 1;
        countClamped += 1;
      }
      const references = referencesAllowed ? referenceList(state, scene) : [];
      const capabilities: ProviderCapabilityKey[] = [required];
      if (references.length > 0) capabilities.push("referenceImages");
      if (outputCount > 1) capabilities.push("batchGeneration");
      const spec: PlannedSpec = {
        id: idFor(state, "generation-spec", `${scene.sceneKey}/${index}/${kind}`),
        specNumber: scene.specs.length + 1,
        kind,
        instructions: composeInstructions(state, scene, kind, references),
        outputCount,
        aspectRatio: state.input.options.aspectRatio,
        ...(kind === "video" ? { durationMs: scene.durationTargetMs } : {}),
        references,
        constraints: constraintLines(state),
        requiredCapabilities: capabilities,
        requirementNotes: `planned by ${state.input.plannerVersion} from beat ${scene.beatKey}`,
      };
      scene.specs.push(spec);
      written += 1;
    });
    scene.plannedKinds = scene.specs.map((spec) => spec.kind);
    // Only a scene that lost every kind to an internal problem lands here; a kind the providers cannot
    // serve is already reported by name, and repeating it as "no spec" would double-book the same fault.
    if (scene.specs.length === 0 && kinds.length > 0 && refusedForScene === 0) {
      notice(
        state,
        "PLANNER_SCENE_UNSPECIFIABLE",
        "ERROR",
        `Scene "${scene.sceneKey}" ended with no generation spec, which the planning rules reject: a scene plan must carry at least one.`,
        "scenePlans",
      );
    }
  }
  if (countClamped > 0) {
    notice(
      state,
      "PLANNER_BATCH_UNAVAILABLE",
      "WARNING",
      `${countClamped} spec(s) asked for ${state.input.options.outputCountPerSpec} outputs; no declared provider supports "batchGeneration", so each was planned as a single output.`,
      "planningOptions.outputCountPerSpec",
    );
  }
  if (state.input.providers.length > 0 && !referencesAllowed && state.scenes.length > 0) {
    notice(
      state,
      "PLANNER_REFERENCES_SKIPPED",
      "INFO",
      "No declared provider supports \"referenceImages\", so the specs were planned without reference material; the scene plans still carry their cast and world bindings.",
      "providerCandidates",
    );
  }
  recordTrace(
    state,
    written > 0 ? "APPLIED" : "SKIPPED",
    state.scenes.flatMap((scene) => scene.specs.map((spec) => `${scene.sceneKey}#${spec.specNumber}`)),
    `${written} spec(s) planned, ${dropped} kind request(s) refused, ${countClamped} output count(s) clamped`,
  );
}

/**
 * Rule `capability-adaptation` is folded into `generation-spec-planning` on purpose: the requirements a
 * spec declares (references, batch count) decide which capabilities it needs, so adapting afterwards
 * would leave a spec whose declared capabilities contradict its own shape — exactly what the Phase 4A
 * validator rejects. The two rule ids stay separately visible in the trace and the documentation, with
 * the adaptation decisions recorded here as their own step.
 */
export function recordCapabilityAdaptation(state: PlannerState): void {
  const probe = capabilityProbe(state);
  const declared = state.input.providers.map((provider) => provider.id);
  const missing = (["imageGeneration", "videoGeneration", "referenceImages", "batchGeneration"] as const).filter(
    (capability) => !probe(capability),
  );
  if (declared.length === 0) {
    recordTrace(state, "SKIPPED", undefined, "no provider candidates declared; capability coverage is left to the executability gate");
    return;
  }
  recordTrace(
    state,
    missing.length > 0 ? "APPLIED" : "SKIPPED",
    declared,
    missing.length > 0
      ? `providers omit ${missing.join(", ")}; specs were planned within that envelope`
      : "every capability the planner may use is declared by at least one candidate",
  );
}

/** References the shot is built on: its world, its visual DNA, and its cast, in that fixed order. */
function referenceList(state: PlannerState, scene: PlannedScenePlan): PlannedSpec["references"] {
  const references: PlannedSpec["references"] = [];
  if (scene.worldId !== undefined) {
    references.push({ kind: "world", id: scene.worldId, note: `setting of ${scene.sceneKey}` });
  }
  if (state.versionVisualDnaId !== undefined) {
    references.push({ kind: "visualDna", id: state.versionVisualDnaId, note: `aesthetic contract of the plan` });
  }
  for (const link of scene.cast) {
    references.push({
      kind: "character",
      id: link.characterId,
      note: link.role.length > 0 ? `appears as ${link.role}` : "appears",
    });
  }
  return references;
}

/** Brief constraints, labelled by kind so the distinction the brief made survives into the spec. */
function constraintLines(state: PlannerState): string[] {
  return state.input.brief.constraints.map((constraint) => `${constraint.kind}: ${constraint.value}`);
}

function composeInstructions(
  state: PlannerState,
  scene: PlannedScenePlan,
  kind: string,
  references: PlannedSpec["references"],
): string {
  const dna = state.input.dna.find((candidate) => candidate.id === state.versionVisualDnaId);
  const world = state.input.worlds.find((candidate) => candidate.worldId === scene.worldId);
  const names = new Map(state.input.characters.map((character) => [character.id, character.name]));
  const lines: string[] = [];
  const purpose = scene.narrativePurpose.trim();
  lines.push(`[${kind}] ${sentence(scene.title)}${purpose.length > 0 ? ` — ${sentence(purpose)}` : ""}`);
  if (dna) {
    const look = [
      dna.style,
      dna.renderingStyle,
      dna.lighting,
      dna.composition,
      dna.cameraLanguage,
      dna.palette.length > 0 ? `palette: ${dna.palette.join(", ")}` : "",
      dna.atmosphere.length > 0 ? `mood: ${dna.atmosphere}` : "",
    ].filter((part) => part.trim().length > 0);
    if (look.length > 0) lines.push(`Look: ${look.join("; ")}.`);
  }
  if (world) {
    lines.push(`Setting: ${world.name}${world.environment.length > 0 ? ` — ${world.environment}` : ""}.`);
  }
  const cast = scene.cast.map((link) => {
    const name = names.get(link.characterId) ?? link.characterId;
    return link.role.length > 0 ? `${name} as ${link.role}` : name;
  });
  if (cast.length > 0) lines.push(`Cast: ${cast.join(", ")}.`);
  const delivery = [
    state.input.brief.style.trim(),
    state.input.brief.tone.trim().length > 0 ? `${state.input.brief.tone.trim()} tone` : "",
  ].filter((part) => part.length > 0);
  const technical = [
    kind === "video" ? `target ${scene.durationTargetMs}ms` : `target ${scene.durationTargetMs}ms scene`,
    `aspect ${state.input.options.aspectRatio}`,
  ];
  lines.push(`Delivery: ${[...delivery, ...technical].join(", ")}.`);
  if (references.length > 0) {
    // Named, not id-truncated: an operator reading a spec must see which people and places it means.
    const labels = references.map((reference) => {
      const target =
        reference.kind === "character" ? names.get(reference.id) : reference.kind === "world" ? world?.name : dna?.name;
      return `${reference.kind} ${target ?? reference.id}`;
    });
    lines.push(`Reference material: ${labels.join(", ")}.`);
  }
  return lines.join("\n");
}

/** End a quoted passage with a single sentence terminator; the text itself is never touched. */
function sentence(text: string): string {
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}
